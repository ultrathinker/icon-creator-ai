// Shared test helpers: tiny raster drawing primitives and synthetic
// "AI-like" candidate icons. Everything a test needs is generated here —
// tests use synthetic data only and never touch the network.

import { encodePng, decodePng } from '../scripts/lib/png.mjs';

export function canvas(size, background = null) {
  const rgba = Buffer.alloc(size * size * 4);
  if (background) fillRect(rgba, size, 0, 0, size, size, background);
  return rgba;
}

export function setPixel(rgba, size, x, y, [r, g, b, a = 255]) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const o = (y * size + x) * 4;
  rgba[o] = r;
  rgba[o + 1] = g;
  rgba[o + 2] = b;
  rgba[o + 3] = a;
}

export function getPixel(rgba, size, x, y) {
  const o = (y * size + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}

export function fillRect(rgba, size, x0, y0, width, height, [r, g, b, a = 255]) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) setPixel(rgba, size, x, y, [r, g, b, a]);
  }
}

export function fillCircle(rgba, size, cx, cy, radius, [r, g, b, a = 255]) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) setPixel(rgba, size, x, y, [r, g, b, a]);
    }
  }
}

/** A square with rounded corners, the classic app-icon tile. */
export function fillRoundedSquare(rgba, size, x0, y0, side, radius, color) {
  for (let y = y0; y < y0 + side; y += 1) {
    for (let x = x0; x < x0 + side; x += 1) {
      const dx = x < x0 + radius ? x0 + radius - x : x >= x0 + side - radius ? x - (x0 + side - radius - 1) : 0;
      const dy = y < y0 + radius ? y0 + radius - y : y >= y0 + side - radius ? y - (y0 + side - radius - 1) : 0;
      if (dx * dx + dy * dy <= radius * radius) setPixel(rgba, size, x, y, color);
    }
  }
}

/** Deterministic pseudo-noise in [0, spread]. */
export function noiseAt(x, y, seed = 1) {
  let value = Math.sin((x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453) * 43758.5453;
  value -= Math.floor(value);
  return value;
}

/** Encode an RGBA buffer to a PNG Buffer. */
export function pngOf(rgba, size) {
  return encodePng(size, size, rgba);
}

/** Decode a PNG Buffer to { rgba, size }. */
export function decodeToSize(buffer) {
  const decoded = decodePng(buffer);
  return { rgba: decoded.rgba, size: decoded.width };
}

// --- Synthetic "AI-like" candidates -----------------------------------------
//
// Each generator returns a PNG Buffer that mimics what an image model returns:
// a subject on a flat or nearly flat background.

/** A rounded tile with a white glyph hole, on a flat white background. */
export function candidateTile(size = 512, { background = [255, 255, 255], tile = [52, 120, 246] } = {}) {
  const rgba = canvas(size, [...background, 255]);
  const side = Math.round(size * 0.7);
  const x0 = Math.floor((size - side) / 2);
  fillRoundedSquare(rgba, size, x0, x0, side, Math.round(side * 0.22), [...tile, 255]);
  // An enclosed light area inside the tile (the "window" of the glyph): must
  // survive background removal.
  const hole = Math.round(side * 0.34);
  fillRect(rgba, size, Math.floor((size - hole) / 2), Math.floor((size - hole) / 2), hole, hole, [...background, 255]);
  return pngOf(rgba, size);
}

/** A bold subject on a slightly noisy flat background (JPEG-like speckle). */
export function candidateNoisy(size = 512, { background = [244, 244, 244], subject = [220, 50, 38], spread = 6 } = {}) {
  const rgba = canvas(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const n = Math.floor(noiseAt(x, y) * spread);
      setPixel(rgba, size, x, y, [background[0] + n, background[1] + n, background[2] - n, 255]);
    }
  }
  fillCircle(rgba, size, size / 2, size / 2, size * 0.3, [...subject, 255]);
  fillRect(rgba, size, Math.floor(size * 0.28), Math.floor(size * 0.28), Math.floor(size * 0.12), Math.floor(size * 0.12), [30, 30, 30, 255]);
  return pngOf(rgba, size);
}

/** A subject on a vertical gradient background (removal must refuse politely). */
export function candidateGradient(size = 512, { from = [255, 255, 255], to = [200, 210, 235], subject = [20, 20, 20] } = {}) {
  const rgba = canvas(size);
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1);
    for (let x = 0; x < size; x += 1) {
      setPixel(rgba, size, x, y, [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
        255,
      ]);
    }
  }
  fillCircle(rgba, size, size / 2, size / 2, size * 0.32, [...subject, 255]);
  return pngOf(rgba, size);
}

/** A dark subject with a light halo band around it (JPEG ringing). */
export function candidateRinging(size = 512, { background = [255, 255, 255], subject = [40, 90, 180] } = {}) {
  const rgba = canvas(size, [...background, 255]);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance <= radius) {
        setPixel(rgba, size, x, y, [...subject, 255]);
      } else if (distance <= radius + Math.max(2, size * 0.01)) {
        // ringing: a pale copy of the edge colour on the background side
        const mix = 0.25;
        setPixel(rgba, size, x, y, [
          Math.round(subject[0] * mix + background[0] * (1 - mix)),
          Math.round(subject[1] * mix + background[1] * (1 - mix)),
          Math.round(subject[2] * mix + background[2] * (1 - mix)),
          255,
        ]);
      }
    }
  }
  return pngOf(rgba, size);
}

/** An already transparent candidate (a model that returned RGBA). */
export function candidateTransparent(size = 512, { subject = [130, 60, 200] } = {}) {
  const rgba = canvas(size);
  fillRoundedSquare(rgba, size, Math.floor(size * 0.15), Math.floor(size * 0.15), Math.floor(size * 0.7), Math.round(size * 0.16), [...subject, 255]);
  fillCircle(rgba, size, size / 2, size / 2, size * 0.16, [255, 255, 255, 255]);
  return pngOf(rgba, size);
}

/** A minimal JPEG with a valid SOF0 frame header (header validation only). */
export function tinyJpegBytes(width = 128, height = 128) {
  const segments = [];
  segments.push(Buffer.from([0xff, 0xd8])); // SOI
  // APP0/JFIF: marker + length + 14 bytes of payload = 18 bytes.
  const jfif = Buffer.alloc(18);
  jfif[0] = 0xff; jfif[1] = 0xe0; jfif.writeUInt16BE(16, 2);
  jfif.write('JFIF\0', 4, 'binary');
  segments.push(jfif);
  // SOF0: marker + length(11) + precision + height + width + 1 component.
  const sof = Buffer.alloc(13);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(11, 2);
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // one component
  sof[10] = 1; sof[11] = 0x11; sof[12] = 0;
  segments.push(sof);
  segments.push(Buffer.from([0xff, 0xd9])); // EOI
  return Buffer.concat(segments);
}

/** A minimal WebP (VP8L lossless header only), for header validation. */
export function tinyWebpBytes(width = 256, height = 256) {
  // VP8L: 'RIFF' <size> 'WEBP' 'VP8L' <chunk size> <signature 0x2f> <bits>.
  // The validator reads the dimensions from the bits word; the payload is not
  // decoded by any test.
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(bits, 1);
  const chunk = Buffer.alloc(8);
  chunk.write('VP8L', 0, 'ascii');
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk, payload]);
  // 'RIFF' containers: fourcc + size + 'WEBP' + chunks; the size counts the
  // bytes after the size field itself.
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
