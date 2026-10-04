// The 16..48 px renderings get a light sharpening after the shrink (a box filter softens them); larger sizes and the
// master itself do not, and --no-sharpen restores the plain shrink. Synthetic images only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sharpenSmall, shrinkForIcon, resizeArea, SHARPEN_MAX_SIZE } from '../scripts/lib/pixels.mjs';
import { prepareCandidate, buildPack, renderSize } from '../scripts/lib/packbuild.mjs';
import { composeSheet } from '../scripts/lib/sheet.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { canvas, fillCircle, fillRect, pngOf, candidateTile } from './helpers.mjs';
import { makeTmpDir } from './tmp.mjs';

const REAL_TMP = fs.realpathSync(os.tmpdir());
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** A square image: dark left half, light right half, a soft one-pixel transition between them, opaque. */
function softEdge(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      const v = x < size / 2 - 1 ? 60 : x === size / 2 - 1 ? 110 : x === size / 2 ? 170 : 220;
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

test('sharpenSmall raises the contrast across an edge, leaves flat areas, alpha and transparent pixels alone', () => {
  const size = 16;
  const soft = softEdge(size);
  const sharp = sharpenSmall(soft, size);
  const at = (img, x, y) => img[(y * size + x) * 4];
  assert.ok(at(sharp, 6, 8) < at(soft, 6, 8), 'the dark side next to the edge gets darker');
  assert.ok(at(sharp, 9, 8) > at(soft, 9, 8), 'the light side next to the edge gets lighter');
  assert.equal(at(sharp, 1, 8), at(soft, 1, 8), 'a flat area is unchanged');
  assert.equal(at(sharp, 14, 8), at(soft, 14, 8));
  for (let o = 3; o < sharp.length; o += 4) assert.equal(sharp[o], soft[o], 'alpha is never changed');
  // Transparent pixels (with colour data that must not leak) stay exactly as they were; an opaque pixel next to them
  // is not pulled toward their colour.
  const withHole = Buffer.from(soft);
  for (let y = 0; y < size; y += 1) {
    const o = (y * size + 0) * 4;
    withHole[o] = 255; withHole[o + 1] = 0; withHole[o + 2] = 0; withHole[o + 3] = 0;
  }
  const out = sharpenSmall(withHole, size);
  for (let y = 0; y < size; y += 1) assert.deepEqual([...out.subarray(y * size * 4, y * size * 4 + 4)], [255, 0, 0, 0]);
  assert.equal(at(out, 1, 8), 60, 'a flat pixel next to a transparent one keeps its colour (no red pulled in)');
  assert.ok(sharp.every((value) => value >= 0 && value <= 255));
});

test('the sharpening is light: across a clean edge it overshoots by a few percent of the step, never a halo', () => {
  const size = 16;
  const step = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      const v = x < size / 2 ? 60 : 220;
      step[o] = v; step[o + 1] = v; step[o + 2] = v; step[o + 3] = 255;
    }
  }
  const sharp = sharpenSmall(step, size); // the default strength
  const row = [];
  for (let x = 0; x < size; x += 1) row.push(sharp[(8 * size + x) * 4]);
  const undershoot = 60 - Math.min(...row);
  const overshoot = Math.max(...row) - 220;
  assert.ok(undershoot >= 8 && overshoot >= 8, `it does sharpen (${undershoot} / ${overshoot})`);
  assert.ok(undershoot <= 26 && overshoot <= 26, `and it stays light (${undershoot} / ${overshoot} on a step of 160), a stronger filter draws halos`);
});

test('shrinkForIcon sharpens only real shrinks up to 48 px; the master, larger sizes and sharpen:false stay plain', () => {
  const master = 256;
  const rgba = canvas(master);
  fillCircle(rgba, master, 128, 128, 100, [30, 90, 200, 255]);
  fillCircle(rgba, master, 100, 110, 22, [255, 255, 255, 255]);
  for (const size of [16, 24, 32, 48]) {
    const plain = resizeArea(rgba, master, master, size, size);
    assert.notDeepEqual(shrinkForIcon(rgba, master, size), plain, `${size} px is sharpened`);
    assert.deepEqual(shrinkForIcon(rgba, master, size, { sharpen: false }), plain, `${size} px with sharpen:false is the plain shrink`);
  }
  for (const size of [64, 128, 192]) {
    assert.deepEqual(shrinkForIcon(rgba, master, size), resizeArea(rgba, master, master, size, size), `${size} px is not sharpened`);
  }
  assert.equal(SHARPEN_MAX_SIZE, 48);
  // A 32 px master rendered at 32 px is the master itself: never "sharpened".
  const small = canvas(32);
  fillCircle(small, 32, 16, 16, 12, [200, 40, 40, 255]);
  assert.deepEqual(shrinkForIcon(small, 32, 32), resizeArea(small, 32, 32, 32, 32));
});

test('the pack files of 16..48 px are sharpened, larger ones are not, and --no-sharpen is honoured by buildPack', () => {
  const prepared = prepareCandidate(candidateTile(512));
  const render = (options) => {
    const written = new Map();
    buildPack(prepared, { name: 'demo', publish: (rel, buffer) => written.set(rel, buffer), ...options });
    return written;
  };
  const sharp = render({});
  const plain = render({ sharpen: false });
  for (const rel of ['linux/hicolor/16x16/apps/demo.png', 'linux/hicolor/32x32/apps/demo.png', 'linux/hicolor/48x48/apps/demo.png']) {
    assert.ok(!sharp.get(rel).equals(plain.get(rel)), `${rel} differs with sharpening`);
  }
  for (const rel of ['linux/hicolor/64x64/apps/demo.png', 'linux/hicolor/256x256/apps/demo.png', 'web/icon-512.png', 'icon-512.png']) {
    assert.ok(sharp.get(rel).equals(plain.get(rel)), `${rel} is identical (not a small size)`);
  }
  assert.ok(!sharp.get('windows/demo.ico').equals(plain.get('windows/demo.ico')), 'the .ico carries the sharpened small entries');
  assert.ok(sharp.get('linux/hicolor/16x16/apps/demo.png').equals(renderSize(prepared, 16)));
  assert.ok(plain.get('linux/hicolor/16x16/apps/demo.png').equals(renderSize(prepared, 16, { sharpen: false })));
});

test('the contact sheet draws the 32 and 16 px renderings exactly as the files are made, and the 64 px one plain', () => {
  const rgba = canvas(256);
  fillCircle(rgba, 256, 128, 128, 110, [30, 90, 200, 255]);
  fillCircle(rgba, 256, 100, 110, 25, [255, 255, 255, 255]);
  const item = { number: 1, prepared: { size: 256, rgba } };
  const sheetSharp = decodePng(composeSheet([item]));
  const sheetPlain = decodePng(composeSheet([item], { sharpen: false }));
  const region = (sheet, x0, y0, size) => {
    const out = [];
    for (let y = y0; y < y0 + size; y += 1) out.push(sheet.rgba.subarray((y * sheet.width + x0) * 4, (y * sheet.width + x0 + size) * 4).toString('hex'));
    return out.join('|');
  };
  // 64 px at x 32, y 208; 32 px at x 108, y 240; 16 px at x 152, y 256 (see the sheet layout).
  assert.equal(region(sheetSharp, 32, 208, 64), region(sheetPlain, 32, 208, 64), '64 px is identical');
  assert.notEqual(region(sheetSharp, 108, 240, 32), region(sheetPlain, 108, 240, 32), '32 px is sharpened');
  assert.notEqual(region(sheetSharp, 152, 256, 16), region(sheetPlain, 152, 256, 16), '16 px is sharpened');
  assert.equal(region(sheetSharp, 24, 46, 144), region(sheetPlain, 24, 46, 144), 'the big preview is identical');
});

test('the CLI sharpens by default and --no-sharpen gives the plain shrink', async () => {
  const run = makeTmpDir('icon-ai-sharp-');
  const rgba = canvas(512, [255, 255, 255, 255]);
  fillCircle(rgba, 512, 256, 256, 180, [30, 90, 200, 255]);
  fillRect(rgba, 512, 200, 200, 60, 60, [255, 255, 255, 255]);
  fs.writeFileSync(path.join(run, 'candidate-1.png'), pngOf(rgba, 512));
  const script = path.join(ROOT, 'scripts', 'pack.mjs');
  const file = path.join(run, 'pack-1', 'linux', 'hicolor', '16x16', 'apps', 'app.png');
  await execFileAsync(process.execPath, [script, 'build', '--run', run]);
  const sharp = fs.readFileSync(file);
  await execFileAsync(process.execPath, [script, 'build', '--run', run, '--no-sharpen', '--force']);
  const plain = fs.readFileSync(file);
  assert.ok(!sharp.equals(plain), 'the default and --no-sharpen differ at 16 px');
  const big = path.join(run, 'pack-1', 'web', 'icon-512.png');
  const before = fs.readFileSync(big);
  await execFileAsync(process.execPath, [script, 'build', '--run', run, '--force']);
  assert.ok(fs.readFileSync(big).equals(before), 'a 512 px file does not depend on the flag');
  fs.rmSync(run, { recursive: true, force: true });
});
