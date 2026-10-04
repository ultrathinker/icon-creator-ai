// Tests of the request pool with fake workers and a recorded fake clock:
// never more than 3 in flight (also for 16 candidates, also across retries),
// 429 with Retry-After honoured, 401 stopping the batch at once, partial
// success returned, deadline enforced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, MAX_PARALLEL, MAX_ATTEMPTS } from '../mcp/lib/pool.mjs';
import { ProviderError } from '../mcp/lib/http.mjs';

function recordedSleep() {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

test('constants are the brief\'s hard numbers', () => {
  assert.equal(MAX_PARALLEL, 3);
  assert.equal(MAX_ATTEMPTS, 3);
});

test('never more than 3 in flight for 16 candidates', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { sleep } = recordedSleep();
  const result = await runBatch({
    tasks: Array.from({ length: 16 }, (_, index) => index),
    worker: async (task) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return task * 2;
    },
    sleep,
    jitter: () => 0,
  });
  assert.ok(maxInFlight <= MAX_PARALLEL, `saw ${maxInFlight} in flight`);
  assert.equal(result.results.filter((value) => value !== null).length, 16);
  assert.equal(result.failures.length, 0);
  assert.equal(result.stopped, null);
});

test('a slow worker proves the in-flight cap directly', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { sleep } = recordedSleep();
  const result = await runBatch({
    tasks: Array.from({ length: 10 }, (_, index) => index),
    worker: async (task) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return task;
    },
    sleep,
    jitter: () => 0,
  });
  assert.ok(maxInFlight <= MAX_PARALLEL, `saw ${maxInFlight} in flight`);
  assert.ok(maxInFlight > 1, 'the pool really runs in parallel');
  assert.equal(result.results.filter((value) => value !== null).length, 10);
});

test('retries obey the cap too: failing workers never raise the in-flight count', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { sleep, sleeps } = recordedSleep();
  let attempts = 0;
  const result = await runBatch({
    tasks: Array.from({ length: 9 }, (_, index) => index),
    worker: async (task, { attempt }) => {
      attempts += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight -= 1;
      // Everything fails once with a 429 carrying Retry-After: 5 s, then succeeds.
      if (attempt === 1) throw new ProviderError('rate limited', { code: 'rate-limit', status: 429, retryable: true, retryAfterMs: 5000 });
      return task;
    },
    sleep,
    jitter: () => 0,
  });
  assert.ok(maxInFlight <= MAX_PARALLEL, `saw ${maxInFlight} in flight during retries`);
  assert.equal(result.results.filter((value) => value !== null).length, 9, 'all recovered on the retry');
  assert.equal(result.failures.length, 0);
  assert.ok(sleeps.includes(5000), `Retry-After honoured in waits: ${sleeps}`);
  assert.equal(attempts, 18);
});

test('Retry-After beats the default backoff and is capped at 30 s', async () => {
  const first = recordedSleep();
  await runBatch({
    tasks: [1],
    worker: async () => { throw new ProviderError('limited', { code: 'rate-limit', retryable: true, retryAfterMs: 12_000 }); },
    sleep: first.sleep,
    jitter: () => 0,
  });
  assert.deepEqual(first.sleeps, [0, 12_000, 12_000], `stagger then Retry-After waits: ${first.sleeps}`);
  // A server asking for 99 s is waited for only 30 s.
  const second = recordedSleep();
  await runBatch({
    tasks: [1],
    worker: async () => { throw new ProviderError('limited', { code: 'rate-limit', retryable: true, retryAfterMs: 99_000 }); },
    sleep: second.sleep,
    jitter: () => 0,
  });
  assert.ok(second.sleeps.every((ms) => ms <= 30_000), `capped waits: ${second.sleeps}`);
});

test('exponential backoff is used when there is no Retry-After', async () => {
  const { sleep, sleeps } = recordedSleep();
  const result = await runBatch({
    tasks: [1],
    worker: async () => { throw new ProviderError('boom', { code: 'server', retryable: true }); },
    sleep,
    jitter: () => 0,
  });
  assert.deepEqual(sleeps, [0, 1000, 2000], `stagger then backoff: ${sleeps}`);
  assert.equal(result.results[0], null);
  assert.deepEqual(result.failures[0], { index: 0, code: 'server', message: 'boom', attempts: 3 });
});

test('401 stops the whole batch at once and does not hammer the key', async () => {
  let calls = 0;
  const { sleep } = recordedSleep();
  const result = await runBatch({
    tasks: Array.from({ length: 16 }, (_, index) => index),
    worker: async () => {
      calls += 1;
      throw new ProviderError('the provider rejected the key (HTTP 401)', { code: 'auth', status: 401, stopsBatch: true });
    },
    sleep,
    jitter: () => 0,
  });
  assert.ok(calls <= MAX_PARALLEL, `the key was used ${calls} times after a 401`);
  assert.equal(result.stopped.code, 'auth');
  assert.ok(result.failures.every((failure) => failure.code === 'auth' || failure.code === 'aborted'));
  assert.equal(result.results.filter((value) => value !== null).length, 0);
  assert.equal(result.failures.length, 16);
});

test('partial failure returns the successes and names the failures', async () => {
  const { sleep } = recordedSleep();
  const result = await runBatch({
    tasks: [0, 1, 2, 3, 4],
    worker: async (task) => {
      if (task % 2 === 1) throw new ProviderError('no image in the response', { code: 'response' });
      return `ok${task}`;
    },
    sleep,
    jitter: () => 0,
  });
  assert.deepEqual(result.results, ['ok0', null, 'ok2', null, 'ok4']);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.failures.map((failure) => failure.index), [1, 3]);
  assert.equal(result.failures[0].code, 'response');
  assert.equal(result.failures[0].attempts, 1, 'a response error is not retried');
});

test('the deadline cuts the run and reports it', async () => {
  const { sleep } = recordedSleep();
  const result = await runBatch({
    tasks: [1, 2, 3],
    worker: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return 'ok';
    },
    sleep,
    deadlineMs: 10,
    jitter: () => 0,
  });
  assert.equal(result.stopped.code, 'deadline');
  assert.deepEqual(result.results, ['ok', 'ok', 'ok'], 'the three requests in flight finish; the deadline only stops new starts');
});

test('progress reports every settled task', async () => {
  const seen = [];
  const { sleep } = recordedSleep();
  await runBatch({
    tasks: [1, 2, 3, 4],
    worker: async (task) => task,
    sleep,
    jitter: () => 0,
    onProgress: (index, { done, total }) => seen.push({ index, done, total }),
  });
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((entry) => entry.done).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.ok(seen.every((entry) => entry.total === 4));
});

test('retries get jitter on top of the backoff, so refused slots do not retry in the same instant (and the cap still holds)', async () => {
  const { sleep, sleeps } = recordedSleep();
  await runBatch({
    tasks: [0],
    worker: async () => { throw new ProviderError('busy', { code: 'server', retryable: true }); },
    sleep,
    jitter: () => 77,
  });
  assert.deepEqual(sleeps, [0, 1077, 2077], `stagger then backoff plus jitter: ${sleeps}`);
  const capped = recordedSleep();
  await runBatch({
    tasks: [0],
    worker: async () => { throw new ProviderError('slow down', { code: 'rate-limit', retryable: true, retryAfterMs: 29_990 }); },
    sleep: capped.sleep,
    jitter: () => 77,
  });
  assert.ok(capped.sleeps.every((ms) => ms <= 30_000), `capped: ${capped.sleeps}`);
});
