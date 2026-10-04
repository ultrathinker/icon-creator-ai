// Validation of an image buffer that came back from a provider (adapted from
// the sibling `icon-creator` plugin, same author, MIT). The format always
// comes from the CONTENT (magic bytes), never from a file extension, and the
// pixel dimensions come from the HEADER. Nothing is decoded here; the pack
// builder decodes PNG through the bundled codec.

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MIN_SIDE = 64;
export const MAX_SIDE = 4096;

/** Detect the format from the first bytes. Returns a lowercase name or null. */
export function detectFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('the JPEG is malformed (expected a marker)');
    let marker = buffer[offset + 1];
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1; // fill bytes
      marker = buffer[offset + 1];
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan before any frame header
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 7 > buffer.length) break;
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error('the JPEG has no frame header (truncated or not a real JPEG)');
}

function webpDimensions(buffer) {
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  }
  throw new Error('the WebP has an unrecognised header');
}

/**
 * Check a returned image before anything is written: a known raster format,
 * a complete container, sane dimensions. Returns
 * { format, width, height, square } or throws with a reason.
 */
export function validateImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('the provider returned an empty image');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`the image is ${buffer.length} bytes, over the ${MAX_IMAGE_BYTES} byte limit`);
  }
  const format = detectFormat(buffer);
  if (format === null) {
    throw new Error('the image is not a PNG, JPEG or WebP (magic bytes unknown)');
  }
  let dimensions;
  if (format === 'png') {
    // signature(8) + length(4) + 'IHDR'(4) + 13 bytes of IHDR data.
    if (buffer.length < 33 || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('the PNG is truncated (no IHDR chunk)');
    }
    dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (format === 'jpeg') {
    dimensions = jpegDimensions(buffer);
  } else {
    dimensions = webpDimensions(buffer);
  }
  const sides = [dimensions.width, dimensions.height];
  if (sides.some((value) => !Number.isInteger(value) || value < MIN_SIDE || value > MAX_SIDE)) {
    throw new Error(`the ${format.toUpperCase()} is ${dimensions.width}x${dimensions.height} px; each side must be ${MIN_SIDE}..${MAX_SIDE} px`);
  }
  return { format, width: dimensions.width, height: dimensions.height, square: dimensions.width === dimensions.height };
}
