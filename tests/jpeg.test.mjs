// The bundled baseline JPEG decoder, compared with libjpeg (via Pillow) on small fixtures, plus the refusals
// that keep the raw file instead of guessing. Offline: every input is embedded in jpeg-fixtures.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeJpeg } from '../scripts/lib/jpeg.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { acceptImage } from '../mcp/lib/drop.mjs';
import { DECODABLE, PROGRESSIVE_JPEG, CMYK_JPEG, SQUARE_420_JPEG } from './jpeg-fixtures.mjs';

const bytes = (base64) => Buffer.from(base64, 'base64');

/** Mean and maximum absolute difference per channel between our decode and libjpeg's picture. */
function difference(fixture) {
  const ours = decodeJpeg(bytes(fixture.jpeg));
  const reference = decodePng(bytes(fixture.reference));
  assert.equal(ours.width, fixture.width);
  assert.equal(ours.height, fixture.height);
  assert.equal(reference.width, fixture.width);
  assert.equal(reference.height, fixture.height);
  let sum = 0;
  let max = 0;
  const pixels = fixture.width * fixture.height;
  for (let i = 0; i < pixels; i += 1) {
    assert.equal(ours.rgba[i * 4 + 3], 255, 'a JPEG has no transparency');
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(ours.rgba[i * 4 + channel] - reference.rgba[i * 4 + channel]);
      sum += delta;
      if (delta > max) max = delta;
    }
  }
  return { mean: sum / (pixels * 3), max };
}

for (const [name, fixture] of Object.entries(DECODABLE)) {
  test(`jpeg decoder matches libjpeg: ${name}`, () => {
    const { mean, max } = difference(fixture);
    // Measured on the generating machine: mean 0.2-0.4, max 3. The bounds leave room for rounding only.
    assert.ok(mean < 1, `mean difference ${mean.toFixed(2)}`);
    assert.ok(max <= 6, `max difference ${max}`);
  });
}

test('progressive and CMYK JPEGs are refused with a clear reason', () => {
  assert.throws(() => decodeJpeg(bytes(PROGRESSIVE_JPEG)), /progressive/);
  assert.throws(() => decodeJpeg(bytes(CMYK_JPEG)), /4 components/);
});

test('broken inputs are refused, never guessed at', () => {
  const full = bytes(DECODABLE.ycc420Odd.jpeg);
  assert.throws(() => decodeJpeg(Buffer.from('not a jpeg at all')), /not a JPEG/);
  assert.throws(() => decodeJpeg(full.subarray(0, 2)), /no frame header|not a JPEG/);
  assert.throws(() => decodeJpeg(full.subarray(0, Math.floor(full.length * 0.6))), /entropy data|truncated|ends early/);
  // The header ends right after the scan header: no entropy data at all.
  const scanAt = full.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(scanAt > 0);
  assert.throws(() => decodeJpeg(full.subarray(0, scanAt + 2 + 2 + 1 + 6 + 3)), /entropy data|truncated|ends early|no scan/);
});

test('an expected restart marker that is missing is an error', () => {
  const restart = Buffer.from(bytes(DECODABLE.ycc444Restart.jpeg));
  const at = restart.indexOf(Buffer.from([0xff, 0xd0]));
  assert.ok(at > 0, 'the fixture really has a restart marker');
  restart[at] = 0x11;
  restart[at + 1] = 0x11;
  assert.throws(() => decodeJpeg(restart), /restart marker/);
});

test('absurd dimensions are refused before any memory is allocated', () => {
  const huge = Buffer.from(bytes(DECODABLE.ycc444Restart.jpeg));
  const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0);
  huge.writeUInt16BE(65535, sof + 5); // height
  huge.writeUInt16BE(65535, sof + 7); // width
  assert.throws(() => decodeJpeg(huge), /dimensions/);
});

test('a decoded JPEG is normalised to a PNG the pack builder can read', () => {
  const accepted = acceptImage(bytes(SQUARE_420_JPEG));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.width, 128);
  assert.equal(accepted.height, 128);
  assert.equal(accepted.mediaType, 'image/png');
  const back = decodePng(accepted.png);
  assert.equal(back.width, 128);
  assert.equal(back.height, 128);
});

test('a progressive JPEG is kept raw with a warning', () => {
  const accepted = acceptImage(bytes(PROGRESSIVE_JPEG));
  assert.equal(accepted.ok, false);
  assert.equal(accepted.keepRaw, true);
  assert.equal(accepted.format, 'jpeg');
  assert.match(accepted.reason, /progressive/);
});
