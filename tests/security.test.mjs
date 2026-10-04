// Security proofs: a sentinel key placed in the server's environment never
// appears in a tool result, an error, run.json, any file under the run
// folder, stderr, or the process arguments — on the success path and on
// every failure path (HTTP error bodies that echo headers, thrown exceptions,
// timeouts, a rejected key). Driven in-process with an injected fetch and,
// for the process-level guarantees, against the real spawned server.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeRedactor, redactDeep, bufferHoldsSecret } from '../mcp/lib/redact.mjs';
import { makeServer } from '../mcp/server.mjs';
import { acceptImage } from '../mcp/lib/drop.mjs';
import { candidateTile, tinyWebpBytes } from './helpers.mjs';
import { PROGRESSIVE_JPEG } from './jpeg-fixtures.mjs';
import { makeTmpDir } from './tmp.mjs';

// On macOS os.tmpdir() is behind the /var symlink, which the plugin refuses by design: tests use its real path.
const REAL_TMP = fs.realpathSync(os.tmpdir());

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SERVER = path.join(ROOT, 'mcp', 'server.mjs');

// Sentinels are neutral strings with NO provider-key prefix or shape: they
// cannot be mistaken for a real Google or OpenRouter key by a scanner, and
// they prove that redaction works by VALUE, not by prefix (a real Google key
// may not start with a known prefix at all; newer ones start with "AQ.").
// Pattern-shaped inputs for the bonus patterns are assembled from
// character codes so no key-shaped literal ever sits in this file.
const GOOGLE_SENTINEL = 'gxgxgxgx-1111-gxgxgxgx-2222';
const OR_SENTINEL = 'rvrvrvrv-3333-rvrvrvrv-4444';
// A Google-shaped string (0x41 0x49 0x7a 0x61 = A I z a), for the pattern test only.
const GOOGLE_SHAPED = String.fromCharCode(0x41, 0x49, 0x7a, 0x61) + 'b'.repeat(35);
// An OpenRouter-shaped string, also assembled by character code.
const OR_SHAPED = String.fromCharCode(0x73, 0x6b, 0x2d, 0x6f, 0x72, 0x2d) + 'c'.repeat(20);
// UPDATE 2: a key with an unknown prefix ("AQ.") and one with no prefix at
// all — the value-based redaction must catch both without any pattern help.
// Assembled from character codes (A Q .), so no key-shaped literal sits in this file.
const AQ_SENTINEL = String.fromCharCode(0x41, 0x51, 0x2e) + 'zrzrzrzr-5555-zrzrzrzr';
const PLAIN_SENTINEL = 'wmwmwmwm-6666-wmwmwmwm-7777';

function tmpDir(label) {
  return makeTmpDir(`icon-ai-sec-${label}-`);
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

function googleOk() {
  return jsonResponse(200, {
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: candidateTile(256).toString('base64') }] }],
    usage: { total_input_tokens: 5, total_output_tokens: 500, total_tokens: 505 },
  });
}

/** Every file under `dir`, recursively, as { path, text } for scanning. */
function scanTree(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...scanTree(full));
    else found.push({ path: full, text: fs.readFileSync(full, 'utf8') });
  }
  return found;
}

function assertNoSecrets(label, sources, secrets = [GOOGLE_SENTINEL, OR_SENTINEL]) {
  for (const { name, value } of sources) {
    for (const secret of secrets) {
      assert.ok(!value.includes(secret), `${label}: ${name} contains a secret`);
      assert.ok(!value.includes(secret.slice(0, 8)), `${label}: ${name} contains a secret prefix`);
    }
  }
}

async function callGenerate(server, args, timeoutMs = 30_000) {
  const response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_images', arguments: args } });
  return { isError: response.result.isError === true, text: response.result.content[0].text };
}

test('the redactor scrubs by VALUE, whatever the prefix — including none', () => {
  const redact = makeRedactor([GOOGLE_SENTINEL, OR_SENTINEL, AQ_SENTINEL, PLAIN_SENTINEL, 'short']);
  for (const secret of [GOOGLE_SENTINEL, OR_SENTINEL, AQ_SENTINEL, PLAIN_SENTINEL]) {
    assert.equal(redact(`a ${secret} b`), 'a *** b', `value redaction for ${secret.slice(0, 4)}...`);
    assert.ok(!redact(`x${secret}x`).includes(secret));
  }
  // A short value (< 8 chars) is ignored on purpose: replacing it would
  // destroy ordinary messages.
  assert.equal(redact('a short b'), 'a short b');
});

test('the redactor also scrubs key-shaped patterns it was not told about (bonus, not the defence)', () => {
  const redact = makeRedactor([GOOGLE_SENTINEL]);
  const dirty = `unrelated ${GOOGLE_SHAPED} and ${OR_SHAPED} shaped strings`;
  const clean = redact(dirty);
  assert.ok(!clean.includes(GOOGLE_SHAPED));
  assert.ok(!clean.includes(OR_SHAPED));
  assert.ok(clean.includes('***'));
});

test('redactDeep walks objects, arrays and keys', () => {
  const redact = makeRedactor([GOOGLE_SENTINEL]);
  const dirty = { note: `key: ${GOOGLE_SENTINEL}`, list: [`x ${GOOGLE_SENTINEL}`], nested: { [GOOGLE_SENTINEL.slice(0, 10)]: 1 } };
  const clean = redactDeep(dirty, redact);
  assert.ok(!JSON.stringify(clean).includes(GOOGLE_SENTINEL));
});

test('success path: the sentinel never reaches a result, a file or stderr', async () => {
  const outDir = tmpDir('success');
  const stderrChunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrChunks.push(String(chunk)); return true; };
  let server;
  try {
    server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL }, fetchImpl: async () => googleOk() });
    const { isError, text } = await callGenerate(server, { prompt: 'a weather radar app', count: 3, out_dir: outDir });
    assert.equal(isError, false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.candidates.length, 3);
    assertNoSecrets('success', [{ name: 'tool result', value: text }, ...scanTree(outDir).map((f) => ({ name: f.path, value: f.text })), { name: 'stderr', value: stderrChunks.join('') }]);
  } finally {
    process.stderr.write = originalWrite;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('failure path: an HTTP error body that echoes the Authorization header', async () => {
  const outDir = tmpDir('echo');
  // Every attempt fails with a body that contains the key and the header line.
  const echoBody = async () => jsonResponse(500, { error: { message: `upstream failed for header x-goog-api-key: ${GOOGLE_SENTINEL}` } });
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL }, fetchImpl: echoBody });
  const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 2, out_dir: outDir }, 60_000);
  assert.equal(isError, true, 'all candidates failed');
  assert.match(text, /upstream failed for header/);
  assertNoSecrets('echo-body', [{ name: 'tool result', value: text }, ...scanTree(outDir).map((f) => ({ name: f.path, value: f.text }))]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('failure path: an exception that carries the key in its message', async () => {
  const outDir = tmpDir('throw');
  const throwing = async () => { throw new Error(`socket destroyed while sending key ${GOOGLE_SENTINEL}`); };
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL }, fetchImpl: throwing });
  const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir }, 60_000);
  assert.equal(isError, true);
  assertNoSecrets('exception', [{ name: 'tool result', value: text }, ...scanTree(outDir).map((f) => ({ name: f.path, value: f.text }))]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('failure path: a timeout that aborts the request', async () => {
  const outDir = tmpDir('timeout');
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error(`request with key ${GOOGLE_SENTINEL} aborted`)));
    });
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL }, fetchImpl: hanging, requestTimeoutMs: 40 });
  const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir }, 60_000);
  assert.equal(isError, true);
  assert.match(text, /timed out/);
  assertNoSecrets('timeout', [{ name: 'tool result', value: text }, ...scanTree(outDir).map((f) => ({ name: f.path, value: f.text }))]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('failure path: a 401 stops the batch and leaks nothing', async () => {
  const outDir = tmpDir('auth');
  let calls = 0;
  const server = makeServer({
    env: { ICON_AI_OPENROUTER_KEY: OR_SENTINEL },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(401, { error: { message: `invalid key ${OR_SENTINEL}` } });
    },
  });
  const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 8, out_dir: outDir });
  assert.equal(isError, true);
  assert.match(text, /rejected the key/);
  assert.ok(calls <= 3, `the bad key was used ${calls} times at most`);
  assertNoSecrets('auth', [{ name: 'tool result', value: text }, ...scanTree(outDir).map((f) => ({ name: f.path, value: f.text }))]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('check_setup with verify on a rejected key reports the failure scrubbed', async () => {
  const server = makeServer({
    env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL },
    fetchImpl: async () => jsonResponse(403, { error: { message: `key ${GOOGLE_SENTINEL} not allowed` } }),
  });
  const response = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_setup', arguments: { verify: true } } });
  const setup = JSON.parse(response.result.content[0].text);
  assert.equal(setup.providers.google.configured, true);
  assert.equal(setup.providers.google.verified, false);
  assert.match(setup.providers.google.error, /rejected the key/);
  assertNoSecrets('verify', [{ name: 'check_setup', value: response.result.content[0].text }]);
});

test('check_setup with verify on a SUCCESSFUL answer that echoes the key reports booleans only', async () => {
  // Review 2, finding 1: a provider-controlled field (a model name, a key label) used to be copied into the result.
  const cases = [
    { id: 'google', env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL }, secret: GOOGLE_SENTINEL, body: { models: [{ name: `models/${GOOGLE_SENTINEL}` }], label: GOOGLE_SENTINEL } },
    { id: 'openrouter', env: { ICON_AI_OPENROUTER_KEY: OR_SENTINEL }, secret: OR_SENTINEL, body: { data: { label: OR_SENTINEL, name: OR_SENTINEL } } },
  ];
  for (const { id, env, secret, body } of cases) {
    const server = makeServer({ env, fetchImpl: async () => jsonResponse(200, body) });
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_setup', arguments: { verify: true } } });
    assert.equal(response.result.isError, undefined);
    const text = response.result.content[0].text;
    assert.deepEqual(JSON.parse(text).providers[id], { configured: true, verified: true }, `${id}: only booleans come back`);
    assert.ok(!text.includes(secret), `${id}: the echoed key is not in the result`);
  }
});

test('a key echoed in a field of a SUCCESSFUL generate answer never reaches the result or any file', async () => {
  const outDir = tmpDir('echo-ok');
  const server = makeServer({
    env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL },
    fetchImpl: async () =>
      jsonResponse(200, {
        id: GOOGLE_SENTINEL,
        model: GOOGLE_SENTINEL,
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: candidateTile(256).toString('base64') }] }],
        usage: { total_input_tokens: 5, total_output_tokens: 500, total_tokens: 505 },
      }),
  });
  const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir });
  assert.equal(isError, false);
  assertNoSecrets('echo-ok', [{ name: 'tool result', value: text }, ...scanTree(outDir).map((f) => ({ name: f.path, value: f.text }))]);
  fs.rmSync(outDir, { recursive: true, force: true });
});

// Review 3: raw provider bytes (a WebP, a JPEG the decoder refuses, a PNG it cannot decode) are written unchanged, so
// text redaction cannot clean them. A payload that carries the key must never be written.
function corruptedPng(secret) {
  const png = Buffer.from(candidateTile(256));
  png[Math.floor(png.length / 2)] ^= 0xff; // breaks the CRC of an IDAT chunk: valid header, undecodable body
  return Buffer.concat([png, Buffer.from(secret, 'utf8')]);
}

const RAW_PATHS = [
  { name: 'a WebP', mime: 'image/webp', format: 'webp', make: (secret) => Buffer.concat([tinyWebpBytes(512, 512), Buffer.from(secret, 'utf8')]) },
  { name: 'a JPEG the decoder refuses', mime: 'image/jpeg', format: 'jpeg', make: (secret) => Buffer.concat([Buffer.from(PROGRESSIVE_JPEG, 'base64'), Buffer.from(secret, 'utf8')]) },
  { name: 'a PNG the decoder cannot decode', mime: 'image/png', format: 'png', make: corruptedPng },
];

function googleWith(image, mime) {
  return jsonResponse(200, {
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: mime, data: image.toString('base64') }] }],
    usage: { total_input_tokens: 5, total_output_tokens: 500, total_tokens: 505 },
  });
}

for (const raw of RAW_PATHS) {
  test(`raw bytes that carry the key are never written: ${raw.name}`, async () => {
    const withKey = raw.make(GOOGLE_SENTINEL);
    // The test must really exercise the keep-raw path, or it proves nothing.
    const accepted = acceptImage(withKey);
    assert.equal(accepted.ok, false, `${raw.name} is not decoded`);
    assert.equal(accepted.keepRaw, true, `${raw.name} takes the keep-raw path`);
    assert.equal(accepted.format, raw.format);

    const outDir = tmpDir('raw-leak');
    const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL }, fetchImpl: async () => googleWith(withKey, raw.mime) });
    const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir });
    assert.equal(isError, true, 'the only candidate was discarded, so the run reports that');
    assert.match(text, /contain the configured key; it was discarded/);
    assert.ok(!text.includes(GOOGLE_SENTINEL));
    const files = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : files.push(path.join(dir, entry.name))));
    walk(outDir);
    assert.ok(files.length > 0, 'run.json was written');
    for (const file of files) {
      assert.ok(!fs.readFileSync(file).includes(Buffer.from(GOOGLE_SENTINEL, 'utf8')), `${path.basename(file)} holds no key bytes`);
      assert.ok(!/candidate-\d+\.(webp|jpeg|png)$/.test(file), `no candidate file was written (${path.basename(file)})`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test(`the same raw path without the key is still kept, with a warning: ${raw.name}`, async () => {
    const clean = raw.make('');
    const outDir = tmpDir('raw-keep');
    const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL }, fetchImpl: async () => googleWith(clean, raw.mime) });
    const { isError, text } = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir });
    assert.equal(isError, false, text.slice(0, 300));
    const parsed = JSON.parse(text);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.candidates[0].file, `candidate-1.${raw.format}`);
    assert.ok(parsed.candidates[0].warning.length > 0);
    fs.rmSync(outDir, { recursive: true, force: true });
  });
}

// Review 5: a provider may echo only the START or a middle run of a key (an error body that quotes the first characters
// of what it was sent). Redacting the whole value only is not enough: no prefix longer than four characters and no run of
// eight characters of a configured key may appear in any text the plugin emits.
function holdsFragment(text, key) {
  if (text.includes(key.slice(0, 5))) return true;
  for (let start = 0; start + 8 <= key.length; start += 1) {
    if (text.includes(key.slice(start, start + 8))) return true;
  }
  return false;
}

async function captureStderr(run) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

const FRAGMENT_KEYS = [
  { label: 'a neutral key with no provider shape', key: PLAIN_SENTINEL },
  { label: 'an AQ-style key', key: AQ_SENTINEL },
  { label: 'a Google-style test key', key: GOOGLE_SENTINEL },
];

// Every echo carries BOTH the first eight characters and a twelve-character run from the middle of the key.
const echoOf = (key) => `${key.slice(0, 8)} ... ${key.slice(10, 22)}`;

const FRAGMENT_PATHS = [
  { name: 'an HTTP 400 body', surfaces: true, fetch: (echo) => async () => jsonResponse(400, { error: { message: `request rejected, you sent ${echo}` } }) },
  { name: 'a 401 body (the batch stops)', surfaces: true, fetch: (echo) => async () => jsonResponse(401, { error: { message: `invalid key starting ${echo}` } }) },
  { name: 'a thrown exception', surfaces: false, fetch: (echo) => async () => { throw new Error(`connection reset near ${echo}`); } },
  { name: 'a redirect-style error', surfaces: false, fetch: (echo) => async () => { throw new TypeError(`redirect to https://x/?k=${echo}`); } },
];

for (const { label, key } of FRAGMENT_KEYS) {
  for (const route of FRAGMENT_PATHS) {
    test(`a partial echo of ${label} is scrubbed from ${route.name} (result, files, stderr)`, async () => {
      const outDir = tmpDir('fragment');
      const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: key }, fetchImpl: route.fetch(echoOf(key)) });
      let outcome;
      const stderr = await captureStderr(async () => {
        outcome = await callGenerate(server, { prompt: 'an app', count: 1, out_dir: outDir }, 60_000);
      });
      assert.equal(outcome.isError, true);
      if (route.surfaces) assert.ok(outcome.text.includes('***'), 'the provider excerpt reached the redactor');
      assert.ok(!holdsFragment(outcome.text, key), 'the tool result holds no fragment of the key');
      assert.ok(!holdsFragment(stderr, key), 'stderr holds no fragment of the key');
      for (const file of scanTree(outDir)) assert.ok(!holdsFragment(file.text, key), `${path.basename(file.path)} holds no fragment of the key`);
      fs.rmSync(outDir, { recursive: true, force: true });
    });
  }

  test(`a partial echo of ${label} is scrubbed from a rejected check_setup verification`, async () => {
    const server = makeServer({
      env: { ICON_AI_GOOGLE_KEY: key },
      fetchImpl: async () => jsonResponse(403, { error: { message: `key ${echoOf(key)} is not allowed` } }),
    });
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_setup', arguments: { verify: true } } });
    const text = response.result.content[0].text;
    assert.ok(text.includes('***'), 'the provider excerpt reached the redactor');
    assert.ok(!holdsFragment(text, key));
  });
}

test('the redactor hides the start of a key, runs from inside it, and merges overlapping hits', () => {
  const key = 'qjqjqjqj-8888-qjqjqjqj';
  const redact = makeRedactor([key, 'short']);
  assert.equal(redact(`a ${key} b`), 'a *** b', 'the whole value, one placeholder');
  assert.equal(redact(`x ${key.slice(0, 8)} y`), 'x *** y', 'the first eight characters');
  assert.ok(!redact(`x ${key.slice(0, 5)} y`).includes(key.slice(0, 5)), 'the first five characters');
  assert.equal(redact(`x ${key.slice(6, 18)} y`), 'x *** y', 'a twelve-character run from the middle, merged into one placeholder');
  assert.equal(redact(`x ${key.slice(6, 13)} y`), `x ${key.slice(6, 13)} y`, 'seven characters from the middle are left alone');
  assert.equal(redact('plain text without any key'), 'plain text without any key');
  assert.equal(makeRedactor([])('nothing to hide'), 'nothing to hide');
});

test('bufferHoldsSecret finds the whole key, its first five characters and any eight-character run', () => {
  const needle = 'zz-binary-needle-value-123456';
  const around = (middle) => Buffer.concat([Buffer.from([0, 255, 1, 2]), Buffer.from(middle, 'utf8'), Buffer.from([9, 8, 7])]);
  assert.equal(bufferHoldsSecret(around(needle), [needle]), true, 'the whole value');
  assert.equal(bufferHoldsSecret(around(needle.slice(0, 5)), [needle]), true, 'the first five characters');
  assert.equal(bufferHoldsSecret(around(needle.slice(7, 15)), [needle]), true, 'eight characters from the middle');
  assert.equal(bufferHoldsSecret(around(needle.slice(7, 14)), [needle]), false, 'seven characters from the middle are not a key');
  assert.equal(bufferHoldsSecret(around('nothing to see here'), [needle, 'short']), false);
  assert.equal(bufferHoldsSecret(around('short'), ['short']), false, 'values under eight characters are ignored');
  assert.equal(bufferHoldsSecret(candidateTile(256), [GOOGLE_SENTINEL, OR_SENTINEL]), false, 'an ordinary image is clean');
});

test('the spawned process carries the key only in its environment, never in argv', async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ICON_AI_GOOGLE_KEY: GOOGLE_SENTINEL },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  const answer = new Promise((resolve) => {
    child.stdout.on('data', () => {
      for (const line of stdout.split('\n')) {
        if (line.includes('"id":77')) resolve(JSON.parse(line));
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'check_setup', arguments: {} } })}\n`);
  const response = await answer;
  assert.equal(response.result.isError, undefined);
  assert.ok(!response.result.content[0].text.includes(GOOGLE_SENTINEL));
  // By construction the command line is exactly [node, server.mjs]; assert it
  // so a future change that moves the key into argv fails here.
  assert.equal(child.spawnargs.length, 2);
  const googlePrefix = String.fromCharCode(0x41, 0x49, 0x7a, 0x61);
  assert.ok(!child.spawnargs.join(' ').includes(googlePrefix));
  child.kill();
});
