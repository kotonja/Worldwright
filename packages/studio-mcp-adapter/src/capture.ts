import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

import { STUDIO_MCP_MAX_CAPTURE_BYTES } from './constants.js';
import { StudioAdapterError, studioDiagnostic } from './diagnostics.js';
import { hashCaptureBytes } from './hashing.js';
import type { StudioViewportEvidence, ViewportCaptureWriteInput } from './types.js';

const SUPPORTED_CAPTURE_MEDIA_TYPES = new Set(['image/png']);
const MAX_DECODED_CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_PNG_CHUNKS = 4096;
const MAX_PNG_IDAT_CHUNKS = 1024;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function crc32(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0xffffffff;
  for (let index = offset; index < offset + length; index += 1) {
    value = CRC32_TABLE[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngBitsPerPixel(colorType: number, bitDepth: number): number | undefined {
  const allowedDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (allowedDepths[colorType]?.includes(bitDepth) !== true) return undefined;
  const channels =
    colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  return channels * bitDepth;
}

export function hasValidPngStructure(bytes: Uint8Array): boolean {
  if (!hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  let offset = 8;
  let sawHeader = false;
  let sawImageData = false;
  let sawPalette = false;
  let imageDataEnded = false;
  let expectedDecodedLength: number | undefined;
  let rowLength: number | undefined;
  let pngColorType: number | undefined;
  let chunkCount = 0;
  let imageDataChunkCount = 0;
  const imageDataChunks: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) return false;
    const length = readUint32Be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const nextOffset = dataOffset + length + 4;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) return false;
    const type = String.fromCharCode(
      bytes[typeOffset]!,
      bytes[typeOffset + 1]!,
      bytes[typeOffset + 2]!,
      bytes[typeOffset + 3]!,
    );
    if (!/^[A-Za-z]{4}$/u.test(type)) return false;
    if (crc32(bytes, typeOffset, 4 + length) !== readUint32Be(bytes, dataOffset + length)) {
      return false;
    }
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = readUint32Be(bytes, dataOffset);
      const height = readUint32Be(bytes, dataOffset + 4);
      if (width === 0 || height === 0) return false;
      const bitDepth = bytes[dataOffset + 8]!;
      const colorType = bytes[dataOffset + 9]!;
      pngColorType = colorType;
      const bitsPerPixel = pngBitsPerPixel(colorType, bitDepth);
      if (
        bitsPerPixel === undefined ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12] !== 0
      ) {
        return false;
      }
      rowLength = Math.ceil((width * bitsPerPixel) / 8);
      expectedDecodedLength = height * (rowLength + 1);
      if (
        !Number.isSafeInteger(expectedDecodedLength) ||
        expectedDecodedLength > MAX_DECODED_CAPTURE_BYTES
      ) {
        return false;
      }
      sawHeader = true;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'PLTE') {
      if (sawImageData || length === 0 || length % 3 !== 0 || length > 768) return false;
      sawPalette = true;
    }
    if (type === 'IDAT') {
      if (imageDataEnded) return false;
      imageDataChunkCount += 1;
      if (imageDataChunkCount > MAX_PNG_IDAT_CHUNKS) return false;
      sawImageData = true;
      imageDataChunks.push(bytes.subarray(dataOffset, dataOffset + length));
    } else if (sawImageData && type !== 'IEND') {
      imageDataEnded = true;
    }
    const critical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
    if (critical && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return false;
    if (type === 'IEND') {
      if (
        length !== 0 ||
        !sawHeader ||
        !sawImageData ||
        nextOffset !== bytes.length ||
        expectedDecodedLength === undefined ||
        rowLength === undefined
      ) {
        return false;
      }
      if (pngColorType === 3 && !sawPalette) return false;
      try {
        const decoded = inflateSync(Buffer.concat(imageDataChunks), {
          maxOutputLength: expectedDecodedLength,
        });
        if (decoded.length !== expectedDecodedLength) return false;
        for (let rowOffset = 0; rowOffset < decoded.length; rowOffset += rowLength + 1) {
          if (decoded[rowOffset]! > 4) return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    offset = nextOffset;
  }
  return false;
}

function hasMatchingImageSignature(mediaType: string, bytes: Uint8Array): boolean {
  return mediaType === 'image/png' && hasValidPngStructure(bytes);
}

function captureFailure(
  code: 'studio.capture_invalid' | 'studio.io_failed',
  message: string,
): never {
  throw new StudioAdapterError([studioDiagnostic(code, '', message)]);
}

export function createViewportEvidence(
  mediaType: string,
  bytes: Uint8Array,
): StudioViewportEvidence {
  if (!SUPPORTED_CAPTURE_MEDIA_TYPES.has(mediaType)) {
    return captureFailure('studio.capture_invalid', 'Viewport capture media type is unsupported.');
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return captureFailure('studio.capture_invalid', 'Viewport capture must contain image bytes.');
  }
  if (bytes.byteLength > STUDIO_MCP_MAX_CAPTURE_BYTES) {
    return captureFailure('studio.capture_invalid', 'Viewport capture exceeds the byte limit.');
  }
  if (!hasMatchingImageSignature(mediaType, bytes)) {
    return captureFailure(
      'studio.capture_invalid',
      'Viewport capture bytes do not match the declared image media type.',
    );
  }
  return {
    mediaType: mediaType as StudioViewportEvidence['mediaType'],
    sha256: hashCaptureBytes(bytes),
    byteLength: bytes.byteLength,
  };
}

/** Writes one already-validated MCP image without returning or recording its local path. */
export async function writeViewportEvidence(
  input: Readonly<ViewportCaptureWriteInput>,
): Promise<StudioViewportEvidence> {
  if (
    typeof input.outputPath !== 'string' ||
    input.outputPath.trim().length === 0 ||
    /^https?:\/\//iu.test(input.outputPath) ||
    input.outputPath.includes('\0')
  ) {
    return captureFailure(
      'studio.capture_invalid',
      'Viewport evidence requires an explicit local output path.',
    );
  }
  const evidence = createViewportEvidence(input.mediaType, input.bytes);
  const bytes = Buffer.from(input.bytes);
  try {
    await writeFile(input.outputPath, bytes, { flag: 'wx' });
  } catch {
    return captureFailure(
      'studio.io_failed',
      'Viewport evidence could not be written exactly once to the selected local path.',
    );
  }
  return evidence;
}
