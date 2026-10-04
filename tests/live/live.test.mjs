// Opt-in live tests: skipped unless ICON_AI_LIVE_GOOGLE_KEY or
// ICON_AI_LIVE_OPENROUTER_KEY is set in the environment of the test runner.
// Per configured provider they make REAL draft generations and bill the
// account the key belongs to (one image for the provider check, one for the
// full chain). Run them only with your own key:
//
//   ICON_AI_LIVE_GOOGLE_KEY=... node --test tests/live/live.test.mjs
//
// CI never sets these variables, so the suite on a clean clone stays offline.
// Generated images go to the OS temp folder and are never committed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { googleGenerateImage, googleVerifyKey } from '../../mcp/lib/provider-google.mjs';
import { openrouterGenerateImage, openrouterVerifyKey } from '../../mcp/lib/provider-openrouter.mjs';
import { validateImage } from '../../scripts/lib/imagecheck.mjs';
import { acceptImage } from '../../mcp/lib/drop.mjs';
import { decodePng } from '../../scripts/lib/png.mjs';
import { parseIco } from '../../scripts/lib/ico.mjs';
import { buildPrompt } from '../../mcp/lib/prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOOGLE_KEY = process.env.ICON_AI_LIVE_GOOGLE_KEY ?? '';
const OPENROUTER_KEY = process.env.ICON_AI_LIVE_OPENROUTER_KEY ?? '';
const SUBJECT = 'a chess clock for correspondence chess with two analog dials';
const PROMPT = buildPrompt(SUBJECT, 'flat minimal glyph, two or three solid colours');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icon-ai-live-'));
}

/** Whatever the provider sent must end up as a PNG we can build packs from. */
function assertUsable(result) {
  const info = validateImage(result.image);
  assert.ok(['png', 'jpeg', 'webp'].includes(info.format), `format ${info.format}`);
  assert.ok(info.width >= 512 && info.width <= 4096, `width ${info.width}`);
  const accepted = acceptImage(result.image);
  assert.equal(accepted.ok, true, accepted.reason);
  const picture = decodePng(accepted.png);
  assert.equal(picture.width, info.width);
  assert.equal(picture.height, info.height);
  return { info, accepted };
}

/** Talk to the real server process the way Claude Code does: JSON lines on stdio. */
function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let stderr = '';
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      const resolve = waiting.get(message.id);
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  let nextId = 1;
  return {
    stderr: () => stderr,
    request(method, params, timeoutMs = 120_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} within ${timeoutMs} ms`)), timeoutMs);
        waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async stop() {
      child.stdin.end();
      await new Promise((resolve) => child.on('close', resolve));
    },
  };
}

/** The whole product path: real server over stdio -> generate_images -> pack.mjs build and sheet. */
async function fullChain({ providerId, key, keyEnv, size = 'draft' }) {
  const outDir = tmpDir();
  const server = startServer({ [keyEnv]: key, ICON_AI_PROVIDER: providerId });
  try {
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test', version: '0' } });
    assert.equal(init.error, undefined);
    server.notify('notifications/initialized', {});
    const call = await server.request('tools/call', { name: 'generate_images', arguments: { prompt: SUBJECT, count: 1, size, out_dir: outDir, provider: providerId } });
    assert.equal(call.error, undefined, JSON.stringify(call.error));
    const text = call.result.content[0].text;
    assert.equal(call.result.isError === true, false, text);
    assert.ok(!text.includes(key), 'the key never appears in a tool result');
    const parsed = JSON.parse(text);
    assert.equal(parsed.candidates.length, 1, `candidates: ${text.slice(0, 400)}`);
    assert.equal(parsed.candidates[0].warning, undefined, 'a live response should need no warning');
    assert.ok(parsed.usage.totalTokens > 0, `the provider reported usage: ${JSON.stringify(parsed.usage)}`);
    assert.ok(parsed.usage.inputTokens > 0 && parsed.usage.outputTokens > 0, `input and output tokens are reported separately: ${JSON.stringify(parsed.usage)}`);
    const candidate = path.join(parsed.runDir, parsed.candidates[0].file);
    assert.equal(path.extname(candidate), '.png');
    const picture = decodePng(fs.readFileSync(candidate));
    assert.ok(picture.width >= (size === 'large' ? 1024 : 512), `candidate width ${picture.width}`);

    const pack = path.join(ROOT, 'scripts', 'pack.mjs');
    const built = execFileSync(process.execPath, [pack, 'build', '--run', parsed.runDir, '--name', 'live'], { encoding: 'utf8', windowsHide: true });
    const sheeted = execFileSync(process.execPath, [pack, 'sheet', '--run', parsed.runDir], { encoding: 'utf8', windowsHide: true });
    const windowsDir = path.join(parsed.runDir, 'pack-1', 'windows');
    const ico = fs.readdirSync(windowsDir).find((entry) => entry.endsWith('.ico'));
    assert.ok(ico, 'the pack contains a Windows .ico');
    const parsedIco = parseIco(fs.readFileSync(path.join(windowsDir, ico)));
    const entries = parsedIco.entries;
    assert.ok(parsedIco.count >= 6 && entries.length === parsedIco.count, `ico entries: ${parsedIco.count}`);
    assert.ok(fs.readdirSync(parsed.runDir).some((entry) => /^sheet-\d+\.png$/.test(entry)), 'a contact sheet exists');
    if (size === 'large') {
      const macosDir = path.join(parsed.runDir, 'pack-1', 'macos');
      assert.ok(fs.readdirSync(macosDir).some((entry) => entry.endsWith('.icns')), 'a 1K master yields the macOS .icns');
    }
    assert.ok(!stderrOrOutputLeaks(server.stderr(), built, sheeted, key), 'no key in stderr or script output');
    console.log(`${providerId} full chain (${size}) ok: ${picture.width}x${picture.height} candidate, ${entries.length} ico entries, run folder ${parsed.runDir}`);
  } finally {
    await server.stop();
  }
}

function stderrOrOutputLeaks(...parts) {
  const key = parts.pop();
  return parts.some((part) => String(part).includes(key));
}

test('google: verify the key, then generate one draft image', { skip: GOOGLE_KEY === '' && 'set ICON_AI_LIVE_GOOGLE_KEY to run' }, async () => {
  const verified = await googleVerifyKey({ apiKey: GOOGLE_KEY });
  assert.equal(verified.ok, true);
  const result = await googleGenerateImage({ apiKey: GOOGLE_KEY, prompt: PROMPT, size: 'draft' });
  const { info, accepted } = assertUsable(result);
  const out = path.join(tmpDir(), 'live-google.png');
  fs.writeFileSync(out, accepted.png);
  console.log(`google live draft: ${info.format} ${info.width}x${info.height}, ${result.image.length} bytes, written as PNG to ${out}, usage ${JSON.stringify(result.usage)}${result.note ? `, note: ${result.note}` : ''}`);
});

test('google: the full chain through the real server, pack builder and contact sheet', { skip: GOOGLE_KEY === '' && 'set ICON_AI_LIVE_GOOGLE_KEY to run' }, async () => {
  await fullChain({ providerId: 'google', key: GOOGLE_KEY, keyEnv: 'ICON_AI_GOOGLE_KEY' });
});

test('openrouter: verify the key, then generate one draft image', { skip: OPENROUTER_KEY === '' && 'set ICON_AI_LIVE_OPENROUTER_KEY to run' }, async () => {
  const verified = await openrouterVerifyKey({ apiKey: OPENROUTER_KEY });
  assert.equal(verified.ok, true);
  const result = await openrouterGenerateImage({ apiKey: OPENROUTER_KEY, prompt: PROMPT, size: 'draft' });
  const { info, accepted } = assertUsable(result);
  const out = path.join(tmpDir(), 'live-openrouter.png');
  fs.writeFileSync(out, accepted.png);
  console.log(`openrouter live draft: ${info.format} ${info.width}x${info.height}, ${result.image.length} bytes, written as PNG to ${out}, usage ${JSON.stringify(result.usage)}${result.note ? `, note: ${result.note}` : ''}`);
});

test('openrouter: the full chain through the real server, pack builder and contact sheet', { skip: OPENROUTER_KEY === '' && 'set ICON_AI_LIVE_OPENROUTER_KEY to run' }, async () => {
  await fullChain({ providerId: 'openrouter', key: OPENROUTER_KEY, keyEnv: 'ICON_AI_OPENROUTER_KEY' });
});

test('google: the full chain at the large (1K) size, including the macOS .icns', { skip: GOOGLE_KEY === '' && 'set ICON_AI_LIVE_GOOGLE_KEY to run' }, async () => {
  await fullChain({ providerId: 'google', key: GOOGLE_KEY, keyEnv: 'ICON_AI_GOOGLE_KEY', size: 'large' });
});

test('openrouter: the full chain at the large (1K) size, including the macOS .icns', { skip: OPENROUTER_KEY === '' && 'set ICON_AI_LIVE_OPENROUTER_KEY to run' }, async () => {
  await fullChain({ providerId: 'openrouter', key: OPENROUTER_KEY, keyEnv: 'ICON_AI_OPENROUTER_KEY', size: 'large' });
});
