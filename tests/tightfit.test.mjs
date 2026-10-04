// Tests of the tight fit: the subject is cropped and refitted so it fills the square,
// instead of keeping the wide margin a generated image has (which swallows the
// picture at 32 and 16 px). Synthetic candidates only; no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareCandidate, renderSize, DEFAULT_FILL } from '../scripts/lib/packbuild.mjs';
import { tightFit, assertFill } from '../scripts/lib/tightfit.mjs';
import { decodePng, encodePng } from '../scripts/lib/png.mjs';
import { buildSheets } from '../scripts/lib/sheet.mjs';
import { canvas, fillCircle, fillRect, fillRoundedSquare, setPixel, getPixel, pngOf, candidateTile, candidateGradient } from './helpers.mjs';
import { makeTmpDir } from './tmp.mjs';

const REAL_TMP = fs.realpathSync(os.tmpdir());
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FLAT = [255, 255, 255];
const BLUE = [20, 90, 200];

/** A disc of `fraction` of the frame, at (cx, cy) fractions, on a flat white background. */
function disc(size, fraction, { cx = 0.5, cy = 0.5 } = {}) {
  const rgba = canvas(size, [...FLAT, 255]);
  fillCircle(rgba, size, size * cx, size * cy, (size * fraction) / 2, BLUE);
  return pngOf(rgba, size);
}

/** Bounding box of the pixels with alpha > 24 in a decoded RGBA square: its own code, independent of the module under test. */
function inkOf(rgba, size) {
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rgba[(y * size + x) * 4 + 3] > 24) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  assert.ok(x1 >= 0, 'something is visible');
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Bounding box of the pixels the test drew in BLUE (the subject), whatever else is on the canvas. */
function blueOf(rgba, size) {
  let x0 = size;
  let x1 = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      if (rgba[o + 3] > 200 && rgba[o + 2] > 150 && rgba[o] < 100) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    }
  }
  return { x: x0, width: x1 - x0 + 1 };
}

function marginsOf(box, size) {
  return { left: box.x, top: box.y, right: size - box.x - box.width, bottom: size - box.y - box.height };
}

test('a subject drawn at 70 % of the frame is cropped to fill 96 % of the square', () => {
  const prepared = prepareCandidate(disc(512, 0.7));
  const box = inkOf(prepared.rgba, 512);
  assert.ok(Math.abs(box.width / 512 - DEFAULT_FILL) < 0.01, `width fills ${box.width / 512}`);
  assert.ok(Math.abs(box.height / 512 - DEFAULT_FILL) < 0.01, `height fills ${box.height / 512}`);
  const margins = marginsOf(box, 512);
  assert.ok(Math.abs(margins.left - margins.right) <= 1 && Math.abs(margins.top - margins.bottom) <= 1, 'centred');
  assert.equal(prepared.size, 512, 'the master keeps the generated size');
  assert.equal(prepared.facts.fit.crop.mode, 'subject');
  assert.ok(Math.abs(prepared.facts.fit.crop.enlarge - 1.37) < 0.05, `enlarged ${prepared.facts.fit.crop.enlarge}`);
  assert.deepEqual(prepared.warnings.filter((warning) => warning.code === 'enlarged'), [], 'a normal enlargement is not a warning');
});

test('an off-centre subject is moved to the centre', () => {
  const prepared = prepareCandidate(disc(512, 0.5, { cx: 0.3, cy: 0.66 }));
  const margins = marginsOf(inkOf(prepared.rgba, 512), 512);
  assert.ok(Math.abs(margins.left - margins.right) <= 1, `margins ${JSON.stringify(margins)}`);
  assert.ok(Math.abs(margins.top - margins.bottom) <= 1, `margins ${JSON.stringify(margins)}`);
  assert.ok(margins.left <= 12, 'about 2 % margin');
});

test('a wide subject fills the long side; the short side keeps its proportion', () => {
  const rgba = canvas(512, [...FLAT, 255]);
  fillRect(rgba, 512, 100, 200, 300, 100, BLUE); // 300 x 100
  const prepared = prepareCandidate(pngOf(rgba, 512));
  const box = inkOf(prepared.rgba, 512);
  assert.ok(Math.abs(box.width / 512 - 0.96) < 0.01, `width ${box.width}`);
  assert.ok(Math.abs(box.height / box.width - 1 / 3) < 0.02, `ratio ${box.height / box.width}`);
  const margins = marginsOf(box, 512);
  assert.ok(Math.abs(margins.top - margins.bottom) <= 1, 'centred vertically');
});

test('the reported case: at 16 px a subject that was drawn at 70 % fills the whole icon', () => {
  const source = disc(512, 0.7);
  const tight = renderSize(prepareCandidate(source), 16);
  const legacy = renderSize(prepareCandidate(source, { crop: false }), 16);
  const widthAt16 = (png) => {
    const decoded = decodePng(png);
    return inkOf(decoded.rgba, 16).width;
  };
  assert.ok(widthAt16(tight) >= 15, `tight: ${widthAt16(tight)} of 16 px`);
  assert.ok(widthAt16(legacy) <= 12, `legacy (crop: false): ${widthAt16(legacy)} of 16 px`);
});

test('fill is configurable and validated', () => {
  for (const fill of [0.8, 0.9, 1]) {
    const box = inkOf(prepareCandidate(disc(512, 0.6), { fill }).rgba, 512);
    assert.ok(Math.abs(box.width / 512 - fill) < 0.012, `fill ${fill}: ${box.width / 512}`);
  }
  for (const bad of [0, 0.4, 1.01, -1, NaN, Infinity, '0.9']) {
    assert.throws(() => assertFill(bad), /fill must be a fraction/, String(bad));
    assert.throws(() => prepareCandidate(disc(128, 0.5), { fill: bad }), /fill must be a fraction/, String(bad));
  }
});

test('crop: false keeps the old centred, uncropped fit', () => {
  const prepared = prepareCandidate(disc(512, 0.7), { crop: false });
  const box = inkOf(prepared.rgba, 512);
  assert.ok(Math.abs(box.width / 512 - 0.7) < 0.01, `width ${box.width / 512}`);
  assert.equal(prepared.facts.fit.crop.mode, 'off');
});

test('a stray speck far from the subject does not widen the crop', () => {
  const rgba = canvas(512, [...FLAT, 255]);
  fillCircle(rgba, 512, 256, 256, 180, BLUE);
  setPixel(rgba, 512, 6, 6, [0, 0, 0, 255]); // one dark pixel the background removal could not reach
  const box = blueOf(prepareCandidate(pngOf(rgba, 512)).rgba, 512);
  assert.ok(box.width / 512 > 0.94 && box.width / 512 < 0.98, `the disc fills ${box.width / 512}, not the speck-wide box`);
});

test('a subject that already fills the frame is shrunk to leave the margin, never cropped away', () => {
  const rgba = canvas(512, [...FLAT, 255]);
  fillCircle(rgba, 512, 256, 256, 256, BLUE); // touches all four sides
  const box = inkOf(prepareCandidate(pngOf(rgba, 512)).rgba, 512);
  assert.ok(box.width / 512 <= 0.97 && box.width / 512 >= 0.94, `fill ${box.width / 512}`);
});

test('an opaque tile with a picture in it is cropped to the picture and stays one opaque colour', () => {
  const size = 512;
  const rgba = canvas(size, [...FLAT, 255]);
  const TILE = [14, 18, 28];
  fillRoundedSquare(rgba, size, 20, 20, 472, 90, TILE);
  fillCircle(rgba, size, 256, 256, 120, [60, 220, 255]); // the picture: a bright disc, 240 px wide
  const prepared = prepareCandidate(pngOf(rgba, size));
  assert.equal(prepared.facts.fit.crop.mode, 'tile');
  assert.ok(prepared.warnings.some((warning) => warning.code === 'tile-recropped'));
  const decoded = decodePng(prepared.png);
  for (let o = 3; o < decoded.rgba.length; o += 4) assert.equal(decoded.rgba[o], 255, 'fully opaque, corners included');
  assert.deepEqual(getPixel(decoded.rgba, size, 0, 0).slice(0, 3), TILE, 'the corner has the tile colour');
  assert.deepEqual(getPixel(decoded.rgba, size, size - 1, size - 1).slice(0, 3), TILE);
  // The picture (bright pixels) now fills 96 % of the square.
  let x0 = size;
  let x1 = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g] = getPixel(decoded.rgba, size, x, y);
      if (g > 150 && r < 150) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    }
  }
  assert.ok(Math.abs((x1 - x0 + 1) / size - 0.96) < 0.015, `the picture fills ${(x1 - x0 + 1) / size}`);
});

test('a picture that nearly fills a very round tile: the window reaches the tile corners and still comes out opaque', () => {
  const size = 512;
  const rgba = canvas(size, [...FLAT, 255]);
  const TILE = [14, 18, 28];
  fillRoundedSquare(rgba, size, 20, 20, 472, 150, TILE); // the rounded corners cut deep into the square
  fillCircle(rgba, size, 256, 256, 220, [60, 220, 255]); // a picture 440 px wide: the window is clamped to the tile
  const prepared = prepareCandidate(pngOf(rgba, size));
  assert.equal(prepared.facts.fit.crop.mode, 'tile');
  const decoded = decodePng(prepared.png);
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    assert.deepEqual(getPixel(decoded.rgba, size, x, y), [...TILE, 255], `corner ${x},${y} has the tile colour and is opaque`);
  }
});

test('tile: keep leaves the tile as drawn, cropped to its own outline', () => {
  const size = 512;
  const rgba = canvas(size, [...FLAT, 255]);
  fillRoundedSquare(rgba, size, 20, 20, 472, 90, [14, 18, 28]);
  fillCircle(rgba, size, 256, 256, 120, [60, 220, 255]);
  const prepared = prepareCandidate(pngOf(rgba, size), { tile: 'keep' });
  assert.equal(prepared.facts.fit.crop.mode, 'subject');
  assert.ok(!prepared.warnings.some((warning) => warning.code === 'tile-recropped'));
  assert.equal(prepared.facts.cornerAlphaAfter.every((alpha) => alpha === 0), true, 'the rounded corners stay transparent');
});

test('a mild gradient behind the subject still crops to the subject; the picture stays full-bleed and opaque', () => {
  const prepared = prepareCandidate(candidateGradient(256));
  assert.equal(prepared.facts.fit.crop.mode, 'tile');
  const decoded = decodePng(prepared.png);
  for (let o = 3; o < decoded.rgba.length; o += 4) assert.equal(decoded.rgba[o], 255);
});

test('a picture with a strongly varying background that fills the whole frame is left alone', () => {
  const prepared = prepareCandidate(candidateGradient(256, { from: [255, 0, 0], to: [0, 0, 255] }));
  assert.equal(prepared.facts.fit.crop.mode, 'filled');
  const decoded = decodePng(prepared.png);
  for (let o = 3; o < decoded.rgba.length; o += 4) assert.equal(decoded.rgba[o], 255, 'no transparent border was added');
  assert.equal(prepared.size, 256);
});

test('nothing visible: no crash, a clear warning', () => {
  const prepared = prepareCandidate(encodePng(64, 64, Buffer.alloc(64 * 64 * 4)));
  assert.ok(prepared.warnings.some((warning) => warning.code === 'nothing-visible'));
  assert.equal(prepared.size, 64);
  assert.equal(tightFit(Buffer.alloc(64 * 64 * 4), 64, 64), null);
});

test('the resample leaves no faint ringing outside the edges (alpha 1 or 2)', () => {
  const decoded = decodePng(prepareCandidate(disc(512, 0.6)).png);
  let faint = 0;
  for (let o = 3; o < decoded.rgba.length; o += 4) if (decoded.rgba[o] === 1 || decoded.rgba[o] === 2) faint += 1;
  assert.equal(faint, 0, `${faint} pixels of alpha 1-2`);
});

test('a tiny subject is enlarged a lot, and the warning says the largest sizes will look soft', () => {
  const prepared = prepareCandidate(disc(512, 0.2));
  assert.ok(prepared.facts.fit.crop.enlarge > 4, `enlarged ${prepared.facts.fit.crop.enlarge}`);
  const warning = prepared.warnings.find((entry) => entry.code === 'enlarged');
  assert.ok(warning && /soft/.test(warning.message), 'the warning is there');
});

test('the resample keeps the subject colour and never bleeds the transparent background into the edge', () => {
  const prepared = prepareCandidate(disc(256, 0.5));
  const decoded = decodePng(prepared.png);
  let checked = 0;
  for (let o = 0; o < decoded.rgba.length; o += 4) {
    if (decoded.rgba[o + 3] === 0) continue;
    checked += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      assert.ok(Math.abs(decoded.rgba[o + channel] - BLUE[channel]) <= 4, `edge pixel colour ${decoded.rgba.subarray(o, o + 4)}`);
    }
  }
  assert.ok(checked > 1000);
});

test('a non-square source is cropped on its own pixels and centred in the longer-side square', () => {
  const rgba = Buffer.alloc(128 * 96 * 4, 0);
  for (let y = 0; y < 96; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      if (Math.hypot(x - 64, y - 48) <= 45) {
        const o = (y * 128 + x) * 4;
        rgba[o] = 10; rgba[o + 1] = 200; rgba[o + 2] = 100; rgba[o + 3] = 255;
      }
    }
  }
  const prepared = prepareCandidate(encodePng(128, 96, rgba));
  assert.equal(prepared.size, 128);
  const box = inkOf(prepared.rgba, 128);
  assert.ok(Math.abs(box.width / 128 - 0.96) < 0.03, `width ${box.width}`);
  assert.ok(Math.abs(box.width - box.height) <= 2, 'a circle stays a circle');
  const content = prepared.facts.fit.content;
  // The visible box is a little wider than the mapped one: the edge is blurred by the enlargement.
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(content[key] - box[key]) <= 4, `content.${key} ${content[key]} vs ${box[key]}`);
});

test('a candidate drawn at 90 % loses little: enlargement stays near 1.07', () => {
  const prepared = prepareCandidate(disc(1024, 0.9));
  assert.ok(Math.abs(prepared.facts.fit.crop.enlarge - 1.07) < 0.03, `enlarged ${prepared.facts.fit.crop.enlarge}`);
});

test('contact sheets and packs use the same crop: the dark tile shows the subject filling its cell', () => {
  const sheets = buildSheets([disc(512, 0.7)]);
  const decoded = decodePng(sheets[0].png);
  // The dark tile starts at x = 178, y = 46 and is 144 px wide; the subject fills 96 % of it.
  // The icon is drawn 128 px wide in the middle of the 144 px tile: it spans x 186..314 at row 118.
  const blueAt = (image, x, y) => image.rgba[(y * image.width + x) * 4 + 2] > 150; // the blue subject, not the dark tile
  assert.ok(blueAt(decoded, 186 + 5, 118), 'the subject reaches almost the left edge of the icon');
  assert.ok(blueAt(decoded, 186 + 128 - 6, 118), 'and the right edge');
  const legacy = decodePng(buildSheets([disc(512, 0.7)], { crop: false })[0].png);
  assert.equal(blueAt(legacy, 186 + 5, 118), false, 'without the crop the same spot is still margin');
});

test('the CLI takes --fill, --no-crop and --keep-tile and rejects a bad --fill', async () => {
  const run = makeTmpDir('icon-ai-tight-');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), disc(512, 0.7));
  const script = path.join(ROOT, 'scripts', 'pack.mjs');
  const widthOf = async (...args) => {
    const out = await execFileAsync(process.execPath, [script, 'build', '--run', run, '--force', ...args]);
    const report = JSON.parse(out.stdout);
    return report.packs[0].facts.ink.bbox.width;
  };
  assert.ok(Math.abs((await widthOf()) / 512 - 0.96) < 0.01, 'default 96 %');
  assert.ok(Math.abs((await widthOf('--fill', '90')) / 512 - 0.9) < 0.012, '--fill 90');
  assert.ok(Math.abs((await widthOf('--no-crop')) / 512 - 0.7) < 0.012, '--no-crop keeps the margin');
  assert.ok((await widthOf('--keep-tile')) / 512 > 0.94, '--keep-tile is accepted');
  await assert.rejects(execFileAsync(process.execPath, [script, 'build', '--run', run, '--fill', '30']), /--fill must be a percentage/);
  await assert.rejects(execFileAsync(process.execPath, [script, 'build', '--run', run, '--fill', 'abc']), /--fill must be a percentage/);
});

test('candidateTile (a rounded tile at 70 % with a glyph hole) is cropped as a subject, not as a full tile', () => {
  const prepared = prepareCandidate(candidateTile(512));
  assert.equal(prepared.facts.fit.crop.mode, 'subject');
  const box = inkOf(prepared.rgba, 512);
  assert.ok(box.width / 512 > 0.94);
});
