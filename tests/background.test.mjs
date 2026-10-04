// Background detection when the four corners do not agree: a subject that touches the image edge (a corner included)
// and a noisy flat colour. The whole border decides then; a gradient or a subject that owns the border still does not
// count as a flat background.

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCandidate } from '../scripts/lib/packbuild.mjs';
import { borderBackground } from '../scripts/lib/pixels.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { canvas, fillCircle, fillRect, setPixel, noiseAt, pngOf, candidateGradient } from './helpers.mjs';

const DARK = [40, 40, 44, 255];

test('a subject that runs off the bottom-right corner of the frame still gets its white background removed', () => {
  // The reported case (candidate 10 of a real run): white everywhere except a dark head that touches the corner.
  const size = 512;
  const rgba = canvas(size, [255, 255, 255, 255]);
  fillCircle(rgba, size, 400, 400, 300, DARK); // reaches the right edge, the bottom edge and the corner
  const prepared = prepareCandidate(pngOf(rgba, size));
  assert.equal(prepared.facts.background.action, 'remove');
  assert.match(prepared.facts.background.reason, /border/);
  assert.ok(!prepared.warnings.some((warning) => warning.code === 'background-uncertain'));
  assert.ok(prepared.facts.madeTransparentPercent > 30, `removed ${prepared.facts.madeTransparentPercent}%`);
  const decoded = decodePng(prepared.png);
  // The subject stays opaque, the top-left corner of the master is transparent.
  const alphaAt = (x, y) => decoded.rgba[(y * size + x) * 4 + 3];
  assert.equal(alphaAt(2, 2), 0);
  assert.equal(alphaAt(size - 40, size - 40), 255);
});

test('a flat but noisy colour whose corners differ by more than the tolerance is still a flat background', () => {
  // JPEG noise on a saturated colour: the corners spread over 50 steps, the border as a whole sits within 32 of its colour.
  const size = 384;
  const rgba = canvas(size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const g = 25 + Math.round((noiseAt(x, y, 3) - 0.5) * 50);
      setPixel(rgba, size, x, y, [252, g, 246, 255]);
    }
  }
  setPixel(rgba, size, 0, 0, [253, 2, 253, 255]);
  setPixel(rgba, size, size - 1, size - 1, [244, 55, 235, 255]);
  fillCircle(rgba, size, size / 2, size / 2, 110, [30, 140, 60, 255]);
  const prepared = prepareCandidate(pngOf(rgba, size));
  assert.equal(prepared.facts.background.action, 'remove');
  assert.ok(!prepared.warnings.some((warning) => warning.code === 'background-uncertain'));
  assert.ok(prepared.facts.madeTransparentPercent > 50, `removed ${prepared.facts.madeTransparentPercent}%`);
});

test('a gradient is still not a flat background: its border drifts away from any one colour', () => {
  const prepared = prepareCandidate(candidateGradient(256));
  assert.ok(prepared.warnings.some((warning) => warning.code === 'background-uncertain'));
  assert.equal(prepared.facts.background.action, 'keep');
});

test('a border split half and half between two colours has no single background colour', () => {
  const size = 256;
  const rgba = canvas(size, [255, 255, 255, 255]);
  fillRect(rgba, size, 0, 0, 128, size, [30, 30, 30, 255]); // the left half of the frame is dark: half of the border
  const decoded = decodePng(pngOf(rgba, size));
  assert.equal(borderBackground(decoded.rgba, size, size, 32), null);
  const prepared = prepareCandidate(pngOf(rgba, size));
  assert.ok(prepared.warnings.some((warning) => warning.code === 'background-uncertain'));
});

test('borderBackground: the dominant border colour, its share, and a refusal when the rest merely drifts', () => {
  const size = 200;
  const rgba = canvas(size, [255, 255, 255, 255]);
  fillRect(rgba, size, 0, 100, 40, 100, [10, 10, 10, 255]); // a dark bar on the left edge: a quarter of the border
  const found = borderBackground(rgba, size, size, 32);
  assert.ok(found !== null);
  assert.deepEqual([found.reference.r, found.reference.g, found.reference.b], [255, 255, 255]);
  assert.ok(found.share > 0.7 && found.share < 0.95, `share ${found.share}`);
  // Drift: a band 40 steps from white along the top is neither "near" (65 % of the border still is) nor clearly
  // "something else", so it is a gradient drifting away, not a subject touching the edge.
  const drift = canvas(size, [255, 255, 255, 255]);
  fillRect(drift, size, 0, 0, size, 40, [215, 215, 215, 255]);
  assert.equal(borderBackground(drift, size, size, 32), null);
});
