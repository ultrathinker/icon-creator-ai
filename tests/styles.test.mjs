// The style picker: every candidate of a run gets a different style, however the ids were requested.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStyles, listStyles, backgroundFor, STYLES } from '../mcp/lib/styles.mjs';

test('requesting the same style twice does not give two candidates the same style', () => {
  const { styles, unknown } = pickStyles(2, { requested: ['flat-glyph', 'flat-glyph'], rng: () => 0 });
  assert.equal(styles.length, 2);
  assert.equal(new Set(styles.map((style) => style.id)).size, 2, 'two different styles');
  assert.equal(styles[0].id, 'flat-glyph', 'the requested style is honoured first');
  assert.deepEqual(unknown, []);
});

test('duplicate unknown ids are reported once', () => {
  const { unknown } = pickStyles(2, { requested: ['no-such', 'no-such', 'flat-glyph'], rng: () => 0 });
  assert.deepEqual(unknown, ['no-such']);
});

test('a picked set is always distinct, for every count and every requested mix', () => {
  const ids = listStyles().map((style) => style.id);
  for (let count = 1; count <= ids.length; count += 1) {
    for (const requested of [[], [ids[0]], [ids[0], ids[0]], [ids[1], ids[0], ids[1], ids[0]], ids.slice(0, count), [...ids, ...ids]]) {
      for (const rng of [() => 0, () => 0.5, () => 0.99]) {
        const { styles } = pickStyles(count, { requested, rng });
        const picked = styles.map((style) => style.id);
        assert.equal(new Set(picked).size, picked.length, `distinct for count ${count} and requested ${JSON.stringify(requested).slice(0, 40)}`);
        assert.equal(picked.length, count, 'as many as asked for, while that many exist');
      }
    }
  }
});

test('styles used by an earlier batch are skipped until the list is exhausted', () => {
  const used = ['flat-glyph', 'neon', 'pixel-art'];
  for (const seed of [0, 0.3, 0.9]) {
    const { styles } = pickStyles(8, { exclude: used, rng: () => seed });
    assert.equal(styles.length, 8);
    assert.equal(new Set(styles.map((style) => style.id)).size, 8);
    assert.ok(styles.every((style) => !used.includes(style.id)), 'eight more are eight new directions');
  }
  // 18 styles, 3 used: asking for 18 must still give 18 distinct ones (the used ones come last).
  const all = pickStyles(STYLES.length, { exclude: used, rng: () => 0.5 }).styles;
  assert.equal(new Set(all.map((style) => style.id)).size, STYLES.length);
  assert.deepEqual(all.slice(-3).map((style) => style.id).sort(), [...used].sort());
  // An explicitly requested style is honoured even when it was used before.
  const { styles } = pickStyles(2, { requested: ['neon'], exclude: used, rng: () => 0 });
  assert.equal(styles[0].id, 'neon');
});

test('every style is drawn on pure white, except the two that would merge into white', () => {
  const black = listStyles().filter((style) => style.background === 'black').map((style) => style.id);
  assert.deepEqual(black.sort(), ['neon', 'sticker']);
  assert.ok(listStyles().every((style) => ['white', 'black'].includes(style.background)));
  const neon = STYLES.find((style) => style.id === 'neon');
  assert.equal(backgroundFor(neon, 'auto'), 'black');
  assert.equal(backgroundFor(neon, 'white'), 'white');
  assert.equal(backgroundFor(STYLES[0], 'auto'), 'white');
  assert.equal(backgroundFor(STYLES[0], 'black'), 'black');
  assert.equal(backgroundFor(STYLES[0], 'as-described'), 'as-described');
});

test('repeat: "more like number 3" fills the whole count with the requested style(s), round-robin', () => {
  const one = pickStyles(4, { requested: ['neon'], repeat: true, rng: () => 0 });
  assert.deepEqual(one.styles.map((style) => style.id), ['neon', 'neon', 'neon', 'neon']);
  const two = pickStyles(5, { requested: ['neon', 'sticker'], repeat: true, rng: () => 0 });
  assert.deepEqual(two.styles.map((style) => style.id), ['neon', 'sticker', 'neon', 'sticker', 'neon']);
  // Without repeat the same request fills up with other, distinct styles (unchanged behaviour).
  const filled = pickStyles(4, { requested: ['neon'], rng: () => 0 });
  assert.equal(new Set(filled.styles.map((style) => style.id)).size, 4);
  // Unknown ids are still reported, and repeat with nothing valid falls back to the normal fill.
  const none = pickStyles(3, { requested: ['no-such'], repeat: true, rng: () => 0 });
  assert.deepEqual(none.unknown, ['no-such']);
  assert.equal(new Set(none.styles.map((style) => style.id)).size, 3);
});
