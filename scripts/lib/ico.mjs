// ICO container writer and parser, carried over from the sibling
// `icon-creator` plugin (same author, MIT). From the public format description:
// a 6-byte ICONDIR header, 16-byte ICONDIRENTRY records, then the image data.
// This tool stores PNG-compressed images only (supported for every size since
// Windows Vista). The width and height bytes of an entry are one byte each, so
// a 256-pixel image is stored as 0 in both.

import { pngInfo } from './png.mjs';

/**
 * Build an .ico from { size, png } entries. Every PNG is checked to be square
 * and to match its declared size, so a bug cannot silently produce a broken
 * icon.
 */
export function buildIco(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('An .ico needs at least one image entry');
  }
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  for (const entry of sorted) {
    if (!Number.isInteger(entry.size) || entry.size < 1 || entry.size > 256) {
      throw new Error(`Invalid .ico entry size ${entry.size} (must be 1..256)`);
    }
    const info = pngInfo(entry.png);
    if (info.width !== entry.size || info.height !== entry.size) {
      throw new Error(
        `Entry claims ${entry.size}px but the PNG is ${info.width}x${info.height}`,
      );
    }
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sorted.length, 4);
  const directory = Buffer.alloc(sorted.length * 16);
  const blobs = [];
  let offset = 6 + sorted.length * 16;
  sorted.forEach((entry, index) => {
    const base = index * 16;
    const dimension = entry.size === 256 ? 0 : entry.size;
    directory[base] = dimension;
    directory[base + 1] = dimension;
    directory[base + 2] = 0; // color count: 0 means unset
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // color planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    blobs.push(entry.png);
    offset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...blobs]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Parse an .ico for verification: returns { count, entries } where each entry
 * has the declared dimensions (256 when the byte is 0), the data range and,
 * for PNG payloads, the true pixel size read from the PNG header. Anything
 * inconsistent raises, so tests can trust the result.
 */
export function parseIco(buffer) {
  if (buffer.length < 6) throw new Error('.ico is shorter than its header');
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  if (reserved !== 0) throw new Error(`.ico reserved field is ${reserved}, expected 0`);
  if (type !== 1) throw new Error(`.ico type field is ${type}, expected 1 (icon)`);
  if (count === 0) throw new Error('.ico declares no images');
  if (buffer.length < 6 + count * 16) throw new Error('.ico directory is truncated');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const base = 6 + index * 16;
    const declaredWidth = buffer[base] === 0 ? 256 : buffer[base];
    const declaredHeight = buffer[base + 1] === 0 ? 256 : buffer[base + 1];
    const byteCount = buffer.readUInt32LE(base + 8);
    const offset = buffer.readUInt32LE(base + 12);
    if (declaredWidth !== declaredHeight) {
      throw new Error(`.ico entry ${index} is ${declaredWidth}x${declaredHeight}, not square`);
    }
    if (offset + byteCount > buffer.length) {
      throw new Error(`.ico entry ${index} data runs past the end of the file`);
    }
    const data = buffer.subarray(offset, offset + byteCount);
    const entry = { index, declaredWidth, declaredHeight, byteCount, offset, isPng: false, pngSize: null };
    if (data.subarray(0, 8).equals(PNG_SIGNATURE)) {
      const info = pngInfo(data);
      entry.isPng = true;
      entry.pngSize = { width: info.width, height: info.height };
      if (info.width !== declaredWidth || info.height !== declaredHeight) {
        throw new Error(
          `.ico entry ${index} says ${declaredWidth}px but its PNG is ${info.width}x${info.height}`,
        );
      }
    }
    entries.push(entry);
  }
  return { count, entries };
}
