// The prompt wrapper: the quality lever. The user's subject sentence is kept
// intact and wrapped in one fixed recipe (one centred subject, bold simple
// shapes, a pure white or pure black flat background so removal works, no
// text, square), plus one art-style hint per candidate. Model output or file
// content never rewrites any of this: the recipe is a constant here, only the
// subject is inserted.
//
// The background is only ever pure white or pure black (a model left to pick
// "one solid colour" chooses saturated colours such as magenta, which the
// background removal then handles badly), unless the user described a
// background of their own: `background: 'as-described'` adds no background
// sentence at all and the subject sentence carries it.

export const MAX_SUBJECT_CHARS = 800;
/** What generate_images accepts for `background`; "auto" picks white or black per art style. */
export const BACKGROUND_CHOICES = ['auto', 'white', 'black', 'as-described'];

const BACKGROUND_SENTENCE = {
  white: 'The whole image, edge to edge and corner to corner, is one pure flat white (#FFFFFF): no rounded card, tile or panel, no frame, no gradient, no texture, no shadow, so that the background can be removed automatically.',
  black: 'The whole image, edge to edge and corner to corner, is one pure flat black (#000000): no rounded card, tile or panel, no white canvas around it, no frame, no gradient, no texture, no vignette, so that the background can be removed automatically.',
};

/** `background` is the resolved choice for this candidate: 'white', 'black' or 'as-described'. */
export function buildPrompt(subject, styleHint, { background = 'white' } = {}) {
  if (background !== 'as-described' && !(background in BACKGROUND_SENTENCE)) {
    throw new Error(`internal error: background must be white, black or as-described (got ${JSON.stringify(background)})`);
  }
  return [
    `App icon: ${subject}.`,
    'One single subject, centred, filling about 70% of the frame.',
    'Bold, simple shapes that stay readable when the icon is only 16 pixels wide.',
    ...(background === 'as-described' ? [] : [BACKGROUND_SENTENCE[background]]),
    'No text, no letters, no numbers, no logo-like wordmarks, no watermark, no frame or border, no drop shadow on the background.',
    'Perfectly square composition.',
    `Art style: ${styleHint}.`,
  ].join(' ');
}

/** Validate the subject sentence; throws with a clear reason when unusable. */
export function assertSubject(subject) {
  if (typeof subject !== 'string') throw new Error('prompt must be a string describing the app in one sentence');
  const trimmed = subject.trim();
  if (trimmed.length < 3) throw new Error('prompt is too short: describe the app in one sentence');
  if (trimmed.length > MAX_SUBJECT_CHARS) {
    throw new Error(`prompt is ${trimmed.length} characters; keep it under ${MAX_SUBJECT_CHARS}`);
  }
  return trimmed;
}
