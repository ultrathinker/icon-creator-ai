// OpenRouter image generation, request and response shape ONLY in this file.
// Verified against https://openrouter.ai/docs/guides/overview/multimodal/image-generation
// on 2026-10-03: documented endpoint `POST /api/v1/images` with
// { model, prompt, n, resolution, aspect_ratio, output_format }; the response
// carries data[].b64_json + media_type and usage (including cost). If the
// shape changes, this file is the only place to correct.

import { ProviderError, requestJson, validateModelName } from './http.mjs';

export const PROVIDER_ID = 'openrouter';
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const DEFAULT_MODEL = 'google/gemini-3.1-flash-image';
export const SIZES = { draft: '512', large: '1K' };

function headers(apiKey) {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

/**
 * True only when a 400 rejection is about the RESOLUTION field. A safety
 * block, a generic bad request or a 404 must never trigger the one retry.
 */
export function isSizeRejection(error) {
  if (!(error instanceof ProviderError) || error.code !== 'rejected') return false;
  const haystack = `${error.message} ${error.detail ?? ''}`;
  return /resolution|image[ _]?size/i.test(haystack);
}

/**
 * Generate one image. `size` is 'draft' (512) or 'large' (1K); PNG output is
 * requested. On a 400 that may be the resolution field, one retry without it
 * is made and a note is returned.
 */
export async function openrouterGenerateImage({ apiKey, model = DEFAULT_MODEL, prompt, size = 'draft', fetchImpl, signal, timeoutMs }) {
  validateModelName(model);
  const resolution = SIZES[size];
  if (resolution === undefined) throw new Error(`unknown size "${size}" (draft or large)`);
  const call = (withResolution) =>
    requestJson({
      method: 'POST',
      url: `${OPENROUTER_ORIGIN}/api/v1/images`,
      headers: headers(apiKey),
      body: {
        model,
        prompt,
        n: 1,
        ...(withResolution ? { resolution } : {}),
        aspect_ratio: '1:1',
        output_format: 'png',
      },
      fetchImpl,
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  let note = null;
  let response;
  try {
    response = await call(true);
  } catch (error) {
    if (isSizeRejection(error)) {
      response = await call(false);
      note = `the API refused the resolution "${resolution}"; retried without it (the model's default size was used)`;
    } else {
      throw error;
    }
  }

  let payload;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new ProviderError('the OpenRouter response was not valid JSON', { code: 'response', status: response.status });
  }
  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (first === null || typeof first.b64_json !== 'string' || first.b64_json.length === 0) {
    throw new ProviderError('the OpenRouter response held no image', { code: 'response', detail: response.text.slice(0, 300) });
  }
  const usage = payload?.usage ?? null;
  return {
    image: Buffer.from(first.b64_json, 'base64'),
    mimeType: first.media_type ?? 'image/png',
    model,
    // The real endpoint reports prompt_tokens, completion_tokens, total_tokens and cost (checked live 2026-10-03);
    // a field that is genuinely absent stays null instead of being counted as zero.
    usage: usage === null ? null : {
      inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
      outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
      cost: typeof usage.cost === 'number' ? usage.cost : null,
      totalTokens: usage.total_tokens ?? null,
    },
    ...(note !== null ? { note } : {}),
  };
}

/**
 * One tiny free request (key info) to prove the key works. The answer is
 * deliberately NOT read: only the status counts, so nothing the provider sends
 * can travel into a tool result.
 */
export async function openrouterVerifyKey({ apiKey, fetchImpl, signal }) {
  await requestJson({
    url: `${OPENROUTER_ORIGIN}/api/v1/key`,
    headers: headers(apiKey),
    fetchImpl,
    signal,
  });
  return { ok: true };
}
