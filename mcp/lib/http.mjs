// Shared HTTP mechanics for the two providers: timeout, body cap, redirect
// refusal and status mapping. The request/response SHAPE of each provider
// lives only in its provider file; only the mechanics live here. Both hosts
// are hard-coded in the provider files and redirects are never followed, so a
// key can only ever be sent to the host it belongs to.

export const BODY_CAP_BYTES = 25 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 90 * 1000;
// The statuses the pool retries (besides network errors and timeouts):
// 429 and these server errors, exactly as the brief names them.
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);

/**
 * The one error type providers throw. `code` is one of:
 *   network, timeout, rate-limit, server, redirect — retryable
 *   auth, credits — retryable never, and the whole batch stops at once
 *   rejected — this request is refused (bad request, safety block, bad model)
 *   response — the provider answered but the payload was unusable
 *   aborted — the batch was stopped while the request was in flight
 */
export class ProviderError extends Error {
  constructor(message, { code, status = 0, retryable = false, stopsBatch = false, retryAfterMs = 0, detail = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.stopsBatch = stopsBatch;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail;
  }
}

/** A model name is identifiers, dots, underscores, hyphens and (OpenRouter) slashes. */
export function validateModelName(model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(model)) {
    throw new Error(
      `"${model}" is not a valid model name: use up to 80 characters of letters, digits, ".", "_", "-", "/"`,
    );
  }
  return model;
}

/** Retry-After as milliseconds: seconds or an HTTP date, capped, never negative. */
export function parseRetryAfterMs(value, { now = Date.now } = {}) {
  if (value === null || value === undefined) return 0;
  const trimmed = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.min(30_000, Math.max(0, Number(trimmed) * 1000));
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) return Math.min(30_000, Math.max(0, asDate - now()));
  return 0;
}

/** "37s" or "0.5s" (the google.rpc.RetryInfo delay) as milliseconds, capped like Retry-After. */
function parseRpcDelayMs(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? '').trim());
  return match === null ? 0 : Math.min(30_000, Math.max(0, Number(match[1]) * 1000));
}

/** What Google's error `details` add: the retry delay it asks for, and whether the quota that ran out is a daily one. */
function rpcDetails(parsed) {
  const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
  let retryDelayMs = 0;
  let daily = false;
  for (const detail of details) {
    const type = String(detail?.['@type'] ?? '');
    if (type.endsWith('RetryInfo')) retryDelayMs = Math.max(retryDelayMs, parseRpcDelayMs(detail.retryDelay));
    if (type.endsWith('QuotaFailure') && Array.isArray(detail.violations)) {
      for (const violation of detail.violations) {
        if (/PerDay/i.test(`${violation?.quotaId ?? ''} ${violation?.quotaMetric ?? ''}`)) daily = true;
      }
    }
  }
  return { retryDelayMs, daily };
}

function statusError(status, text, headers = null) {
  let serverMessage = '';
  let rpc = { retryDelayMs: 0, daily: false };
  try {
    const parsed = JSON.parse(text);
    serverMessage = String(parsed?.error?.message ?? parsed?.message ?? '').slice(0, 300);
    rpc = rpcDetails(parsed);
  } catch {
    // not JSON: fall through to the raw excerpt
  }
  const excerpt = (serverMessage || text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const suffix = excerpt ? `: ${excerpt}` : '';
  const retryAfterMs = Math.max(parseRetryAfterMs(headers?.get?.('retry-after')), rpc.retryDelayMs);
  if (status === 401 || status === 403) {
    return new ProviderError(`the provider rejected the key (HTTP ${status})${suffix}`, {
      code: 'auth', status, stopsBatch: true, detail: excerpt,
    });
  }
  // Google answers an invalid key with 400 "API key not valid", not 401:
  // recognise that shape too, so a bad key stops the batch instead of being
  // retried once per candidate.
  if (status === 400 && /\b(api[ _-]?key|key)[ _-]+(not[ _-]+valid|invalid|required)|invalid[ _-]+(api[ _-]+)?key\b/i.test(excerpt)) {
    return new ProviderError(`the provider rejected the key (HTTP 400)${suffix}`, {
      code: 'auth', status, stopsBatch: true, detail: excerpt,
    });
  }
  if (status === 402) {
    return new ProviderError(`the provider account has insufficient credits (HTTP 402)${suffix}`, {
      code: 'credits', status, stopsBatch: true, detail: excerpt,
    });
  }
  if (status === 429 && rpc.daily) {
    // A daily quota does not come back in the seconds a retry waits: retrying every candidate three times only burns requests.
    return new ProviderError(`the provider's daily quota is used up (HTTP 429)${suffix}`, {
      code: 'credits', status, stopsBatch: true, detail: excerpt,
    });
  }
  if (status === 429) {
    return new ProviderError(`the provider is rate limiting (HTTP 429)${suffix}`, { code: 'rate-limit', status, retryable: true, retryAfterMs, detail: excerpt });
  }
  // Only the statuses the brief names are retried. Other 5xx answers (501 Not
  // Implemented, 505, ...) say the request itself will not succeed; retrying
  // would only burn the budget. Retry-After still reaches the pool when set.
  if (RETRYABLE_SERVER_STATUSES.has(status)) {
    return new ProviderError(`the provider had a server error (HTTP ${status})${suffix}`, { code: 'server', status, retryable: true, retryAfterMs, detail: excerpt });
  }
  if (status >= 500) {
    return new ProviderError(`the provider had a server error (HTTP ${status})${suffix}`, { code: 'server', status, retryAfterMs, detail: excerpt });
  }
  return new ProviderError(`the provider refused the request (HTTP ${status})${suffix}`, { code: 'rejected', status, detail: excerpt });
}

/**
 * Read the response body under the same abort/timeout scope as the request:
 * streamed and byte-counted when the response exposes a body stream (every
 * real fetch Response does), so an oversized body is cancelled at the cap
 * instead of buffered; minimal fake responses without a stream fall back to
 * text(), raced against the abort signal so a hanging body cannot hang the
 * request either way.
 */
async function readBodyCapped(response, { capBytes, mapFailure, abortSignal }) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? value?.length ?? 0;
        if (received > capBytes) {
          await reader.cancel().catch(() => {});
          throw new ProviderError(`the response body passed ${received} bytes, over the ${capBytes} byte cap`, { code: 'response' });
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join('');
    } catch (error) {
      throw mapFailure(error, 'the streamed response body could not be read');
    }
  }
  try {
    return await Promise.race([
      response.text(),
      new Promise((_resolve, reject) => {
        const rejectWithAbort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (abortSignal.aborted) rejectWithAbort();
        else abortSignal.addEventListener('abort', rejectWithAbort, { once: true });
      }),
    ]);
  } catch (error) {
    throw mapFailure(error, 'the response body could not be read');
  }
}

/**
 * One HTTP request with every guard: per-request timeout covering the request
 * AND the body, a combined abort signal, no redirects, a streamed body cap
 * and status mapping. Returns { status, headers, text }. Throws ProviderError
 * on every failure path.
 */
export async function requestJson({ method = 'GET', url, headers, body = null, fetchImpl = fetch, signal = null, timeoutMs = REQUEST_TIMEOUT_MS, capBytes = BODY_CAP_BYTES }) {
  const local = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    local.abort();
  }, timeoutMs);
  const onExternalAbort = () => local.abort();
  if (signal !== null) {
    if (signal.aborted) local.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (signal !== null) signal.removeEventListener('abort', onExternalAbort);
  };
  const mapFailure = (error, fallback) => {
    if (signal !== null && signal.aborted && !timedOut) {
      return new ProviderError('the request was aborted (the batch stopped)', { code: 'aborted' });
    }
    if (timedOut) {
      return new ProviderError(`the request timed out after ${Math.round(timeoutMs / 1000)} s`, { code: 'timeout', retryable: true });
    }
    if (error instanceof ProviderError) return error;
    const base = error instanceof Error ? error.message : String(error);
    // undici reports every failure as "fetch failed" and keeps the reason in `cause` (a refused redirect, DNS, TLS, a proxy ...).
    const cause = error instanceof Error ? error.cause : undefined;
    const causeText = cause instanceof Error ? [cause.code, cause.message].filter(Boolean).join(' ') : cause === undefined ? '' : String(cause);
    const message = causeText === '' ? base : `${base} (${causeText})`;
    if (/redirect/i.test(base) || /redirect/i.test(causeText)) {
      return new ProviderError(`the provider tried to redirect to another host; refused: ${message}`, { code: 'redirect', detail: message });
    }
    return new ProviderError(`${fallback}: ${message}`, { code: 'network', retryable: true, detail: message });
  };
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: local.signal,
      redirect: 'error', // a redirect would send the key to another host: never follow one
    });
    const declaredLength = Number(response.headers?.get?.('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > capBytes) {
      throw new ProviderError(`the response body is ${declaredLength} bytes, over the ${capBytes} byte cap`, { code: 'response' });
    }
    let text;
    try {
      text = await readBodyCapped(response, { capBytes, mapFailure, abortSignal: local.signal });
    } catch (error) {
      throw mapFailure(error, 'the response body could not be read');
    }
    if (Buffer.byteLength(text) > capBytes) {
      throw new ProviderError(`the response body is ${Buffer.byteLength(text)} bytes, over the ${capBytes} byte cap`, { code: 'response' });
    }
    if (!response.ok) throw statusError(response.status, text, response.headers);
    return { status: response.status, headers: response.headers, text };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw mapFailure(error, 'a network error occurred');
  } finally {
    cleanup();
  }
}
