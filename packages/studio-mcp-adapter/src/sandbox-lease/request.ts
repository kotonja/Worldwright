import { STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION } from '../constants.js';
import { StudioAdapterError } from '../diagnostics.js';
import type {
  StudioSandboxLeaseBoundSnapshotRequest,
  StudioSandboxLeaseClaimRequest,
  StudioSandboxLeaseReadRequest,
  StudioSandboxLeaseRecord,
} from './types.js';
import { validateStudioSandboxLeaseRequest } from './validate.js';

function checked<
  T extends
    | StudioSandboxLeaseReadRequest
    | StudioSandboxLeaseClaimRequest
    | StudioSandboxLeaseBoundSnapshotRequest,
>(candidate: T): T {
  const validation = validateStudioSandboxLeaseRequest(candidate);
  if (!validation.valid) throw new StudioAdapterError(validation.diagnostics);
  return validation.value as T;
}

export function buildReadSandboxLeaseRequest(): StudioSandboxLeaseReadRequest {
  return checked({
    protocolVersion: STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION,
    action: 'read_lease',
  });
}

export function buildClaimSandboxLeaseRequest(
  expectedLease: Readonly<StudioSandboxLeaseRecord> | undefined,
  newLease: Readonly<StudioSandboxLeaseRecord>,
): StudioSandboxLeaseClaimRequest {
  return checked({
    protocolVersion: STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION,
    action: 'claim_lease',
    expectedLeasePresent: expectedLease !== undefined,
    ...(expectedLease === undefined ? {} : { expectedLease: structuredClone(expectedLease) }),
    newLease: structuredClone(newLease),
  });
}

export function buildBoundSnapshotSandboxLeaseRequest(
  lease: Readonly<StudioSandboxLeaseRecord>,
): StudioSandboxLeaseBoundSnapshotRequest {
  return checked({
    protocolVersion: STUDIO_SANDBOX_LEASE_PROTOCOL_VERSION,
    action: 'bound_snapshot',
    lease: structuredClone(lease),
  });
}

/** Alias with the action name first for adapter and CLI call sites. */
export const buildBoundSandboxSnapshotRequest = buildBoundSnapshotSandboxLeaseRequest;
