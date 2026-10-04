// Tests of the two provider modules with an injected fetch: the exact
// request shape, the response parsing, the error mapping and the one-retry
// rule for a rejected size field. No test ever reaches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { googleGenerateImage, googleVerifyKey, GOOGLE_ORIGIN } from '../mcp/lib/provider-google.mjs';
import { openrouterGenerateImage, openrouterVerifyKey, OPENROUTER_ORIGIN } from '../mcp/lib/provider-openrouter.mjs';
import { requestJson, parseRetryAfterMs, validateModelName, ProviderError } from '../mcp/lib/http.mjs';
import { candidateTile } from './helpers.mjs';
import { SQUARE_420_JPEG } from './jpeg-fixtures.mjs';

// Neutral test keys: no provider prefix, no key shape — a scanner cannot
// mistake them for real credentials, and the tests still exercise every path.
const GOOGLE_KEY = 'gxgxgxgx-1111-gxgxgxgx-2222';
const OR_KEY = 'rvrvrvrv-3333-rvrvrvrv-4444';

const PNG_B64 = candidateTile(128).toString('base64');
// Google's image models answer image/jpeg only (verified live 2026-10-03), so its fixture is a real JPEG.
const GOOGLE_JPEG_B64 = SQUARE_420_JPEG;

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
    id: 'x',
    model: 'gemini-3.1-flash-image',
    status: 'completed',
    steps: [
      { type: 'thought', summary: 'thinking...' },
      { type: 'model_output', content: [
        { type: 'text', text: 'here is your icon' },
        { type: 'image', mime_type: 'image/jpeg', data: GOOGLE_JPEG_B64 },
      ] },
    ],
    usage: { total_input_tokens: 12, total_output_tokens: 1289, total_tokens: 1301 },
  });
}

function openrouterOk() {
  return jsonResponse(200, {
    created: 1,
    data: [{ b64_json: PNG_B64, media_type: 'image/png' }],
    usage: { prompt_tokens: 12, completion_tokens: 1289, total_tokens: 1301, cost: 0.004 },
  });
}

test('google sends the documented Interactions API shape', async () => {
  const calls = [];
  const result = await googleGenerateImage({
    apiKey: GOOGLE_KEY,
    prompt: 'a chess clock app',
    size: 'draft',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return googleOk();
    },
  });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${GOOGLE_ORIGIN}/v1/interactions`, 'the stable path, not v1beta');
  assert.equal(init.headers['x-goog-api-key'], GOOGLE_KEY);
  assert.equal(init.redirect, 'error', 'redirects must be refused');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gemini-3.1-flash-image');
  assert.equal(body.input, 'a chess clock app', 'on the stable path the input is a plain string');
  assert.deepEqual(body.response_format, { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '512' });
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.image.length, Buffer.from(GOOGLE_JPEG_B64, 'base64').length);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 1289, totalTokens: 1301 });
});

test('google retries once without image_size when the size is rejected', async () => {
  const bodies = [];
  let call = 0;
  const result = await googleGenerateImage({
    apiKey: GOOGLE_KEY,
    prompt: 'p',
    size: 'draft',
    fetchImpl: async (url, init) => {
      call += 1;
      bodies.push(JSON.parse(init.body));
      if (call === 1) return jsonResponse(400, { error: { message: 'image_size is not supported for this model' } });
      return googleOk();
    },
  });
  assert.equal(call, 2);
  assert.ok(!('image_size' in bodies[1].response_format), 'the retry drops the size field');
  assert.match(result.note, /image_size/);
  assert.equal(bodies[1].response_format.mime_type, 'image/jpeg', 'the retry still asks for JPEG, the only format Google returns');
  assert.ok(result.image.length > 0);
});

test('openrouter sends the documented /api/v1/images shape', async () => {
  const calls = [];
  const result = await openrouterGenerateImage({
    apiKey: OR_KEY,
    prompt: 'a chess clock app',
    size: 'large',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return openrouterOk();
    },
  });
  const { url, init } = calls[0];
  assert.equal(url, `${OPENROUTER_ORIGIN}/api/v1/images`);
  assert.equal(init.headers.authorization, `Bearer ${OR_KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'google/gemini-3.1-flash-image');
  assert.equal(body.resolution, '1K');
  assert.equal(body.n, 1);
  assert.equal(body.aspect_ratio, '1:1');
  assert.equal(body.output_format, 'png');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 1289, cost: 0.004, totalTokens: 1301 }, 'prompt_tokens and completion_tokens are mapped, not dropped');
});

test('openrouter usage keeps a field that is absent as null, never as zero', async () => {
  const result = await openrouterGenerateImage({
    apiKey: OR_KEY,
    prompt: 'p',
    fetchImpl: async () => jsonResponse(200, { data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { total_tokens: 40 } }),
  });
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, cost: null, totalTokens: 40 });
  const none = await openrouterGenerateImage({
    apiKey: OR_KEY,
    prompt: 'p',
    fetchImpl: async () => jsonResponse(200, { data: [{ b64_json: PNG_B64, media_type: 'image/png' }] }),
  });
  assert.equal(none.usage, null);
});

test('openrouter retries once without resolution on a 400', async () => {
  const bodies = [];
  let call = 0;
  const result = await openrouterGenerateImage({
    apiKey: OR_KEY,
    prompt: 'p',
    size: 'draft',
    fetchImpl: async (url, init) => {
      call += 1;
      bodies.push(JSON.parse(init.body));
      if (call === 1) return jsonResponse(400, { error: { message: 'resolution not supported' } });
      return openrouterOk();
    },
  });
  assert.equal(call, 2);
  assert.ok(!('resolution' in bodies[1]));
  assert.match(result.note, /resolution/);
});

test('a safety block or generic 400 is ONE call: the size retry never fires', async () => {
  const cases = [
    { error: { message: 'safety block: the prompt was rejected' } },
    { error: { message: 'Invalid JSON payload received.' } },
  ];
  for (const body of cases) {
    let call = 0;
    await assert.rejects(
      googleGenerateImage({
        apiKey: GOOGLE_KEY,
        prompt: 'p',
        fetchImpl: async () => {
          call += 1;
          return jsonResponse(400, body);
        },
      }),
      (error) => error instanceof ProviderError && error.code === 'rejected' && !error.retryable,
    );
    assert.equal(call, 1, `no retry for: ${body.error.message.slice(0, 30)}`);
  }
});

test('a 404 (unknown model) is not retried either', async () => {
  let call = 0;
  await assert.rejects(
    googleGenerateImage({
      apiKey: GOOGLE_KEY,
      prompt: 'p',
      fetchImpl: async () => {
        call += 1;
        return jsonResponse(404, { error: { message: 'model not found' } });
      },
    }),
    (error) => error.code === 'rejected' && !error.retryable,
  );
  assert.equal(call, 1);
});

test('401, 402 and 429 map to the batch-level codes', async () => {
  const cases = [
    [401, 'auth', true],
    [403, 'auth', true],
    [402, 'credits', true],
    [429, 'rate-limit', false],
    [500, 'server', false],
    [503, 'server', false],
  ];
  for (const [status, code, stops] of cases) {
    await assert.rejects(
      googleGenerateImage({
        apiKey: GOOGLE_KEY,
        prompt: 'p',
        fetchImpl: async () => jsonResponse(status, { error: { message: `HTTP ${status}` } }),
      }),
      (error) => error instanceof ProviderError && error.code === code && error.stopsBatch === stops && error.retryable === !stops && (code !== 'rate-limit' || error.retryAfterMs === 0),
    );
  }
});

test('Google\'s 400 "API key not valid" is an auth error that stops the batch', async () => {
  let calls = 0;
  await assert.rejects(
    googleGenerateImage({
      apiKey: GOOGLE_KEY,
      prompt: 'p',
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
      },
    }),
    (error) => error instanceof ProviderError && error.code === 'auth' && error.stopsBatch === true,
  );
  assert.equal(calls, 1, 'no size-retry for an invalid key');
});

test('Retry-After is parsed and capped at 30 s', async () => {
  await assert.rejects(
    openrouterGenerateImage({
      apiKey: OR_KEY,
      prompt: 'p',
      fetchImpl: async () => jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }),
    }),
    (error) => error.code === 'rate-limit' && error.retryAfterMs === 7000,
  );
  assert.equal(parseRetryAfterMs('120'), 30000);
  // toUTCString() works in whole seconds, so target a round second to keep
  // the measured delta inside a fixed window no matter when the test runs.
  const target = Math.round((Date.now() + 2000) / 1000) * 1000;
  const asDate = parseRetryAfterMs(new Date(target).toUTCString());
  assert.ok(asDate >= 1500 && asDate <= 2600, `HTTP date parsed to ${asDate} ms`);
  assert.equal(parseRetryAfterMs('garbage'), 0);
  assert.equal(parseRetryAfterMs(null), 0);
});

test('model names are strictly validated', () => {
  assert.equal(validateModelName('gemini-3.1-flash-image'), 'gemini-3.1-flash-image');
  assert.equal(validateModelName('google/gemini-3.1-flash-image'), 'google/gemini-3.1-flash-image');
  assert.throws(() => validateModelName('../evil'), /not a valid model name/);
  assert.throws(() => validateModelName('model?x'), /not a valid model name/);
  assert.throws(() => validateModelName('x'.repeat(81)), /not a valid model name/);
  assert.throws(() => validateModelName(' model'), /not a valid model name/);
});

test('a redirect anywhere is refused, not followed', async () => {
  await assert.rejects(
    requestJson({
      url: `${GOOGLE_ORIGIN}/v1/interactions`,
      fetchImpl: async () => {
        throw new TypeError('unexpected redirect');
      },
    }),
    (error) => error instanceof ProviderError && error.code === 'redirect' && !error.retryable,
  );
});

test('network errors are retryable, timeouts are retryable, aborts are not', async () => {
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
    (error) => error.code === 'network' && error.retryable === true,
  );
  // A fetch that hangs until its signal aborts (like a real stalled request).
  const hanging = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    });
  await assert.rejects(
    requestJson({ url: 'https://x', timeoutMs: 30, fetchImpl: hanging }),
    (error) => error.code === 'timeout' && error.retryable === true,
  );
  // A response whose BODY never settles is bounded by the same timeout.
  const hangingBody = { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise(() => {}) };
  await assert.rejects(
    requestJson({ url: 'https://x', timeoutMs: 40, fetchImpl: async () => hangingBody }),
    (error) => error.code === 'timeout' && error.retryable === true,
  );
  const external = new AbortController();
  const aborting = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      setTimeout(() => external.abort(new Error('batch stopped')), 10);
    });
  await assert.rejects(
    requestJson({ url: 'https://x', signal: external.signal, fetchImpl: aborting }),
    (error) => error.code === 'aborted' && error.retryable === false,
  );
});

test('the body cap covers streamed bodies and cancels them at the limit', async () => {
  const makeStream = (chunks) =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
  const oversize = { ok: true, status: 200, headers: { get: () => null }, body: makeStream(['x'.repeat(700), 'y'.repeat(700)]) };
  await assert.rejects(
    requestJson({ url: 'https://x', capBytes: 1000, fetchImpl: async () => oversize }),
    (error) => error.code === 'response' && /over the 1000 byte cap/.test(error.message),
  );
  const good = { ok: true, status: 200, headers: { get: () => null }, body: makeStream(['{"a":', '1}']) };
  const result = await requestJson({ url: 'https://x', fetchImpl: async () => good });
  assert.equal(result.text, '{"a":1}');
  // A declared content-length over the cap is refused before any read.
  await assert.rejects(
    requestJson({ url: 'https://x', capBytes: 100, fetchImpl: async () => jsonResponse(200, {}, { 'content-length': '500' }) }),
    (error) => error.code === 'response' && /over the 100 byte cap/.test(error.message),
  );
});

test('only 500/502/503/504 are retryable, and Retry-After reaches the pool', async () => {
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => jsonResponse(501, {}) }),
    (error) => error.code === 'server' && error.retryable === false,
  );
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => jsonResponse(505, {}) }),
    (error) => error.code === 'server' && error.retryable === false,
  );
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => jsonResponse(503, {}, { 'retry-after': '9' }) }),
    (error) => error.code === 'server' && error.retryable === true && error.retryAfterMs === 9000,
  );
  // And through the pool: a 503 with Retry-After 9 sleeps 9000, not 1000.
  const { runBatch } = await import('../mcp/lib/pool.mjs');
  let calls = 0;
  const sleeps = [];
  const outcome = await runBatch({
    tasks: [1],
    worker: async () => {
      calls += 1;
      await requestJson({ url: 'https://x', fetchImpl: async () => jsonResponse(503, {}, { 'retry-after': '9' }) });
    },
    sleep: async (ms) => { sleeps.push(ms); },
    jitter: () => 0,
  });
  assert.equal(calls, 3, '503 is retried twice');
  assert.deepEqual(sleeps, [0, 9000, 9000], `Retry-After honoured: ${sleeps}`);
  assert.equal(outcome.failures[0].code, 'server');
  // A 501 is not retried at all.
  let calls501 = 0;
  const sleeps501 = [];
  await runBatch({
    tasks: [1],
    worker: async () => {
      calls501 += 1;
      await requestJson({ url: 'https://x', fetchImpl: async () => jsonResponse(501, {}) });
    },
    sleep: async (ms) => { sleeps501.push(ms); },
    jitter: () => 0,
  });
  assert.equal(calls501, 1);
  assert.deepEqual(sleeps501, [0]);
});

test('an oversized body is refused before parsing', async () => {
  await assert.rejects(
    requestJson({
      url: 'https://x',
      fetchImpl: async () => jsonResponse(200, { ok: true }, { 'content-length': String(26 * 1024 * 1024) }),
    }),
    (error) => error.code === 'response' && /byte cap/.test(error.message),
  );
  const huge = jsonResponse(200, {});
  huge.text = async () => 'x'.repeat(25 * 1024 * 1024 + 1);
  await assert.rejects(
    requestJson({ url: 'https://x', fetchImpl: async () => huge }),
    (error) => error.code === 'response' && /byte cap/.test(error.message),
  );
});

test('a response without an image is a response error, not a crash', async () => {
  const empty = jsonResponse(200, { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot do that' }] }] });
  await assert.rejects(
    googleGenerateImage({ apiKey: GOOGLE_KEY, prompt: 'p', fetchImpl: async () => empty }),
    (error) => error.code === 'response' && /held no image/.test(error.message),
  );
});

test('verifyKey hits the free endpoints and reports key problems', async () => {
  const calls = [];
  const ok = await googleVerifyKey({
    apiKey: GOOGLE_KEY,
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(200, { models: [{ name: 'models/gemini-3.1-flash-image' }] });
    },
  });
  assert.match(calls[0], /\/v1\/models/);
  assert.doesNotMatch(calls[0], /v1beta/);
  assert.deepEqual(ok, { ok: true }, 'verification reports only success: nothing the provider sends is passed on');
  const orCalls = [];
  await openrouterVerifyKey({
    apiKey: OR_KEY,
    fetchImpl: async (url) => {
      orCalls.push(url);
      return jsonResponse(200, { data: { label: 'test key' } });
    },
  });
  assert.match(orCalls[0], /\/api\/v1\/key$/);
  await assert.rejects(
    googleVerifyKey({ apiKey: GOOGLE_KEY, fetchImpl: async () => jsonResponse(401, { error: { message: 'bad key' } }) }),
    (error) => error.code === 'auth' && error.stopsBatch,
  );
});
