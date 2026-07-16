import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createViewportEvidence, writeViewportEvidence } from '../src/capture.js';
import { StudioAdapterError } from '../src/diagnostics.js';
import { hashCaptureBytes } from '../src/hashing.js';

const temporaryDirectories: string[] = [];
const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function pngCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function corruptPngImageDataWithValidCrc(): Buffer {
  const bytes = Buffer.from(VALID_PNG_BYTES);
  const typeOffset = bytes.indexOf(Buffer.from('IDAT', 'ascii'));
  const length = bytes.readUInt32BE(typeOffset - 4);
  const dataOffset = typeOffset + 4;
  bytes[dataOffset + Math.floor(length / 2)]! ^= 0xff;
  bytes.writeUInt32BE(
    pngCrc32(bytes.subarray(typeOffset, dataOffset + length)),
    dataOffset + length,
  );
  return bytes;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function pngWithExcessiveImageDataChunks(): Buffer {
  const idatTypeOffset = VALID_PNG_BYTES.indexOf(Buffer.from('IDAT', 'ascii'));
  return Buffer.concat([
    VALID_PNG_BYTES.subarray(0, idatTypeOffset - 4),
    ...Array.from({ length: 1024 }, () => pngChunk('IDAT')),
    VALID_PNG_BYTES.subarray(idatTypeOffset - 4),
  ]);
}

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
    const outputPath = join(directory, 'viewport.png');
    const bytes = new Uint8Array(VALID_PNG_BYTES);
    const evidence = await writeViewportEvidence({ outputPath, mediaType: 'image/png', bytes });
    expect(evidence).toEqual({
      mediaType: 'image/png',
      sha256: hashCaptureBytes(bytes),
      byteLength: bytes.byteLength,
    });
    expect(evidence).not.toHaveProperty('outputPath');
    expect(new Uint8Array(await readFile(outputPath))).toEqual(bytes);
    await expect(
      writeViewportEvidence({ outputPath, mediaType: 'image/png', bytes }),
    ).rejects.toBeInstanceOf(StudioAdapterError);
  });

  it('rejects URLs, empty captures, unsupported media types, and mismatched bytes', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    await expect(
      writeViewportEvidence({
        outputPath: 'https://example.com/capture.png',
        mediaType: 'image/png',
        bytes,
      }),
    ).rejects.toBeInstanceOf(StudioAdapterError);
    expect(() => createViewportEvidence('image/png', new Uint8Array())).toThrow(StudioAdapterError);
    expect(() => createViewportEvidence('image/svg+xml', bytes)).toThrow(StudioAdapterError);
    expect(() =>
      createViewportEvidence(
        'image/jpeg',
        Uint8Array.from([
          0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0xff, 0xda, 0x00,
          0x02, 0xff, 0xd9,
        ]),
      ),
    ).toThrow(StudioAdapterError);
    expect(() => createViewportEvidence('image/png', bytes)).toThrow(StudioAdapterError);
    expect(() =>
      createViewportEvidence('image/png', new Uint8Array(VALID_PNG_BYTES.subarray(0, 24))),
    ).toThrow(StudioAdapterError);
    const invalidCrc = Buffer.from(VALID_PNG_BYTES);
    invalidCrc[32]! ^= 0xff;
    expect(() => createViewportEvidence('image/png', invalidCrc)).toThrow(StudioAdapterError);
    expect(() => createViewportEvidence('image/png', corruptPngImageDataWithValidCrc())).toThrow(
      StudioAdapterError,
    );
    expect(() => createViewportEvidence('image/png', pngWithExcessiveImageDataChunks())).toThrow(
      StudioAdapterError,
    );
  });
});
