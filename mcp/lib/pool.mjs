// The request pool: at most MAX_PARALLEL requests in flight for the whole
// run (a hard constant, never a setting), staggered starts so a batch is not
// a burst, up to two retries per request on network errors / 429 / 5xx with
// exponential backoff that honours Retry-After, a per-run deadline (it stops new
// starts and retries; requests already in flight finish, each bounded by its own
// timeout), and an immediate full stop when the key is rejected (401/403) or the account is
// out of credits (402) — a bad key is never hammered. Partial success is
// normal: whatever succeeded is returned, every failure is named.

import { ProviderError } from './http.mjs';

export const MAX_PARALLEL = 3;
export const MAX_ATTEMPTS = 3; // the first try plus two retries
export const RUN_DEADLINE_MS = 10 * 60 * 1000;
export const RETRY_CAP_MS = 30 * 1000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultJitter = () => 120 + Math.random() * 230;

/**
 * Run `worker(task, { signal, attempt })` for every task. A task holds its
 * slot for its whole life, retries included, so the in-flight count can never
 * exceed `limit` (itself capped at MAX_PARALLEL). Returns
 * { results, failures, stopped } where results[i] is null for a failed task,
 * failures are [{ index, code, message, attempts }] and stopped is
 * null or { code, message } describing why the rest of the batch was cut.
 */
export async function runBatch({ tasks, worker, limit = MAX_PARALLEL, jitter = defaultJitter, sleep = realSleep, deadlineMs = RUN_DEADLINE_MS, onProgress = () => {} }) {
  if (!Array.isArray(tasks)) throw new Error('tasks must be an array');
  const effectiveLimit = Math.max(1, Math.min(limit, MAX_PARALLEL, tasks.length));
  const results = new Array(tasks.length).fill(null);
  const failures = [];
  let stopped = null;
  let cursor = 0;
  let settled = 0;

  const batch = new AbortController();
  const stop = (code, message, { abortInFlight = true } = {}) => {
    if (stopped === null) {
      stopped = { code, message };
      if (abortInFlight) batch.abort(new Error(message));
    }
  };
  // The deadline only stops what has not started: an image that is nearly done is not thrown away.
  const deadlineTimer = setTimeout(() => stop('deadline', 'the run deadline passed', { abortInFlight: false }), deadlineMs);

  const runner = async (slot) => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      if (stopped !== null) {
        failures.push({ index, code: 'aborted', message: `not started: ${stopped.message}`, attempts: 0 });
        settled += 1;
        onProgress(index, { done: settled, total: tasks.length });
        continue;
      }
      // Staggered start: a few hundred ms per slot so three starts never land
      // on the same tick (and retries inside a slot stay spaced too).
      await sleep(slot * jitter());
      let attempts = 0;
      let last = null;
      while (attempts < MAX_ATTEMPTS && stopped === null) {
        attempts += 1;
        try {
          results[index] = await worker(tasks[index], { signal: batch.signal, attempt: attempts });
          last = null;
          break;
        } catch (error) {
          last = error;
          if (!(error instanceof ProviderError)) break; // a bug, not a provider state
          if (error.stopsBatch) {
            stop(error.code, error.message);
            break;
          }
          if (error.code === 'aborted') break; // the batch is already stopping
          if (!error.retryable || attempts >= MAX_ATTEMPTS) break;
          const backoff = Math.min(RETRY_CAP_MS, 1000 * 2 ** (attempts - 1));
          // Retry-After wins when it asks for longer, but never past the cap. A little jitter on top keeps three slots that
          // were refused in the same instant from retrying in the same instant (the stagger above only spaces the first starts).
          await sleep(Math.min(RETRY_CAP_MS, Math.max(backoff, error.retryAfterMs) + jitter()));
        }
      }
      if (results[index] === null) {
        const message = last instanceof Error ? last.message : stopped !== null ? `stopped: ${stopped.message}` : 'failed';
        failures.push({ index, code: last instanceof ProviderError ? last.code : stopped !== null && last === null ? 'aborted' : 'internal', message, attempts });
      }
      settled += 1;
      onProgress(index, { done: settled, total: tasks.length });
    }
  };

  try {
    await Promise.all(Array.from({ length: effectiveLimit }, (_, slot) => runner(slot)));
  } finally {
    clearTimeout(deadlineTimer);
  }
  return { results, failures, stopped };
}
