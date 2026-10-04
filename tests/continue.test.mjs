// Tests of the three user-reported behaviours of a run: the background the model is asked for (pure white or black,
// or none when the user described one), "eight more" going into the SAME run folder numbered on, and the contact
// sheet showing icons with no margin of its own. In-process through makeServer with an injected fetch; no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeServer } from '../mcp/server.mjs';
import { candidateTile } from './helpers.mjs';
import { composeSheet } from '../scripts/lib/sheet.mjs';
import { readRunRecords } from '../scripts/lib/runrecords.mjs';
import { makeTmpDir } from './tmp.mjs';

const REAL_TMP = fs.realpathSync(os.tmpdir());
const GOOGLE_KEY = 'gxgxgxgx-1111-gxgxgxgx-2222';
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function tmpDir(label) {
  return makeTmpDir(`icon-ai-cont-${label}-`);
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function imageResponse() {
  return jsonResponse(200, {
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: candidateTile(256).toString('base64') }] }],
    usage: { total_input_tokens: 10, total_output_tokens: 900, total_tokens: 910 },
  });
}

/** A fetch that records the prompt of every request. */
function recordingFetch(responder = () => imageResponse()) {
  const prompts = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(typeof body.input === 'string' ? body.input : String(body.prompt ?? ''));
    return responder(prompts.length);
  };
  return { prompts, fetchImpl };
}

async function call(server, args) {
  const response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_images', arguments: args } });
  assert.equal(response.error, undefined, `protocol error: ${JSON.stringify(response.error)}`);
  const payload = response.result;
  return { isError: payload.isError === true, text: payload.content[0].text, parsed: payload.isError ? null : JSON.parse(payload.content[0].text) };
}

/** { relative path -> sha256 } of every file under `dir`. */
function snapshot(dir) {
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

const serverWith = (fetchImpl) => makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
const WHITE = 'pure flat white (#FFFFFF)';
const BLACK = 'pure flat black (#000000)';

// --- the background -----------------------------------------------------------------------------------------------

test('the model is asked for a pure white background, or pure black for neon and sticker, never "one solid colour"', async () => {
  const outDir = tmpDir('bg-auto');
  const { prompts, fetchImpl } = recordingFetch();
  const { isError } = await call(serverWith(fetchImpl), { prompt: 'a chess clock', count: 3, out_dir: outDir, styles: ['neon', 'sticker', 'flat-glyph'] });
  assert.equal(isError, false);
  const byStyle = (hint) => prompts.find((prompt) => prompt.includes(hint));
  assert.ok(byStyle('glowing neon').includes(BLACK) && !byStyle('glowing neon').includes(WHITE));
  assert.ok(byStyle('die-cut sticker').includes(BLACK));
  assert.ok(byStyle('flat minimal glyph').includes(WHITE) && !byStyle('flat minimal glyph').includes(BLACK));
  for (const prompt of prompts) assert.ok(!/one solid colour/.test(prompt), 'no free choice of colour');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('background: white or black forces one for every style; the run records the choice per candidate', async () => {
  const outDir = tmpDir('bg-force');
  const { prompts, fetchImpl } = recordingFetch();
  const { parsed } = await call(serverWith(fetchImpl), { prompt: 'a chess clock', count: 2, out_dir: outDir, styles: ['neon', 'mascot'], background: 'white' });
  assert.ok(prompts.every((prompt) => prompt.includes(WHITE) && !prompt.includes(BLACK)));
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.background), ['white', 'white']);
  assert.equal(parsed.background, 'white');
  const run = JSON.parse(fs.readFileSync(parsed.runJson, 'utf8'));
  assert.equal(run.batches[0].background, 'white');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('background: as-described asks for no background at all, because the prompt carries the one the user wants', async () => {
  const outDir = tmpDir('bg-described');
  const { prompts, fetchImpl } = recordingFetch();
  const { parsed } = await call(serverWith(fetchImpl), { prompt: 'a chess clock on a deep red background', count: 2, out_dir: outDir, background: 'as-described' });
  for (const prompt of prompts) {
    assert.ok(prompt.includes('on a deep red background'));
    assert.ok(!prompt.includes('#FFFFFF') && !prompt.includes('#000000') && !/The background is one pure flat/.test(prompt));
  }
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.background), ['as-described', 'as-described']);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('an unknown background value is a clear tool error and nothing is created', async () => {
  const outDir = tmpDir('bg-bad');
  const { fetchImpl, prompts } = recordingFetch();
  const { isError, text } = await call(serverWith(fetchImpl), { prompt: 'an app', count: 1, out_dir: outDir, background: 'magenta' });
  assert.equal(isError, true);
  assert.match(text, /background must be one of/);
  assert.equal(prompts.length, 0);
  assert.deepEqual(fs.readdirSync(outDir), []);
  fs.rmSync(outDir, { recursive: true, force: true });
});

// --- continuing a run -------------------------------------------------------------------------------------------------

test('"eight more" go into the SAME run folder, numbered on from the highest candidate', async () => {
  const outDir = tmpDir('more');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'the head of Godzilla', count: 4, out_dir: outDir })).parsed;
  assert.deepEqual(first.candidates.map((candidate) => candidate.index), [1, 2, 3, 4]);
  const second = await call(server, { prompt: 'the head of Godzilla', count: 3, run_dir: first.runDir });
  assert.equal(second.isError, false, second.text);
  assert.equal(second.parsed.runDir, first.runDir, 'the same folder');
  assert.equal(second.parsed.continued, true);
  assert.equal(second.parsed.batch, 2);
  assert.deepEqual(second.parsed.candidates.map((candidate) => candidate.index), [5, 6, 7]);
  assert.equal(second.parsed.totalCandidatesInRun, 7);
  for (let k = 1; k <= 7; k += 1) assert.ok(fs.existsSync(path.join(first.runDir, `candidate-${k}.png`)), `candidate-${k}.png`);
  assert.equal(fs.readdirSync(outDir).length, 1, 'no second run folder was created');
  // The new candidates take styles the first batch did not use.
  const usedFirst = new Set(first.candidates.map((candidate) => candidate.style));
  assert.ok(second.parsed.candidates.every((candidate) => !usedFirst.has(candidate.style)));
  // Build the new packs only and give them a sheet of their own: nothing existing is rewritten.
  assert.match(second.parsed.nextSteps[0], /build .*--only 5-7/);
  assert.match(second.parsed.nextSteps[1], /sheet .*--only 5-7/);
  assert.ok(!second.parsed.nextSteps.join(' ').includes('--force'), 'no step overwrites anything');
  // run.json is exactly what the first call wrote; the second round is in its own batch-2.json.
  const run = JSON.parse(fs.readFileSync(first.runJson, 'utf8'));
  assert.equal(run.batches.length, 1);
  assert.equal(run.candidates.length, 4);
  const batch2 = JSON.parse(fs.readFileSync(path.join(first.runDir, 'batch-2.json'), 'utf8'));
  assert.equal(batch2.plugin, 'icon-creator-ai');
  assert.equal(batch2.batch.number, 2);
  assert.deepEqual(batch2.batch.candidates, [5, 6, 7]);
  assert.deepEqual(batch2.candidates.map((candidate) => [candidate.index, candidate.batch]), [[5, 2], [6, 2], [7, 2]]);
  assert.equal(second.parsed.batchJson, path.join(first.runDir, 'batch-2.json'));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a third batch keeps numbering on, and "more like N" can pass a style of an earlier batch', async () => {
  const outDir = tmpDir('more3');
  const { fetchImpl, prompts } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 2, out_dir: outDir, styles: ['pixel-art', 'mascot'] })).parsed;
  await call(server, { prompt: 'an app', count: 2, run_dir: first.runDir });
  const third = (await call(server, { prompt: 'an app', count: 2, run_dir: first.runDir, styles: ['pixel-art'] })).parsed;
  assert.deepEqual(third.candidates.map((candidate) => candidate.index), [5, 6]);
  assert.equal(third.candidates[0].style, 'pixel-art', 'an explicitly requested style is honoured although it was used before');
  assert.equal(third.batch, 3);
  assert.ok(fs.existsSync(path.join(first.runDir, 'batch-2.json')) && fs.existsSync(path.join(first.runDir, 'batch-3.json')));
  assert.ok(prompts.length === 6);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('numbering goes on from the highest number on disk, not from a count', async () => {
  const outDir = tmpDir('more-gap');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 2, out_dir: outDir })).parsed;
  fs.writeFileSync(path.join(first.runDir, 'candidate-9.png'), candidateTile(64));
  const next = (await call(server, { prompt: 'an app', count: 1, run_dir: first.runDir })).parsed;
  assert.deepEqual(next.candidates.map((candidate) => candidate.index), [10]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a run folder made before this change (flat run.json) can be continued; its candidates become batch 1', async () => {
  const outDir = tmpDir('legacy');
  const runDir = path.join(outDir, 'run-20261004-071648-1nf');
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, 'candidate-1.png'), candidateTile(256));
  fs.writeFileSync(path.join(runDir, 'candidate-2.png'), candidateTile(256));
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    created: '2026-10-04T07:16:48.000Z', plugin: 'icon-creator-ai', prompt: 'the head of Godzilla', provider: 'google', model: 'm', size: 'draft',
    styles: ['pixel-art', 'flat-glyph'],
    candidates: [{ index: 1, style: 'pixel-art', file: 'candidate-1.png' }, { index: 2, style: 'flat-glyph', file: 'candidate-2.png' }],
    failures: [], usage: { requests: 2, cost: null }, notes: [], stopped: null,
  }));
  const { fetchImpl } = recordingFetch();
  const { parsed, isError, text } = await call(serverWith(fetchImpl), { prompt: 'the head of Godzilla', count: 2, run_dir: runDir });
  assert.equal(isError, false, text);
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.index), [3, 4]);
  assert.ok(parsed.candidates.every((candidate) => !['pixel-art', 'flat-glyph'].includes(candidate.style)));
  // The flat run.json of the older version is left exactly as it was; the new round is batch 2 in its own file.
  const legacy = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.equal(legacy.batches, undefined, 'run.json is untouched (still the flat shape)');
  assert.equal(legacy.candidates.length, 2);
  assert.equal(parsed.batch, 2);
  const batch2 = JSON.parse(fs.readFileSync(path.join(runDir, 'batch-2.json'), 'utf8'));
  assert.deepEqual(batch2.candidates.map((candidate) => [candidate.index, candidate.batch]), [[3, 2], [4, 2]]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a failed continuation records the batch, keeps the candidates already there and says why', async () => {
  const outDir = tmpDir('more-fail');
  const server1 = serverWith(recordingFetch().fetchImpl);
  const first = (await call(server1, { prompt: 'an app', count: 2, out_dir: outDir })).parsed;
  const rejecting = recordingFetch(() => jsonResponse(401, { error: { message: 'API key not valid' } }));
  const { isError, text } = await call(serverWith(rejecting.fetchImpl), { prompt: 'an app', count: 2, run_dir: first.runDir });
  assert.equal(isError, true);
  assert.match(text, /No candidate was generated/);
  const run = JSON.parse(fs.readFileSync(first.runJson, 'utf8'));
  assert.equal(run.batches.length, 1, 'run.json is untouched');
  assert.equal(run.candidates.length, 2, 'the two earlier candidates are untouched');
  const failed = JSON.parse(fs.readFileSync(path.join(first.runDir, 'batch-2.json'), 'utf8'));
  assert.deepEqual(failed.candidates, []);
  assert.equal(failed.batch.failures.length, 2, 'the failed round is recorded in its own file');
  assert.ok(fs.existsSync(path.join(first.runDir, 'candidate-2.png')));
  assert.ok(!fs.existsSync(path.join(first.runDir, 'candidate-3.png')));
  // The next round is batch 3 and numbering is still from the candidates that exist.
  const retry = (await call(serverWith(recordingFetch().fetchImpl), { prompt: 'an app', count: 1, run_dir: first.runDir })).parsed;
  assert.equal(retry.batch, 3);
  assert.deepEqual(retry.candidates.map((candidate) => candidate.index), [3]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('run_dir is refused unless it is a real run folder of this plugin; nothing is written', async () => {
  const outDir = tmpDir('refuse');
  const { fetchImpl, prompts } = recordingFetch();
  const server = serverWith(fetchImpl);
  const refuse = async (args, pattern) => {
    const { isError, text } = await call(server, { prompt: 'an app', count: 1, ...args });
    assert.equal(isError, true, text);
    assert.match(text, pattern);
  };
  await refuse({ run_dir: path.join(outDir, 'does-not-exist') }, /not an existing run folder/);
  const plain = path.join(outDir, 'plain');
  fs.mkdirSync(plain);
  await refuse({ run_dir: plain }, /no run\.json of its own/);
  const odd = path.join(outDir, 'odd');
  fs.mkdirSync(path.join(odd, 'run.json'), { recursive: true }); // a run.json that is not a regular file (a link is refused the same way)
  await refuse({ run_dir: odd }, /no run\.json of its own/);
  fs.writeFileSync(path.join(plain, 'run.json'), JSON.stringify({ plugin: 'something-else' }));
  await refuse({ run_dir: plain }, /not a run folder made by this plugin/);
  fs.writeFileSync(path.join(plain, 'run.json'), 'not json');
  await refuse({ run_dir: plain }, /not valid JSON/);
  await refuse({ run_dir: plain, out_dir: outDir }, /either run_dir .* or out_dir/);
  await refuse({ run_dir: '' }, /run_dir must be/);
  await refuse({ run_dir: 7 }, /run_dir must be/);
  await refuse({}, /out_dir must be the folder/);
  assert.equal(prompts.length, 0, 'no request was made');
  assert.deepEqual(fs.readdirSync(plain).sort(), ['run.json']);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a damaged or foreign batch file in the folder refuses the continuation instead of guessing', async () => {
  const outDir = tmpDir('bad-batch');
  const { fetchImpl, prompts } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 1, out_dir: outDir })).parsed;
  fs.writeFileSync(path.join(first.runDir, 'batch-2.json'), 'garbage');
  const damaged = await call(server, { prompt: 'an app', count: 1, run_dir: first.runDir });
  assert.equal(damaged.isError, true);
  assert.match(damaged.text, /not valid JSON/);
  fs.writeFileSync(path.join(first.runDir, 'batch-2.json'), JSON.stringify({ plugin: 'icon-creator-ai', batch: { number: 7 }, candidates: [] }));
  const mismatch = await call(server, { prompt: 'an app', count: 1, run_dir: first.runDir });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.text, /not a batch file made by this plugin/);
  assert.equal(prompts.length, 1, 'only the first round made a request');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('the reported case: a second round of eight touches NOTHING that exists; it adds candidates, packs, a batch file and its own sheet', async () => {
  const outDir = tmpDir('reported');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const script = path.join(ROOT, 'scripts', 'pack.mjs');
  const cli = async (...args) => JSON.parse((await execFileAsync(process.execPath, [script, ...args])).stdout);
  const first = (await call(server, { prompt: 'the head of Godzilla', count: 4, out_dir: outDir })).parsed;
  await cli('build', '--run', first.runDir, '--name', 'godzilla');
  const firstSheet = await cli('sheet', '--run', first.runDir);
  assert.deepEqual(firstSheet.sheets.map((sheet) => [sheet.file, sheet.candidates]), [['sheet-1.png', 4]]);
  const before = snapshot(first.runDir);

  const second = (await call(server, { prompt: 'the head of Godzilla', count: 8, run_dir: first.runDir })).parsed;
  assert.deepEqual(second.candidates.map((candidate) => candidate.index), [5, 6, 7, 8, 9, 10, 11, 12]);
  const built = await cli('build', '--run', first.runDir, '--name', 'godzilla', '--only', '5-12');
  assert.deepEqual(built.packs.map((pack) => pack.candidate), [5, 6, 7, 8, 9, 10, 11, 12]);
  const sheet = await cli('sheet', '--run', first.runDir, '--only', '5-12');
  assert.deepEqual(sheet.sheets.map((entry) => [entry.file, entry.candidates]), [['sheet-2.png', 8]], 'one NEW file with the eight new pictures');

  const after = snapshot(first.runDir);
  for (const [file, hash] of Object.entries(before)) assert.equal(after[file], hash, `${file} was not touched`);
  const added = Object.keys(after).filter((file) => !(file in before));
  assert.ok(added.includes('sheet-2.png') && added.includes('batch-2.json') && added.includes('candidate-12.png') && added.includes('pack-12/icon-256.png'));
  assert.ok(!added.some((file) => file === 'sheet-1.png' || file === 'run.json' || /^pack-[1-4]\//.test(file)));
  assert.ok(!fs.existsSync(path.join(first.runDir, 'sheet-3.png')), 'eight candidates fit one sheet page');

  // A third round of 3 gets sheet-3 and leaves sheet-1 and sheet-2 alone.
  const mid = snapshot(first.runDir);
  const third = (await call(server, { prompt: 'the head of Godzilla', count: 3, run_dir: first.runDir })).parsed;
  assert.deepEqual(third.candidates.map((candidate) => candidate.index), [13, 14, 15]);
  await cli('build', '--run', first.runDir, '--name', 'godzilla', '--only', '13-15');
  assert.deepEqual((await cli('sheet', '--run', first.runDir, '--only', '13-15')).sheets.map((entry) => entry.file), ['sheet-3.png']);
  const end = snapshot(first.runDir);
  for (const [file, hash] of Object.entries(mid)) assert.equal(end[file], hash, `${file} was not touched by round 3`);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('run_dir through a symbolic link or junction is refused', async () => {
  const outDir = tmpDir('refuse-link');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 1, out_dir: outDir })).parsed;
  const link = path.join(outDir, 'alias');
  fs.symlinkSync(first.runDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  const { isError, text } = await call(server, { prompt: 'an app', count: 1, run_dir: link });
  assert.equal(isError, true);
  assert.match(text, /symbolic link or junction/);
  assert.ok(!fs.existsSync(path.join(first.runDir, 'candidate-2.png')));
  fs.rmSync(link, { force: true, recursive: false });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a run.json that is a symbolic link is not followed or replaced', async () => {
  const outDir = tmpDir('refuse-json-link');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 1, out_dir: outDir })).parsed;
  const real = path.join(outDir, 'real.json');
  fs.renameSync(first.runJson, real);
  try {
    fs.symlinkSync(real, first.runJson, 'file');
  } catch {
    fs.renameSync(real, first.runJson); // no symlink right on this machine: nothing to prove here
    fs.rmSync(outDir, { recursive: true, force: true });
    return;
  }
  const { isError, text } = await call(server, { prompt: 'an app', count: 1, run_dir: first.runDir });
  assert.equal(isError, true);
  assert.match(text, /no run\.json of its own/);
  fs.rmSync(outDir, { recursive: true, force: true });
});

// --- list_run, repeat_styles, races, names --------------------------------------------------------------------------

async function callTool(server, name, args) {
  const response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const payload = response.result;
  return { isError: payload.isError === true, text: payload.content[0].text, parsed: payload.isError ? null : JSON.parse(payload.content[0].text) };
}

test('list_run gives one merged view of every round, the packs and sheets that exist, and the pack name', async () => {
  const outDir = tmpDir('listrun');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'the head of Godzilla', count: 2, out_dir: outDir })).parsed;
  const script = path.join(ROOT, 'scripts', 'pack.mjs');
  await execFileAsync(process.execPath, [script, 'build', '--run', first.runDir, '--name', 'godzilla-head']);
  await execFileAsync(process.execPath, [script, 'sheet', '--run', first.runDir]);
  await call(server, { prompt: 'the head of Godzilla', count: 3, run_dir: first.runDir, background: 'black' });
  const listed = await callTool(server, 'list_run', { run_dir: first.runDir });
  assert.equal(listed.isError, false, listed.text);
  const view = listed.parsed;
  assert.equal(view.packName, 'godzilla-head');
  assert.deepEqual(view.batches.map((batch) => batch.number), [1, 2]);
  assert.equal(view.batches[1].background, 'black');
  assert.deepEqual(view.candidates.map((candidate) => [candidate.index, candidate.batch]), [[1, 1], [2, 1], [3, 2], [4, 2], [5, 2]]);
  assert.ok(view.candidates.every((candidate) => typeof candidate.style === 'string' && candidate.file.startsWith('candidate-')));
  assert.deepEqual(view.packs, ['pack-1', 'pack-2']);
  assert.deepEqual(view.sheets, ['sheet-1.png']);
  assert.equal(view.nextCandidate, 6);
  assert.equal(view.nextBatch, 3);
  // Read-only: nothing changed on disk.
  assert.ok(!fs.existsSync(path.join(first.runDir, 'batch-3.json')));
  for (const bad of [{}, { run_dir: '' }, { run_dir: path.join(outDir, 'nope') }, { run_dir: '~/x' }]) {
    const refused = await callTool(server, 'list_run', bad);
    assert.equal(refused.isError, true, JSON.stringify(bad));
  }
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('repeat_styles: "more like number 3" gives three candidates in that one style', async () => {
  const outDir = tmpDir('repeat');
  const { fetchImpl, prompts } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 2, out_dir: outDir, styles: ['pixel-art', 'mascot'] })).parsed;
  const more = (await call(server, { prompt: 'an app', count: 3, run_dir: first.runDir, styles: ['pixel-art'], repeat_styles: true })).parsed;
  assert.deepEqual(more.candidates.map((candidate) => candidate.style), ['pixel-art', 'pixel-art', 'pixel-art']);
  assert.equal(prompts.slice(2).filter((prompt) => prompt.includes('pixel art')).length, 3);
  const bad = await call(server, { prompt: 'an app', count: 1, run_dir: first.runDir, repeat_styles: 'yes' });
  assert.equal(bad.isError, true);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('two continuations of the same run at the same time both keep their images: the second renumbers instead of failing', async () => {
  const outDir = tmpDir('race');
  const slow = recordingFetch(() => new Promise((resolve) => setTimeout(() => resolve(imageResponse()), 80)));
  const server = serverWith(slow.fetchImpl);
  const first = (await call(serverWith(recordingFetch().fetchImpl), { prompt: 'an app', count: 2, out_dir: outDir })).parsed;
  const [a, b] = await Promise.all([
    call(server, { prompt: 'an app', count: 2, run_dir: first.runDir }),
    call(server, { prompt: 'an app', count: 2, run_dir: first.runDir }),
  ]);
  assert.equal(a.isError, false, a.text);
  assert.equal(b.isError, false, b.text);
  assert.equal(a.parsed.failures.length + b.parsed.failures.length, 0, 'no billed image was lost');
  const numbers = [...a.parsed.candidates, ...b.parsed.candidates].map((candidate) => candidate.index).sort((x, y) => x - y);
  assert.deepEqual(numbers, [3, 4, 5, 6], 'distinct numbers, none overwritten');
  for (const k of [3, 4, 5, 6]) assert.ok(fs.existsSync(path.join(first.runDir, `candidate-${k}.png`)));
  assert.deepEqual([a.parsed.batch, b.parsed.batch].sort(), [2, 3], 'each call has its own batch file');
  assert.ok(fs.existsSync(path.join(first.runDir, 'batch-2.json')) && fs.existsSync(path.join(first.runDir, 'batch-3.json')));
  const batch3 = JSON.parse(fs.readFileSync(path.join(first.runDir, 'batch-3.json'), 'utf8'));
  assert.equal(batch3.batch.number, 3);
  assert.ok(batch3.candidates.every((candidate) => candidate.batch === 3), 'candidates name the batch they ended up in');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('the next round number is the highest batch number plus one, not a count (a gap or a deleted file does not reuse a number)', async () => {
  const outDir = tmpDir('batch-gap');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 1, out_dir: outDir })).parsed;
  fs.writeFileSync(path.join(first.runDir, 'batch-3.json'), JSON.stringify({
    plugin: 'icon-creator-ai', batch: { number: 3, candidates: [2], failures: [] },
    candidates: [{ index: 2, batch: 3, style: 'mascot', file: 'candidate-2.png' }],
  }));
  fs.writeFileSync(path.join(first.runDir, 'candidate-2.png'), candidateTile(64));
  const next = (await call(server, { prompt: 'an app', count: 1, run_dir: first.runDir })).parsed;
  assert.equal(next.batch, 4);
  assert.deepEqual(next.candidates.map((candidate) => candidate.index), [3]);
  assert.ok(next.candidates.every((candidate) => candidate.style !== 'mascot'), 'styles of the gapped round count as used');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('"~" is refused for out_dir and run_dir: a literal ~ folder would land inside the project', async () => {
  const { fetchImpl, prompts } = recordingFetch();
  const server = serverWith(fetchImpl);
  for (const args of [{ out_dir: '~/icons' }, { run_dir: '~/icons/run-1' }]) {
    const { isError, text } = await call(server, { prompt: 'an app', count: 1, ...args });
    assert.equal(isError, true);
    assert.match(text, /absolute path/);
  }
  assert.equal(prompts.length, 0);
});

test('the next steps carry the absolute path of this plugin\'s pack script and, from round 2 on, the pack name already used', async () => {
  const outDir = tmpDir('names');
  const { fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = (await call(server, { prompt: 'an app', count: 2, out_dir: outDir })).parsed;
  assert.ok(first.nextSteps[0].includes(path.join(ROOT, 'scripts', 'pack.mjs')), 'absolute script path');
  assert.match(first.nextSteps[0], /--name "<app-slug>"/, 'the first round has no name yet');
  const script = path.join(ROOT, 'scripts', 'pack.mjs');
  await execFileAsync(process.execPath, [script, 'build', '--run', first.runDir, '--name', 'chess-clock']);
  const second = (await call(server, { prompt: 'an app', count: 2, run_dir: first.runDir })).parsed;
  assert.match(second.nextSteps[0], /--name "chess-clock"/, 'the name of round 1 is reused');
  assert.match(second.nextSteps[0], /--only 3-4/);
  fs.rmSync(outDir, { recursive: true, force: true });
});

// --- pack.mjs --only -------------------------------------------------------------------------------------------------

test('pack.mjs build --only makes just the named packs; the sheet then shows every candidate', async () => {
  const run = tmpDir('only');
  for (let k = 1; k <= 3; k += 1) fs.writeFileSync(path.join(run, `candidate-${k}.png`), candidateTile(256));
  const script = path.join(ROOT, 'scripts', 'pack.mjs');
  const built = async (...args) => JSON.parse((await execFileAsync(process.execPath, [script, 'build', '--run', run, ...args])).stdout).packs.map((pack) => pack.candidate);
  assert.deepEqual(await built('--only', '2'), [2]);
  assert.deepEqual(fs.readdirSync(run).filter((name) => name.startsWith('pack-')), ['pack-2']);
  assert.deepEqual(await built('--only', '1,3'), [1, 3]);
  assert.deepEqual(await built('--only', '2-3', '--force'), [2, 3]);
  await assert.rejects(execFileAsync(process.execPath, [script, 'build', '--run', run, '--only', '9']), /no candidate matches --only/);
  await assert.rejects(execFileAsync(process.execPath, [script, 'build', '--run', run, '--only', 'abc']), /--only must be/);
  await assert.rejects(execFileAsync(process.execPath, [script, 'build', '--run', run, '--only', '3-1']), /--only must be/);
  const sheet = JSON.parse((await execFileAsync(process.execPath, [script, 'sheet', '--run', run])).stdout);
  assert.equal(sheet.sheets[0].candidates, 3);
  // Without --only the sheets start at sheet-1.png again, which exists: that needs --force.
  await assert.rejects(execFileAsync(process.execPath, [script, 'sheet', '--run', run]), /already exists/);
  await execFileAsync(process.execPath, [script, 'sheet', '--run', run, '--force']);
  // With --only the sheet is a NEW file after the existing ones, never an overwrite.
  const only = JSON.parse((await execFileAsync(process.execPath, [script, 'sheet', '--run', run, '--only', '2-3'])).stdout);
  assert.deepEqual(only.sheets.map((entry) => [entry.file, entry.candidates]), [['sheet-2.png', 2]]);
  await assert.rejects(execFileAsync(process.execPath, [script, 'sheet', '--run', run, '--only', '9']), /no candidate matches --only/);
  fs.rmSync(run, { recursive: true, force: true });
});

// --- the sheet: no margin of its own ------------------------------------------------------------------------------------

function solid(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let o = 0; o < rgba.length; o += 4) { rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; }
  return { size, rgba };
}

test('the sheet shows an icon edge to edge: previews fill their 144 px tile, the 64/32/16 px renderings sit on tiles of their own size', async () => {
  const { decodePng } = await import('../scripts/lib/png.mjs');
  const sheet = decodePng(composeSheet([{ number: 1, prepared: solid(256, [200, 30, 30]) }]));
  const at = (x, y) => { const o = (y * sheet.width + x) * 4; return [sheet.rgba[o], sheet.rgba[o + 1], sheet.rgba[o + 2]]; };
  const isRed = ([r, g, b]) => r > 150 && g < 80 && b < 80;
  // Previews: the checkerboard tile is x 24..167, y 46..189; the dark tile x 178..321.
  for (const [x0, x1] of [[24, 167], [178, 321]]) {
    assert.ok(isRed(at(x0, 46)) && isRed(at(x1, 46)) && isRed(at(x0, 189)) && isRed(at(x1, 189)), 'the picture reaches all four corners of the tile');
  }
  assert.ok(!isRed(at(23, 46)) && !isRed(at(24, 45)), 'and stops at the tile');
  // Under the previews ONE white strip starts at y = 200 and ends at y 276; the 64, 32 and 16 px renderings sit 4 px above its end
  // (y 272), under the checkerboard (x 24) and under the dark tile (x 178).
  for (const [x, size] of [[32, 64], [104, 32], [144, 16], [186, 64], [258, 32], [298, 16]]) {
    const y = 272 - size;
    assert.ok(isRed(at(x, y)) && isRed(at(x + size - 1, y + size - 1)), `${size} px at x ${x}: the picture fills its whole tile`);
    assert.ok(!isRed(at(x - 1, y)) && !isRed(at(x + size, y)) && !isRed(at(x, y - 1)), `${size} px at x ${x}: no margin around it`);
    assert.deepEqual(at(x - 1, y), [255, 255, 255], `${size} px at x ${x}: white right next to the picture, no grey padding`);
  }
  assert.equal(sheet.height, 12 + (34 + 144 + 10 + 76 + 12) + 10, 'and nothing is drawn below the strip (no zoom row)');
});

test('the strip under the previews has no grey: white, and dark tiles of exactly the small sizes under the dark preview', async () => {
  const { decodePng } = await import('../scripts/lib/png.mjs');
  const clear = { size: 256, rgba: Buffer.alloc(256 * 256 * 4) }; // fully transparent: only the ground shows
  const sheet = decodePng(composeSheet([{ number: 1, prepared: clear }]));
  const at = (x, y) => { const o = (y * sheet.width + x) * 4; return [sheet.rgba[o], sheet.rgba[o + 1], sheet.rgba[o + 2]]; };
  const seen = new Set();
  for (let y = 200; y < 276; y += 1) for (let x = 24; x < 322; x += 1) seen.add(at(x, y).join(','));
  assert.deepEqual([...seen].sort(), ['24,27,33', '255,255,255'], 'only white and the dark of the dark preview');
  for (const [x, size] of [[186, 64], [258, 32], [298, 16]]) {
    const y = 272 - size;
    assert.deepEqual(at(x, y), [24, 27, 33]);
    assert.deepEqual(at(x + size - 1, y + size - 1), [24, 27, 33]);
    assert.deepEqual(at(x - 1, y), [255, 255, 255]);
    assert.deepEqual(at(x + size, y), [255, 255, 255]);
  }
  for (const [x, size] of [[32, 64], [104, 32], [144, 16]]) assert.deepEqual(at(x + size - 1, 272 - 1), [255, 255, 255], 'under the checkerboard the pictures sit on plain white');
});

// --- review 10 ----------------------------------------------------------------------------------------------------------

test('a later round keeps the background choice of the round before it, and an explicit choice still wins', async () => {
  const outDir = tmpDir('bg-inherit');
  const { prompts, fetchImpl } = recordingFetch();
  const server = serverWith(fetchImpl);
  const first = await call(server, { prompt: 'a chess clock on a chalkboard', count: 1, out_dir: outDir, background: 'as-described' });
  const more = await call(server, { prompt: 'a chess clock on a chalkboard', count: 2, run_dir: first.parsed.runDir });
  assert.equal(more.parsed.background, 'as-described', 'the tool reports the choice it used');
  assert.deepEqual(more.parsed.candidates.map((candidate) => candidate.background), ['as-described', 'as-described']);
  for (const prompt of prompts.slice(1)) assert.ok(!prompt.includes('#FFFFFF') && !prompt.includes('#000000'), 'no white or black background is asked for');
  assert.ok(more.parsed.notes.some((note) => /carried over from the earlier round/.test(note)), 'the carry-over is said out loud');
  const record = JSON.parse(fs.readFileSync(more.parsed.batchJson, 'utf8'));
  assert.equal(record.batch.background, 'as-described');
  // the third round inherits from the second (the last), and an explicit "auto" returns to white or black
  const third = await call(server, { prompt: 'a chess clock', count: 1, run_dir: first.parsed.runDir });
  assert.equal(third.parsed.background, 'as-described');
  const back = await call(server, { prompt: 'a chess clock', count: 1, run_dir: first.parsed.runDir, background: 'auto', styles: ['flat-glyph'] });
  assert.equal(back.parsed.background, 'auto');
  assert.ok(prompts[prompts.length - 1].includes(WHITE));
  assert.ok(!back.parsed.notes.some((note) => /carried over/.test(note)));
  // what is inherited is the LAST round's choice, not the first round's: after "auto" the next round stays on auto
  const after = await call(server, { prompt: 'a chess clock', count: 1, run_dir: first.parsed.runDir, styles: ['flat-glyph'] });
  assert.equal(after.parsed.background, 'auto');
  assert.ok(prompts[prompts.length - 1].includes(WHITE));
  // a run that never named a background is not changed by any of this
  const plain = await call(server, { prompt: 'a chess clock', count: 1, out_dir: outDir });
  const plainMore = await call(server, { prompt: 'a chess clock', count: 1, run_dir: plain.parsed.runDir, styles: ['flat-glyph'] });
  assert.equal(plainMore.parsed.background, 'auto');
  assert.ok(!plainMore.parsed.notes.some((note) => /carried over/.test(note)));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a round that produced nothing names the file that holds its details: batch-<n>.json for a continued run, run.json for a new one', async () => {
  const outDir = tmpDir('nothing');
  const good = recordingFetch();
  const first = await call(serverWith(good.fetchImpl), { prompt: 'a chess clock', count: 1, out_dir: outDir });
  const refusing = async () => jsonResponse(401, { error: { message: 'API key not valid' } });
  const later = await call(serverWith(refusing), { prompt: 'a chess clock', count: 1, run_dir: first.parsed.runDir });
  assert.equal(later.isError, true);
  assert.match(later.text, /details in batch-2\.json/);
  assert.ok(fs.existsSync(path.join(first.parsed.runDir, 'batch-2.json')), 'and that file exists');
  const fresh = await call(serverWith(refusing), { prompt: 'a chess clock', count: 1, out_dir: outDir });
  assert.equal(fresh.isError, true);
  assert.match(fresh.text, /details in run\.json/);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a run record holding nulls or numbers where objects belong is read around, not crashed on', () => {
  const dir = tmpDir('damaged-records');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ plugin: 'icon-creator-ai', batches: [null, 5, { number: 1, background: 'white' }], candidates: [null, 'x', { index: 2 }] }));
  fs.writeFileSync(path.join(dir, 'batch-2.json'), JSON.stringify({ plugin: 'icon-creator-ai', batch: { number: 2 }, candidates: [null, { index: 3 }] }));
  for (const strict of [false, true]) {
    const view = readRunRecords(dir, { strict });
    assert.deepEqual(view.run.batches.map((batch) => batch.number), [1, 2]);
    assert.deepEqual(view.run.candidates.map((candidate) => candidate.index), [2, 3]);
    assert.equal(view.nextIndex, 4);
    assert.equal(view.nextBatch, 3);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
