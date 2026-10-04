// Contact sheets: one PNG per eight candidates, composed in pure Node. Each
// block shows the processed icon (background removed, the same preparation
// the pack builder uses) on a transparency checkerboard and on a dark tile,
// plus the 64, 32 and 16 px renderings next to it, with the candidate number
// drawn by a small built-in 3x5 bitmap font. Everything a reviewer needs to
// judge small-size legibility in one picture.

import { encodePng } from './png.mjs';
import { resizeArea, shrinkForIcon } from './pixels.mjs';
import { prepareCandidate } from './packbuild.mjs';

export const SHEET_PER_PAGE = 8;
export const SHEET_COLUMNS = 4;

// Block geometry (pixels): header strip, two 144 px preview tiles, the small size row under them, and gaps around everything. The icon fills its tile exactly (the
// previews are 144 px, the 64/32/16 px renderings sit on tiles of their own
// size): a sheet must show an icon as the real file looks, with no margin of
// the sheet's own around it.
const HEADER = 34;
const TILE = 144;
const ICON = TILE;
const SMALL_ROW = 76;
const GAP = 10;
const PAD = 12;
const BLOCK_WIDTH = PAD + TILE + GAP + TILE + PAD;
const BLOCK_HEIGHT = HEADER + TILE + GAP + SMALL_ROW + PAD;
const DARK = [24, 27, 33]; // the dark preview tile, and the tiles of the small renderings under it

// A 3x5 bitmap font for the digits 0-9 (columns left to right, rows top to
// bottom). Numbers up to 16 need two digits; a one-pixel space separates them.
const DIGITS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

const FONT_SCALE = 4; // 3x5 glyphs drawn at 12x20

/** Draw `number` at (x0, y0) in `color`. Returns the width used. */
export function drawNumber(canvas, canvasWidth, x0, y0, number, color = [24, 26, 30]) {
  const text = String(number);
  let x = x0;
  for (const character of text) {
    const glyph = DIGITS[character];
    if (glyph === undefined) continue;
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row][column] !== '1') continue;
        for (let dy = 0; dy < FONT_SCALE; dy += 1) {
          for (let dx = 0; dx < FONT_SCALE; dx += 1) {
            const px = x + column * FONT_SCALE + dx;
            const py = y0 + row * FONT_SCALE + dy;
            const offset = (py * canvasWidth + px) * 4;
            canvas[offset] = color[0];
            canvas[offset + 1] = color[1];
            canvas[offset + 2] = color[2];
            canvas[offset + 3] = 255;
          }
        }
      }
    }
    x += 4 * FONT_SCALE; // glyph plus one pixel of space
  }
  return x - x0;
}

function fillRectOn(canvas, canvasWidth, x0, y0, width, height, color) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      const offset = (y * canvasWidth + x) * 4;
      canvas[offset] = color[0];
      canvas[offset + 1] = color[1];
      canvas[offset + 2] = color[2];
      canvas[offset + 3] = 255;
    }
  }
}

/** Alpha-blend an RGBA icon onto the opaque canvas, centred in a tile. */
function blitCentered(canvas, canvasWidth, icon, size, tileX, tileY, tileSize) {
  const x0 = tileX + Math.floor((tileSize - size) / 2);
  const y0 = tileY + Math.floor((tileSize - size) / 2);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const source = (y * size + x) * 4;
      const alpha = icon[source + 3] / 255;
      const destination = ((y0 + y) * canvasWidth + x0 + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const background = canvas[destination + channel];
        canvas[destination + channel] = Math.round(icon[source + channel] * alpha + background * (1 - alpha));
      }
      canvas[destination + 3] = 255;
    }
  }
}

function checkerTile(canvas, canvasWidth, x0, y0, size) {
  const cell = 8;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const light = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const offset = ((y0 + y) * canvasWidth + x0 + x) * 4;
      const value = light ? 255 : 214;
      canvas[offset] = value;
      canvas[offset + 1] = value;
      canvas[offset + 2] = value;
      canvas[offset + 3] = 255;
    }
  }
}

/**
 * Compose one sheet PNG for up to SHEET_PER_PAGE prepared candidates.
 * `candidates` is [{ number, prepared }] in display order; `prepared` comes
 * from prepareCandidate. Pure: returns the PNG Buffer.
 */
export function composeSheet(candidates, { sharpen = true } = {}) {
  if (candidates.length === 0 || candidates.length > SHEET_PER_PAGE) {
    throw new Error(`a sheet holds 1..${SHEET_PER_PAGE} candidates, got ${candidates.length}`);
  }
  const rows = Math.ceil(candidates.length / SHEET_COLUMNS);
  const width = PAD + SHEET_COLUMNS * (BLOCK_WIDTH + GAP);
  const height = PAD + rows * (BLOCK_HEIGHT + GAP);
  const canvas = Buffer.alloc(width * height * 4);
  fillRectOn(canvas, width, 0, 0, width, height, [245, 246, 248]);

  candidates.forEach(({ number, prepared }, index) => {
    const column = index % SHEET_COLUMNS;
    const row = Math.floor(index / SHEET_COLUMNS);
    const bx = PAD + column * (BLOCK_WIDTH + GAP);
    const by = PAD + row * (BLOCK_HEIGHT + GAP);

    // Header: the candidate number.
    fillRectOn(canvas, width, bx, by, BLOCK_WIDTH, HEADER, [232, 234, 238]);
    drawNumber(canvas, width, bx + 8, by + 7, number);

    const preview = resizeArea(prepared.rgba, prepared.size, prepared.size, ICON, ICON);
    const tileY = by + HEADER;

    // Preview 1: transparency checkerboard.
    checkerTile(canvas, width, bx + PAD, tileY, TILE);
    blitCentered(canvas, width, preview, ICON, bx + PAD, tileY, TILE);
    // Preview 2: dark tile.
    fillRectOn(canvas, width, bx + PAD + TILE + GAP, tileY, TILE, TILE, DARK);
    blitCentered(canvas, width, preview, ICON, bx + PAD + TILE + GAP, tileY, TILE);

    // Under the previews one white strip with the 64, 32 and 16 px renderings, baseline-aligned at the bottom: under the
    // checkerboard directly on the white, under the dark tile each on a dark tile of exactly its own size (no grey anywhere).
    const rowY = tileY + TILE + GAP;
    fillRectOn(canvas, width, bx + PAD, rowY, 2 * TILE + GAP, SMALL_ROW, [255, 255, 255]);
    for (const [x0, dark] of [[bx + PAD, false], [bx + PAD + TILE + GAP, true]]) {
      let sx = x0 + 8;
      for (const size of [64, 32, 16]) {
        const icon = shrinkForIcon(prepared.rgba, prepared.size, size, { sharpen });
        const smallY = rowY + SMALL_ROW - size - 4;
        if (dark) fillRectOn(canvas, width, sx, smallY, size, size, DARK);
        blitCentered(canvas, width, icon, size, sx, smallY, size);
        sx += size + 8;
      }
    }
  });
  return encodePng(width, height, canvas);
}

/**
 * Build every sheet for a run: prepares each candidate PNG (the same
 * preparation the packs use) and returns [{ file: 'sheet-1.png', png, count }].
 */
export function buildSheets(candidates, options = {}) {
  return sheetsFromPrepared(
    candidates.map((entry, index) =>
      Buffer.isBuffer(entry)
        ? { number: index + 1, prepared: prepareCandidate(entry, options) }
        : { number: entry.number, prepared: entry.prepared ?? prepareCandidate(entry.buffer, options) },
    ),
  );
}

/**
 * Pages of up to SHEET_PER_PAGE candidates, each drawn with its OWN number: the k of
 * candidate-k, so that a sheet and pack-k always agree even when a file in between was skipped.
 */
export function sheetsFromPrepared(items, { firstSheet = 1, sharpen = true, series = null } = {}) {
  const sheets = [];
  for (let page = 0; page * SHEET_PER_PAGE < items.length; page += 1) {
    const candidates = items.slice(page * SHEET_PER_PAGE, (page + 1) * SHEET_PER_PAGE);
    sheets.push({ file: `sheet-${series === null ? '' : `${series}-`}${firstSheet + page}.png`, png: composeSheet(candidates, { sharpen }), count: candidates.length });
  }
  return sheets;
}
