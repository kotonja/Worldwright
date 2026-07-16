import type { RobloxManagedNode } from '@worldwright/roblox-compiler';

import { compareCodePoints } from '../src/diagnostics.js';
import { hashStudioManagedNodeState } from '../src/hashing.js';
import type {
  StudioCompactManagedNode,
  StudioCompactSnapshot,
  StudioRawUnmanagedRoot,
} from '../src/types.js';

const Z85_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';

function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...new Set([...values].map(canonicalNumber))].sort((left, right) => left - right);
}

function dictionaryIndexes<T extends string | number>(values: readonly T[]): Map<T, number> {
  return new Map(values.map((value, index) => [value, index]));
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

function frontCodeNames(values: readonly string[]): StudioCompactSnapshot['names'] {
  return values.map((value, index) => {
    const previous = values[index - 1] ?? '';
    const prefixLength = commonCodePointPrefixLength(previous, value);
    return [prefixLength, [...value].slice(prefixLength).join('')];
  });
}

function z85EncodeHash(hash: string): string {
  const bytes = hash.match(/../gu)!.map((pair) => Number.parseInt(pair, 16));
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let value =
      (((bytes[offset]! * 256 + bytes[offset + 1]!) * 256 + bytes[offset + 2]!) * 256 +
        bytes[offset + 3]!) >>>
      0;
    const characters = Array.from<string>({ length: 5 });
    for (let index = 4; index >= 0; index -= 1) {
      characters[index] = Z85_ALPHABET[value % 85]!;
      value = Math.floor(value / 85);
    }
    encoded += characters.join('');
  }
  return encoded;
}

function primitiveNumbers(node: Readonly<RobloxManagedNode>): readonly number[] {
  if (node.className === 'Folder' || node.className === 'Model') return [];
  return [
    node.properties.position.x,
    node.properties.position.y,
    node.properties.position.z,
    node.properties.rotationEulerDegreesXYZ.x,
    node.properties.rotationEulerDegreesXYZ.y,
    node.properties.rotationEulerDegreesXYZ.z,
    node.properties.size.x,
    node.properties.size.y,
    node.properties.size.z,
    node.properties.color.r,
    node.properties.color.g,
    node.properties.color.b,
    node.properties.transparency,
  ];
}

/** Builds deterministic compact bridge values for fixtures and fake-MCP tests only. */
export function compactSnapshotFixture(
  projectId: string,
  inputNodes: readonly RobloxManagedNode[],
  inputUnmanagedRoots: readonly StudioRawUnmanagedRoot[],
): StudioCompactSnapshot {
  const nodes = [...inputNodes].sort((left, right) => compareCodePoints(left.id, right.id));
  const unmanagedRoots = [...inputUnmanagedRoots].sort(
    (left, right) =>
      compareCodePoints(left.parentEntityId, right.parentEntityId) ||
      compareCodePoints(left.className, right.className) ||
      compareCodePoints(left.name, right.name) ||
      left.ordinal - right.ordinal,
  );
  const idTokens = sortedStrings(nodes.flatMap((node) => node.id.split('-')));
  const nameValues = sortedStrings([
    ...nodes.map((node) => node.name),
    ...unmanagedRoots.map((entry) => entry.name),
  ]);
  const names = frontCodeNames(nameValues);
  const entityKinds = sortedStrings(nodes.map((node) => node.entityKind)) as Array<
    RobloxManagedNode['entityKind']
  >;
  const sourceHashes = sortedStrings(
    nodes.flatMap((node) =>
      node.attributes.WorldwrightSourceHash === undefined
        ? []
        : [node.attributes.WorldwrightSourceHash],
    ),
  );
  const numbers = sortedNumbers(nodes.flatMap((node) => primitiveNumbers(node)));
  const materials = sortedStrings(
    nodes.flatMap((node) =>
      node.className === 'Folder' || node.className === 'Model' ? [] : [node.properties.material],
    ),
  ) as StudioCompactSnapshot['materials'];
  const shapes = sortedStrings(
    nodes.flatMap((node) => (node.className === 'Part' ? [node.properties.shape] : [])),
  ) as StudioCompactSnapshot['shapes'];
  const unmanagedClasses = sortedStrings(unmanagedRoots.map((entry) => entry.className));

  const idTokenIndex = dictionaryIndexes(idTokens);
  const nameIndex = dictionaryIndexes(nameValues);
  const entityKindIndex = dictionaryIndexes(entityKinds);
  const sourceHashIndex = dictionaryIndexes(sourceHashes);
  const numberIndex = dictionaryIndexes(numbers);
  const materialIndex = dictionaryIndexes(materials);
  const shapeIndex = dictionaryIndexes(shapes);
  const unmanagedClassIndex = dictionaryIndexes(unmanagedClasses);
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const number = (value: number): number => numberIndex.get(canonicalNumber(value))!;

  const compactNodes: StudioCompactManagedNode[] = nodes.map((node) => {
    const header = [
      node.id.split('-').map((token) => idTokenIndex.get(token)!),
      node.parentId === undefined ? -1 : nodeIndex.get(node.parentId)!,
      node.name,
      node.entityKind,
      node.attributes.WorldwrightSourceHash,
    ] as const;
    const base = [
      header[0],
      header[1],
      nameIndex.get(header[2])!,
      entityKindIndex.get(header[3])!,
      header[4] === undefined ? -1 : sourceHashIndex.get(header[4])!,
    ] as const;
    switch (node.className) {
      case 'Folder':
        return [base[0], base[1], 0, base[2], base[3], base[4]];
      case 'Model':
        return [base[0], base[1], 1, base[2], base[3], base[4]];
      case 'Part':
      case 'WedgePart':
      case 'CornerWedgePart': {
        const flags =
          (node.properties.anchored ? 1 : 0) |
          (node.properties.canCollide ? 2 : 0) |
          (node.properties.canQuery ? 4 : 0) |
          (node.properties.canTouch ? 8 : 0) |
          (node.properties.castShadow ? 16 : 0);
        const tail = [
          number(node.properties.position.x),
          number(node.properties.position.y),
          number(node.properties.position.z),
          number(node.properties.rotationEulerDegreesXYZ.x),
          number(node.properties.rotationEulerDegreesXYZ.y),
          number(node.properties.rotationEulerDegreesXYZ.z),
          number(node.properties.size.x),
          number(node.properties.size.y),
          number(node.properties.size.z),
          materialIndex.get(node.properties.material)!,
          number(node.properties.color.r),
          number(node.properties.color.g),
          number(node.properties.color.b),
          number(node.properties.transparency),
          flags,
        ] as const;
        const classCode = node.className === 'Part' ? 2 : node.className === 'WedgePart' ? 3 : 4;
        const compactShape =
          node.className === 'Part' ? shapeIndex.get(node.properties.shape)! : -1;
        return [
          base[0],
          base[1],
          classCode,
          base[2],
          base[3],
          base[4],
          ...tail,
          compactShape,
        ] as StudioCompactManagedNode;
      }
    }
  });

  return {
    projectId,
    idTokens,
    names,
    entityKinds,
    sourceHashes,
    numbers,
    materials,
    shapes,
    nodes: compactNodes,
    unmanagedClasses,
    unmanagedRoots: unmanagedRoots.map((entry) => [
      nodeIndex.get(entry.parentEntityId)!,
      unmanagedClassIndex.get(entry.className)!,
      nameIndex.get(entry.name)!,
      entry.ordinal,
    ]),
    stateHashesZ85: nodes.map((node) => z85EncodeHash(hashStudioManagedNodeState(node))).join(''),
  };
}
