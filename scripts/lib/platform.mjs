// Platform-specific renderings that cannot be "the master, smaller": the master fills the square edge to edge on a
// transparent background, which is what an icon file wants, but
//   - an iOS home-screen icon (apple-touch-icon) must be OPAQUE (iOS paints transparency black) and is cut to a
//     rounded square, so the picture needs a margin;
//   - an Android/PWA "maskable" icon is cropped to a circle or squircle by the system: everything that matters has to
//     sit inside the central safe zone (a circle of 80 % of the icon's width) on an opaque full-bleed background.
// Both are separate files; the master and every other file keep the picture edge to edge. Pure functions.

import { resizeArea } from './pixels.mjs';
import { encodePng } from './png.mjs';

/** The safe zone of a maskable icon: a circle with a diameter of 80 % of the icon's side. */
export const MASKABLE_SAFE_ZONE = 0.8;
/** The apple-touch icon keeps its picture inside this share of its side (iOS rounds the corners). */
export const APPLE_CONTENT_SHARE = 0.78;
const DARK = [27, 30, 36];
const WHITE = [255, 255, 255];

function luminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The opaque colour that goes behind the picture where an icon needs one: the tile colour of a tile; the mean colour of the
 * edge ring of a picture that fills its frame; for a subject on transparency, white behind a dark subject and a dark
 * neutral behind a light one (mean brightness of its visible pixels).
 */
export function iconBackground(prepared) {
  const crop = prepared.facts?.fit?.crop;
  if (crop?.mode === 'tile' && Array.isArray(crop.tileColor)) return crop.tileColor.map(Math.round);
  const { size, rgba } = prepared;
  const at = (x, y) => (y * size + x) * 4;
  const corners = [at(0, 0), at(size - 1, 0), at(0, size - 1), at(size - 1, size - 1)];
  if (corners.every((o) => rgba[o + 3] > 200)) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const take = (x, y) => {
      const o = at(x, y);
      r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; n += 1;
    };
    for (let i = 0; i < size; i += 1) { take(i, 0); take(i, size - 1); take(0, i); take(size - 1, i); }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }
  let sum = 0;
  let weight = 0;
  for (let o = 0; o < rgba.length; o += 4) {
    if (rgba[o + 3] <= 128) continue;
    sum += luminance(rgba[o], rgba[o + 1], rgba[o + 2]);
    weight += 1;
  }
  return weight > 0 && sum / weight < 0.5 ? WHITE : DARK;
}

export function hexOf([r, g, b]) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Pixels the master is shrunk to inside an `outSize` apple-touch icon. */
export function appleInner(outSize) {
  return Math.round(outSize * APPLE_CONTENT_SHARE);
}

/**
 * How far from the centre of the master its drawing reaches (px of the master). For a subject on transparency that is the
 * farthest visible pixel, so a round subject may use the whole safe-zone circle and a square one fits by its corners; for a
 * tile or a picture that fills its frame (nothing is transparent) it is the farthest corner of the drawing's box.
 */
function reach(prepared) {
  const { size, rgba } = prepared;
  const centre = size / 2;
  const corners = [0, (size - 1) * 4, (size - 1) * size * 4, ((size - 1) * size + size - 1) * 4];
  const opaque = corners.every((o) => rgba[o + 3] > 200);
  const content = prepared.facts?.fit?.content;
  if (opaque && content) {
    let farthest = 0;
    for (const [x, y] of [[content.x, content.y], [content.x + content.width, content.y], [content.x, content.y + content.height], [content.x + content.width, content.y + content.height]]) {
      farthest = Math.max(farthest, Math.hypot(x - centre, y - centre));
    }
    return farthest;
  }
  let farthestSquared = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rgba[(y * size + x) * 4 + 3] <= 40) continue;
      const dx = x + 0.5 - centre;
      const dy = y + 0.5 - centre;
      const d = dx * dx + dy * dy;
      if (d > farthestSquared) farthestSquared = d;
    }
  }
  return Math.sqrt(farthestSquared);
}

/**
 * Pixels the master is shrunk to inside a maskable icon of `outSize`: its farthest drawn pixel from the centre must lie on or
 * inside the safe-zone circle (a radius of 40 % of the icon's side).
 */
export function maskableInner(prepared, outSize) {
  const radius = Math.max(1, reach(prepared));
  const inner = Math.round((prepared.size * (MASKABLE_SAFE_ZONE / 2) * outSize) / radius);
  return Math.max(1, Math.min(outSize, inner));
}

/** An opaque `outSize` x `outSize` PNG: the master shrunk to `inner` px and centred on `background`. */
export function renderOnBackground(prepared, outSize, inner, background) {
  if (inner > prepared.size) throw new Error(`internal error: ${inner} px inside the icon from a ${prepared.size} px master`);
  const small = inner === prepared.size ? prepared.rgba : resizeArea(prepared.rgba, prepared.size, prepared.size, inner, inner);
  const out = Buffer.alloc(outSize * outSize * 4);
  for (let o = 0; o < out.length; o += 4) {
    out[o] = background[0]; out[o + 1] = background[1]; out[o + 2] = background[2]; out[o + 3] = 255;
  }
  const left = Math.floor((outSize - inner) / 2);
  const top = Math.floor((outSize - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const s = (y * inner + x) * 4;
      const d = ((top + y) * outSize + left + x) * 4;
      const a = small[s + 3] / 255;
      for (let c = 0; c < 3; c += 1) out[d + c] = Math.round(small[s + c] * a + out[d + c] * (1 - a));
    }
  }
  return encodePng(outSize, outSize, out);
}

/** WCAG relative luminance of an sRGB colour (0..255 channels). */
function relativeLuminance(r, g, b) {
  const lin = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The dark tile of the contact sheet (24, 27, 33), the colour "a dark theme" is judged against. */
const DARK_TILE_LUMINANCE = relativeLuminance(24, 27, 33);

/**
 * 1 for every pixel whose (2 * radius + 1) square holds an invisible pixel (alpha 32 or less): a box dilation of the
 * invisible mask, as two passes of running sums.
 */
function nearInvisible(rgba, size, radius) {
  const rows = new Uint16Array(size * size);
  const prefix = new Uint32Array(size + 1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) prefix[x + 1] = prefix[x] + (rgba[(y * size + x) * 4 + 3] <= 32 ? 1 : 0);
    for (let x = 0; x < size; x += 1) rows[y * size + x] = prefix[Math.min(size, x + radius + 1)] - prefix[Math.max(0, x - radius)];
  }
  const near = new Uint8Array(size * size);
  const column = new Uint32Array(size + 1);
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) column[y + 1] = column[y] + rows[y * size + x];
    for (let y = 0; y < size; y += 1) near[y * size + x] = column[Math.min(size, y + radius + 1)] - column[Math.max(0, y - radius)] > 0 ? 1 : 0;
  }
  return near;
}

/**
 * How the OUTER EDGE of the drawing reads against a dark and a light background: the mean brightness of the solid
 * pixels (alpha 200 or more) that lie within about 1.2 % of the side from the transparent surround, as WCAG contrast
 * ratios against the sheet's dark tile and against white. Background removal leaves a soft ramp of a pixel or several at
 * the edge, and the pixels of that ramp are blends with the old background, so the rim is measured on the solid pixels
 * just inside it, not on the ramp. A silhouette that is nearly black melts into a dark theme, a pale one into a light
 * page, a neon outline into a white one.
 * Null when the drawing has no transparent surround (a tile or a full picture: its own background carries the contrast).
 */
export function rimContrast(rgba, size) {
  const near = nearInvisible(rgba, size, Math.max(3, Math.round(size * 0.012)));
  let sum = 0;
  let rim = 0;
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    if (rgba[o + 3] < 200 || near[i] === 0) continue;
    sum += relativeLuminance(rgba[o], rgba[o + 1], rgba[o + 2]);
    rim += 1;
  }
  if (rim < 30) return null;
  const luminance = sum / rim;
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return { rimPixels: rim, luminance, onDark: ratio(luminance, DARK_TILE_LUMINANCE), onLight: ratio(luminance, 1) };
}
