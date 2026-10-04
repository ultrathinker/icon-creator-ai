// Pixel operations on 8-bit RGBA buffers, carried over from the sibling
// `icon-creator` plugin (same author, MIT): background removal by flood fill
// from the edges, anti-aliased edge cleaning, area-average downscaling and
// square fitting. Pure functions, no file access.

/** Largest per-channel difference between two RGB triples. */
function channelDistance(r1, g1, b1, r2, g2, b2) {
  return Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));
}

/** The four corner pixels as { r, g, b, a } in the order TL, TR, BL, BR. */
export function cornerPixels(rgba, width, height) {
  const at = (x, y) => {
    const o = (y * width + x) * 4;
    return { r: rgba[o], g: rgba[o + 1], b: rgba[o + 2], a: rgba[o + 3] };
  };
  return [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
}

/**
 * Reference background colour for an explicit "remove": the most common
 * (4 bits per channel) opaque colour on the image border, averaged over the
 * border pixels in that bucket. Returns null when the border has no opaque
 * pixel at all (it is already transparent).
 */
export function borderReference(rgba, width, height) {
  const buckets = new Map();
  const visit = (x, y) => {
    const o = (y * width + x) * 4;
    if (rgba[o + 3] < 245) return;
    const key = ((rgba[o] >> 4) << 8) | ((rgba[o + 1] >> 4) << 4) | (rgba[o + 2] >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += rgba[o];
    bucket.g += rgba[o + 1];
    bucket.b += rgba[o + 2];
    buckets.set(key, bucket);
  };
  for (let x = 0; x < width; x += 1) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    visit(0, y);
    visit(width - 1, y);
  }
  let best = null;
  for (const bucket of buckets.values()) if (best === null || bucket.count > best.count) best = bucket;
  if (best === null) return null;
  return { r: Math.round(best.r / best.count), g: Math.round(best.g / best.count), b: Math.round(best.b / best.count) };
}

/**
 * A flat background that does not show in all four corners: the subject may touch the image edge (even a corner), and
 * a JPEG may be noisy. The dominant colour of the border is the background when at least 60 % of the opaque border
 * pixels are within `tolerance` of it and the rest are clearly something else (more than twice the tolerance away:
 * a subject touching the edge), not a gradient drifting away from it. Returns { reference, share } or null.
 */
export function borderBackground(rgba, width, height, tolerance) {
  const reference = borderReference(rgba, width, height);
  if (reference === null) return null;
  let total = 0;
  let near = 0;
  let far = 0;
  const visit = (x, y) => {
    const o = (y * width + x) * 4;
    if (rgba[o + 3] < 245) return;
    total += 1;
    const distance = channelDistance(rgba[o], rgba[o + 1], rgba[o + 2], reference.r, reference.g, reference.b);
    if (distance <= tolerance) near += 1;
    else if (distance > 2 * tolerance) far += 1;
  };
  for (let x = 0; x < width; x += 1) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    visit(0, y);
    visit(width - 1, y);
  }
  if (total === 0 || near < 0.6 * total) return null;
  if (far < 0.8 * (total - near)) return null;
  return { reference, share: near / total };
}

/** True when all four corners are opaque and within `tolerance` of each other. */
export function cornersUniform(corners, tolerance) {
  if (corners.some((corner) => corner.a < 245)) return false;
  for (let i = 1; i < corners.length; i += 1) {
    if (channelDistance(corners[0].r, corners[0].g, corners[0].b, corners[i].r, corners[i].g, corners[i].b) > tolerance) return false;
  }
  return true;
}

/** Mean colour of the four corners (used as the reference after the uniformity test). */
export function meanColor(corners) {
  const n = corners.length;
  return {
    r: Math.round(corners.reduce((sum, c) => sum + c.r, 0) / n),
    g: Math.round(corners.reduce((sum, c) => sum + c.g, 0) / n),
    b: Math.round(corners.reduce((sum, c) => sum + c.b, 0) / n),
  };
}

const FRINGE_DEPTH = 2;
const CORE_RADIUS = 3;

/**
 * Make the background transparent. The background is every pixel within
 * `tolerance` (largest per-channel difference) of `reference` that is
 * connected to the image border through such pixels (4-connected flood fill),
 * so enclosed light areas inside the motif survive. The fringe of pixels
 * just inside that region (up to two pixels deep) holds anti-aliased blends of
 * motif and background; each gets a coverage alpha by projecting its colour
 * onto the line from the background to the nearby motif colour, and the
 * background share is un-mixed from its colour, so no light halo is left.
 *
 * Returns a new buffer plus counts: `transparent` (pixels that were visible
 * and are now fully transparent) and `softened` (pixels made partly
 * transparent by the edge cleaning).
 */
export function removeBackground(rgba, width, height, reference, tolerance) {
  const total = width * height;
  const out = Buffer.from(rgba);
  const distanceToReference = (index) => {
    const o = index * 4;
    const alpha = rgba[o + 3];
    if (alpha <= 8) return 0; // already transparent: part of the background
    let r = rgba[o];
    let g = rgba[o + 1];
    let b = rgba[o + 2];
    if (alpha < 255) {
      const k = alpha / 255;
      r = r * k + reference.r * (1 - k);
      g = g * k + reference.g * (1 - k);
      b = b * k + reference.b * (1 - k);
    }
    return channelDistance(r, g, b, reference.r, reference.g, reference.b);
  };

  const state = new Uint8Array(total); // 0 unvisited, 1 background, 2 fringe 1, 3 fringe 2
  const stack = new Int32Array(total);
  let top = 0;
  const seed = (x, y) => {
    const index = y * width + x;
    if (state[index] === 0 && distanceToReference(index) <= tolerance) {
      state[index] = 1;
      stack[top] = index;
      top += 1;
    }
  };
  for (let x = 0; x < width; x += 1) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    seed(0, y);
    seed(width - 1, y);
  }
  while (top > 0) {
    top -= 1;
    const index = stack[top];
    const x = index % width;
    const y = (index - x) / width;
    const neighbours = [];
    if (x > 0) neighbours.push(index - 1);
    if (x < width - 1) neighbours.push(index + 1);
    if (y > 0) neighbours.push(index - width);
    if (y < height - 1) neighbours.push(index + width);
    for (const next of neighbours) {
      if (state[next] === 0 && distanceToReference(next) <= tolerance) {
        state[next] = 1;
        stack[top] = next;
        top += 1;
      }
    }
  }

  // Fringe layers: grow from the background FRINGE_DEPTH pixels deep. The
  // layers live in `state` (1 background, 2 first fringe layer, 3 second), so
  // no per-pixel lists are kept and memory stays proportional to the image.
  for (let depth = 1; depth <= FRINGE_DEPTH; depth += 1) {
    for (let index = 0; index < total; index += 1) {
      if (state[index] !== depth) continue;
      const x = index % width;
      if (x > 0 && state[index - 1] === 0) state[index - 1] = depth + 1;
      if (x < width - 1 && state[index + 1] === 0) state[index + 1] = depth + 1;
      if (index >= width && state[index - width] === 0) state[index - width] = depth + 1;
      if (index < total - width && state[index + width] === 0) state[index + width] = depth + 1;
    }
  }

  let transparent = 0;
  let softened = 0;
  for (let index = 0; index < total; index += 1) {
    if (state[index] !== 1) continue;
    if (rgba[index * 4 + 3] > 0) transparent += 1;
    out[index * 4] = 0;
    out[index * 4 + 1] = 0;
    out[index * 4 + 2] = 0;
    out[index * 4 + 3] = 0;
  }
  for (let index = 0; index < total; index += 1) {
    if (state[index] < 2) continue;
    const x = index % width;
    const y = (index - x) / width;
    // Motif colour near this pixel: mean of opaque pixels that are neither
    // background nor fringe within CORE_RADIUS.
    let count = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let yy = Math.max(0, y - CORE_RADIUS); yy <= Math.min(height - 1, y + CORE_RADIUS); yy += 1) {
      for (let xx = Math.max(0, x - CORE_RADIUS); xx <= Math.min(width - 1, x + CORE_RADIUS); xx += 1) {
        const neighbour = yy * width + xx;
        if (state[neighbour] === 0 && rgba[neighbour * 4 + 3] >= 250) {
          count += 1;
          sumR += rgba[neighbour * 4];
          sumG += rgba[neighbour * 4 + 1];
          sumB += rgba[neighbour * 4 + 2];
        }
      }
    }
    if (count === 0) continue; // a thin line with no solid motif around it: keep as is
    const motif = { r: sumR / count, g: sumG / count, b: sumB / count };
    const vr = motif.r - reference.r;
    const vg = motif.g - reference.g;
    const vb = motif.b - reference.b;
    const span = vr * vr + vg * vg + vb * vb;
    if (Math.max(Math.abs(vr), Math.abs(vg), Math.abs(vb)) <= tolerance) continue; // motif too close to the background to separate
    const o = index * 4;
    const pr = rgba[o] - reference.r;
    const pg = rgba[o + 1] - reference.g;
    const pb = rgba[o + 2] - reference.b;
    const coverage = Math.min(1, Math.max(0, (pr * vr + pg * vg + pb * vb) / span));
    if (coverage >= 0.98) continue;
    if (coverage < 0.04) {
      if (rgba[o + 3] > 0) transparent += 1;
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    out[o] = clamp(reference.r + pr / coverage);
    out[o + 1] = clamp(reference.g + pg / coverage);
    out[o + 2] = clamp(reference.b + pb / coverage);
    out[o + 3] = Math.round(rgba[o + 3] * coverage);
    softened += 1;
  }
  return { rgba: out, transparent, softened };
}

/**
 * Area-average (box filter) resize in premultiplied alpha, so transparent
 * pixels never bleed colour into the edges. Intended for shrinking; equal
 * sizes return the input unchanged.
 */
export function resizeArea(rgba, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) return Buffer.from(rgba);
  const stepX = sourceWidth / targetWidth;
  const stepY = sourceHeight / targetHeight;
  // Horizontal pass: targetWidth x sourceHeight, premultiplied floats.
  const middle = new Float32Array(targetWidth * sourceHeight * 4);
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const from = tx * stepX;
      const to = from + stepX;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let x = Math.floor(from); x < Math.min(sourceWidth, Math.ceil(to)); x += 1) {
        const weight = Math.min(to, x + 1) - Math.max(from, x);
        const o = (y * sourceWidth + x) * 4;
        const alpha = rgba[o + 3] / 255;
        r += rgba[o] * alpha * weight;
        g += rgba[o + 1] * alpha * weight;
        b += rgba[o + 2] * alpha * weight;
        a += alpha * weight;
      }
      const m = (y * targetWidth + tx) * 4;
      middle[m] = r / stepX;
      middle[m + 1] = g / stepX;
      middle[m + 2] = b / stepX;
      middle[m + 3] = a / stepX;
    }
  }
  const out = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const from = ty * stepY;
    const to = from + stepY;
    for (let x = 0; x < targetWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = Math.floor(from); y < Math.min(sourceHeight, Math.ceil(to)); y += 1) {
        const weight = Math.min(to, y + 1) - Math.max(from, y);
        const m = (y * targetWidth + x) * 4;
        r += middle[m] * weight;
        g += middle[m + 1] * weight;
        b += middle[m + 2] * weight;
        a += middle[m + 3] * weight;
      }
      a /= stepY;
      const o = (ty * targetWidth + x) * 4;
      if (a > 0.0005) {
        out[o] = Math.min(255, Math.round(r / stepY / a));
        out[o + 1] = Math.min(255, Math.round(g / stepY / a));
        out[o + 2] = Math.min(255, Math.round(b / stepY / a));
        out[o + 3] = Math.min(255, Math.round(a * 255));
      }
    }
  }
  return out;
}

/**
 * Fit a picture into a square transparent canvas: never stretched or cropped,
 * centred, shrunk (never enlarged) so the longer side is at most `maxSize`.
 * Returns { size, rgba, content: {x, y, width, height}, padded, downscaled }.
 */
export function fitToSquare(rgba, width, height, maxSize) {
  const longest = Math.max(width, height);
  const size = Math.min(longest, maxSize);
  const scale = size / longest;
  const contentWidth = scale === 1 ? width : Math.max(1, Math.round(width * scale));
  const contentHeight = scale === 1 ? height : Math.max(1, Math.round(height * scale));
  const content = resizeArea(rgba, width, height, contentWidth, contentHeight);
  const canvas = Buffer.alloc(size * size * 4);
  const left = Math.floor((size - contentWidth) / 2);
  const topOffset = Math.floor((size - contentHeight) / 2);
  for (let y = 0; y < contentHeight; y += 1) {
    content.copy(canvas, ((topOffset + y) * size + left) * 4, y * contentWidth * 4, (y + 1) * contentWidth * 4);
  }
  return {
    size,
    rgba: canvas,
    content: { x: left, y: topOffset, width: contentWidth, height: contentHeight },
    padded: contentWidth !== size || contentHeight !== size,
    downscaled: scale !== 1,
  };
}

/** Renderings up to this many px get a light sharpening after the shrink (see shrinkForIcon). */
export const SHARPEN_MAX_SIZE = 48;
/** Strength of that sharpening: measured on real candidates, 0.5 crisps eyes and edges at 16/32 px, 1.0 starts to halo. */
export const SHARPEN_AMOUNT = 0.5;

/**
 * Unsharp mask on the colour of a small square rendering: out = c + amount * (c - blur3x3(c)), the blur weighted by
 * alpha so transparent pixels never pull colour into an edge. Alpha is never changed (no halo outside the shape) and
 * fully transparent pixels stay as they are.
 */
export function sharpenSmall(rgba, size, amount = SHARPEN_AMOUNT) {
  const out = Buffer.from(rgba);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      if (rgba[o + 3] === 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const q = (yy * size + xx) * 4;
            const w = (rgba[q + 3] / 255) * (dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1);
            sum += rgba[q + channel] * w;
            weight += w;
          }
        }
        const blur = weight > 0 ? sum / weight : rgba[o + channel];
        out[o + channel] = Math.max(0, Math.min(255, Math.round(rgba[o + channel] + amount * (rgba[o + channel] - blur))));
      }
    }
  }
  return out;
}

/**
 * Shrink a square master to `size` px for an icon file: the area-average resize, and for the small sizes (up to
 * SHARPEN_MAX_SIZE px) a light sharpening on top, because a box filter softens a 16 or 32 px rendering. A size equal to
 * the master is the master itself, untouched. `sharpen: false` gives the plain resize.
 */
export function shrinkForIcon(rgba, sourceSize, size, { sharpen = true } = {}) {
  const small = resizeArea(rgba, sourceSize, sourceSize, size, size);
  if (!sharpen || size >= sourceSize || size > SHARPEN_MAX_SIZE) return small;
  return sharpenSmall(small, size);
}
