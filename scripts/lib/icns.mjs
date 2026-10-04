// ICNS (Apple Icon Image) writer and parser, carried over from the sibling
// `icon-creator` plugin (same author, MIT). From the public format description:
// an 8-byte file header ('icns' + total file length, big-endian, length
// includes the header itself), then chunks of a 4-byte type code, a 4-byte
// big-endian length that INCLUDES the 8-byte chunk header, and the image data.
// Modern files store PNG data.

import { pngInfo } from './png.mjs';

// Emission order: ascending pixel size, @1x chunk before the @2x chunk that
// shares the same pixel size.
export const ICNS_PNG_TYPES = [
  { type: 'icp4', size: 16, scale: '1x' },
  { type: 'icp5', size: 32, scale: '1x' },
  { type: 'ic11', size: 32, scale: '2x' },
  { type: 'icp6', size: 64, scale: '1x' },
  { type: 'ic12', size: 64, scale: '2x' },
  { type: 'ic07', size: 128, scale: '1x' },
  { type: 'ic08', size: 256, scale: '1x' },
  { type: 'ic13', size: 256, scale: '2x' },
  { type: 'ic09', size: 512, scale: '1x' },
  { type: 'ic14', size: 512, scale: '2x' },
  { type: 'ic10', size: 1024, scale: '2x' },
];

const ICNS_SIZES = new Set(ICNS_PNG_TYPES.map((entry) => entry.size));

/**
 * Build an .icns from a Map of pixel size -> PNG Buffer. Every size given must be one of the seven (16, 32, 64, 128,
 * 256, 512, 1024) and each PNG is verified to be square and of its declared size; a size that is not given gets no
 * chunk (a 512 px master makes an .icns without the 1024 px slice, which macOS accepts), but the set may not be empty
 * and must reach 256 px. Retina chunk types reuse the @1x pixel data of their size.
 */
export function buildIcns(pngBySize) {
  const unknown = [...pngBySize.keys()].filter((size) => !ICNS_SIZES.has(size));
  if (unknown.length > 0) throw new Error(`.icns has no slice of ${unknown.join(', ')} px`);
  if (![...pngBySize.keys()].some((size) => size >= 256)) {
    throw new Error('.icns needs renders up to at least 256 px; the missing sizes are: ' + [...ICNS_SIZES].filter((size) => !pngBySize.has(size)).join(', '));
  }
  const chunks = [];
  for (const descriptor of ICNS_PNG_TYPES) {
    const png = pngBySize.get(descriptor.size);
    if (png === undefined) continue;
    const info = pngInfo(png);
    if (info.width !== descriptor.size || info.height !== descriptor.size) {
      throw new Error(
        `Chunk ${descriptor.type} needs ${descriptor.size}px, got ${info.width}x${info.height}`,
      );
    }
    const head = Buffer.alloc(8);
    head.write(descriptor.type, 0, 'ascii');
    head.writeUInt32BE(8 + png.length, 4); // length includes the chunk header
    chunks.push(Buffer.concat([head, png]));
  }
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(totalLength, 4); // total length includes the file header
  return Buffer.concat([header, ...chunks]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Parse an .icns for verification: checks the magic, that the file header
 * length equals the real file size, and every chunk's length field (which must
 * include its own 8-byte header) and PNG payload size against the type table.
 */
export function parseIcns(buffer) {
  if (buffer.length < 8) throw new Error('.icns is shorter than its header');
  if (buffer.toString('ascii', 0, 4) !== 'icns') {
    throw new Error('.icns magic is not "icns"');
  }
  const totalLength = buffer.readUInt32BE(4);
  if (totalLength !== buffer.length) {
    throw new Error(`.icns header says ${totalLength} bytes, file has ${buffer.length}`);
  }
  const byType = new Map(ICNS_PNG_TYPES.map((entry) => [entry.type, entry]));
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('.icns chunk header is truncated');
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8) throw new Error(`.icns chunk ${type} length ${length} is smaller than its header`);
    if (offset + length > buffer.length) {
      throw new Error(`.icns chunk ${type} runs past the end of the file`);
    }
    const data = buffer.subarray(offset + 8, offset + length);
    const chunk = { type, dataLength: length - 8, offset, pngSize: null, expectedSize: null };
    const descriptor = byType.get(type);
    if (descriptor && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      const info = pngInfo(data);
      chunk.pngSize = { width: info.width, height: info.height };
      chunk.expectedSize = descriptor.size;
      if (info.width !== descriptor.size || info.height !== descriptor.size) {
        throw new Error(
          `.icns chunk ${type} should hold ${descriptor.size}px, PNG is ${info.width}x${info.height}`,
        );
      }
    }
    chunks.push(chunk);
    offset += length;
  }
  return { totalLength, chunks };
}
