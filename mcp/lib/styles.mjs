// The curated art-style list: every candidate request in a run carries one
// style hint, so eight or sixteen candidates are genuinely different
// directions instead of near copies. The ids are stable (they are stored in
// run.json and named in conversation: "more like number 3").
//
// `background` is the pure flat colour the model is asked to draw behind the
// subject so the background can be removed: white unless the style is built
// from white or glowing parts that would merge into white (a neon glow, a
// sticker's white border), which get black.

export const STYLES = [
  { id: 'flat-glyph', name: 'Flat glyph', hint: 'flat minimal glyph, two or three solid colours, no gradients, crisp edges' },
  { id: 'rounded-tile', name: 'Gradient rounded tile', hint: 'rounded-square app tile with a soft vertical colour gradient and one simple white symbol' },
  { id: 'glossy-3d', name: 'Glossy 3D app icon', hint: 'glossy 3D app icon with a shiny highlight at the top, classic smartphone app style' },
  { id: 'monoline', name: 'Monoline outline', hint: 'single-weight outline icon, uniform stroke width, no fill, elegant and thin' },
  { id: 'geometric', name: 'Geometric minimal', hint: 'geometric minimalism, the subject built from circles, squares and triangles in flat colours' },
  { id: 'isometric', name: 'Isometric', hint: 'isometric 3D illustration, clean edges, soft ambient shading' },
  { id: 'mascot', name: 'Mascot character', hint: 'friendly mascot character made of simple rounded shapes with bold outlines and a cute expression' },
  { id: 'paper-cut', name: 'Paper cut', hint: 'layered paper-cut craft style, solid colours with soft shadows between the layers' },
  { id: 'neon', name: 'Neon on dark', hint: 'glowing neon outline, one accent colour', background: 'black' },
  { id: 'pixel-art', name: 'Pixel art', hint: 'pixel art with chunky visible pixels, high contrast, readable when tiny' },
  { id: 'sticker', name: 'Die-cut sticker', hint: 'die-cut sticker with a bold white border around the subject and a slight gloss', background: 'black' },
  { id: 'material', name: 'Material', hint: 'material design icon, flat colours, subtle long diagonal shadow' },
  { id: 'clay-3d', name: 'Clay 3D', hint: 'handmade clay 3D render, soft studio light, slightly imperfect surfaces' },
  { id: 'low-poly', name: 'Low poly', hint: 'low-poly 3D, faceted flat-shaded triangles, a few colours' },
  { id: 'duotone', name: 'Duotone', hint: 'duotone, exactly two colours, shapes overlapping with a multiply effect' },
  { id: 'line-art', name: 'Technical line art', hint: 'clean black line art like a technical illustration, uniform lines, no shading' },
  { id: 'soft-blob', name: 'Soft gradient blob', hint: 'a smooth blurred gradient blob as the background shape with one white symbol on top' },
  { id: 'negative-space', name: 'Negative space', hint: 'the subject appears as negative space cut out of one solid bold shape' },
];

const BY_ID = new Map(STYLES.map((style) => [style.id, style]));

export function listStyles() {
  return STYLES.map(({ id, name, hint, background }) => ({ id, name, hint, background: background ?? 'white' }));
}

/**
 * The background a candidate of `style` is asked to have. `choice` is the caller's setting: "auto" (the style's own
 * white or black), "white", "black" or "as-described" (no background asked for; the subject sentence describes it).
 */
export function backgroundFor(style, choice = 'auto') {
  if (choice === 'auto') return style.background ?? 'white';
  return choice;
}

/** A style by id, or null. */
export function styleById(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Pick `count` distinct styles. Explicit ids are honoured first (unknown ids
 * are reported, not silently dropped); the rest are filled by rotating
 * through the curated list from a random start so two runs differ.
 */
export function pickStyles(count, { requested = [], exclude = [], repeat = false, rng = Math.random } = {}) {
  if (!Number.isInteger(count) || count < 1) return { styles: [], unknown: [] };
  // Each id counts once: asking for the same style twice must not give two candidates the same style.
  const unknown = [...new Set(requested.filter((id) => !BY_ID.has(id)))];
  const chosen = [...new Set(requested.filter((id) => BY_ID.has(id)))].map((id) => BY_ID.get(id));
  // "More like number 3": every candidate in the requested style(s), round-robin, instead of filling up with other styles.
  if (repeat && chosen.length > 0) {
    return { styles: Array.from({ length: count }, (_, index) => chosen[index % chosen.length]), unknown };
  }
  const start = Math.floor(rng() * STYLES.length);
  // `exclude` is the styles an earlier batch of the same run already used: new candidates take the unused styles first
  // (so "eight more" are eight new directions) and fall back to the used ones only when the list is exhausted.
  const skip = new Set(exclude);
  for (const unusedOnly of [true, false]) {
    for (let index = 0; chosen.length < count && index < STYLES.length; index += 1) {
      const candidate = STYLES[(start + index) % STYLES.length];
      if (unusedOnly && skip.has(candidate.id)) continue;
      if (!chosen.some((style) => style.id === candidate.id)) chosen.push(candidate);
    }
  }
  return { styles: chosen.slice(0, count), unknown };
}
