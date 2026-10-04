// Google (Gemini API) image generation, request and response shape ONLY in
// this file. VERIFIED LIVE on 2026-10-03 with a real key (the opt-in tests in
// tests/live/ repeat it): the Interactions API on the STABLE path
// (`POST /v1/interactions`, documented at https://ai.google.dev/api/interactions-api-v1;
// its `input` is a plain string, unlike the beta path's content array, which
// the stable path refuses) is the documented way to generate an image,
// and the live service answers image/jpeg ONLY — `response_format.mime_type:
// "image/png"` is refused with HTTP 400 "Supported values: 'image/jpeg'",
// while the classic `models/{model}:generateContent` (responseModalities +
// imageConfig) also returns JPEG inlineData. So this module asks for
// image/jpeg and the drop stage decodes it with the bundled baseline JPEG
// decoder. `image_size: "512"` was accepted live on gemini-3.1-flash-image.
// The model travels in the request BODY (not the URL) and is still strictly
// validated before use. If the service changes again, this file is the only
// place to correct.

import { ProviderError, requestJson, validateModelName } from './http.mjs';

export const PROVIDER_ID = 'google';
export const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com';
export const DEFAULT_MODEL = 'gemini-3.1-flash-image';
// 512 px exists on the "Nano Banana 2" models only; 1K is the general default.
export const SIZES = { draft: '512', large: '1K' };

function headers(apiKey) {
  return { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
}

/**
 * True only when a 400 rejection is about the SIZE field. A safety block, a
 * generic bad request or a 404 must never trigger the one size retry.
 */
export function isSizeRejection(error) {
  if (!(error instanceof ProviderError) || error.code !== 'rejected') return false;
  const haystack = `${error.message} ${error.detail ?? ''}`;
  return /image_size|image[ _]?size|imageconfig|resolution/i.test(haystack);
}

/**
 * Generate one image. `size` is 'draft' (512) or 'large' (1K). On a 400 that
 * may be the size field, one retry without `image_size` is made and a note is
 * returned (the brief's rule: never fail a whole run over the size field).
 */
export async function googleGenerateImage({ apiKey, model = DEFAULT_MODEL, prompt, size = 'draft', fetchImpl, signal, timeoutMs }) {
  validateModelName(model);
  const imageSize = SIZES[size];
  if (imageSize === undefined) throw new Error(`unknown size "${size}" (draft or large)`);
  const responseFormat = { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: imageSize };
  const call = async (format) =>
    requestJson({
      method: 'POST',
      url: `${GOOGLE_ORIGIN}/v1/interactions`,
      headers: headers(apiKey),
      body: { model, input: prompt, response_format: format },
      fetchImpl,
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  let note = null;
  let response;
  try {
    response = await call(responseFormat);
  } catch (error) {
    if (isSizeRejection(error)) {
      // Once without the size field; if that also fails the error propagates.
      response = await call({ type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1' });
      note = `the API refused the image_size "${imageSize}"; retried without it (the model's default size was used)`;
    } else {
      throw error;
    }
  }

  let interaction;
  try {
    interaction = JSON.parse(response.text);
  } catch {
    throw new ProviderError('the Google response was not valid JSON', { code: 'response', status: response.status });
  }
  const image = findImage(interaction);
  if (image === null) {
    const status = interaction?.status ? ` (interaction status "${interaction.status}")` : '';
    throw new ProviderError(`the Google response held no image${status}`, { code: 'response', detail: response.text.slice(0, 300) });
  }
  const usage = interaction?.usage ?? null;
  return {
    image: Buffer.from(image.data, 'base64'),
    mimeType: image.mime_type ?? 'image/jpeg',
    model: interaction?.model ?? model,
    usage: usage === null ? null : {
      inputTokens: usage.total_input_tokens ?? null,
      outputTokens: usage.total_output_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    },
    ...(note !== null ? { note } : {}),
  };
}

function findImage(interaction) {
  const steps = Array.isArray(interaction?.steps) ? interaction.steps : [];
  for (const step of steps) {
    if (step?.type !== 'model_output') continue;
    const content = Array.isArray(step.content) ? step.content : [];
    for (const block of content) {
      if (block?.type === 'image' && typeof block.data === 'string' && block.data.length > 0) {
        return block;
      }
    }
  }
  return null;
}

/**
 * One tiny free request (list models, first page) to prove the key works. The
 * answer is deliberately NOT read: only the status counts, so nothing the
 * provider sends can travel into a tool result.
 */
export async function googleVerifyKey({ apiKey, fetchImpl, signal }) {
  await requestJson({
    url: `${GOOGLE_ORIGIN}/v1/models?pageSize=1`,
    headers: headers(apiKey),
    fetchImpl,
    signal,
  });
  return { ok: true };
}
