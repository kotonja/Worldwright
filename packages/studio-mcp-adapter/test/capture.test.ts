import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createViewportEvidence,
  hasValidJpegStructure,
  writeViewportEvidence,
} from '../src/capture.js';
import { StudioAdapterError } from '../src/diagnostics.js';
import { hashCaptureBytes } from '../src/hashing.js';
import { createStructurallyValidJpeg, VALID_JPEG_BYTES } from './image-fixtures.js';

const temporaryDirectories: string[] = [];
const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('viewport evidence', () => {
  it('hashes bounded bytes and writes exactly once without returning the local path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldwright-capture-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'viewport.jpg');
    const bytes = new Uint8Array(VALID_JPEG_BYTES);
    const evidence = await writeViewportEvidence({ outputPath, mediaType: 'image/jpeg', bytes });
    expect(evidence).toEqual({
      mediaType: 'image/jpeg',
      sha256: hashCaptureBytes(bytes),
      byteLength: bytes.byteLength,
    });
    expect(evidence).not.toHaveProperty('outputPath');
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes);
    await expect(
      writeViewportEvidence({ outputPath, mediaType: 'image/jpeg', bytes }),
    ).rejects.toBeInstanceOf(StudioAdapterError);
  });

  it('rejects URLs, empty captures, unsupported media types, and mismatched bytes', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    await expect(
      writeViewportEvidence({
        outputPath: 'https://example.com/capture.jpg',
        mediaType: 'image/jpeg',
        bytes,
      }),
    ).rejects.toBeInstanceOf(StudioAdapterError);
    expect(() => createViewportEvidence('image/jpeg', new Uint8Array())).toThrow(
      StudioAdapterError,
    );
    expect(() => createViewportEvidence('image/svg+xml', bytes)).toThrow(StudioAdapterError);
    expect(() => createViewportEvidence('image/png', VALID_PNG_BYTES)).toThrow(StudioAdapterError);
  });

  it('validates JPEG scan stuffing and ordered restart markers', () => {
    expect(
      hasValidJpegStructure(
        createStructurallyValidJpeg({ entropy: Uint8Array.from([0xff, 0x00]) }),
      ),
    ).toBe(true);
    expect(
      hasValidJpegStructure(
        createStructurallyValidJpeg({
          restartInterval: 1,
          entropy: Uint8Array.from([0x01, 0xff, 0xd0, 0x02, 0xff, 0xd1, 0x03]),
        }),
      ),
    ).toBe(true);
  });

  it('rejects malformed, ambiguous, unsupported, or trailing JPEG structures', () => {
    const trailing = Buffer.concat([VALID_JPEG_BYTES, Buffer.from([0])]);
    const missingEnd = VALID_JPEG_BYTES.subarray(0, -2);
    const missingFrame = Buffer.concat([
      VALID_JPEG_BYTES.subarray(0, VALID_JPEG_BYTES.indexOf(Buffer.from([0xff, 0xc0]))),
      VALID_JPEG_BYTES.subarray(VALID_JPEG_BYTES.indexOf(Buffer.from([0xff, 0xc4]))),
    ]);
    const invalidSegmentLength = Buffer.from(VALID_JPEG_BYTES);
    invalidSegmentLength.writeUInt16BE(1, 4);
    const progressive = Buffer.from(VALID_JPEG_BYTES);
    progressive[progressive.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc2;
    const scanOffset = VALID_JPEG_BYTES.indexOf(Buffer.from([0xff, 0xda]));
    const scanEnd = scanOffset + 2 + VALID_JPEG_BYTES.readUInt16BE(scanOffset + 2);
    const arithmetic = Buffer.concat([
      VALID_JPEG_BYTES.subarray(0, scanOffset),
      Buffer.from([0xff, 0xcc, 0x00, 0x04, 0x00, 0x00]),
      VALID_JPEG_BYTES.subarray(scanOffset),
    ]);
    const quantizationOffset = VALID_JPEG_BYTES.indexOf(Buffer.from([0xff, 0xdb]));
    const quantizationEnd =
      quantizationOffset + 2 + VALID_JPEG_BYTES.readUInt16BE(quantizationOffset + 2);
    const duplicateQuantizationTable = Buffer.concat([
      VALID_JPEG_BYTES.subarray(0, quantizationEnd),
      VALID_JPEG_BYTES.subarray(quantizationOffset, quantizationEnd),
      VALID_JPEG_BYTES.subarray(quantizationEnd),
    ]);
    const huffmanOffset = VALID_JPEG_BYTES.indexOf(Buffer.from([0xff, 0xc4]));
    const huffmanEnd = huffmanOffset + 2 + VALID_JPEG_BYTES.readUInt16BE(huffmanOffset + 2);
    const completeHuffmanTable = Buffer.concat([
      Buffer.from([0xff, 0xc4, 0x00, 0x15, 0x00, 0x02]),
      Buffer.alloc(15),
      Buffer.from([0x00, 0x01]),
    ]);
    const allOnesHuffmanCode = Buffer.concat([
      VALID_JPEG_BYTES.subarray(0, huffmanOffset),
      completeHuffmanTable,
      VALID_JPEG_BYTES.subarray(huffmanEnd),
    ]);
    const duplicateHuffmanTables = Buffer.concat([
      VALID_JPEG_BYTES.subarray(0, huffmanEnd),
      VALID_JPEG_BYTES.subarray(huffmanOffset, huffmanEnd),
      VALID_JPEG_BYTES.subarray(huffmanEnd),
    ]);
    const withRestartInterval = createStructurallyValidJpeg({ restartInterval: 1 });
    const restartScanOffset = withRestartInterval.indexOf(Buffer.from([0xff, 0xda]));
    const duplicateRestartInterval = Buffer.concat([
      withRestartInterval.subarray(0, restartScanOffset),
      Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x01]),
      withRestartInterval.subarray(restartScanOffset),
    ]);
    const multipleScans = Buffer.concat([
      VALID_JPEG_BYTES.subarray(0, -2),
      VALID_JPEG_BYTES.subarray(scanOffset, scanEnd),
      Buffer.from([0x03, 0xff, 0xd9]),
    ]);
    const excessiveRestartMarkers = createStructurallyValidJpeg({
      restartInterval: 1,
      entropy: Buffer.concat(
        Array.from({ length: 16_384 }, (_, index) => Buffer.from([0x01, 0xff, 0xd0 + (index % 8)])),
      ),
    });
    const cases = [
      trailing,
      missingEnd,
      missingFrame,
      invalidSegmentLength,
      progressive,
      arithmetic,
      duplicateQuantizationTable,
      allOnesHuffmanCode,
      duplicateHuffmanTables,
      duplicateRestartInterval,
      multipleScans,
      excessiveRestartMarkers,
      createStructurallyValidJpeg({ precision: 12 }),
      createStructurallyValidJpeg({ height: 0 }),
      createStructurallyValidJpeg({ height: 2_000, width: 65_535 }),
      createStructurallyValidJpeg({ componentCount: 2 }),
      createStructurallyValidJpeg({ componentCount: 4 }),
      createStructurallyValidJpeg({ entropy: Uint8Array.from([0xff, 0xff, 0x00]) }),
      createStructurallyValidJpeg({ entropy: Uint8Array.from([0x01, 0xff, 0xd0, 0x02]) }),
      createStructurallyValidJpeg({
        restartInterval: 1,
        entropy: Uint8Array.from([0x01, 0xff, 0xd1, 0x02]),
      }),
    ];
    for (const bytes of cases) {
      expect(hasValidJpegStructure(bytes)).toBe(false);
      expect(() => createViewportEvidence('image/jpeg', bytes)).toThrow(StudioAdapterError);
    }
  });
});
