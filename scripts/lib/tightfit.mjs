// Tight fit: crop a prepared candidate to its subject and refit it so the subject
// fills the square (about 96 % of the longer side by default), instead of leaving
// the wide empty margin a generated image always has. A margin that looks fine at
// 512 px swallows the picture at 32 and 16 px, so the master itself is cropped.
//
// Two kinds of candidate are told apart:
//   subject — a subject on a transparent background (the background was removed or
//             was already transparent): crop to the visible pixels;
//   tile    — an opaque, uniformly coloured tile with the subject drawn inside it
//             (the tile fills most of the frame): crop to the subject inside the
//             tile and keep the tile colour all the way to the edge.
// The crop is a resample of the pixels the model generated (typically 1.1-1.4x
// larger than they were), not new detail; `enlarge` in the result says by how much.
// Pure: no file access.

export const DEFAULT_FILL = 0.96;
export const MIN_FILL = 0.5;
export const MAX_FILL = 1;
/** A subject drawn larger than this many times looks soft; the caller says so. */
export const SOFT_ENLARGE = 1.6;

const ALPHA_VISIBLE = 24; // a pixel counts as part of a subject above this alpha
const ALPHA_OPAQUE = 200;
const ALPHA_FLOOR = 0.01; // resampled coverage below this is ringing, not picture
const INK_DISTANCE = 48; // how far from the tile colour a pixel must be to count as drawing
const RING_DISTANCE = 40; // how far a ring sample may be from the tile colour before the tile is "not uniform"
const RING_SHARE = 0.85;
const TILE_MIN_COVER = 0.8; // the tile spans at least this much of both frame sides
const TILE_MIN_OPAQUE = 0.9;

export function assertFill(fill) {
  if (!Number.isFinite(fill) || fill < MIN_FILL || fill > MAX_FILL) {
    throw new Error(`fill must be a fraction from ${MIN_FILL} to ${MAX_FILL} (for example ${DEFAULT_FILL})`);
  }
  return fill;
}

/**
 * Bounding box of the pixels for which `isInk(offset)` is true, ignoring isolated specks: a pixel only counts when at
 * least one of its eight neighbours is ink too. A 1 px line or a thin antenna therefore counts (it is a line of
 * neighbours), a single stray pixel the background removal could not reach does not. Null when nothing counts.
 */
function boxOf(width, height, left, top, right, bottom, isInk) {
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) ink[y * w + x] = isInk(((top + y) * width + left + x) * 4) ? 1 : 0;
  }
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (ink[y * w + x] === 0) continue;
      let neighbours = 0;
      for (let dy = -1; dy <= 1 && neighbours === 0; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && ink[yy * w + xx] === 1) {
            neighbours += 1;
            break;
          }
        }
      }
      if (neighbours === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: left + x0, y: top + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Bounding box of the visible (alpha) pixels, or null when nothing is visible. */
export function visibleBox(rgba, width, height) {
  return boxOf(width, height, 0, 0, width, height, (o) => rgba[o + 3] > ALPHA_VISIBLE);
}

function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Is the visible box an opaque tile of one colour? Returns { color: [r,g,b], inset } or null.
 * A tile spans most of the frame, is almost fully opaque inside its box, and a ring just
 * inside its edge (away from the rounded corners) is one colour.
 */
export function findTile(rgba, width, height, box) {
  if (box.width < TILE_MIN_COVER * width || box.height < TILE_MIN_COVER * height) return null;
  let opaque = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) if (rgba[(y * width + x) * 4 + 3] > ALPHA_OPAQUE) opaque += 1;
  }
  if (opaque < TILE_MIN_OPAQUE * box.width * box.height) return null;
  const inset = Math.max(2, Math.round(0.02 * Math.min(box.width, box.height)));
  const samples = [];
  const steps = 24;
  for (let step = 0; step <= steps; step += 1) {
    const t = 0.2 + (0.6 * step) / steps;
    const px = box.x + Math.round(t * (box.width - 1));
    const py = box.y + Math.round(t * (box.height - 1));
    samples.push([px, box.y + inset], [px, box.y + box.height - 1 - inset], [box.x + inset, py], [box.x + box.width - 1 - inset, py]);
  }
  const colors = samples.map(([x, y]) => {
    const o = (y * width + x) * 4;
    return rgba[o + 3] > ALPHA_OPAQUE ? [rgba[o], rgba[o + 1], rgba[o + 2]] : null;
  }).filter((color) => color !== null);
  if (colors.length < 0.8 * samples.length) return null;
  const color = [0, 1, 2].map((channel) => median(colors.map((c) => c[channel])));
  const near = colors.filter((c) => Math.max(Math.abs(c[0] - color[0]), Math.abs(c[1] - color[1]), Math.abs(c[2] - color[2])) <= RING_DISTANCE).length;
  if (near < RING_SHARE * colors.length) return null;
  return { color, inset };
}

/** The square window (in source pixels) in which a `box` of drawing fills `fill` of the longer side. */
export function windowFor(box, fill) {
  const size = Math.max(box.width, box.height) / fill;
  return { x: box.x + box.width / 2 - size / 2, y: box.y + box.height / 2 - size / 2, size };
}

function weights(t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
}

/**
 * Resample the square `win` of the source (outside it, and outside the picture, is transparent)
 * to `out` x `out` px: Catmull-Rom bicubic in premultiplied alpha, so transparent pixels never bleed colour.
 */
export function resampleWindow(rgba, width, height, win, out) {
  const result = Buffer.alloc(out * out * 4);
  const scale = win.size / out;
  for (let oy = 0; oy < out; oy += 1) {
    const sy = win.y + (oy + 0.5) * scale - 0.5;
    const iy = Math.floor(sy);
    const wy = weights(sy - iy);
    for (let ox = 0; ox < out; ox += 1) {
      const sx = win.x + (ox + 0.5) * scale - 0.5;
      const ix = Math.floor(sx);
      const wx = weights(sx - ix);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < 4; j += 1) {
        const py = iy - 1 + j;
        if (py < 0 || py >= height) continue;
        for (let i = 0; i < 4; i += 1) {
          const px = ix - 1 + i;
          if (px < 0 || px >= width) continue;
          const weight = wx[i] * wy[j];
          const o = (py * width + px) * 4;
          const alpha = rgba[o + 3] / 255;
          r += rgba[o] * alpha * weight;
          g += rgba[o + 1] * alpha * weight;
          b += rgba[o + 2] * alpha * weight;
          a += alpha * weight;
        }
      }
      // The cubic's negative lobes ring faintly just outside an edge: below 1 % coverage a pixel stays transparent,
      // and the colour is divided by the unclamped coverage so an overshoot above 1 does not brighten the edge.
      if (a > ALPHA_FLOOR) {
        const o = (oy * out + ox) * 4;
        const channel = (value) => Math.max(0, Math.min(255, Math.round(value / a)));
        result[o] = channel(r);
        result[o + 1] = channel(g);
        result[o + 2] = channel(b);
        result[o + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
  }
  return result;
}

/** The visible box spans the whole frame and all four corners are opaque. */
function coversFrame(rgba, width, height, box) {
  if (box.width < 0.98 * width || box.height < 0.98 * height) return false;
  return [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4].every((o) => rgba[o + 3] > ALPHA_OPAQUE);
}

/** Composite over a solid colour: the result is fully opaque. */
function flattenOver(rgba, color) {
  for (let o = 0; o < rgba.length; o += 4) {
    const alpha = rgba[o + 3] / 255;
    rgba[o] = Math.round(rgba[o] * alpha + color[0] * (1 - alpha));
    rgba[o + 1] = Math.round(rgba[o + 1] * alpha + color[1] * (1 - alpha));
    rgba[o + 2] = Math.round(rgba[o + 2] * alpha + color[2] * (1 - alpha));
    rgba[o + 3] = 255;
  }
}

/**
 * Crop to the subject and refit it into a `size` x `size` master (size = the longer source side).
 * Returns null when there is nothing to fit (no visible pixel); { mode: 'filled' } when the picture already fills the
 * whole frame (nothing to crop); otherwise
 * { size, rgba, mode: 'subject' | 'tile', source: {x,y,width,height}, window, enlarge, content: {x,y,width,height}, tileColor }.
 * `tile: 'keep'` treats a tile like any subject (cropped to its own outline).
 */
export function tightFit(rgba, width, height, { fill = DEFAULT_FILL, tile = 'crop' } = {}) {
  assertFill(fill);
  const box = visibleBox(rgba, width, height);
  if (box === null) return null;
  const size = Math.max(width, height);
  let mode = 'subject';
  let source = box;
  let win = windowFor(box, fill);
  let tileColor = null;
  const found = tile === 'crop' ? findTile(rgba, width, height, box) : null;
  if (found !== null) {
    const left = box.x + found.inset;
    const top = box.y + found.inset;
    const right = box.x + box.width - found.inset;
    const bottom = box.y + box.height - found.inset;
    const [r, g, b] = found.color;
    const ink = boxOf(width, height, left, top, right, bottom, (o) =>
      rgba[o + 3] > ALPHA_OPAQUE && Math.max(Math.abs(rgba[o] - r), Math.abs(rgba[o + 1] - g), Math.abs(rgba[o + 2] - b)) > INK_DISTANCE);
    if (ink !== null) {
      mode = 'tile';
      tileColor = found.color;
      source = ink;
      // The window stays inside the tile (its rounded corners must not come in), centred on the drawing.
      const inner = Math.min(right - left, bottom - top);
      const wanted = Math.min(Math.max(ink.width, ink.height) / fill, inner);
      win = {
        size: wanted,
        x: Math.max(left, Math.min(right - wanted, ink.x + ink.width / 2 - wanted / 2)),
        y: Math.max(top, Math.min(bottom - wanted, ink.y + ink.height / 2 - wanted / 2)),
      };
    }
  }
  if (mode === 'subject' && coversFrame(rgba, width, height, box)) {
    // A picture that fills the whole frame (a gradient or patterned background that was kept): there is no margin to
    // crop, and shrinking it would only add a transparent border around it.
    return { mode: 'filled' };
  }
  const out = resampleWindow(rgba, width, height, win, size);
  if (mode === 'tile') flattenOver(out, tileColor);
  const enlarge = size / win.size;
  // Where the drawing ended up in the master.
  const content = {
    x: Math.round((source.x - win.x) * enlarge),
    y: Math.round((source.y - win.y) * enlarge),
    width: Math.round(source.width * enlarge),
    height: Math.round(source.height * enlarge),
  };
  return { size, rgba: out, mode, source, window: win, enlarge, content, tileColor };
}
