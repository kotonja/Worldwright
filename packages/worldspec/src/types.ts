import type { Static } from '@sinclair/typebox';

import type {
  BoundsSchema,
  BudgetsSchema,
  ConstraintSchema,
  EntitySchema,
  IntentSchema,
  LockSchema,
  ProjectSchema,
  ProvenanceSchema,
  ReferenceSchema,
  RelationshipSchema,
  StyleDnaSchema,
  TransformSchema,
  WorldSpecSchema,
} from './schema.js';

export type Project = Static<typeof ProjectSchema>;
export type Intent = Static<typeof IntentSchema>;
export type WorldReference = Static<typeof ReferenceSchema>;
export type StyleDna = Static<typeof StyleDnaSchema>;
export type Provenance = Static<typeof ProvenanceSchema>;
export type Transform = Static<typeof TransformSchema>;
export type Bounds = Static<typeof BoundsSchema>;
export type WorldEntity = Static<typeof EntitySchema>;
export type WorldRelationship = Static<typeof RelationshipSchema>;
export type WorldConstraint = Static<typeof ConstraintSchema>;
export type WorldLock = Static<typeof LockSchema>;
export type WorldBudgets = Static<typeof BudgetsSchema>;
export type WorldSpec = Static<typeof WorldSpecSchema>;
