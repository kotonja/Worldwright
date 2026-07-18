import { createViewportEvidence, writeViewportEvidence } from '../capture.js';
import { StudioAdapterError, studioDiagnostic } from '../diagnostics.js';
import type { StudioMcpImageResult } from '../mcp/result.js';
import type { StudioPlaytestCaptureEvidence } from './types.js';

function identifiers(evidenceId: string, checkpointId: string): void {
  const pattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
  if (
    evidenceId.length > 128 ||
    checkpointId.length > 128 ||
    !pattern.test(evidenceId) ||
    !pattern.test(checkpointId)
  ) {
    throw new StudioAdapterError([
      studioDiagnostic(
        'studio.capture_invalid',
        '/capture',
        'Playtest viewport evidence requires bounded canonical identifiers.',
      ),
    ]);
  }
}

/** Convert private image bytes to a strict shareable record, optionally writing once locally. */
export async function createStudioPlaytestCaptureEvidence(
  image: Readonly<StudioMcpImageResult>,
  evidenceId: string,
  checkpointId: string,
  outputPath?: string,
): Promise<StudioPlaytestCaptureEvidence> {
  identifiers(evidenceId, checkpointId);
  const evidence =
    outputPath === undefined
      ? createViewportEvidence(image.mediaType, image.bytes)
      : await writeViewportEvidence({
          mediaType: image.mediaType,
          bytes: image.bytes,
          outputPath,
        });
  return Object.freeze({ evidenceId, checkpointId, ...evidence });
}
