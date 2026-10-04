// Round 9 hardening: format bytes checked against the specs (not against our own parser), anti-aliased edges, the outer
// redaction layers, a decompression bomb, thin lines, network error causes, Google's retry hints, the deadline.
// Synthetic data only; no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { makeServer } from '../mcp/server.mjs';
import { requestJson, ProviderError } from '../mcp/lib/http.mjs';
import { runBatch } from '../mcp/lib/pool.mjs';
import { prepareCandidate, buildPack } from '../scripts/lib/packbuild.mjs';
import { decodePng, crc32 } from '../scripts/lib/png.mjs';
import { canvas, fillCircle, setPixel, pngOf, candidateTile } from './helpers.mjs';
import { makeTmpDir } from './tmp.mjs';

const REAL_TMP = fs.realpathSync(os.tmpdir());
const KEY = 'gxgxgxgx-1111-gxgxgxgx-2222';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function packFiles(master = 512) {
  const prepared = prepareCandidate(candidateTile(master));
  const written = new Map();
  buildPack(prepared, { name: 'app', publish: (rel, buffer) => written.set(rel, buffer) });
  return written;
}

/** Width and height straight from the IHDR bytes of a PNG (no decoder). */
function ihdr(png) {
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// --- formats against the specs ------------------------------------------------------------------------------------

test('the .ico bytes follow the ICO format: header, 16-byte directory entries, 32-bit PNG entries, contiguous data', () => {
  const ico = packFiles(512).get('windows/app.ico');
  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon');
  const count = ico.readUInt16LE(4);
  assert.equal(count, 7);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  let expectedOffset = 6 + count * 16;
  for (let i = 0; i < count; i += 1) {
    const e = 6 + i * 16;
    const side = sizes[i];
    assert.equal(ico[e], side === 256 ? 0 : side, `entry ${i} width byte (0 means 256)`);
    assert.equal(ico[e + 1], side === 256 ? 0 : side, `entry ${i} height byte`);
    assert.equal(ico.readUInt16LE(e + 4), 1, 'colour planes');
    assert.equal(ico.readUInt16LE(e + 6), 32, `entry ${i} bits per pixel`);
    const bytes = ico.readUInt32LE(e + 8);
    const offset = ico.readUInt32LE(e + 12);
    assert.equal(offset, expectedOffset, `entry ${i} data follows the previous one`);
    const blob = ico.subarray(offset, offset + bytes);
    assert.deepEqual(ihdr(blob), { width: side, height: side }, `entry ${i} holds a ${side} px PNG`);
    expectedOffset += bytes;
  }
  assert.equal(expectedOffset, ico.length, 'no trailing bytes');
});

test('the .icns chunk types match Apple\'s table (icp4/icp5/icp6, ic07-ic14) with the right pixel size in each', () => {
  const icns = packFiles(1024).get('macos/app.icns');
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  // type -> pixel size, written out from the published icon type table (ic11 = 16@2x = 32 px, ic12 = 32@2x = 64 px, ...).
  const table = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  const seen = {};
  let offset = 8;
  while (offset < icns.length) {
    const type = icns.toString('ascii', offset, offset + 4);
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(type in table, `known type ${type}`);
    assert.deepEqual(ihdr(icns.subarray(offset + 8, offset + length)), { width: table[type], height: table[type] }, `${type} holds ${table[type]} px`);
    seen[type] = true;
    offset += length;
  }
  assert.equal(offset, icns.length);
  assert.deepEqual(Object.keys(seen).sort(), Object.keys(table).sort(), 'every type of the table is present once');
});

// --- anti-aliased edges ---------------------------------------------------------------------------------------------

test('background removal leaves no white halo around an anti-aliased subject', () => {
  const size = 512;
  const rgba = canvas(size, [255, 255, 255, 255]);
  // A disc drawn with 4x4 supersampled edges: the edge pixels are real blends of blue and white.
  const cx = 256;
  const cy = 256;
  const radius = 150;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      for (let sy = 0; sy < 4; sy += 1) for (let sx = 0; sx < 4; sx += 1) {
        const dx = x + (sx + 0.5) / 4 - cx;
        const dy = y + (sy + 0.5) / 4 - cy;
        if (dx * dx + dy * dy <= radius * radius) inside += 1;
      }
      if (inside > 0) {
        const t = inside / 16;
        setPixel(rgba, size, x, y, [Math.round(255 + (20 - 255) * t), Math.round(255 + (90 - 255) * t), Math.round(255 + (200 - 255) * t), 255]);
      }
    }
  }
  const prepared = prepareCandidate(pngOf(rgba, size), { crop: false });
  const decoded = decodePng(prepared.png);
  let halo = 0;
  for (let o = 0; o < decoded.rgba.length; o += 4) {
    if (decoded.rgba[o + 3] > 0 && decoded.rgba[o] > 200 && decoded.rgba[o + 1] > 200 && decoded.rgba[o + 2] > 200) halo += 1;
  }
  assert.ok(halo < 10, `${halo} whitish pixels left on the edge`);
});

// --- thin lines -----------------------------------------------------------------------------------------------------

test('a 1 px line or antenna counts for the crop box; an isolated single pixel does not', () => {
  const size = 512;
  const rgba = canvas(size); // transparent
  for (let x = 100; x < 400; x += 1) setPixel(rgba, size, x, 256, [10, 10, 10, 255]); // a 1 px horizontal line
  const line = prepareCandidate(pngOf(rgba, size));
  assert.ok(!line.warnings.some((warning) => warning.code === 'nothing-visible'), 'a thin line is something');
  assert.equal(line.facts.fit.crop.mode, 'subject');
  assert.ok(line.facts.fit.crop.source.width >= 299, `the box spans the line: ${line.facts.fit.crop.source.width}`);

  const antenna = canvas(size, [255, 255, 255, 255]);
  fillCircle(antenna, size, 256, 300, 120, [30, 90, 200, 255]);
  for (let y = 60; y < 180; y += 1) setPixel(antenna, size, 256, y, [30, 90, 200, 255]); // a 1 px antenna on top
  const withAntenna = prepareCandidate(pngOf(antenna, size));
  assert.ok(withAntenna.facts.fit.crop.source.y <= 62, `the crop box reaches the antenna tip: y=${withAntenna.facts.fit.crop.source.y}`);

  const speck = canvas(size);
  setPixel(speck, size, 5, 5, [0, 0, 0, 255]);
  const alone = prepareCandidate(pngOf(speck, size));
  assert.ok(alone.warnings.some((warning) => warning.code === 'nothing-visible'), 'one lone pixel is not a subject');
});

// --- decompression bomb ---------------------------------------------------------------------------------------------

test('a PNG that inflates to far more than its header declares is refused, not decompressed', () => {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(head.subarray(4, 8), data), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  const bomb = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024))), chunk('IEND', Buffer.alloc(0))]);
  const before = process.memoryUsage().rss;
  assert.throws(() => decodePng(bomb), /does not decompress|more than its header declares/);
  assert.ok(process.memoryUsage().rss - before < 20 * 1024 * 1024, 'the 40 MB payload was never inflated');
  // A normal PNG still decodes.
  assert.equal(decodePng(pngOf(canvas(8, [1, 2, 3, 255]), 8)).width, 8);
});

// --- the outer redaction layers ---------------------------------------------------------------------------------------

test('a key typed into the prompt never reaches the tool result or any file the server writes (result layer and file layer)', async () => {
  const outDir = makeTmpDir('icon-ai-redact-');
  const okResponse = () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: candidateTile(128).toString('base64') }] }], usage: {} }),
  });
  const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: KEY }, fetchImpl: async () => okResponse() });
  const run = async (args) => {
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_images', arguments: args } });
    return response.result.content[0].text;
  };
  const first = await run({ prompt: `an app, my key is ${KEY}`, count: 1, out_dir: outDir });
  assert.ok(!first.includes(KEY), 'the tool result of a new run is clean');
  const runDir = JSON.parse(first).runDir;
  const second = await run({ prompt: `an app, my key is ${KEY}`, count: 1, run_dir: runDir });
  assert.ok(!second.includes(KEY), 'the tool result of a continued run is clean');
  for (const file of ['run.json', 'batch-2.json']) {
    const text = fs.readFileSync(path.join(runDir, file), 'utf8');
    assert.ok(!text.includes(KEY), `${file} is clean`);
    assert.ok(text.includes('an app, my key is'), `${file} still records the rest of the prompt`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
});

// --- network errors and Google's retry hints --------------------------------------------------------------------------

const rpcResponse = (status, body) => ({ ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('a network failure keeps its cause (undici says only "fetch failed"), and a refused redirect is recognised from the cause', async () => {
  const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' }) });
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => { throw dns; } }),
    (error) => error instanceof ProviderError && error.code === 'network' && error.retryable === true && /ENOTFOUND/.test(error.message) && /getaddrinfo/.test(error.message),
  );
  const redirect = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => { throw redirect; } }),
    (error) => error instanceof ProviderError && error.code === 'redirect' && error.retryable === false,
  );
});

test('Google 429: the RetryInfo delay is honoured, and a daily quota stops the batch instead of being retried', async () => {
  const withDelay = rpcResponse(429, { error: { message: 'slow down', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } });
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => withDelay }),
    (error) => error.code === 'rate-limit' && error.retryable === true && error.retryAfterMs === 7000,
  );
  const long = rpcResponse(429, { error: { message: 'slow', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }] } });
  await assert.rejects(requestJson({ url: 'https://x', fetchImpl: async () => long }), (error) => error.retryAfterMs === 30_000, 'capped like Retry-After');
  const daily = rpcResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => daily }),
    (error) => error.code === 'credits' && error.stopsBatch === true && /daily quota/.test(error.message),
  );
  const perMinute = rpcResponse(429, { error: { message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] }] } });
  await assert.rejects(requestJson({ url: 'https://x', fetchImpl: async () => perMinute }), (error) => error.code === 'rate-limit' && error.retryable === true, 'a per-minute quota is an ordinary rate limit');
});

// --- the deadline -----------------------------------------------------------------------------------------------------

test('the deadline lets the requests in flight finish and cuts the rest, naming them', async () => {
  const result = await runBatch({
    tasks: [1, 2, 3, 4, 5],
    // Like the real worker, this one hands the batch's abort signal to its request: a deadline that aborted the batch
    // would turn the three requests in flight into failures, which a worker that ignores the signal never shows.
    worker: (_task, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('ok'), 80);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new ProviderError('aborted', { code: 'aborted' })); });
    }),
    sleep: async () => {},
    deadlineMs: 10,
    jitter: () => 0,
  });
  assert.equal(result.stopped.code, 'deadline');
  assert.deepEqual(result.results, ['ok', 'ok', 'ok', null, null], 'three in flight finished, two never started');
  assert.deepEqual(result.failures.map((failure) => [failure.index, failure.code]), [[3, 'aborted'], [4, 'aborted']]);
});

// --- two processes, one name -------------------------------------------------------------------------------------------

test('six processes creating the same candidate file at the same instant: exactly one wins and nobody overwrites it', async () => {
  const dir = makeTmpDir('icon-ai-excl-');
  const target = path.join(dir, 'candidate-1.png');
  const pathsUrl = new URL('../mcp/lib/paths.mjs', import.meta.url).href;
  const size = 6 * 1024 * 1024;
  const script = [
    `const { writeFileExclusive } = await import(${JSON.stringify(pathsUrl)});`,
    'const [target, id, startAt] = process.argv.slice(1);',
    `const buffer = Buffer.alloc(${size}, Number(id));`,
    'while (Date.now() < Number(startAt)) { /* spin until the shared start */ }',
    'try { writeFileExclusive(target, buffer); process.exit(0); } catch (error) { process.exit(/already exists/.test(error.message) ? 3 : 4); }',
  ].join('\n');
  const startAt = Date.now() + 3500;
  const codes = await Promise.all([1, 2, 3, 4, 5, 6].map((id) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, target, String(id), String(startAt)], { stdio: 'ignore', windowsHide: true });
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  })));
  const winners = codes.filter((code) => code === 0).length;
  assert.equal(winners, 1, `exactly one process may create the file, got exit codes ${codes.join(',')}`);
  assert.ok(codes.every((code) => code === 0 || code === 3), `the others must be refused with "already exists", got ${codes.join(',')}`);
  const winner = codes.indexOf(0) + 1;
  assert.ok(fs.readFileSync(target).equals(Buffer.alloc(size, winner)), 'the file holds the winner\'s bytes, whole');
  assert.deepEqual(fs.readdirSync(dir), ['candidate-1.png'], 'no half-written temporary file is left behind');
});

// --- the provider setting is free text now (the directory refuses `options` in userConfig) -----------------------------------

test('a provider setting that is not one of the three values means auto; case and spaces do not matter', async () => {
  const setting = async (value) => {
    const server = makeServer({ env: { ICON_AI_GOOGLE_KEY: 'gxgxgxgx-1111-gxgxgxgx-2222', ICON_AI_PROVIDER: value } });
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_setup', arguments: {} } });
    return JSON.parse(response.result.content[0].text).providerSetting;
  };
  assert.equal(await setting('Banana'), 'auto');
  assert.equal(await setting(' OpenRouter '), 'openrouter');
  assert.equal(await setting('google'), 'google');
  assert.equal(await setting(''), 'auto');
});
