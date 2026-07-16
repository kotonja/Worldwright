import {
  ROBLOX_COMPILER_VERSION,
  normalizeRobloxSnapshot,
  validateRobloxSnapshot,
  type RobloxManagedNode,
  type RobloxSnapshot,
} from '@worldwright/roblox-compiler';

import {
  STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS,
  STUDIO_MCP_MAX_MANAGED_NODES,
} from './constants.js';
import {
  compareCodePoints,
  StudioAdapterError,
  studioDiagnostic,
  type StudioDiagnostic,
} from './diagnostics.js';
import { verifyStudioRawNode } from './engine-state.js';
import { hashStudioManagedNodeState } from './hashing.js';
import type { StudioCompactSnapshot, StudioRawSnapshot } from './types.js';
import { deriveUnmanagedRoot } from './unmanaged.js';

const COMPACT_CLASS_NAMES = ['Folder', 'Model', 'Part', 'WedgePart', 'CornerWedgePart'] as const;
const Z85_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
const Z85_INDEX = new Map([...Z85_ALPHABET].map((character, index) => [character, index]));

interface DecodedCompactNames {
  readonly values: readonly string[];
  readonly diagnostics: readonly StudioDiagnostic[];
}

function commonCodePointPrefixLength(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  let length = 0;
  while (
    length < leftCodePoints.length &&
    length < rightCodePoints.length &&
    leftCodePoints[length] === rightCodePoints[length]
  ) {
    length += 1;
  }
  return length;
}

function containsOnlyUnicodeScalarValues(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0xd800 || codePoint > 0xdfff;
  });
}

function decodeCompactNames(
  compact: Readonly<StudioCompactSnapshot>,
  basePath: string,
): DecodedCompactNames {
  const values: string[] = [];
  const diagnostics: StudioDiagnostic[] = [];
  for (let index = 0; index < compact.names.length; index += 1) {
    const [prefixLength, suffix] = compact.names[index]!;
    const path = `${basePath}/names/${String(index)}`;
    const previous = values[index - 1] ?? '';
    const previousCodePoints = [...previous];
    if (prefixLength > previousCodePoints.length) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          `${path}/0`,
          'Compact name prefix length exceeds the prior decoded name.',
        ),
      );
    }
    const value = `${previousCodePoints.slice(0, prefixLength).join('')}${suffix}`;
    values.push(value);
    if (!containsOnlyUnicodeScalarValues(value)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          path,
          'Decoded compact names must contain only Unicode scalar values.',
        ),
      );
    }
    if ([...value].length > STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          path,
          `Decoded compact Instance.Name exceeds ${STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS} Unicode scalar values.`,
        ),
      );
    }
    if (prefixLength !== commonCodePointPrefixLength(previous, value)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          `${path}/0`,
          'Compact names must use the exact longest Unicode code-point prefix.',
        ),
      );
    }
    if (index > 0 && compareCodePoints(previous, value) >= 0) {
      diagnostics.push(
        studioDiagnostic(
          'studio.response_invalid',
          path,
          'Decoded compact names must be strictly sorted and unique.',
        ),
      );
    }
  }
  return { values, diagnostics };
}

interface DecodedStateHashes {
  readonly values: readonly string[];
  readonly diagnostics: readonly StudioDiagnostic[];
}

function decodeStateHashes(
  compact: Readonly<StudioCompactSnapshot>,
  basePath: string,
): DecodedStateHashes {
  const path = `${basePath}/stateHashesZ85`;
  if (compact.stateHashesZ85.length !== compact.nodes.length * 40) {
    return {
      values: [],
      diagnostics: [
        studioDiagnostic(
          'studio.response_invalid',
          path,
          'Packed compact state hashes must contain exactly 40 Z85 characters per node.',
        ),
      ],
    };
  }
  const bytes: number[] = [];
  for (let offset = 0; offset < compact.stateHashesZ85.length; offset += 5) {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const digit = Z85_INDEX.get(compact.stateHashesZ85[offset + index]!);
      if (digit === undefined) {
        return {
          values: [],
          diagnostics: [
            studioDiagnostic(
              'studio.response_invalid',
              path,
              'Packed compact state hashes contain a character outside the Z85 alphabet.',
            ),
          ],
        };
      }
      value = value * 85 + digit;
    }
    if (value > 0xffff_ffff) {
      return {
        values: [],
        diagnostics: [
          studioDiagnostic(
            'studio.response_invalid',
            path,
            'Packed compact state hashes contain a noncanonical Z85 group.',
          ),
        ],
      };
    }
    bytes.push(
      Math.floor(value / 0x1_00_00_00) % 256,
      Math.floor(value / 0x1_00_00) % 256,
      Math.floor(value / 0x1_00) % 256,
      value % 256,
    );
  }
  const values: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32) {
    values.push(
      bytes
        .slice(offset, offset + 32)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    );
  }
  return { values, diagnostics: [] };
}

type CompactDictionaryName =
  | 'idTokens'
  | 'names'
  | 'entityKinds'
  | 'sourceHashes'
  | 'numbers'
  | 'materials'
  | 'shapes'
  | 'unmanagedClasses';

interface CompactDictionaryUsage {
  readonly idTokens: Set<number>;
  readonly names: Set<number>;
  readonly entityKinds: Set<number>;
  readonly sourceHashes: Set<number>;
  readonly numbers: Set<number>;
  readonly materials: Set<number>;
  readonly shapes: Set<number>;
  readonly unmanagedClasses: Set<number>;
}

function compactUsage(): CompactDictionaryUsage {
  return {
    idTokens: new Set<number>(),
    names: new Set<number>(),
    entityKinds: new Set<number>(),
    sourceHashes: new Set<number>(),
    numbers: new Set<number>(),
    materials: new Set<number>(),
    shapes: new Set<number>(),
    unmanagedClasses: new Set<number>(),
  };
}

function dictionaryDiagnostics(
  values: readonly string[] | readonly number[],
  path: string,
): StudioDiagnostic[] {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (typeof value === 'number' && Object.is(value, -0)) {
      return [
        studioDiagnostic(
          'studio.response_invalid',
          `${path}/${String(index)}`,
          'Compact snapshot number dictionaries must normalize negative zero.',
        ),
      ];
    }
    if (index === 0) continue;
    const previous = values[index - 1]!;
    const order =
      typeof value === 'string' && typeof previous === 'string'
        ? compareCodePoints(previous, value)
        : (previous as number) < (value as number)
          ? -1
          : (previous as number) === (value as number)
            ? 0
            : 1;
    if (order >= 0) {
      return [
        studioDiagnostic(
          'studio.response_invalid',
          `${path}/${String(index)}`,
          'Compact snapshot dictionaries must be strictly sorted and unique.',
        ),
      ];
    }
  }
  return [];
}

function compactIndex(
  index: number,
  values: readonly unknown[],
  usage: Set<number>,
  path: string,
  diagnostics: StudioDiagnostic[],
): boolean {
  if (index < 0 || index >= values.length) {
    diagnostics.push(
      studioDiagnostic(
        'studio.response_invalid',
        path,
        'Compact snapshot dictionary index is out of range.',
      ),
    );
    return false;
  }
  usage.add(index);
  return true;
}

function optionalCompactIndex(
  index: number,
  values: readonly unknown[],
  usage: Set<number>,
  path: string,
  diagnostics: StudioDiagnostic[],
): boolean {
  return index === -1 || compactIndex(index, values, usage, path, diagnostics);
}

function unusedDictionaryDiagnostics(
  compact: Readonly<StudioCompactSnapshot>,
  usage: Readonly<CompactDictionaryUsage>,
  basePath: string,
): StudioDiagnostic[] {
  for (const name of [
    'idTokens',
    'names',
    'entityKinds',
    'sourceHashes',
    'numbers',
    'materials',
    'shapes',
    'unmanagedClasses',
  ] as const satisfies readonly CompactDictionaryName[]) {
    const values = compact[name];
    if (values.length !== usage[name].size) {
      return [
        studioDiagnostic(
          'studio.response_invalid',
          `${basePath}/${name}`,
          'Compact snapshot dictionaries may contain only referenced values.',
        ),
      ];
    }
  }
  return [];
}

function compactTuple(node: StudioCompactSnapshot['nodes'][number]): readonly unknown[] {
  return node;
}

function compactNodeIds(compact: Readonly<StudioCompactSnapshot>): string[] {
  return compact.nodes.map((node) =>
    node[0].map((tokenIndex) => compact.idTokens[tokenIndex]!).join('-'),
  );
}

function decodeCompactManagedNodes(
  compact: Readonly<StudioCompactSnapshot>,
  names: readonly string[],
  nodeIds: readonly string[],
): RobloxManagedNode[] {
  return compact.nodes.map((node, nodeIndex) => {
    const tuple = compactTuple(node);
    const id = nodeIds[nodeIndex]!;
    const parentIndex = tuple[1] as number;
    const className = COMPACT_CLASS_NAMES[tuple[2] as number]!;
    const entityKind = compact.entityKinds[tuple[4] as number]!;
    const sourceHashIndex = tuple[5] as number;
    const common = {
      id,
      entityKind,
      name: names[tuple[3] as number]!,
      ...(parentIndex === -1 ? {} : { parentId: nodeIds[parentIndex]! }),
      attributes: {
        WorldwrightManaged: true as const,
        WorldwrightProjectId: compact.projectId,
        WorldwrightEntityId: id,
        WorldwrightEntityKind: entityKind,
        WorldwrightCompilerVersion: ROBLOX_COMPILER_VERSION,
        ...(sourceHashIndex === -1
          ? {}
          : { WorldwrightSourceHash: compact.sourceHashes[sourceHashIndex]! }),
      },
    };
    if (className === 'Folder') {
      return { ...common, className: 'Folder', properties: {} };
    }
    if (className === 'Model') {
      return { ...common, className: 'Model', properties: {} };
    }
    const value = (tupleIndex: number): number => compact.numbers[tuple[tupleIndex] as number]!;
    const flags = tuple[20] as number;
    const primitiveProperties = {
      position: { x: value(6), y: value(7), z: value(8) },
      rotationEulerDegreesXYZ: { x: value(9), y: value(10), z: value(11) },
      size: { x: value(12), y: value(13), z: value(14) },
      anchored: true as const,
      material: compact.materials[tuple[15] as number]!,
      color: { r: value(16), g: value(17), b: value(18) },
      transparency: value(19),
      canCollide: (flags & 2) !== 0,
      canQuery: (flags & 4) !== 0,
      canTouch: (flags & 8) !== 0,
      castShadow: (flags & 16) !== 0,
    };
    if (className === 'Part') {
      return {
        ...common,
        className,
        properties: {
          ...primitiveProperties,
          shape: compact.shapes[tuple[21] as number]!,
        },
      };
    }
    if (className === 'WedgePart') {
      return { ...common, className: 'WedgePart', properties: primitiveProperties };
    }
    return { ...common, className: 'CornerWedgePart', properties: primitiveProperties };
  });
}

export function compactSnapshotSemanticDiagnostics(
  compact: Readonly<StudioCompactSnapshot>,
  basePath = '/compactSnapshot',
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  const usage = compactUsage();
  const decodedNames = decodeCompactNames(compact, basePath);
  const names = decodedNames.values;
  diagnostics.push(...decodedNames.diagnostics);
  for (const name of [
    'idTokens',
    'entityKinds',
    'sourceHashes',
    'materials',
    'shapes',
    'unmanagedClasses',
  ] as const) {
    diagnostics.push(...dictionaryDiagnostics(compact[name], `${basePath}/${name}`));
  }
  diagnostics.push(...dictionaryDiagnostics(compact.numbers, `${basePath}/numbers`));

  const nodeIds: Array<string | undefined> = [];
  for (let nodeIndex = 0; nodeIndex < compact.nodes.length; nodeIndex += 1) {
    const tuple = compactTuple(compact.nodes[nodeIndex]!);
    const nodePath = `${basePath}/nodes/${String(nodeIndex)}`;
    const tokenIndices = tuple[0] as readonly number[];
    const tokens: string[] = [];
    let validTokens = true;
    for (let tokenIndex = 0; tokenIndex < tokenIndices.length; tokenIndex += 1) {
      const dictionaryIndex = tokenIndices[tokenIndex]!;
      if (
        !compactIndex(
          dictionaryIndex,
          compact.idTokens,
          usage.idTokens,
          `${nodePath}/0/${String(tokenIndex)}`,
          diagnostics,
        )
      ) {
        validTokens = false;
      } else {
        tokens.push(compact.idTokens[dictionaryIndex]!);
      }
    }
    if (validTokens) {
      const entityId = tokens.join('-');
      nodeIds.push(entityId);
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(entityId) || entityId.length > 128) {
        diagnostics.push(
          studioDiagnostic(
            'studio.identity_invalid',
            `${nodePath}/0`,
            'Compact snapshot ID tokens do not reconstruct a valid managed entity ID.',
          ),
        );
      }
      const previousId = nodeIds[nodeIndex - 1];
      if (previousId !== undefined && compareCodePoints(previousId, entityId) >= 0) {
        diagnostics.push(
          studioDiagnostic(
            'studio.identity_invalid',
            `${nodePath}/0`,
            'Compact snapshot nodes must be strictly sorted by unique entity ID.',
          ),
        );
      }
    } else {
      nodeIds.push(undefined);
    }

    compactIndex(tuple[3] as number, names, usage.names, `${nodePath}/3`, diagnostics);
    compactIndex(
      tuple[4] as number,
      compact.entityKinds,
      usage.entityKinds,
      `${nodePath}/4`,
      diagnostics,
    );
    optionalCompactIndex(
      tuple[5] as number,
      compact.sourceHashes,
      usage.sourceHashes,
      `${nodePath}/5`,
      diagnostics,
    );

    if (tuple.length === 6) continue;
    for (let tupleIndex = 6; tupleIndex <= 14; tupleIndex += 1) {
      compactIndex(
        tuple[tupleIndex] as number,
        compact.numbers,
        usage.numbers,
        `${nodePath}/${String(tupleIndex)}`,
        diagnostics,
      );
    }
    compactIndex(
      tuple[15] as number,
      compact.materials,
      usage.materials,
      `${nodePath}/15`,
      diagnostics,
    );
    for (let tupleIndex = 16; tupleIndex <= 19; tupleIndex += 1) {
      compactIndex(
        tuple[tupleIndex] as number,
        compact.numbers,
        usage.numbers,
        `${nodePath}/${String(tupleIndex)}`,
        diagnostics,
      );
    }
    const flags = tuple[20] as number;
    if ((flags & 1) === 0) {
      diagnostics.push(
        studioDiagnostic(
          'studio.property_invalid',
          `${nodePath}/20`,
          'Compact managed primitives must remain anchored.',
        ),
      );
    }
    if ((tuple[2] as number) === 2) {
      compactIndex(
        tuple[21] as number,
        compact.shapes,
        usage.shapes,
        `${nodePath}/21`,
        diagnostics,
      );
    }

    const numberAt = (tupleIndex: number): number | undefined => {
      const dictionaryIndex = tuple[tupleIndex] as number;
      return dictionaryIndex >= 0 && dictionaryIndex < compact.numbers.length
        ? compact.numbers[dictionaryIndex]
        : undefined;
    };
    for (let tupleIndex = 12; tupleIndex <= 14; tupleIndex += 1) {
      const size = numberAt(tupleIndex);
      if (size !== undefined && size <= 0) {
        diagnostics.push(
          studioDiagnostic(
            'studio.property_invalid',
            `${nodePath}/${String(tupleIndex)}`,
            'Compact managed primitive sizes must be positive.',
          ),
        );
      }
    }
    for (let tupleIndex = 16; tupleIndex <= 18; tupleIndex += 1) {
      const color = numberAt(tupleIndex);
      if (color !== undefined && (!Number.isInteger(color) || color < 0 || color > 255)) {
        diagnostics.push(
          studioDiagnostic(
            'studio.property_invalid',
            `${nodePath}/${String(tupleIndex)}`,
            'Compact managed primitive colors must be integer RGB channels.',
          ),
        );
      }
    }
    const transparency = numberAt(19);
    if (transparency !== undefined && (transparency < 0 || transparency > 1)) {
      diagnostics.push(
        studioDiagnostic(
          'studio.property_invalid',
          `${nodePath}/19`,
          'Compact managed primitive transparency must be between zero and one.',
        ),
      );
    }
  }

  const rootIndices: number[] = [];
  for (let nodeIndex = 0; nodeIndex < compact.nodes.length; nodeIndex += 1) {
    const tuple = compactTuple(compact.nodes[nodeIndex]!);
    const parentIndex = tuple[1] as number;
    const nodePath = `${basePath}/nodes/${String(nodeIndex)}`;
    if (parentIndex === -1) {
      rootIndices.push(nodeIndex);
      continue;
    }
    if (parentIndex < 0 || parentIndex >= compact.nodes.length) {
      diagnostics.push(
        studioDiagnostic(
          'studio.hierarchy_invalid',
          `${nodePath}/1`,
          'Compact managed parent index is out of range.',
        ),
      );
      continue;
    }
    const parentClassCode = compactTuple(compact.nodes[parentIndex]!)[2] as number;
    if (parentClassCode !== 0 && parentClassCode !== 1) {
      diagnostics.push(
        studioDiagnostic(
          'studio.hierarchy_invalid',
          `${nodePath}/1`,
          'Compact managed parents must be Folder or Model nodes.',
        ),
      );
    }
  }
  if (compact.nodes.length > 0 && rootIndices.length !== 1) {
    diagnostics.push(
      studioDiagnostic(
        'studio.root_invalid',
        `${basePath}/nodes`,
        'A non-empty compact managed project must contain exactly one Workspace root.',
      ),
    );
  }
  const rootIndex = rootIndices[0];
  if (rootIndex !== undefined) {
    const root = compactTuple(compact.nodes[rootIndex]!);
    const rootClassCode = root[2] as number;
    const entityKindIndex = root[4] as number;
    const rootKind = compact.entityKinds[entityKindIndex];
    if (rootClassCode !== 0 && rootClassCode !== 1) {
      diagnostics.push(
        studioDiagnostic(
          'studio.root_invalid',
          `${basePath}/nodes/${String(rootIndex)}/2`,
          'The compact managed root must be a Folder or Model.',
        ),
      );
    }
    if (rootKind !== undefined && rootKind !== 'world') {
      diagnostics.push(
        studioDiagnostic(
          'studio.root_invalid',
          `${basePath}/nodes/${String(rootIndex)}/4`,
          'The compact managed root must retain entity kind world.',
        ),
      );
    }
    if ((root[5] as number) === -1) {
      diagnostics.push(
        studioDiagnostic(
          'studio.identity_invalid',
          `${basePath}/nodes/${String(rootIndex)}/5`,
          'The compact managed root must carry source-hash metadata.',
        ),
      );
    }
  }
  for (let nodeIndex = 0; nodeIndex < compact.nodes.length; nodeIndex += 1) {
    const tuple = compactTuple(compact.nodes[nodeIndex]!);
    if (nodeIndex !== rootIndex && (tuple[5] as number) !== -1) {
      diagnostics.push(
        studioDiagnostic(
          'studio.identity_invalid',
          `${basePath}/nodes/${String(nodeIndex)}/5`,
          'Compact source-hash metadata is allowed only on the managed root.',
        ),
      );
    }
    const visited = new Set<number>();
    let currentIndex = nodeIndex;
    while (currentIndex !== -1 && currentIndex < compact.nodes.length) {
      if (visited.has(currentIndex)) {
        diagnostics.push(
          studioDiagnostic(
            'studio.hierarchy_invalid',
            `${basePath}/nodes/${String(nodeIndex)}/1`,
            'Compact managed parent references must be acyclic.',
          ),
        );
        break;
      }
      visited.add(currentIndex);
      currentIndex = compactTuple(compact.nodes[currentIndex]!)[1] as number;
      if (currentIndex < -1) break;
    }
  }

  let previousUnmanaged:
    | {
        readonly parentId: string;
        readonly className: string;
        readonly name: string;
        readonly ordinal: number;
      }
    | undefined;
  const unmanagedKeys = new Set<string>();
  for (let index = 0; index < compact.unmanagedRoots.length; index += 1) {
    const tuple = compact.unmanagedRoots[index]!;
    const rootPath = `${basePath}/unmanagedRoots/${String(index)}`;
    const parentIndex = tuple[0];
    const validParent = parentIndex >= 0 && parentIndex < compact.nodes.length;
    if (!validParent) {
      diagnostics.push(
        studioDiagnostic(
          'studio.hierarchy_invalid',
          `${rootPath}/0`,
          'Compact unmanaged-root parent index is out of range.',
        ),
      );
    }
    const validClass = compactIndex(
      tuple[1],
      compact.unmanagedClasses,
      usage.unmanagedClasses,
      `${rootPath}/1`,
      diagnostics,
    );
    const validName = compactIndex(tuple[2], names, usage.names, `${rootPath}/2`, diagnostics);
    if (validParent && validClass && validName) {
      const parentId = nodeIds[parentIndex];
      const className = compact.unmanagedClasses[tuple[1]]!;
      const name = names[tuple[2]]!;
      if (parentId !== undefined) {
        const order =
          previousUnmanaged === undefined
            ? -1
            : compareCodePoints(previousUnmanaged.parentId, parentId) ||
              compareCodePoints(previousUnmanaged.className, className) ||
              compareCodePoints(previousUnmanaged.name, name) ||
              previousUnmanaged.ordinal - tuple[3];
        if (order >= 0) {
          diagnostics.push(
            studioDiagnostic(
              'studio.identity_invalid',
              rootPath,
              'Compact unmanaged roots must use canonical parent, class, name, and ordinal order.',
            ),
          );
        }
        const sameGroup =
          previousUnmanaged !== undefined &&
          previousUnmanaged.parentId === parentId &&
          previousUnmanaged.className === className &&
          previousUnmanaged.name === name;
        const expectedOrdinal =
          sameGroup && previousUnmanaged !== undefined ? previousUnmanaged.ordinal + 1 : 1;
        if (tuple[3] !== expectedOrdinal) {
          diagnostics.push(
            studioDiagnostic(
              'studio.identity_invalid',
              `${rootPath}/3`,
              'Compact unmanaged ordinals must be consecutive within each parent, class, and name group.',
            ),
          );
        }
        previousUnmanaged = { parentId, className, name, ordinal: tuple[3] };
        const identityKey = `${parentId}\u0000${className}\u0000${name}\u0000${String(tuple[3])}`;
        if (unmanagedKeys.has(identityKey)) {
          diagnostics.push(
            studioDiagnostic(
              'studio.identity_invalid',
              rootPath,
              'Compact unmanaged structural descriptors must be unique.',
            ),
          );
        }
        unmanagedKeys.add(identityKey);
        const structuralPath = `${parentId}/${className}/${name}/${String(tuple[3])}`;
        if (structuralPath.length > 2048) {
          diagnostics.push(
            studioDiagnostic(
              'studio.response_invalid',
              rootPath,
              'Decoded unmanaged structural path exceeds its length limit.',
            ),
          );
        }
      }
    }
  }
  diagnostics.push(...unusedDictionaryDiagnostics(compact, usage, basePath));
  const decodedStateHashes = decodeStateHashes(compact, basePath);
  diagnostics.push(...decodedStateHashes.diagnostics);
  if (
    diagnostics.length === 0 &&
    nodeIds.every((nodeId): nodeId is string => nodeId !== undefined)
  ) {
    const nodes = decodeCompactManagedNodes(compact, names, nodeIds);
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      if (decodedStateHashes.values[index] !== hashStudioManagedNodeState(node)) {
        diagnostics.push(
          studioDiagnostic(
            'studio.adapter_metadata_invalid',
            `${basePath}/stateHashesZ85`,
            'Packed stored-state hash does not match the reconstructed canonical managed node.',
            { relatedId: node.id },
          ),
        );
      }
    }
  }
  return diagnostics;
}

function validateSnapshotCandidate(candidate: unknown): RobloxSnapshot {
  const validation = validateRobloxSnapshot(candidate);
  if (!validation.valid) {
    throw new StudioAdapterError(
      validation.diagnostics.map((entry) =>
        studioDiagnostic(
          entry.code.includes('unmanaged')
            ? 'studio.unmanaged_content_protected'
            : 'studio.snapshot_invalid',
          entry.path,
          `${entry.code}: ${entry.message}`,
          entry.relatedId === undefined ? {} : { relatedId: entry.relatedId },
        ),
      ),
    );
  }
  return structuredClone(normalizeRobloxSnapshot(validation.value));
}

export function snapshotFromStudioCompact(
  compact: Readonly<StudioCompactSnapshot>,
  expectedProjectId: string,
): RobloxSnapshot {
  if (compact.projectId !== expectedProjectId) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.project_mismatch',
        '/projectId',
        'Studio snapshot project does not match the requested project.',
        { relatedId: expectedProjectId },
      ),
    ]);
  }
  const compactDiagnostics = compactSnapshotSemanticDiagnostics(compact, '');
  if (compactDiagnostics.length > 0) throw new StudioAdapterError(compactDiagnostics);

  const names = decodeCompactNames(compact, '').values;
  const nodeIds = compactNodeIds(compact);
  const nodes = decodeCompactManagedNodes(compact, names, nodeIds);
  const rootIndex = compact.nodes.findIndex((node) => node[1] === -1);
  const unmanagedRoots = compact.unmanagedRoots.map((entry) => {
    const parentEntityId = nodeIds[entry[0]]!;
    const className = compact.unmanagedClasses[entry[1]]!;
    const name = names[entry[2]]!;
    const ordinal = entry[3];
    return deriveUnmanagedRoot({
      parentEntityId,
      className,
      name,
      structuralPath: `${parentEntityId}/${className}/${name}/${String(ordinal)}`,
      ordinal,
    });
  });
  return validateSnapshotCandidate({
    schemaVersion: '0.1.0',
    projectId: compact.projectId,
    target: { service: 'Workspace' },
    ...(rootIndex === -1 ? {} : { rootNodeId: nodeIds[rootIndex] }),
    nodes,
    unmanagedRoots,
  });
}

export function snapshotFromStudioRaw(
  raw: Readonly<StudioRawSnapshot>,
  expectedProjectId: string,
): RobloxSnapshot {
  if (raw.projectId !== expectedProjectId) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.project_mismatch',
        '/projectId',
        'Studio snapshot project does not match the requested project.',
        { relatedId: expectedProjectId },
      ),
    ]);
  }
  if (raw.nodes.length > STUDIO_MCP_MAX_MANAGED_NODES) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.node_limit_exceeded',
        '/nodes',
        `Studio snapshot exceeds ${STUDIO_MCP_MAX_MANAGED_NODES} managed nodes.`,
      ),
    ]);
  }

  for (const [path, name] of [
    ...raw.nodes.map((node, index) => [`/nodes/${String(index)}/name`, node.name] as const),
    ...raw.unmanagedRoots.map(
      (root, index) => [`/unmanagedRoots/${String(index)}/name`, root.name] as const,
    ),
  ]) {
    if (
      !containsOnlyUnicodeScalarValues(name) ||
      [...name].length > STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS
    ) {
      throw new StudioAdapterError([
        studioDiagnostic(
          'studio.response_invalid',
          path,
          `Observed Instance.Name must contain at most ${STUDIO_MCP_MAX_INSTANCE_NAME_CODE_POINTS} Unicode scalar values.`,
        ),
      ]);
    }
  }

  const nodes: RobloxManagedNode[] = raw.nodes.map((node) => verifyStudioRawNode(node));
  const rootCandidates = nodes.filter((node) => node.parentId === undefined);
  if (nodes.length > 0 && rootCandidates.length !== 1) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.root_invalid',
        '/nodes',
        'A non-empty managed project must contain exactly one Workspace root.',
      ),
    ]);
  }
  const root = rootCandidates[0];
  if (
    root !== undefined &&
    (root.className !== 'Folder' || root.entityKind !== 'world') &&
    (root.className !== 'Model' || root.entityKind !== 'world')
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.root_invalid',
        `/nodes/${root.id}`,
        'The managed root must be a world Folder or Model directly under Workspace.',
        { relatedId: root.id },
      ),
    ]);
  }

  const candidate: unknown = {
    schemaVersion: '0.1.0',
    projectId: expectedProjectId,
    target: { service: 'Workspace' },
    ...(root === undefined ? {} : { rootNodeId: root.id }),
    nodes,
    unmanagedRoots: raw.unmanagedRoots.map((entry) => deriveUnmanagedRoot(entry)),
  };
  return validateSnapshotCandidate(candidate);
}
