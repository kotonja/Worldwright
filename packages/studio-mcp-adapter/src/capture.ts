import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';

import { STUDIO_MCP_MAX_CAPTURE_BYTES, STUDIO_MCP_VIEWPORT_MEDIA_TYPE } from './constants.js';
import { StudioAdapterError, studioDiagnostic } from './diagnostics.js';
import { hashCaptureBytes } from './hashing.js';
import type { StudioViewportEvidence, ViewportCaptureWriteInput } from './types.js';

const MAX_DECODED_CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_JPEG_MARKERS = 16_384;
const MAX_JPEG_SCANS = 1;

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

interface JpegFrameComponent {
  readonly quantizationTable: number;
}

interface JpegSegment {
  readonly dataOffset: number;
  readonly endOffset: number;
}

function readJpegSegment(bytes: Uint8Array, offset: number): JpegSegment | undefined {
  if (offset + 2 > bytes.length) return undefined;
  const length = readUint16Be(bytes, offset);
  if (length < 2) return undefined;
  const endOffset = offset + length;
  if (!Number.isSafeInteger(endOffset) || endOffset > bytes.length) return undefined;
  return { dataOffset: offset + 2, endOffset };
}

function readJpegMarker(
  bytes: Uint8Array,
  offset: number,
): { readonly marker: number; readonly nextOffset: number } | undefined {
  if (bytes[offset] !== 0xff) return undefined;
  let cursor = offset + 1;
  while (bytes[cursor] === 0xff) cursor += 1;
  if (cursor >= bytes.length || bytes[cursor] === 0x00) return undefined;
  return { marker: bytes[cursor]!, nextOffset: cursor + 1 };
}

function readJpegQuantizationTables(
  bytes: Uint8Array,
  segment: Readonly<JpegSegment>,
  tables: Set<number>,
): boolean {
  let offset = segment.dataOffset;
  const localTables = new Set<number>();
  while (offset < segment.endOffset) {
    const descriptor = bytes[offset];
    if (descriptor === undefined) return false;
    const precision = descriptor >>> 4;
    const table = descriptor & 0x0f;
    if (precision !== 0 || table > 3 || localTables.has(table) || tables.has(table)) return false;
    offset += 1;
    if (offset + 64 > segment.endOffset) return false;
    for (let index = offset; index < offset + 64; index += 1) {
      if (bytes[index] === 0) return false;
    }
    localTables.add(table);
    tables.add(table);
    offset += 64;
  }
  return localTables.size > 0 && offset === segment.endOffset;
}

function validJpegHuffmanSymbols(tableClass: number, symbols: Uint8Array): boolean {
  if (new Set(symbols).size !== symbols.length) return false;
  if (tableClass === 0) return symbols.every((symbol) => symbol <= 11);
  return symbols.every((symbol) => {
    if (symbol === 0x00 || symbol === 0xf0) return true;
    const coefficientSize = symbol & 0x0f;
    return coefficientSize >= 1 && coefficientSize <= 10;
  });
}

function readJpegHuffmanTables(
  bytes: Uint8Array,
  segment: Readonly<JpegSegment>,
  tables: Set<string>,
): boolean {
  let offset = segment.dataOffset;
  const localTables = new Set<string>();
  while (offset < segment.endOffset) {
    const descriptor = bytes[offset];
    if (descriptor === undefined) return false;
    const tableClass = descriptor >>> 4;
    const table = descriptor & 0x0f;
    const key = `${tableClass}:${table}`;
    if (
      tableClass > 1 ||
      table > 3 ||
      localTables.has(key) ||
      tables.has(key) ||
      offset + 17 > segment.endOffset
    ) {
      return false;
    }
    offset += 1;
    let symbolCount = 0;
    let availableCodes = 1;
    for (let index = 0; index < 16; index += 1) {
      const count = bytes[offset + index]!;
      symbolCount += count;
      availableCodes = availableCodes * 2 - count;
      if (availableCodes < 0) return false;
    }
    if (availableCodes === 0) return false;
    offset += 16;
    if (symbolCount === 0 || symbolCount > 256 || offset + symbolCount > segment.endOffset) {
      return false;
    }
    const symbols = bytes.subarray(offset, offset + symbolCount);
    if (!validJpegHuffmanSymbols(tableClass, symbols)) return false;
    offset += symbolCount;
    localTables.add(key);
    tables.add(key);
  }
  return localTables.size > 0 && offset === segment.endOffset;
}

function readJpegBaselineFrame(
  bytes: Uint8Array,
  segment: Readonly<JpegSegment>,
): ReadonlyMap<number, JpegFrameComponent> | undefined {
  const dataLength = segment.endOffset - segment.dataOffset;
  if (dataLength < 9 || bytes[segment.dataOffset] !== 8) return undefined;
  const height = readUint16Be(bytes, segment.dataOffset + 1);
  const width = readUint16Be(bytes, segment.dataOffset + 3);
  const componentCount = bytes[segment.dataOffset + 5]!;
  if (
    width === 0 ||
    height === 0 ||
    ![1, 3].includes(componentCount) ||
    dataLength !== 6 + 3 * componentCount ||
    width * height * 4 > MAX_DECODED_CAPTURE_BYTES
  ) {
    return undefined;
  }
  const components = new Map<number, JpegFrameComponent>();
  let samplingArea = 0;
  for (let index = 0; index < componentCount; index += 1) {
    const offset = segment.dataOffset + 6 + 3 * index;
    const identifier = bytes[offset]!;
    const sampling = bytes[offset + 1]!;
    const horizontalSampling = sampling >>> 4;
    const verticalSampling = sampling & 0x0f;
    const quantizationTable = bytes[offset + 2]!;
    if (
      components.has(identifier) ||
      horizontalSampling < 1 ||
      horizontalSampling > 4 ||
      verticalSampling < 1 ||
      verticalSampling > 4 ||
      quantizationTable > 3
    ) {
      return undefined;
    }
    samplingArea += horizontalSampling * verticalSampling;
    components.set(identifier, { quantizationTable });
  }
  return samplingArea <= 10 ? components : undefined;
}

function readJpegBaselineScan(
  bytes: Uint8Array,
  segment: Readonly<JpegSegment>,
  frameComponents: ReadonlyMap<number, JpegFrameComponent>,
  scannedComponents: Set<number>,
  quantizationTables: ReadonlySet<number>,
  huffmanTables: ReadonlySet<string>,
): boolean {
  const componentCount = bytes[segment.dataOffset];
  if (
    componentCount === undefined ||
    componentCount < 1 ||
    componentCount !== frameComponents.size ||
    segment.endOffset - segment.dataOffset !== 4 + 2 * componentCount
  ) {
    return false;
  }
  const selected = new Set<number>();
  for (let index = 0; index < componentCount; index += 1) {
    const offset = segment.dataOffset + 1 + 2 * index;
    const identifier = bytes[offset]!;
    const tables = bytes[offset + 1]!;
    const dcTable = tables >>> 4;
    const acTable = tables & 0x0f;
    const component = frameComponents.get(identifier);
    if (
      component === undefined ||
      selected.has(identifier) ||
      scannedComponents.has(identifier) ||
      dcTable > 3 ||
      acTable > 3 ||
      !quantizationTables.has(component.quantizationTable) ||
      !huffmanTables.has(`0:${dcTable}`) ||
      !huffmanTables.has(`1:${acTable}`)
    ) {
      return false;
    }
    selected.add(identifier);
  }
  const parametersOffset = segment.dataOffset + 1 + 2 * componentCount;
  if (
    bytes[parametersOffset] !== 0 ||
    bytes[parametersOffset + 1] !== 63 ||
    bytes[parametersOffset + 2] !== 0
  ) {
    return false;
  }
  for (const identifier of selected) scannedComponents.add(identifier);
  return true;
}

/**
 * Validates one standalone 8-bit baseline-sequential JPEG without decoding pixels.
 * The accepted profile has one SOF0 frame, one or three components, in-file 8-bit
 * quantization and Huffman tables, one complete scan, and an exact terminal EOI marker.
 */
export function hasValidJpegStructure(bytes: Uint8Array): boolean {
  if (!hasBytes(bytes, 0, [0xff, 0xd8]) || bytes.length < 4) return false;
  let offset = 2;
  let pendingMarker: number | undefined;
  let markerCount = 1;
  let scanCount = 0;
  let restartInterval = 0;
  let sawRestartInterval = false;
  let frameComponents: ReadonlyMap<number, JpegFrameComponent> | undefined;
  const quantizationTables = new Set<number>();
  const huffmanTables = new Set<string>();
  const scannedComponents = new Set<number>();

  while (offset < bytes.length || pendingMarker !== undefined) {
    let marker: number;
    if (pendingMarker === undefined) {
      const result = readJpegMarker(bytes, offset);
      if (result === undefined) return false;
      marker = result.marker;
      offset = result.nextOffset;
      markerCount += 1;
    } else {
      marker = pendingMarker;
      pendingMarker = undefined;
    }
    if (markerCount > MAX_JPEG_MARKERS || marker === 0xd8 || marker === 0x01) return false;
    if (scanCount > 0 && marker !== 0xd9) return false;
    if (marker === 0xd9) {
      return (
        offset === bytes.length &&
        frameComponents !== undefined &&
        scanCount > 0 &&
        scannedComponents.size === frameComponents.size
      );
    }
    if (marker >= 0xd0 && marker <= 0xd7) return false;
    const segment = readJpegSegment(bytes, offset);
    if (segment === undefined) return false;

    if (marker === 0xdb) {
      if (!readJpegQuantizationTables(bytes, segment, quantizationTables)) return false;
    } else if (marker === 0xc4) {
      if (!readJpegHuffmanTables(bytes, segment, huffmanTables)) return false;
    } else if (marker === 0xc0) {
      if (frameComponents !== undefined || scanCount > 0) return false;
      frameComponents = readJpegBaselineFrame(bytes, segment);
      if (frameComponents === undefined) return false;
    } else if (marker === 0xdd) {
      if (sawRestartInterval || segment.endOffset - segment.dataOffset !== 2) return false;
      restartInterval = readUint16Be(bytes, segment.dataOffset);
      sawRestartInterval = true;
    } else if (marker === 0xda) {
      if (
        frameComponents === undefined ||
        scanCount >= MAX_JPEG_SCANS ||
        !readJpegBaselineScan(
          bytes,
          segment,
          frameComponents,
          scannedComponents,
          quantizationTables,
          huffmanTables,
        )
      ) {
        return false;
      }
      scanCount += 1;
      offset = segment.endOffset;
      let entropySinceMarker = false;
      let expectedRestart = 0;
      while (offset < bytes.length) {
        const value = bytes[offset]!;
        offset += 1;
        if (value !== 0xff) {
          entropySinceMarker = true;
          continue;
        }
        if (offset >= bytes.length) return false;
        let next = bytes[offset]!;
        offset += 1;
        let hadFillByte = false;
        while (next === 0xff) {
          hadFillByte = true;
          if (offset >= bytes.length) return false;
          next = bytes[offset]!;
          offset += 1;
        }
        if (next === 0x00) {
          if (hadFillByte) return false;
          entropySinceMarker = true;
          continue;
        }
        markerCount += 1;
        if (markerCount > MAX_JPEG_MARKERS || !entropySinceMarker) return false;
        if (next >= 0xd0 && next <= 0xd7) {
          if (restartInterval === 0 || next !== 0xd0 + expectedRestart) return false;
          expectedRestart = (expectedRestart + 1) % 8;
          entropySinceMarker = false;
          continue;
        }
        pendingMarker = next;
        break;
      }
      if (pendingMarker === undefined) return false;
      continue;
    } else if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) {
      return false;
    }
    offset = segment.endOffset;
  }
  return false;
}

function hasMatchingImageSignature(mediaType: string, bytes: Uint8Array): boolean {
  return mediaType === STUDIO_MCP_VIEWPORT_MEDIA_TYPE && hasValidJpegStructure(bytes);
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
  if (mediaType !== STUDIO_MCP_VIEWPORT_MEDIA_TYPE) {
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
