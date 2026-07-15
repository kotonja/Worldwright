import { describe, expect, it } from 'vitest';

import { evaluateArchitecturePlan } from '../src/plan-evaluation.js';
import { planArchitectureWorldSpec } from '../src/planner.js';
import { extractArchitectureSourceProfile } from '../src/source-profile.js';
import { ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES } from '../src/index.js';
import {
  ARCHITECTURE_MAX_WINDOWS_PER_ROOM,
  type ArchitectureBuildingDirective,
} from '../src/entity-directive-schema.js';
import { clone, entityById, loadMansionProgram } from './helpers.js';

function diagnosticCodes(input: unknown): readonly string[] {
  return extractArchitectureSourceProfile(input).diagnostics.map((entry) => entry.code);
}

function attributes(source: ReturnType<typeof loadMansionProgram>, id: string) {
  return entityById(source, id).attributes;
}

describe('supported architectural source profile', () => {
  it('extracts the checked-in two-floor mansion program deterministically', () => {
    const source = loadMansionProgram();
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    if (!result.valid) return;
    expect(result.value.buildingEntity.id).toBe('mansion-cliffwatch');
    expect(result.value.floors.map((floor) => [floor.entity.id, floor.rooms.length])).toEqual([
      ['floor-ground', 7],
      ['floor-upper', 6],
    ]);
    expect(result.value.stair?.entity.id).toBe('stair-main');
    expect(result.value.adjacencies).toHaveLength(8);
    expect(result.value.floors[0]?.rooms.map((room) => room.entity.id)).toEqual(
      [...(result.value.floors[0]?.rooms ?? [])].map((room) => room.entity.id).sort(),
    );
  });

  it('does not mutate source input and returns an independent normalized source', () => {
    const source = loadMansionProgram();
    source.entities.reverse();
    const before = JSON.stringify(source);
    const result = extractArchitectureSourceProfile(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.source).not.toBe(source);
      expect(result.value.source.entities.map((entity) => entity.id)).toEqual(
        [...result.value.source.entities.map((entity) => entity.id)].sort(),
      );
    }
  });

  it('requires exactly one building directive', () => {
    const missing = loadMansionProgram();
    delete attributes(missing, 'mansion-cliffwatch')['worldwright.architecture'];
    expect(diagnosticCodes(missing)).toContain('architecture.directive_missing');

    const duplicate = loadMansionProgram();
    attributes(duplicate, 'floor-ground')['worldwright.architecture'] = clone(
      attributes(duplicate, 'mansion-cliffwatch')[
        'worldwright.architecture'
      ] as ArchitectureBuildingDirective,
    );
    expect(diagnosticCodes(duplicate)).toContain('architecture.multiple_buildings');
  });

  it('rejects non-contiguous and duplicate floor levels', () => {
    const nonContiguous = loadMansionProgram();
    const upper = attributes(nonContiguous, 'floor-upper')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    upper.level = 2;
    expect(diagnosticCodes(nonContiguous)).toContain('architecture.floor_invalid');

    const duplicate = loadMansionProgram();
    const duplicateUpper = attributes(duplicate, 'floor-upper')[
      'worldwright.architecture'
    ] as Record<string, unknown>;
    duplicateUpper.level = 0;
    expect(diagnosticCodes(duplicate)).toContain('architecture.floor_invalid');
  });

  it('always rejects floor clear height below the default door', () => {
    const source = loadMansionProgram();
    const floor = attributes(source, 'floor-ground')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    floor.clearHeight = 8;
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.opening_infeasible',
        path: expect.stringMatching(/clearHeight$/u),
        relatedId: 'floor-ground',
      }),
    );
  });

  it('allows a low floor with no requested windows and warns for preferred-only windows', () => {
    const noWindows = loadMansionProgram();
    const upperFloor = attributes(noWindows, 'floor-upper')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    upperFloor.clearHeight = 9;
    for (const entity of noWindows.entities.filter(
      (candidate) => candidate.parentId === 'floor-upper' && candidate.kind === 'room',
    )) {
      const directive = attributes(noWindows, entity.id)['worldwright.architecture'] as Record<
        string,
        unknown
      >;
      directive.windows = { minimum: 0, preferred: 0 };
    }
    expect(planArchitectureWorldSpec(noWindows).success).toBe(true);

    const preferredOnly = clone(noWindows);
    for (const entity of preferredOnly.entities.filter(
      (candidate) => candidate.parentId === 'floor-upper' && candidate.kind === 'room',
    )) {
      const directive = attributes(preferredOnly, entity.id)['worldwright.architecture'] as Record<
        string,
        unknown
      >;
      directive.windows = { minimum: 0, preferred: 1 };
    }
    const result = planArchitectureWorldSpec(preferredOnly);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'architecture.preference_unsatisfied' }),
    );
    expect(
      result.plan.openings.filter(
        (opening) => opening.floorId === 'floor-upper' && opening.type === 'window',
      ),
    ).toHaveLength(0);
    expect(result.plan.score.preferredWindows).toBe(6);
  });

  it('rejects a required window that cannot fit below the floor clear height', () => {
    const source = loadMansionProgram();
    const upperFloor = attributes(source, 'floor-upper')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    upperFloor.clearHeight = 9;
    for (const entity of source.entities.filter(
      (candidate) => candidate.parentId === 'floor-upper' && candidate.kind === 'room',
    )) {
      const directive = attributes(source, entity.id)['worldwright.architecture'] as Record<
        string,
        unknown
      >;
      directive.windows = { minimum: 0, preferred: 0 };
    }
    const primary = attributes(source, 'primary-bedroom')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    primary.windows = { minimum: 1, preferred: 1 };

    const result = extractArchitectureSourceProfile(source);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.opening_infeasible',
        path: expect.stringMatching(/clearHeight$/u),
        relatedId: 'floor-upper',
      }),
    );
  });

  it('rejects a corridor cross-span that leaves fewer than two room-band grid cells', () => {
    const source = loadMansionProgram();
    const building = attributes(source, 'mansion-cliffwatch')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    building.corridorAxis = 'x';
    building.corridorWidth = 83;

    const result = extractArchitectureSourceProfile(source);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.directive_invalid',
        path: expect.stringMatching(/corridorWidth$/u),
      }),
    );
  });

  it('requires planned floors to remain direct structure children', () => {
    const source = loadMansionProgram();
    entityById(source, 'floor-upper').parentId = 'parcel-cliffwatch';
    expect(diagnosticCodes(source)).toContain('architecture.directive_invalid');
  });

  it('enforces bounded floor and room counts', () => {
    const tooFewRooms = loadMansionProgram();
    for (const roomId of [
      'east-bedroom',
      'guest-sitting-room',
      'primary-bath',
      'primary-bedroom',
      'upper-study',
    ]) {
      entityById(tooFewRooms, roomId).parentId = 'floor-ground';
    }
    expect(diagnosticCodes(tooFewRooms)).toContain('architecture.floor_invalid');

    const tooManyFloors = loadMansionProgram();
    for (const suffix of ['third', 'fourth']) {
      const floor = clone(entityById(tooManyFloors, 'floor-upper'));
      floor.id = `floor-${suffix}`;
      const directive = floor.attributes['worldwright.architecture'] as Record<string, unknown>;
      directive.level = 2;
      tooManyFloors.entities.push(floor);
      for (const roomSuffix of ['a', 'b']) {
        const room = clone(entityById(tooManyFloors, 'east-bedroom'));
        room.id = `room-${suffix}-${roomSuffix}`;
        room.parentId = floor.id;
        room.name = `${suffix} ${roomSuffix}`;
        tooManyFloors.entities.push(room);
      }
    }
    expect(diagnosticCodes(tooManyFloors)).toContain('architecture.capacity_exceeded');
  });

  it('requires one aligned stair route only for multi-floor programs', () => {
    const source = loadMansionProgram();
    source.entities = source.entities.filter((entity) => entity.id !== 'stair-main');
    expect(diagnosticCodes(source)).toContain('architecture.stair_required');
  });

  it('requires exactly one entrance on level zero', () => {
    const missing = loadMansionProgram();
    const foyer = attributes(missing, 'foyer-grand')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    foyer.isEntrance = false;
    expect(diagnosticCodes(missing)).toContain('architecture.room_invalid');

    const upperEntrance = loadMansionProgram();
    const upperFoyer = attributes(upperEntrance, 'foyer-grand')[
      'worldwright.architecture'
    ] as Record<string, unknown>;
    upperFoyer.isEntrance = false;
    const bedroom = attributes(upperEntrance, 'primary-bedroom')[
      'worldwright.architecture'
    ] as Record<string, unknown>;
    bedroom.isEntrance = true;
    expect(diagnosticCodes(upperEntrance)).toContain('architecture.room_invalid');
  });

  it('requires stair floor IDs to match exact level order', () => {
    const source = loadMansionProgram();
    const stair = attributes(source, 'stair-main')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    stair.floorIds = ['floor-upper', 'floor-ground'];
    expect(diagnosticCodes(source)).toContain('architecture.stair_infeasible');
  });

  it('reserves both deterministic landings when checking stair tread fit', () => {
    const source = loadMansionProgram();
    const stair = attributes(source, 'stair-main')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    stair.minimumTreadDepth = 1.1;
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.stair_infeasible',
        relatedId: 'stair-main',
        message:
          'A straight stair run cannot satisfy riser and tread limits after reserving both deterministic landings.',
      }),
    );
  });

  it('rejects stair and window requests beyond practical expansion caps', () => {
    const excessiveSteps = loadMansionProgram();
    const stair = attributes(excessiveSteps, 'stair-main')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    stair.maximumRiserHeight = 0.01;
    const stairResult = extractArchitectureSourceProfile(excessiveSteps);
    expect(stairResult.valid).toBe(false);
    expect(stairResult.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.capacity_exceeded',
        path: expect.stringMatching(/maximumRiserHeight$/u),
        relatedId: 'stair-main',
      }),
    );

    const excessiveWindows = loadMansionProgram();
    const foyer = attributes(excessiveWindows, 'foyer-grand')['worldwright.architecture'] as Record<
      string,
      unknown
    >;
    foyer.windows = { minimum: 0, preferred: ARCHITECTURE_MAX_WINDOWS_PER_ROOM + 1 };
    expect(diagnosticCodes(excessiveWindows)).toContain('architecture.directive_invalid');
  });

  it('accepts a one-floor program without stairs and rejects an unnecessary stair', () => {
    const source = loadMansionProgram();
    const upperIds = new Set(
      source.entities
        .filter((entity) => entity.id === 'floor-upper' || entity.parentId === 'floor-upper')
        .map((entity) => entity.id),
    );
    const oneFloor = clone(source);
    oneFloor.entities = oneFloor.entities.filter(
      (entity) => !upperIds.has(entity.id) && entity.id !== 'stair-main',
    );
    oneFloor.relationships = oneFloor.relationships.filter(
      (relationship) =>
        !upperIds.has(relationship.sourceId) && !upperIds.has(relationship.targetId),
    );
    expect(extractArchitectureSourceProfile(oneFloor).valid).toBe(true);

    const unnecessary = clone(source);
    unnecessary.entities = unnecessary.entities.filter((entity) => !upperIds.has(entity.id));
    unnecessary.relationships = unnecessary.relationships.filter(
      (relationship) =>
        !upperIds.has(relationship.sourceId) && !upperIds.has(relationship.targetId),
    );
    expect(diagnosticCodes(unnecessary)).toContain('architecture.profile_invalid');
  });

  it('rejects cross-floor door relationships and non-room endpoints', () => {
    const crossFloor = loadMansionProgram();
    const relationship = crossFloor.relationships.find(
      (entry) => entry.id === 'relationship-foyer-ballroom',
    )!;
    relationship.targetId = 'primary-bath';
    expect(diagnosticCodes(crossFloor)).toContain('architecture.relationship_invalid');

    const nonRoom = loadMansionProgram();
    const nonRoomRelationship = nonRoom.relationships.find(
      (entry) => entry.id === 'relationship-foyer-ballroom',
    )!;
    nonRoomRelationship.targetId = 'floor-ground';
    expect(diagnosticCodes(nonRoom)).toContain('architecture.relationship_invalid');
  });

  it('rejects directed architecture adjacency relationships', () => {
    const source = loadMansionProgram();
    const relationship = source.relationships.find(
      (entry) => entry.id === 'relationship-foyer-ballroom',
    )!;
    relationship.directed = true;
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.relationship_invalid',
        relatedId: relationship.id,
      }),
    );
  });

  it.each([
    ['required door', { requirement: 'required', connection: 'door', weight: 100 }],
    ['preferred near', { requirement: 'preferred', connection: 'near', weight: 25 }],
    ['avoid', { requirement: 'avoid', connection: 'none', weight: 100 }],
  ] as const)(
    'deterministically rejects a second %s directive for one unordered room pair',
    (_label, duplicateMode) => {
      const source = loadMansionProgram();
      const original = source.relationships.find(
        (entry) => entry.id === 'relationship-foyer-ballroom',
      )!;
      const duplicate = clone(original);
      duplicate.id = `relationship-foyer-ballroom-duplicate-${duplicateMode.connection}`;
      [duplicate.sourceId, duplicate.targetId] = [duplicate.targetId, duplicate.sourceId];
      duplicate.attributes['worldwright.architecture'] = {
        schemaVersion: '0.1.0',
        mode: 'adjacency',
        ...duplicateMode,
      };
      source.relationships.unshift(duplicate);
      const reordered = clone(source);
      reordered.relationships.reverse();

      const result = extractArchitectureSourceProfile(source);
      const reorderedResult = extractArchitectureSourceProfile(reordered);
      expect(result.valid).toBe(false);
      expect(reorderedResult).toEqual(result);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'architecture.relationship_invalid',
          relatedId: duplicate.id,
        }),
      );
      expect(planArchitectureWorldSpec(source).success).toBe(false);
    },
  );

  it('rejects more than 512 architecture relationship directives before parsing them', () => {
    expect(ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES).toBe(512);
    const source = loadMansionProgram();
    const template = source.relationships[0]!;
    for (
      let index = source.relationships.length;
      index <= ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES;
      index += 1
    ) {
      const relationship = clone(template);
      relationship.id = `relationship-cap-${String(index).padStart(3, '0')}`;
      relationship.attributes['worldwright.architecture'] = { malformed: true };
      source.relationships.push(relationship);
    }

    expect(extractArchitectureSourceProfile(source)).toEqual({
      valid: false,
      diagnostics: [
        expect.objectContaining({
          code: 'architecture.capacity_exceeded',
          path: '/relationships',
          message: `Planner v0.1 accepts at most ${ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES} architecture relationship directives.`,
        }),
      ],
    });
  });

  it('accepts the exact 512-directive bound with unique floor-local room pairs', () => {
    const source = loadMansionProgram();
    const roomIdsByFloor: string[][] = [];
    for (const [floorId, templateId, suffix] of [
      ['floor-ground', 'ballroom', 'ground'],
      ['floor-upper', 'primary-bedroom', 'upper'],
    ] as const) {
      const roomIds = source.entities
        .filter((entity) => entity.parentId === floorId)
        .map((entity) => entity.id);
      const template = entityById(source, templateId);
      for (let index = roomIds.length; index < 32; index += 1) {
        const room = clone(template);
        room.id = `relationship-bound-room-${suffix}-${String(index).padStart(2, '0')}`;
        room.name = `Relationship Bound ${suffix} ${String(index)}`;
        room.parentId = floorId;
        const directive = room.attributes['worldwright.architecture'] as Record<string, unknown>;
        directive.isEntrance = false;
        source.entities.push(room);
        roomIds.push(room.id);
      }
      roomIds.sort();
      roomIdsByFloor.push(roomIds);
    }

    source.relationships = [];
    let relationshipCount = 0;
    for (const roomIds of roomIdsByFloor) {
      for (let left = 0; left < roomIds.length && relationshipCount < 512; left += 1) {
        for (let right = left + 1; right < roomIds.length && relationshipCount < 512; right += 1) {
          const mode = relationshipCount % 3;
          source.relationships.push({
            id: `relationship-bound-${String(relationshipCount).padStart(3, '0')}`,
            type: 'adjacent_to',
            sourceId: roomIds[left]!,
            targetId: roomIds[right]!,
            directed: false,
            attributes: {
              'worldwright.architecture': {
                schemaVersion: '0.1.0',
                mode: 'adjacency',
                requirement: mode === 0 ? 'required' : mode === 1 ? 'preferred' : 'avoid',
                connection: mode === 2 ? 'none' : 'door',
                weight: 1,
              },
            },
          });
          relationshipCount += 1;
        }
      }
    }

    expect(source.relationships).toHaveLength(ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES);
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.adjacencies).toHaveLength(ARCHITECTURE_MAX_RELATIONSHIP_DIRECTIVES);
    }
  });

  it('accepts only non-empty room-to-room reachability constraints with empty parameters', () => {
    const supported = loadMansionProgram();
    supported.constraints.push({
      id: 'constraint-foyer-reaches-ballroom',
      type: 'reachability',
      severity: 'error',
      source: 'user',
      description: 'The foyer must reach the ballroom.',
      subjectIds: ['foyer-grand'],
      targetIds: ['ballroom'],
      parameters: {},
    });
    const accepted = extractArchitectureSourceProfile(supported);
    expect(accepted.valid).toBe(true);
    if (accepted.valid) {
      expect(accepted.value.supportedConstraints.map((constraint) => constraint.id)).toEqual([
        'constraint-foyer-reaches-ballroom',
      ]);
    }

    const parameterized = clone(supported);
    parameterized.constraints[0]!.parameters = { maximumDoors: 3 };
    expect(diagnosticCodes(parameterized)).toContain('architecture.constraint_unsupported');

    const emptyEndpointSet = clone(supported);
    emptyEndpointSet.constraints[0]!.targetIds = [];
    expect(diagnosticCodes(emptyEndpointSet)).toContain('architecture.constraint_unsupported');
  });

  it('preserves unsupported warning reachability parameters as unevaluated warnings', () => {
    const source = loadMansionProgram();
    source.constraints.push({
      id: 'constraint-parameterized-warning',
      type: 'reachability',
      severity: 'warning',
      source: 'user',
      description: 'A reachability variant outside planner v0.1.',
      subjectIds: ['foyer-grand'],
      targetIds: ['ballroom'],
      parameters: { maximumDoors: 3 },
    });
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.constraint_unevaluated',
        severity: 'warning',
        relatedId: 'constraint-parameterized-warning',
      }),
    );
    if (result.valid) expect(result.value.supportedConstraints).toEqual([]);
  });

  it('evaluates supported reachability against explicit circulation edges', () => {
    const source = loadMansionProgram();
    source.constraints.push({
      id: 'constraint-foyer-reaches-ballroom',
      type: 'reachability',
      severity: 'error',
      source: 'user',
      description: 'The foyer must reach the ballroom.',
      subjectIds: ['foyer-grand'],
      targetIds: ['ballroom'],
      parameters: {},
    });
    const planned = planArchitectureWorldSpec(source);
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    planned.plan.circulationEdges = planned.plan.circulationEdges.filter(
      (edge) => edge.fromNodeId !== 'ballroom' && edge.toNodeId !== 'ballroom',
    );

    const result = evaluateArchitecturePlan(source, planned.plan);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.circulation_unreachable',
        path: '/constraints/0',
        relatedId: 'constraint-foyer-reaches-ballroom',
      }),
    );
  });

  it('preserves but does not interpret a relationship without an architecture directive', () => {
    const source = loadMansionProgram();
    const relationship = source.relationships[0]!;
    delete relationship.attributes['worldwright.architecture'];
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.adjacencies).toHaveLength(source.relationships.length - 1);
      expect(result.value.source.relationships).toHaveLength(source.relationships.length);
    }
  });

  it.each([
    [
      'pre-authored Roblox directive',
      'architecture.roblox_directive_conflict',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        attributes(source, 'foyer-grand')['worldwright.roblox'] = {
          schemaVersion: '0.1.0',
          mode: 'container',
          className: 'Folder',
        };
      },
    ],
    [
      'reserved generated ID',
      'architecture.reserved_id_conflict',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        const entity = clone(entityById(source, 'parcel-cliffwatch'));
        entity.id = 'archgen-authored-parcel';
        entity.parentId = source.rootEntityId;
        source.entities.push(entity);
      },
    ],
    [
      'lock targeting the planned building',
      'architecture.lock_unsupported',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        source.locks.push({
          id: 'lock-building',
          entityId: 'mansion-cliffwatch',
          fieldPaths: ['attributes.worldwright.architecture'],
          owner: 'user',
          reason: 'Authored lock.',
        });
      },
    ],
    [
      'unsupported hard constraint',
      'architecture.constraint_unsupported',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        source.constraints.push({
          id: 'constraint-custom-hard',
          type: 'custom',
          severity: 'error',
          source: 'user',
          description: 'Unsupported hard rule.',
          subjectIds: ['mansion-cliffwatch'],
          targetIds: [],
          parameters: {},
        });
      },
    ],
  ])('rejects %s with %s', (_label, expectedCode, mutate) => {
    const source = loadMansionProgram();
    mutate(source);
    expect(diagnosticCodes(source)).toContain(expectedCode);
  });

  it.each([
    [
      'project',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        source.project.id = 'archgen-authored-project';
      },
    ],
    [
      'reference',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        const reference = clone(source.references[0]!);
        reference.id = 'archgen-authored-reference';
        source.references.push(reference);
      },
    ],
    [
      'relationship',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        source.relationships[0]!.id = 'archgen-authored-relationship';
      },
    ],
    [
      'constraint',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        source.constraints.push({
          id: 'archgen-authored-constraint',
          type: 'custom',
          severity: 'warning',
          source: 'user',
          description: 'Reserved ID coverage.',
          subjectIds: [],
          targetIds: [],
          parameters: {},
        });
      },
    ],
    [
      'lock',
      (source: ReturnType<typeof loadMansionProgram>): void => {
        source.locks.push({
          id: 'archgen-authored-lock',
          entityId: 'world-cliffwatch',
          fieldPaths: ['name'],
          owner: 'user',
          reason: 'Reserved ID coverage.',
        });
      },
    ],
  ])('rejects the reserved generated prefix on a source %s ID', (_label, mutate) => {
    const source = loadMansionProgram();
    mutate(source);
    expect(diagnosticCodes(source)).toContain('architecture.reserved_id_conflict');
  });

  it('preserves unsupported warning constraints and reports a warning', () => {
    const source = loadMansionProgram();
    source.constraints.push({
      id: 'constraint-custom-warning',
      type: 'custom',
      severity: 'warning',
      source: 'user',
      description: 'A warning outside planner v0.1.',
      subjectIds: ['mansion-cliffwatch'],
      targetIds: [],
      parameters: { note: 'preserve me' },
    });
    const result = extractArchitectureSourceProfile(source);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'architecture.constraint_unevaluated',
        severity: 'warning',
        relatedId: 'constraint-custom-warning',
      }),
    );
    if (result.valid) {
      expect(result.value.source.constraints.at(-1)?.parameters).toEqual({ note: 'preserve me' });
    }
  });
});
