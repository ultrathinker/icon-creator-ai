// Minimal PNG codec, carried over from the sibling `icon-creator` plugin (same
// author, MIT). Just enough to decode the candidates and build every pack file
// without any dependency. Decoding supports 8-bit, non-interlaced images of
// color type 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha) and 6 (RGBA) —
// everything common encoders write. Encoding always writes 8-bit RGBA with
// filter 0.

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export function crc32(...buffers) {
  let c = 0xffffffff;
  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i += 1) {
      c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(head.subarray(4), data), 0);
  return Buffer.concat([head, data, tail]);
}

/** Encode 8-bit RGBA pixels (Buffer of width*height*4) as a PNG. */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid PNG dimensions ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`Pixel buffer has ${rgba.length} bytes, expected ${width * height * 4}`);
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Read the IHDR of a PNG without decoding pixels. Throws on malformed files. */
export function pngInfo(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature)');
  }
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      return { width, height, bitDepth: buffer[offset + 16], colorType: buffer[offset + 17], interlace: buffer[offset + 20] };
    }
    offset += 12 + length;
  }
  throw new Error('PNG has no IHDR chunk');
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  let prev = null;
  for (let y = 0; y < height; y += 1) {
    if (pos + 1 + stride > raw.length) {
      throw new Error('PNG pixel data is truncated');
    }
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = i >= channels && prev !== null ? prev[i - channels] : 0;
      const x = line[i];
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new Error(`Unsupported PNG filter type ${filter}`);
      }
      cur[i] = value & 0xff;
    }
    prev = cur;
  }
  return out;
}

function expandToRgba(rows, width, height, colorType, palette, transparency) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    switch (colorType) {
      case 6:
        rows.copy(rgba, o, i * 4, i * 4 + 4);
        break;
      case 2:
        rgba[o] = rows[i * 3];
        rgba[o + 1] = rows[i * 3 + 1];
        rgba[o + 2] = rows[i * 3 + 2];
        rgba[o + 3] = 255;
        break;
      case 4:
        rgba[o] = rgba[o + 1] = rgba[o + 2] = rows[i * 2];
        rgba[o + 3] = rows[i * 2 + 1];
        break;
      case 0:
        rgba[o] = rgba[o + 1] = rgba[o + 2] = rows[i];
        rgba[o + 3] = 255;
        break;
      case 3: {
        const index = rows[i];
        const inPalette = index < palette.length / 3;
        rgba[o] = inPalette ? palette[index * 3] : 0;
        rgba[o + 1] = inPalette ? palette[index * 3 + 1] : 0;
        rgba[o + 2] = inPalette ? palette[index * 3 + 2] : 0;
        rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : inPalette ? 255 : 0;
        break;
      }
      default:
        throw new Error(`Unsupported PNG color type ${colorType}`);
    }
  }
  return rgba;
}

/** Decode a PNG into { width, height, rgba, colorType }. */
export function decodePng(buffer) {
  const info = pngInfo(buffer);
  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[info.colorType];
  if (channels === undefined) {
    throw new Error(`Unsupported PNG color type ${info.colorType}`);
  }
  if (info.bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${info.bitDepth} (only 8-bit is handled)`);
  }
  if (info.interlace !== 0) {
    throw new Error('Unsupported PNG: interlaced (Adam7) images are not handled');
  }
  let palette = null;
  let transparency = null;
  const idat = [];
  let offset = 8;
  let sawIend = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length || offset + 12 + length > buffer.length) throw new Error('PNG chunk is truncated');
    const storedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (storedCrc !== crc32(buffer.subarray(offset + 4, offset + 8), data)) {
      throw new Error(`PNG chunk ${type} fails its CRC check (the file is corrupt)`);
    }
    if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IEND') { sawIend = true; break; }
    offset += 12 + length;
  }
  if (!sawIend) throw new Error('PNG has no IEND chunk');
  if (idat.length === 0) throw new Error('PNG has no IDAT chunk');
  if (info.colorType === 3 && palette === null) throw new Error('Palette PNG without a PLTE chunk');
  let raw;
  try {
    // At most what the header declares: a few hundred KB of zlib can otherwise inflate to gigabytes.
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: info.height * (info.width * channels + 1) });
  } catch (error) {
    throw new Error(`PNG pixel data does not decompress (or holds more than its header declares): ${error.message}`);
  }
  const rows = unfilter(raw, info.width, info.height, channels);
  const rgba = expandToRgba(rows, info.width, info.height, info.colorType, palette, transparency);
  return { width: info.width, height: info.height, rgba, colorType: info.colorType };
}

/**
 * Objective measurements of an RGBA image: corner alpha values, the share of
 * visible pixels, and the bounding box of everything visible.
 */
export function analyzeRgba(width, height, rgba) {
  const cornerAlphas = [
    rgba[3],
    rgba[(width - 1) * 4 + 3],
    rgba[(height - 1) * width * 4 + 3],
    rgba[((height - 1) * width + width - 1) * 4 + 3],
  ];
  let visible = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > 0) {
        visible += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    cornerAlphas,
    visibleRatio: visible / (width * height),
    bbox:
      maxX >= 0
        ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
        : null,
  };
}
