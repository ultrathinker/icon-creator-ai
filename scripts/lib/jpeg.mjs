// A baseline JPEG decoder, written for this plugin so a Google image
// response (the service returns JPEG only — verified live on 2026-10-03:
// the Interactions API refuses mime_type image/png with "Supported values:
// 'image/jpeg'", and generateContent also answers image/jpeg) can be
// normalised to PNG with zero packages. Scope: sequential baseline JPEG
// (SOF0/SOF1), 8-bit precision, Huffman coding, grayscale or YCbCr (1 or 3
// components), one interleaved scan (or one single-component scan), restart
// markers. Progressive JPEG (SOF2), arithmetic coding, 12-bit precision, CMYK
// and multi-scan sequential files are REFUSED with a clear error; the caller
// keeps the raw file and warns, instead of guessing.
const MAX_SIDE = 16384;
const MAX_PIXELS = 64 * 1024 * 1024;

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

/** Parse the frame header (SOF) and DHT/DQT tables into a plain structure. */
function parseJpeg(buffer) {
  if (!(buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8)) {
    throw new Error('not a JPEG (missing SOI)');
  }
  let offset = 2;
  let frame = null;
  const quantTables = new Map();
  const huffmanTables = new Map(); // "c< class><id>" -> table
  let restartInterval = 0;
  const scans = [];
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break; // garbage: stop at entropy data without SOS
    let marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    offset += 2;
    if (marker === 0xd9) break; // EOI
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue; // no payload
    const length = buffer.readUInt16BE(offset);
    const segment = buffer.subarray(offset + 2, offset + length);
    if (marker === 0xdb) {
      let p = 0;
      while (p < segment.length) {
        const precision = segment[p] >> 4;
        const id = segment[p] & 0x0f;
        if (precision !== 0) throw new Error('the JPEG uses 16-bit quantization tables; the built-in decoder handles 8-bit only');
        quantTables.set(id, segment.subarray(p + 1, p + 65));
        p += 65;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (frame !== null) throw new Error('the JPEG has more than one frame');
      frame = parseFrame(segment);
    } else if (marker === 0xc2) {
      throw new Error('the JPEG is progressive; the built-in decoder handles baseline only (the raw file is kept)');
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < segment.length) {
        const tableClass = segment[p] >> 4;
        const tableId = segment[p] & 0x0f;
        huffmanTables.set(`${tableClass}${tableId}`, buildHuffman(segment.subarray(p + 1)));
        p += 1 + 16 + segment.subarray(p + 1, p + 17).reduce((sum, value) => sum + value, 0);
      }
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc) {
      // 0xc4 (DHT) and 0xcc (DAC) are not SOF markers; everything else in the
      // range is a frame type this decoder does not handle.
      throw new Error(`the JPEG uses an unsupported SOF type (marker 0x${marker.toString(16)})`);
    } else if (marker === 0xdd) {
      restartInterval = segment.readUInt16BE(0);
    } else if (marker === 0xda) {
      scans.push({ offset: offset + length, header: segment });
      break; // entropy data follows; further markers are reached while decoding
    }
    // APPn, COM and everything else: skipped, metadata never interpreted.
    offset += length;
  }
  if (frame === null) throw new Error('the JPEG has no frame header');
  if (scans.length === 0) throw new Error('the JPEG has no scan');
  return { frame, quantTables, huffmanTables, restartInterval, firstScan: scans[0], buffer };
}

function parseFrame(segment) {
  if (segment.length < 6) throw new Error('the JPEG frame header is truncated');
  const precision = segment[0];
  if (precision !== 8) throw new Error(`the JPEG has ${precision}-bit samples; the built-in decoder handles 8-bit only`);
  const height = segment.readUInt16BE(1);
  const width = segment.readUInt16BE(3);
  const componentCount = segment[5];
  if (componentCount !== 1 && componentCount !== 3) {
    throw new Error(`the JPEG has ${componentCount} components; the built-in decoder handles grayscale and YCbCr (1 or 3) only`);
  }
  if (width === 0 || height === 0 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error(`the JPEG dimensions ${width}x${height} are outside what the built-in decoder accepts`);
  }
  const components = [];
  for (let index = 0; index < componentCount; index += 1) {
    const base = 6 + index * 3;
    const h = segment[base + 1] >> 4;
    const v = segment[base + 1] & 0x0f;
    if (h < 1 || h > 4 || v < 1 || v > 4) throw new Error('the JPEG has an invalid sampling factor');
    components.push({ id: segment[base], h, v, quantId: segment[base + 2] });
  }
  return { width, height, components };
}

/** A canonical Huffman table from the 16 count bytes plus the symbol list. */
function buildHuffman(countsAndSymbols) {
  const counts = countsAndSymbols.subarray(0, 16);
  const symbolCount = counts.reduce((sum, value) => sum + value, 0);
  const symbols = countsAndSymbols.subarray(16, 16 + symbolCount);
  // Fast lookup for short codes plus a walk for the rest: map code value by
  // (length, code). Codes are at most 16 bits, so a 2^16 table is wasteful;
  // store codes in a Map keyed by (length << 16) | code.
  const table = new Map();
  let code = 0;
  let symbolIndex = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let n = 0; n < counts[length - 1]; n += 1) {
      table.set((length << 16) | code, symbols[symbolIndex]);
      symbolIndex += 1;
      code += 1;
    }
    code <<= 1;
  }
  return table;
}

/** Bit reader over the entropy-coded segment, aware of stuffing and restarts. */
class BitReader {
  constructor(buffer, start) {
    this.buffer = buffer;
    this.position = start;
    this.bits = 0;
    this.count = 0;
    this.stoppedAt = null;
  }

  ensure(count) {
    while (this.count < count) {
      if (this.position >= this.buffer.length) {
        this.stoppedAt = this.buffer.length;
        throw new Error('the JPEG entropy data is truncated');
      }
      const byte = this.buffer[this.position];
      if (byte === 0xff) {
        const next = this.position + 1 < this.buffer.length ? this.buffer[this.position + 1] : 0x00;
        if (next === 0x00) {
          this.position += 2; // stuffed literal 0xff
        } else {
          // A marker where entropy data was expected (EOI, or a restart that
          // was not due): the data is cut short or corrupt.
          this.stoppedAt = this.position;
          throw new Error('the JPEG entropy data ends early (a marker appeared where image data was expected)');
        }
      } else {
        this.position += 1;
      }
      this.bits = (this.bits << 8) | byte;
      this.count += 8;
    }
  }

  /** Restart boundary: drop the padding bits of the current byte and skip the RSTn marker. */
  restart() {
    this.bits = 0;
    this.count = 0;
    while (this.buffer[this.position] === 0xff && this.buffer[this.position + 1] === 0xff) this.position += 1;
    const marker = this.buffer[this.position + 1];
    if (this.buffer[this.position] !== 0xff || marker < 0xd0 || marker > 0xd7) {
      throw new Error('the JPEG is missing an expected restart marker');
    }
    this.position += 2;
  }

  receive(count) {
    if (count === 0) return 0;
    this.ensure(count);
    const value = (this.bits >>> (this.count - count)) & ((1 << count) - 1);
    this.count -= count;
    return value;
  }

  decodeHuffman(table) {
    let code = 0;
    for (let length = 1; length <= 16; length += 1) {
      code = (code << 1) | this.receive(1);
      const symbol = table.get((length << 16) | code);
      if (symbol !== undefined) return symbol;
    }
    throw new Error('the JPEG contains an invalid Huffman code');
  }
}

// Separable 8x8 inverse DCT basis (float): accurate enough for icons that are
// immediately downscaled, and simple to verify against the spec formula.
const BASIS = (() => {
  const table = [];
  for (let y = 0; y < 8; y += 1) {
    const row = [];
    for (let u = 0; u < 8; u += 1) {
      row.push(0.5 * Math.cos(((2 * y + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1));
    }
    table.push(row);
  }
  return table;
})();

function idctBlock(coefficients, out, outOffset, outStride) {
  const temp = new Float64Array(64);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1) {
        sum += BASIS[x][u] * coefficients[y * 8 + u];
      }
      temp[y * 8 + x] = sum;
    }
  }
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1) {
        sum += BASIS[y][v] * temp[v * 8 + x];
      }
      out[outOffset + y * outStride + x] = Math.max(0, Math.min(255, Math.round(sum + 128)));
    }
  }
}

/** Extend a received magnitude to its signed value (JPEG spec F.2.2.1). */
function extend(value, count) {
  return count === 0 ? 0 : value < (1 << (count - 1)) ? value - (1 << count) + 1 : value;
}

/**
 * Decode a baseline JPEG into { width, height, rgba }. Throws a clear error
 * for anything the decoder does not handle; callers keep the raw file then.
 */
export function decodeJpeg(buffer) {
  const { frame, quantTables, huffmanTables, restartInterval, firstScan } = parseJpeg(buffer);
  const { width, height, components } = frame;
  // A single-component scan is one block per MCU whatever sampling it declares.
  if (components.length === 1) {
    components[0].h = 1;
    components[0].v = 1;
  }
  const maxH = Math.max(...components.map((component) => component.h));
  const maxV = Math.max(...components.map((component) => component.v));
  const mcuWidth = 8 * maxH;
  const mcuHeight = 8 * maxV;
  const mcusX = Math.ceil(width / mcuWidth);
  const mcusY = Math.ceil(height / mcuHeight);

  for (const component of components) {
    component.blocksX = mcusX * component.h;
    component.blocksY = mcusY * component.v;
    // Whole blocks are written, so the plane is padded up to a block multiple.
    component.planeWidth = component.blocksX * 8;
    component.planeHeight = component.blocksY * 8;
    component.plane = new Uint8Array(component.planeWidth * component.planeHeight);
    // The part of the plane that holds real picture data (the rest is block padding).
    component.validWidth = Math.ceil((width * component.h) / maxH);
    component.validHeight = Math.ceil((height * component.v) / maxV);
    component.prediction = 0;
    if (!quantTables.has(component.quantId)) throw new Error(`the JPEG references quantization table ${component.quantId}, which is not defined`);
  }

  // Scan header: which components, which tables.
  const scanComponents = [];
  for (let index = 0; index < firstScan.header[0]; index += 1) {
    const base = 1 + index * 2;
    const id = firstScan.header[base];
    const component = components.find((entry) => entry.id === id);
    if (component === undefined) throw new Error(`the scan references component ${id}, which the frame does not define`);
    const dcTable = huffmanTables.get(`0${firstScan.header[base + 1] >> 4}`);
    const acTable = huffmanTables.get(`1${firstScan.header[base + 1] & 0x0f}`);
    if (dcTable === undefined || acTable === undefined) throw new Error('the scan references a Huffman table that is not defined');
    scanComponents.push({ component, dcTable, acTable });
  }
  if (scanComponents.length !== components.length) {
    throw new Error('the JPEG stores its components in separate scans; the built-in decoder handles one scan only');
  }
  const interleaved = scanComponents.length > 1;

  const reader = new BitReader(buffer, firstScan.offset);
  const coefficients = new Int16Array(64);
  const totalMcus = interleaved ? mcusX * mcusY : scanComponents[0].component.blocksX * scanComponents[0].component.blocksY;

  for (let step = 0; step < totalMcus; step += 1) {
    if (restartInterval > 0 && step > 0 && step % restartInterval === 0) {
      reader.restart();
      for (const entry of scanComponents) entry.component.prediction = 0;
    }
    if (interleaved) {
      const mcuX = step % mcusX;
      const mcuY = Math.floor(step / mcusX);
      for (const { component, dcTable, acTable } of scanComponents) {
        for (let v = 0; v < component.v; v += 1) {
          for (let h = 0; h < component.h; h += 1) {
            decodeBlock(reader, component, dcTable, acTable, coefficients, quantTables);
            const blockX = mcuX * component.h + h;
            const blockY = mcuY * component.v + v;
            idctBlock(coefficients, component.plane, (blockY * 8) * component.planeWidth + blockX * 8, component.planeWidth);
          }
        }
      }
    } else {
      const { component, dcTable, acTable } = scanComponents[0];
      const blocksX = component.blocksX;
      const blockIndex = step;
      decodeBlock(reader, component, dcTable, acTable, coefficients, quantTables);
      const blockX = blockIndex % blocksX;
      const blockY = Math.floor(blockIndex / blocksX);
      idctBlock(coefficients, component.plane, (blockY * 8) * component.planeWidth + blockX * 8, component.planeWidth);
    }
  }

  // Assemble RGBA from the component planes (YCbCr -> RGB, or gray/N/A).
  const rgba = Buffer.alloc(width * height * 4);
  if (components.length === 1) {
    const [luma] = components;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = luma.plane[y * luma.planeWidth + x];
        const offset = (y * width + x) * 4;
        rgba[offset] = value;
        rgba[offset + 1] = value;
        rgba[offset + 2] = value;
        rgba[offset + 3] = 255;
      }
    }
  } else {
    const [yComp, cbComp, crComp] = components;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const yValue = samplePlane(yComp, x, y, maxH, maxV);
        const cbValue = samplePlane(cbComp, x, y, maxH, maxV);
        const crValue = samplePlane(crComp, x, y, maxH, maxV);
        // (the plane sampler interpolates subsampled chroma, like libjpeg's "fancy" upsampling)
        const offset = (y * width + x) * 4;
        const cb = cbValue - 128;
        const cr = crValue - 128;
        rgba[offset] = clamp(yValue + 1.402 * cr);
        rgba[offset + 1] = clamp(yValue - 0.344136 * cb - 0.714136 * cr);
        rgba[offset + 2] = clamp(yValue + 1.772 * cb);
        rgba[offset + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Sample a component plane at full-resolution (x, y). A plane stored at full
 * resolution is read directly; a subsampled one is interpolated bilinearly
 * between sample centres (the same result as libjpeg's "fancy" upsampling),
 * clamped to the real picture area so block padding never bleeds in.
 */
function samplePlane(component, x, y, maxH, maxV) {
  if (component.h === maxH && component.v === maxV) return component.plane[y * component.planeWidth + x];
  const fx = ((x + 0.5) * component.h) / maxH - 0.5;
  const fy = ((y + 0.5) * component.v) / maxV - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = Math.max(0, Math.min(component.validWidth - 1, x0));
  const xb = Math.max(0, Math.min(component.validWidth - 1, x0 + 1));
  const ya = Math.max(0, Math.min(component.validHeight - 1, y0));
  const yb = Math.max(0, Math.min(component.validHeight - 1, y0 + 1));
  const stride = component.planeWidth;
  const plane = component.plane;
  const top = plane[ya * stride + xa] * (1 - tx) + plane[ya * stride + xb] * tx;
  const bottom = plane[yb * stride + xa] * (1 - tx) + plane[yb * stride + xb] * tx;
  return top * (1 - ty) + bottom * ty;
}

function decodeBlock(reader, component, dcTable, acTable, coefficients, quantTables) {
  coefficients.fill(0);
  const quant = quantTables.get(component.quantId);
  const dcCategory = reader.decodeHuffman(dcTable);
  const diff = extend(reader.receive(dcCategory), dcCategory);
  component.prediction += diff;
  coefficients[0] = component.prediction * quant[0];
  let position = 1;
  while (position < 64) {
    const symbol = reader.decodeHuffman(acTable);
    if (symbol === 0x00) break; // end of block
    const run = symbol >> 4;
    const size = symbol & 0x0f;
    if (size === 0) {
      if (run === 15) {
        position += 16; // ZRL: sixteen zeros
        continue;
      }
      break; // EOB is handled above; anything else here is reserved
    }
    position += run;
    if (position > 63) throw new Error('the JPEG block runs past 63 coefficients');
    const value = extend(reader.receive(size), size);
    coefficients[ZIGZAG[position]] = value * quant[position]; // DQT entries are in zigzag order
    position += 1;
  }
}
