// pack.mjs: a background the prompt described is kept, a rebuild with other settings goes beside the old files
// (--variant), nothing is half-overwritten, the pack name is reused between rounds, and --title.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeServer } from '../mcp/server.mjs';
import { prepareCandidate } from '../scripts/lib/packbuild.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { canvas, fillCircle, pngOf, candidateTile, getPixel } from './helpers.mjs';
import { makeTmpDir } from './tmp.mjs';

const REAL_TMP = fs.realpathSync(os.tmpdir());
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SCRIPT = path.join(ROOT, 'scripts', 'pack.mjs');
const KEY = 'gxgxgxgx-1111-gxgxgxgx-2222';

const tmp = (label) => makeTmpDir(`icon-ai-pcli-${label}-`);
const pack = async (...args) => JSON.parse((await execFileAsync(process.execPath, [SCRIPT, ...args])).stdout);

function hashes(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else out[path.relative(dir, absolute).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** A deep-red full-bleed picture with a white disc: what a model draws for "on a deep red background". */
function redPicture() {
  const rgba = canvas(512, [150, 20, 30, 255]);
  fillCircle(rgba, 512, 256, 256, 140, [250, 250, 250, 255]);
  return pngOf(rgba, 512);
}

function responseWith(buffer) {
  return {
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: buffer.toString('base64') }] }], usage: {} }),
  };
}

test('prepareCandidate: background "keep" skips the removal and says why; the picture is cropped as a full-bleed one', () => {
  const removed = prepareCandidate(redPicture());
  assert.equal(removed.facts.background.action, 'remove', 'by default a flat colour is the background');
  const kept = prepareCandidate(redPicture(), { background: 'keep' });
  assert.equal(kept.facts.background.action, 'keep');
  assert.match(kept.facts.background.reason, /described its own background/);
  assert.ok(!kept.warnings.some((warning) => warning.code === 'background-uncertain' || warning.code === 'opaque-corners'), 'no complaint about what was asked for');
  const decoded = decodePng(kept.png);
  assert.deepEqual(getPixel(decoded.rgba, 512, 0, 0), [150, 20, 30, 255], 'the corner keeps the requested colour');
  for (let o = 3; o < decoded.rgba.length; o += 4) assert.equal(decoded.rgba[o], 255);
});

test('a candidate asked for "as-described" keeps its flat red background in build and sheet; the others are processed as usual', async () => {
  const outDir = tmp('keep');
  let call = 0;
  const server = makeServer({
    env: { ICON_AI_GOOGLE_KEY: KEY },
    fetchImpl: async () => responseWith(call++ % 2 === 0 ? redPicture() : candidateTile(512)),
  });
  const ask = async (args) => JSON.parse((await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_images', arguments: args } })).result.content[0].text);
  const described = await ask({ prompt: 'a game logo on a deep red background', count: 1, out_dir: outDir, background: 'as-described' });
  const run = described.runDir;
  const normal = await ask({ prompt: 'a game logo', count: 1, run_dir: run, background: 'auto' }); // a later round would carry as-described over
  assert.deepEqual([described.candidates[0].index, normal.candidates[0].index], [1, 2]);
  const built = await pack('build', '--run', run, '--name', 'game');
  const byCandidate = Object.fromEntries(built.packs.map((entry) => [entry.candidate, entry]));
  assert.equal(byCandidate[1].facts.background.action, 'keep', 'candidate 1 asked for its own background');
  assert.equal(byCandidate[2].facts.background.action, 'remove', 'candidate 2 is processed as usual');
  const master = decodePng(fs.readFileSync(path.join(run, 'pack-1', 'icon-512.png')));
  assert.deepEqual(getPixel(master.rgba, master.width, 0, 0), [150, 20, 30, 255]);
  // The sheet draws it too (a full red tile with the disc), without error.
  const sheet = await pack('sheet', '--run', run);
  assert.equal(sheet.sheets[0].candidates, 2);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('--variant builds a second version beside the old files and leaves every old file untouched', async () => {
  const run = tmp('variant');
  for (let k = 1; k <= 2; k += 1) fs.writeFileSync(path.join(run, `candidate-${k}.png`), candidateTile(512));
  await pack('build', '--run', run, '--name', 'app');
  await pack('sheet', '--run', run);
  const before = hashes(run);
  const built = await pack('build', '--run', run, '--variant', 'fill90', '--fill', '90');
  assert.equal(built.variant, 'fill90');
  assert.deepEqual(built.packs.map((entry) => path.basename(entry.packDir)), ['pack-1-fill90', 'pack-2-fill90']);
  const sheet = await pack('sheet', '--run', run, '--variant', 'fill90', '--fill', '90');
  assert.deepEqual(sheet.sheets.map((entry) => entry.file), ['sheet-fill90-1.png']);
  const after = hashes(run);
  for (const [file, hash] of Object.entries(before)) assert.equal(after[file], hash, `${file} was not touched`);
  assert.ok(Object.keys(after).some((file) => file.startsWith('pack-1-fill90/')));
  // The 90 % version really is a different picture from the 96 % one.
  assert.notEqual(after['pack-1-fill90/icon-512.png'], after['pack-1/icon-512.png']);
  // A second sheet in the series goes after the first, not over it.
  assert.deepEqual((await pack('sheet', '--run', run, '--variant', 'fill90', '--only', '1')).sheets.map((entry) => entry.file), ['sheet-fill90-2.png']);
  fs.rmSync(run, { recursive: true, force: true });
});

test('--variant is a short safe label; --title is 1 to 80 characters', async () => {
  const run = tmp('variant-bad');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), candidateTile(256));
  for (const bad of ['', '..', 'a/b', 'UPPER', '123', 'x'.repeat(25), 'a b']) {
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT, 'build', '--run', run, '--variant', bad]), /--variant must be|needs a value/, JSON.stringify(bad));
  }
  await assert.rejects(execFileAsync(process.execPath, [SCRIPT, 'build', '--run', run, '--title', 'x'.repeat(81)]), /--title must be/);
  assert.deepEqual(fs.readdirSync(run), ['candidate-1.png'], 'nothing was written');
  fs.rmSync(run, { recursive: true, force: true });
});

test('a build over existing packs refuses BEFORE writing anything and names the safe options', async () => {
  const run = tmp('precheck');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), candidateTile(256));
  await pack('build', '--run', run, '--name', 'app');
  fs.writeFileSync(path.join(run, 'candidate-2.png'), candidateTile(256)); // a new candidate next to the packed one
  const before = hashes(run);
  let failure = null;
  try {
    await execFileAsync(process.execPath, [SCRIPT, 'build', '--run', run]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== null, 'refused');
  assert.match(failure.stderr, /pack-1 already exists/);
  assert.match(failure.stderr, /Nothing was written/);
  assert.match(failure.stderr, /--only/);
  assert.match(failure.stderr, /--variant/);
  assert.deepEqual(hashes(run), before, 'not even the new candidate got a pack');
  // The advice works: --only for the new one.
  assert.deepEqual((await pack('build', '--run', run, '--only', '2')).packs.map((entry) => entry.candidate), [2]);
  fs.rmSync(run, { recursive: true, force: true });
});

test('the pack name of earlier rounds is reused when --name is left out; the result says where the name came from', async () => {
  const run = tmp('name');
  for (let k = 1; k <= 2; k += 1) fs.writeFileSync(path.join(run, `candidate-${k}.png`), candidateTile(256));
  const first = await pack('build', '--run', run, '--only', '1');
  assert.equal(first.name, 'app');
  assert.match(first.nameFrom, /default/);
  fs.rmSync(run, { recursive: true, force: true });
  const second = tmp('name2');
  for (let k = 1; k <= 2; k += 1) fs.writeFileSync(path.join(second, `candidate-${k}.png`), candidateTile(256));
  await pack('build', '--run', second, '--name', 'chess-clock', '--only', '1');
  const next = await pack('build', '--run', second, '--only', '2');
  assert.equal(next.name, 'chess-clock');
  assert.match(next.nameFrom, /already in this run folder/);
  assert.ok(fs.existsSync(path.join(second, 'pack-2', 'windows', 'chess-clock.ico')), 'round 2 matches round 1: no app.ico beside chess-clock.ico');
  const titled = await pack('build', '--run', second, '--only', '1', '--variant', 'titled', '--title', 'Chess Clock Pro');
  assert.equal(titled.name, 'chess-clock');
  const desktop = fs.readFileSync(path.join(second, 'pack-1-titled', 'linux', 'chess-clock.desktop'), 'utf8');
  assert.match(desktop, /Name=Chess Clock Pro/);
  fs.rmSync(second, { recursive: true, force: true });
});

test('a damaged batch record is reported on stderr and in recordProblems, not silently skipped; a folder with no records says nothing', async () => {
  const run = tmp('damaged-batch');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), candidateTile(512));
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({
    created: 'x', plugin: 'icon-creator-ai', batches: [{ number: 1, background: 'auto' }], candidates: [{ index: 1, batch: 1, background: 'white' }],
  }));
  fs.writeFileSync(path.join(run, 'batch-2.json'), '{ this is not json');
  const built = await execFileAsync(process.execPath, [SCRIPT, 'build', '--run', run, '--name', 'app']);
  const result = JSON.parse(built.stdout);
  assert.equal(result.recordProblems.length, 1);
  assert.match(result.recordProblems[0], /batch-2\.json/);
  assert.match(built.stderr, /warning: .*batch-2\.json.*skipped/);
  const sheet = await execFileAsync(process.execPath, [SCRIPT, 'sheet', '--run', run]);
  assert.equal(JSON.parse(sheet.stdout).recordProblems.length, 1);
  assert.match(sheet.stderr, /batch-2\.json/);
  // the user's own folder of candidates has no records at all: normal, no noise
  const plain = tmp('no-records');
  fs.writeFileSync(path.join(plain, 'candidate-1.png'), candidateTile(512));
  const quiet = await execFileAsync(process.execPath, [SCRIPT, 'build', '--run', plain]);
  assert.equal(quiet.stderr, '');
  assert.equal(JSON.parse(quiet.stdout).recordProblems, undefined);
});
