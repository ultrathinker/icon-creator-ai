// In-process tests of the generate_images flow through makeServer with an
// injected fetch: the run folder layout, run.json, partial failure, non-PNG
// responses kept raw, the size-field retry note, progress notifications and
// the argument validation. No test reaches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeServer } from '../mcp/server.mjs';
import { candidateTile, candidateTransparent } from './helpers.mjs';
import { SQUARE_420_JPEG, PROGRESSIVE_JPEG } from './jpeg-fixtures.mjs';
import { decodePng } from '../scripts/lib/png.mjs';
import { makeTmpDir } from './tmp.mjs';

// On macOS os.tmpdir() is behind the /var symlink, which the plugin refuses by design: tests use its real path.
const REAL_TMP = fs.realpathSync(os.tmpdir());

const GOOGLE_KEY = 'gxgxgxgx-1111-gxgxgxgx-2222';

function tmpDir(label) {
  return makeTmpDir(`icon-ai-gen-${label}-`);
}

function jsonResponse(status, body, headers = {}) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower.get(String(name).toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  };
}

function googleImageResponse(imageBuffer, mimeType = 'image/png') {
  return jsonResponse(200, {
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: mimeType, data: imageBuffer.toString('base64') }] }],
    usage: { total_input_tokens: 10, total_output_tokens: 900, total_tokens: 910 },
  });
}

function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(calls.length, url, init);
  };
  return { calls, fetchImpl };
}

async function callGenerate(server, args, timeoutMs = 20_000) {
  const response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_images', arguments: args } });
  assert.equal(response.error, undefined, `protocol error: ${JSON.stringify(response.error)}`);
  const payload = response.result;
  return { isError: payload.isError === true, text: payload.content[0].text, parsed: payload.isError ? null : JSON.parse(payload.content[0].text) };
}

test('a successful run writes candidates and run.json under a fresh run folder', async () => {
  const outDir = tmpDir('ok');
  const tiles = [candidateTile(512), candidateTransparent(512), candidateTile(512, { tile: [200, 40, 40] }), candidateTile(512, { tile: [20, 160, 90] })];
  const { fetchImpl } = makeFetch((call) => googleImageResponse(tiles[call - 1]));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { isError, parsed } = await callGenerate(server, { prompt: 'a markdown notes app with a pine tree logo', count: 4, out_dir: outDir });
  assert.equal(isError, false);
  assert.equal(parsed.candidates.length, 4);
  assert.equal(parsed.provider, 'google');
  assert.equal(parsed.model, 'gemini-3.1-flash-image');
  assert.equal(parsed.failures.length, 0);
  assert.deepEqual(parsed.usage, { requests: 4, inputTokens: 40, outputTokens: 3600, totalTokens: 3640, cost: null, costKnown: false }, 'Google reports tokens but no cost: the cost is unknown, not zero');
  const runDir = parsed.runDir;
  assert.ok(fs.existsSync(path.join(runDir, 'candidate-1.png')));
  assert.ok(fs.existsSync(path.join(runDir, 'candidate-4.png')));
  assert.ok(fs.existsSync(path.join(runDir, 'run.json')));
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.equal(run.batches.length, 1);
  assert.equal(run.batches[0].prompt, 'a markdown notes app with a pine tree logo');
  assert.equal(run.candidates.length, 4);
  assert.equal(run.candidates[0].file, 'candidate-1.png');
  assert.equal(run.candidates[0].batch, 1);
  assert.equal(new Set(run.batches[0].styles).size, 4, 'four distinct styles');
  assert.equal(parsed.continued, false);
  assert.match(parsed.nextSteps[0], /pack\.mjs"? build/);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a second run never overwrites the first: a new run folder is created', async () => {
  const outDir = tmpDir('twice');
  const { fetchImpl } = makeFetch(() => googleImageResponse(candidateTile(256)));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const first = (await callGenerate(server, { prompt: 'app one', count: 1, out_dir: outDir })).parsed;
  const second = (await callGenerate(server, { prompt: 'app two', count: 1, out_dir: outDir })).parsed;
  assert.notEqual(first.runDir, second.runDir);
  assert.ok(fs.existsSync(path.join(first.runDir, 'candidate-1.png')));
  assert.ok(fs.existsSync(path.join(second.runDir, 'candidate-1.png')));
  fs.rmSync(outDir, { recursive: true, force: true });
});

// Windows junctions and POSIX symlinks alike must be refused in the whole
// typed output chain — including the folder the user named itself.
function makeLink(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

test('a junction or symlink as out_dir is refused, not written through', async () => {
  const real = tmpDir('realout');
  const link = path.join(REAL_TMP, `icon-ai-link-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  makeLink(real, link);
  const { fetchImpl } = makeFetch(() => googleImageResponse(candidateTile(256)));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: link });
  assert.equal(isError, true, 'a run through an alias must fail');
  assert.match(text, /symbolic link or junction/);
  assert.match(text, /pass that real path instead|pass the real path/);
  assert.equal(fs.readdirSync(real).length, 0, 'nothing was written through the alias');
  fs.rmSync(link, { force: true });
  fs.rmSync(real, { recursive: true, force: true });
});

test('a link in the MIDDLE of the out_dir chain is refused too', async () => {
  const real = tmpDir('mid-real');
  const link = path.join(REAL_TMP, `icon-ai-link-mid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  makeLink(real, link);
  const throughLink = path.join(link, 'icon-runs');
  const { fetchImpl } = makeFetch(() => googleImageResponse(candidateTile(256)));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: throughLink });
  assert.equal(isError, true);
  assert.match(text, /symbolic link or junction/);
  assert.equal(fs.existsSync(path.join(real, 'icon-runs')), false, 'nothing was created through the alias');
  fs.rmSync(link, { force: true });
  fs.rmSync(real, { recursive: true, force: true });
});

test('partial failure returns the successes and names the failures', async () => {
  const outDir = tmpDir('partial');
  // Fail deterministically by STYLE (visible in the prompt), not by call
  // order: retries re-call the same task and would shift a counter.
  const doomed = ['pixel art', 'glowing neon'];
  const { fetchImpl } = makeFetch((_call, _url, init) => {
    const body = JSON.parse(init.body);
    const prompt = typeof body.input === 'string' ? body.input : body.prompt ?? '';
    const fails = doomed.some((hint) => prompt.includes(hint));
    return fails ? jsonResponse(500, { error: { message: 'backend blew up' } }) : googleImageResponse(candidateTile(256));
  });
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { isError, parsed } = await callGenerate(
    server,
    { prompt: 'a podcast catcher', count: 4, out_dir: outDir, styles: ['pixel-art', 'mascot', 'neon', 'clay-3d'] },
    60_000,
  );
  assert.equal(isError, false, 'partial success is not a tool error');
  assert.equal(parsed.candidates.length, 2);
  assert.deepEqual(parsed.candidates.map((candidate) => candidate.style).sort(), ['clay-3d', 'mascot']);
  assert.equal(parsed.failures.length, 2);
  assert.deepEqual(parsed.failures.map((failure) => failure.style).sort(), ['neon', 'pixel-art']);
  assert.equal(parsed.failures[0].code, 'server');
  assert.match(parsed.failures[0].message, /backend blew up/);
  assert.equal(parsed.failures[0].attempts, 3, '500s are retried twice');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a JPEG response (what Google really returns) is decoded and saved as a PNG candidate', async () => {
  const outDir = tmpDir('jpeg');
  const { fetchImpl } = makeFetch(() => googleImageResponse(Buffer.from(SQUARE_420_JPEG, 'base64'), 'image/jpeg'));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { isError, parsed } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir });
  assert.equal(isError, false);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].file, 'candidate-1.png');
  assert.equal(parsed.candidates[0].warning, undefined, 'a decodable JPEG needs no warning');
  const saved = fs.readFileSync(path.join(parsed.runDir, 'candidate-1.png'));
  const picture = decodePng(saved);
  assert.equal(picture.width, 128);
  assert.equal(picture.height, 128);
  assert.equal(fs.existsSync(path.join(parsed.runDir, 'candidate-1.jpeg')), false, 'no raw copy is left behind');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a JPEG variant the decoder does not handle is kept raw with a warning', async () => {
  const outDir = tmpDir('jpeg-prog');
  const { fetchImpl } = makeFetch(() => googleImageResponse(Buffer.from(PROGRESSIVE_JPEG, 'base64'), 'image/jpeg'));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { isError, parsed } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir });
  assert.equal(isError, false);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].file, 'candidate-1.jpeg');
  assert.match(parsed.candidates[0].warning, /progressive/);
  assert.ok(fs.existsSync(path.join(parsed.runDir, 'candidate-1.jpeg')));
  fs.rmSync(outDir, { recursive: true, force: true });
});

// Review 6: a usage field a provider did not send must reach the result as null, not as 0 and not as a partial sum.
function openrouterImage(usage) {
  const body = { created: 1, data: [{ b64_json: candidateTile(256).toString('base64'), media_type: 'image/png' }] };
  if (usage !== undefined) body.usage = usage;
  return jsonResponse(200, body);
}

test('usage: a response with only total_tokens and cost leaves the token split unknown (null), not zero', async () => {
  const outDir = tmpDir('usage-partial');
  const { fetchImpl } = makeFetch(() => openrouterImage({ total_tokens: 40, cost: 0.1 }));
  const server = makeServer({ env: { ICON_AI_OPENROUTER_KEY: 'rvrvrvrv-3333-rvrvrvrv-4444' }, fetchImpl });
  const { parsed } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir, provider: 'openrouter' });
  assert.deepEqual(parsed.usage, { requests: 1, inputTokens: null, outputTokens: null, totalTokens: 40, cost: 0.1, costKnown: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(parsed.runJson, 'utf8')).batches[0].usage, parsed.usage, 'run.json agrees');
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('usage: an answer with no usage block at all leaves every field unknown', async () => {
  const outDir = tmpDir('usage-none');
  const { fetchImpl } = makeFetch(() => openrouterImage(undefined));
  const server = makeServer({ env: { ICON_AI_OPENROUTER_KEY: 'rvrvrvrv-3333-rvrvrvrv-4444' }, fetchImpl });
  const { parsed } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir, provider: 'openrouter' });
  assert.deepEqual(parsed.usage, { requests: 1, inputTokens: null, outputTokens: null, totalTokens: null, cost: null, costKnown: false });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('usage: fields are aggregated independently, and a field one billed answer omitted is unknown for the whole run', async () => {
  const outDir = tmpDir('usage-mixed');
  const answers = [
    { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.01 },
    { total_tokens: 50, cost: 0.02 }, // no token split
  ];
  let call = 0;
  const { fetchImpl } = makeFetch(() => openrouterImage(answers[call++ % 2]));
  const server = makeServer({ env: { ICON_AI_OPENROUTER_KEY: 'rvrvrvrv-3333-rvrvrvrv-4444' }, fetchImpl });
  const { parsed } = await callGenerate(server, { prompt: 'an app', count: 2, out_dir: outDir, provider: 'openrouter' });
  assert.equal(parsed.usage.requests, 2);
  assert.equal(parsed.usage.inputTokens, null, 'one answer did not report the input tokens, so the total is unknown');
  assert.equal(parsed.usage.outputTokens, null);
  assert.equal(parsed.usage.totalTokens, 80, 'both reported the total, so it is summed');
  assert.ok(Math.abs(parsed.usage.cost - 0.03) < 1e-9, 'both reported the cost, so it is summed');
  assert.equal(parsed.usage.costKnown, true);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('a size rejection produces a note, not a failure', async () => {
  const outDir = tmpDir('size');
  const { calls, fetchImpl } = makeFetch((call) => (call === 1 ? jsonResponse(400, { error: { message: 'image_size bad for this model' } }) : googleImageResponse(candidateTile(256))));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { isError, parsed } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir });
  assert.equal(isError, false);
  assert.equal(parsed.candidates.length, 1);
  assert.ok(parsed.notes.some((note) => /image_size/.test(note)));
  assert.equal(calls.length, 2);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('requested styles are honoured and unknown ones reported', async () => {
  const outDir = tmpDir('styles');
  const { fetchImpl } = makeFetch(() => googleImageResponse(candidateTile(256)));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const { parsed } = await callGenerate(server, { prompt: 'an app', count: 2, out_dir: outDir, styles: ['pixel-art', 'no-such-style'] });
  assert.equal(parsed.candidates[0].style, 'pixel-art', 'the requested style is used first');
  assert.notEqual(parsed.candidates[1].style, 'pixel-art');
  assert.ok(parsed.notes.some((note) => /unknown style ids ignored: no-such-style/.test(note)));
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('progress notifications stream the per-run total when a token is given', async () => {
  const outDir = tmpDir('progress');
  const { fetchImpl } = makeFetch(() => googleImageResponse(candidateTile(128)));
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl });
  const sent = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    const text = String(chunk);
    if (text.includes('notifications/progress')) sent.push(JSON.parse(text.trim()));
    return true;
  };
  try {
    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'generate_images', arguments: { prompt: 'an app', count: 3, out_dir: outDir }, _meta: { progressToken: 'tok-1' } },
    });
    assert.equal(response.result.isError, undefined);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.ok(sent.length >= 3, `at least one notification per candidate: ${sent.length}`);
  assert.ok(sent.every((message) => message.params.progressToken === 'tok-1'));
  assert.equal(Math.max(...sent.map((message) => message.params.progress)), 3);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('argument validation rejects nonsense before anything runs', async () => {
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_KEY }, fetchImpl: async () => { throw new Error('must not be called'); } });
  const cases = [
    [{}, /prompt must be a string/],
    [{ prompt: '' }, /too short/],
    [{ prompt: 'an app' }, /out_dir must be the folder/],
    [{ prompt: 'an app', out_dir: tmpDir('v'), count: 0 }, /count must be a whole number/],
    [{ prompt: 'an app', out_dir: tmpDir('v'), count: 17 }, /count must be a whole number/],
    [{ prompt: 'an app', out_dir: tmpDir('v'), size: 'huge' }, /size must be/],
    [{ prompt: 'an app', out_dir: tmpDir('v'), provider: 'custom' }, /provider must be/],
    [{ prompt: 'x'.repeat(900), out_dir: tmpDir('v') }, /under 800/],
  ];
  for (const [args, pattern] of cases) {
    const { isError, text } = await callGenerate(server, args);
    assert.equal(isError, true, `expected an error for ${JSON.stringify(args).slice(0, 60)}`);
    assert.match(text, pattern);
  }
});

test('an explicit provider override selects OpenRouter; model overrides pass through', async () => {
  const outDir = tmpDir('override');
  // The usage block has the shape the real endpoint returned on 2026-10-03 (extra detail fields included).
  const { calls, fetchImpl } = makeFetch(() => jsonResponse(200, {
    created: 1,
    data: [{ b64_json: candidateTile(256).toString('base64'), media_type: 'image/png' }],
    usage: {
      prompt_tokens: 18, completion_tokens: 747, total_tokens: 765, cost: 0.044829, is_byok: false,
      prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, image_tokens: 747 },
    },
  }));
  const server = makeServer({ env: { ICON_AI_OPENROUTER_KEY: 'rvrvrvrv-3333-rvrvrvrv-4444' }, fetchImpl });
  const { parsed } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir, provider: 'openrouter' });
  assert.equal(parsed.provider, 'openrouter');
  assert.equal(parsed.model, 'google/gemini-3.1-flash-image');
  assert.match(calls[0].url, /openrouter\.ai\/api\/v1\/images$/);
  assert.deepEqual(parsed.usage, { requests: 1, inputTokens: 18, outputTokens: 747, totalTokens: 765, cost: 0.044829, costKnown: true });
  const run = JSON.parse(fs.readFileSync(parsed.runJson, 'utf8'));
  assert.deepEqual(run.batches[0].usage, parsed.usage, 'run.json carries the same aggregated usage');
  fs.rmSync(outDir, { recursive: true, force: true });
});
