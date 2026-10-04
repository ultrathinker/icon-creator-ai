// Platform renderings that are not "the master, smaller": the opaque apple-touch icon with a margin, the maskable 512
// icon inside the safe zone, the colour behind them, and the web manifest that carries it. Synthetic candidates only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCandidate, buildPack, planPack } from '../scripts/lib/packbuild.mjs';
import { iconBackground, hexOf, maskableInner, appleInner, renderOnBackground } from '../scripts/lib/platform.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { canvas, fillCircle, fillRect, fillRoundedSquare, pngOf, candidateTile } from './helpers.mjs';

const BLUE = [20, 90, 200, 255];

function written(prepared, name = 'demo') {
  const out = new Map();
  const pack = buildPack(prepared, { name, publish: (rel, buffer) => out.set(rel, buffer) });
  return { files: out, pack };
}

/** A subject on a white background that ends up transparent. */
function subject(color, shape = 'disc') {
  const rgba = canvas(512, [255, 255, 255, 255]);
  if (shape === 'disc') fillCircle(rgba, 512, 256, 256, 170, color);
  else fillRect(rgba, 512, 60, 190, 392, 130, color); // a wide bar: 392 x 130
  return prepareCandidate(pngOf(rgba, 512));
}

test('iconBackground: white behind a dark subject, a dark neutral behind a light one, the tile colour of a tile, the ring of a full picture', () => {
  assert.deepEqual(iconBackground(subject([10, 10, 10, 255])), [255, 255, 255]);
  assert.deepEqual(iconBackground(subject([240, 240, 120, 255])), [27, 30, 36]);
  // A tile with a picture: the tile colour.
  const tileRgba = canvas(512, [255, 255, 255, 255]);
  fillRoundedSquare(tileRgba, 512, 20, 20, 472, 90, [14, 18, 120, 255]);
  fillCircle(tileRgba, 512, 256, 256, 120, [250, 220, 60, 255]);
  const tile = prepareCandidate(pngOf(tileRgba, 512));
  assert.equal(tile.facts.fit.crop.mode, 'tile');
  assert.deepEqual(iconBackground(tile), [14, 18, 120]);
  assert.equal(hexOf([14, 18, 120]), '#0e1278');
  assert.equal(hexOf([255, 255, 255]), '#ffffff');
});

test('the apple-touch icon is opaque, 180 px, with the picture inside a margin; the master and the other icons stay edge to edge', () => {
  const { files } = written(subject(BLUE));
  const apple = decodePng(files.get('web/apple-touch-icon.png'));
  assert.deepEqual([apple.width, apple.height], [180, 180]);
  for (let o = 3; o < apple.rgba.length; o += 4) assert.equal(apple.rgba[o], 255, 'iOS paints transparency black: every pixel is opaque');
  // The outer 15 px ring is the plain background colour (white behind this blue disc).
  const ring = 15;
  for (let y = 0; y < 180; y += 1) {
    for (let x = 0; x < 180; x += 1) {
      if (x >= ring && x < 180 - ring && y >= ring && y < 180 - ring) continue;
      const o = (y * 180 + x) * 4;
      assert.deepEqual([apple.rgba[o], apple.rgba[o + 1], apple.rgba[o + 2]], [255, 255, 255], `ring pixel ${x},${y}`);
    }
  }
  assert.equal(appleInner(180), 140);
  // The 512 px web icon and the master keep the picture edge to edge on transparency.
  for (const rel of ['web/icon-512.png', 'icon-512.png']) {
    const big = decodePng(files.get(rel));
    assert.equal(big.rgba[3], 0, `${rel} keeps its transparent corner`);
  }
});

test('the maskable icon: opaque 512, the whole drawing inside the 80 % safe-zone circle, round or wide', () => {
  for (const shape of ['disc', 'bar']) {
    const prepared = subject(BLUE, shape);
    const { files } = written(prepared);
    const icon = decodePng(files.get('web/icon-maskable-512.png'));
    assert.deepEqual([icon.width, icon.height], [512, 512]);
    for (let o = 3; o < icon.rgba.length; o += 4) assert.equal(icon.rgba[o], 255, 'opaque');
    // Independent check: every pixel that is not the background colour lies within the circle of radius 40 % of the side.
    const bg = iconBackground(prepared);
    let farthest = 0;
    let drawn = 0;
    for (let y = 0; y < 512; y += 1) {
      for (let x = 0; x < 512; x += 1) {
        const o = (y * 512 + x) * 4;
        if (Math.max(Math.abs(icon.rgba[o] - bg[0]), Math.abs(icon.rgba[o + 1] - bg[1]), Math.abs(icon.rgba[o + 2] - bg[2])) > 40) {
          drawn += 1;
          farthest = Math.max(farthest, Math.hypot(x + 0.5 - 256, y + 0.5 - 256));
        }
      }
    }
    assert.ok(drawn > 20_000, `${shape}: the picture is there (${drawn} px)`);
    assert.ok(farthest <= 0.4 * 512 + 3, `${shape}: farthest drawn pixel ${farthest.toFixed(1)} px from the centre, safe radius ${0.4 * 512}`);
    assert.ok(farthest >= 0.4 * 512 - 6, `${shape}: and it uses the safe zone (${farthest.toFixed(1)}), it is not needlessly small`);
  }
  assert.ok(maskableInner(subject(BLUE), 512) < 512 && maskableInner(subject(BLUE), 512) > 250);
});

test('the manifest carries start_url, display, the icon colour and the maskable icon; head.html carries theme-color; all of it matches the files', () => {
  const { files } = written(subject(BLUE));
  const manifest = JSON.parse(files.get('web/site.webmanifest').toString('utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#ffffff');
  assert.equal(manifest.theme_color, '#ffffff');
  assert.deepEqual(manifest.icons.map((icon) => [icon.src, icon.sizes, icon.purpose]), [
    ['/icon-192.png', '192x192', 'any'], ['/icon-512.png', '512x512', 'any'], ['/icon-maskable-512.png', '512x512', 'maskable'],
  ]);
  for (const icon of manifest.icons) assert.ok(files.has(`web/${icon.src.slice(1)}`), `${icon.src} exists in the pack`);
  const head = files.get('web/head.html').toString('utf8');
  assert.match(head, /<meta name="theme-color" content="#ffffff">/);
  assert.match(head, /rel="apple-touch-icon"/);
});

test('without a 512 px master there is no maskable icon, the manifest has no maskable entry, and the file is named as missing', () => {
  for (const master of [192, 256]) {
    const plan = planPack('app', master);
    assert.ok(!plan.files.some((file) => file.rel === 'web/icon-maskable-512.png'), `${master} px`);
    assert.ok(plan.omitted.some((line) => line.startsWith('web/icon-maskable-512.png')));
    const { files } = written(prepareCandidate(candidateTile(master)));
    const manifest = JSON.parse(files.get('web/site.webmanifest').toString('utf8'));
    assert.ok(!manifest.icons.some((icon) => icon.purpose === 'maskable'));
    for (const icon of manifest.icons) assert.ok(files.has(`web/${icon.src.slice(1)}`));
  }
  for (const master of [512, 1024]) {
    assert.ok(planPack('app', master).files.some((file) => file.rel === 'web/icon-maskable-512.png'), `${master} px`);
  }
});

test('renderOnBackground never enlarges the master', () => {
  const prepared = subject(BLUE);
  assert.throws(() => renderOnBackground(prepared, 1024, 600, [255, 255, 255]), /internal error/);
});

// --- how the edge reads on dark and light ----------------------------------------------------------------------------

import { rimContrast } from '../scripts/lib/platform.mjs';

const codes = (prepared) => prepared.warnings.map((warning) => warning.code);

test('a nearly black silhouette fades on a dark background, a pale one on a light one, a mid-tone on neither', () => {
  const black = subject([12, 12, 14, 255]);
  assert.ok(codes(black).includes('fades-on-dark') && !codes(black).includes('fades-on-light'), codes(black).join());
  assert.ok(black.facts.contrast.onDark < 2 && black.facts.contrast.onLight > 8);
  const pale = subject([250, 250, 205, 255]);
  assert.ok(codes(pale).includes('fades-on-light') && !codes(pale).includes('fades-on-dark'), codes(pale).join());
  const blue = subject(BLUE);
  assert.ok(!codes(blue).includes('fades-on-dark') && !codes(blue).includes('fades-on-light'), codes(blue).join());
  assert.match(black.warnings.find((warning) => warning.code === 'fades-on-dark').message, /contrast \d\.\d:1/);
});

test('a neon outline (bright rim, black inside) fades on light, not on dark', () => {
  const rgba = canvas(512, [0, 0, 0, 255]);
  fillCircle(rgba, 512, 256, 256, 170, [60, 255, 230, 255]);
  fillCircle(rgba, 512, 256, 256, 160, [0, 0, 0, 255]);
  const neon = prepareCandidate(pngOf(rgba, 512));
  assert.ok(codes(neon).includes('fades-on-light') && !codes(neon).includes('fades-on-dark'), codes(neon).join());
});

/** A disc of `colour` on white whose edge is a soft ramp of about `ramp` px, like the edge background removal leaves. */
function softDisc(colour, ramp) {
  const rgba = canvas(512, [255, 255, 255, 255]);
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 512; x += 1) {
      const a = Math.min(1, Math.max(0, (170 - Math.hypot(x + 0.5 - 256, y + 0.5 - 256)) / ramp + 0.5));
      const o = (y * 512 + x) * 4;
      for (let c = 0; c < 3; c += 1) rgba[o + c] = Math.round(colour[c] * a + 255 * (1 - a));
    }
  }
  return prepareCandidate(pngOf(rgba, 512));
}

test('a soft edge (a ramp of 0.5 to 5 px) is measured too: a black disc still fades on dark, a pale one on light, blue on neither', () => {
  for (const ramp of [0.5, 1, 1.5, 2, 3, 5]) {
    const black = softDisc([12, 12, 14], ramp);
    assert.notEqual(black.facts.contrast, null, `ramp ${ramp}: the rim is found`);
    assert.ok(codes(black).includes('fades-on-dark') && !codes(black).includes('fades-on-light'), `ramp ${ramp}: ${codes(black).join()}`);
    const pale = softDisc([250, 250, 205], ramp);
    assert.ok(codes(pale).includes('fades-on-light') && !codes(pale).includes('fades-on-dark'), `ramp ${ramp}: ${codes(pale).join()}`);
    const blue = softDisc([20, 90, 200], ramp);
    assert.notEqual(blue.facts.contrast, null);
    assert.ok(!codes(blue).includes('fades-on-dark') && !codes(blue).includes('fades-on-light'), `ramp ${ramp}: ${codes(blue).join()}`);
  }
});

test('a tile, a full picture or an empty image has no transparent surround, so no edge verdict', () => {
  const tile = canvas(512, [255, 255, 255, 255]);
  fillRoundedSquare(tile, 512, 20, 20, 472, 90, [14, 18, 120, 255]);
  fillCircle(tile, 512, 256, 256, 120, [250, 220, 60, 255]);
  const prepared = prepareCandidate(pngOf(tile, 512));
  assert.equal(prepared.facts.contrast, null);
  assert.ok(!codes(prepared).includes('fades-on-dark') && !codes(prepared).includes('fades-on-light'));
  assert.equal(rimContrast(canvas(64), 64), null);
});
