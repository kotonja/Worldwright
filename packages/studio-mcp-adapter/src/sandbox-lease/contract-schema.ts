import { Type } from '@sinclair/typebox';

import {
  STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION,
  STUDIO_SANDBOX_LEASE_RECORD_SCHEMA_ID,
  STUDIO_SANDBOX_LEASE_RECORD_VERSION,
  STUDIO_SANDBOX_LEASE_REQUEST_SCHEMA_ID,
  STUDIO_SANDBOX_LEASE_RESPONSE_SCHEMA_ID,
} from '../constants.js';
import {
  StudioCompactSnapshotSchema,
  StudioIdentifierSchema,
  StudioProtocolDiagnosticSchema,
  StudioSha256Schema,
} from '../contract-schema.js';

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

function leaseRecordSchema(options: Readonly<Record<string, unknown>> = {}) {
  return Type.Object(
    {
      schemaVersion: Type.Literal(STUDIO_SANDBOX_LEASE_RECORD_VERSION),
      leaseId: StudioSha256Schema,
      projectId: StudioIdentifierSchema,
      changeSetHash: StudioSha256Schema,
    },
    { ...options, additionalProperties: false },
  );
}

export const StudioSandboxLeaseRecordSchema = leaseRecordSchema({
  $id: STUDIO_SANDBOX_LEASE_RECORD_SCHEMA_ID,
  $schema: JSON_SCHEMA_DRAFT_2020_12,
});

const requestBase = {
  protocolVersion: Type.Literal(STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION),
} as const;

export const StudioSandboxLeaseReadRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('read_lease'),
  },
  { additionalProperties: false },
);

export const StudioSandboxLeaseClaimRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('claim_lease'),
    expectedLeasePresent: Type.Boolean(),
    expectedLease: Type.Optional(leaseRecordSchema()),
    newLease: leaseRecordSchema(),
  },
  { additionalProperties: false },
);

export const StudioSandboxLeaseBoundSnapshotRequestSchema = Type.Object(
  {
    ...requestBase,
    action: Type.Literal('bound_snapshot'),
    lease: leaseRecordSchema(),
  },
  { additionalProperties: false },
);

export const StudioSandboxLeaseRequestSchema = Type.Union(
  [
    StudioSandboxLeaseReadRequestSchema,
    StudioSandboxLeaseClaimRequestSchema,
    StudioSandboxLeaseBoundSnapshotRequestSchema,
  ],
  {
    $id: STUDIO_SANDBOX_LEASE_REQUEST_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

const responseBase = {
  protocolVersion: Type.Literal(STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION),
} as const;

export const StudioSandboxLeaseReadSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('read_lease'),
    ok: Type.Literal(true),
    leasePresent: Type.Boolean(),
    lease: Type.Optional(leaseRecordSchema()),
  },
  { additionalProperties: false },
);

export const StudioSandboxLeaseClaimSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('claim_lease'),
    ok: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const StudioSandboxLeaseBoundSnapshotSuccessSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Literal('bound_snapshot'),
    ok: Type.Literal(true),
    compactSnapshot: StudioCompactSnapshotSchema,
  },
  { additionalProperties: false },
);

export const StudioSandboxLeaseFailureSchema = Type.Object(
  {
    ...responseBase,
    action: Type.Union([
      Type.Literal('read_lease'),
      Type.Literal('claim_lease'),
      Type.Literal('bound_snapshot'),
    ]),
    ok: Type.Literal(false),
    diagnostic: StudioProtocolDiagnosticSchema,
  },
  { additionalProperties: false },
);

export const StudioSandboxLeaseResponseSchema = Type.Union(
  [
    StudioSandboxLeaseReadSuccessSchema,
    StudioSandboxLeaseClaimSuccessSchema,
    StudioSandboxLeaseBoundSnapshotSuccessSchema,
    StudioSandboxLeaseFailureSchema,
  ],
  {
    $id: STUDIO_SANDBOX_LEASE_RESPONSE_SCHEMA_ID,
    $schema: JSON_SCHEMA_DRAFT_2020_12,
  },
);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

deepFreeze(StudioSandboxLeaseRecordSchema);
deepFreeze(StudioSandboxLeaseRequestSchema);
deepFreeze(StudioSandboxLeaseResponseSchema);
