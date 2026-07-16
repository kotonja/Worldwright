function jpegSegment(marker: number, data: Uint8Array): Buffer {
  const segment = Buffer.alloc(4 + data.byteLength);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(data.byteLength + 2, 2);
  Buffer.from(data).copy(segment, 4);
  return segment;
}

function jpegHuffmanTable(tableClass: 0 | 1, table = 0): Buffer {
  return Buffer.from([(tableClass << 4) | table, 1, ...Array<number>(15).fill(0), 0]);
}

export function createStructurallyValidJpeg(
  options: {
    readonly entropy?: Uint8Array;
    readonly restartInterval?: number;
    readonly precision?: number;
    readonly height?: number;
    readonly width?: number;
    readonly componentCount?: 1 | 2 | 3 | 4;
  } = {},
): Buffer {
  const componentCount = options.componentCount ?? 3;
  const frameComponents = Array.from({ length: componentCount }, (_, index) => [
    index + 1,
    0x11,
    0,
  ]).flat();
  const scanComponents = Array.from({ length: componentCount }, (_, index) => [
    index + 1,
    0x00,
  ]).flat();
  const restart =
    options.restartInterval === undefined
      ? []
      : [
          jpegSegment(
            0xdd,
            Buffer.from([options.restartInterval >>> 8, options.restartInterval & 0xff]),
          ),
        ];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    jpegSegment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])),
    jpegSegment(
      0xc0,
      Buffer.from([
        options.precision ?? 8,
        (options.height ?? 1) >>> 8,
        (options.height ?? 1) & 0xff,
        (options.width ?? 1) >>> 8,
        (options.width ?? 1) & 0xff,
        componentCount,
        ...frameComponents,
      ]),
    ),
    jpegSegment(0xc4, Buffer.concat([jpegHuffmanTable(0), jpegHuffmanTable(1)])),
    ...restart,
    jpegSegment(0xda, Buffer.from([componentCount, ...scanComponents, 0, 63, 0])),
    Buffer.from(options.entropy ?? [0x03]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** Matches the marker, frame, component, and table profile observed from Studio screen_capture. */
export function createObservedStudioJpegProfile(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    jpegSegment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])),
    jpegSegment(0xdb, Buffer.from([1, ...Array<number>(64).fill(1)])),
    jpegSegment(
      0xc0,
      Buffer.from([8, 0x02, 0xb4, 0x04, 0xcf, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ),
    jpegSegment(0xc4, jpegHuffmanTable(0, 0)),
    jpegSegment(0xc4, jpegHuffmanTable(1, 0)),
    jpegSegment(0xc4, jpegHuffmanTable(0, 1)),
    jpegSegment(0xc4, jpegHuffmanTable(1, 1)),
    jpegSegment(0xda, Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0])),
    Buffer.from([0x03]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export const VALID_JPEG_BYTES = createObservedStudioJpegProfile();
