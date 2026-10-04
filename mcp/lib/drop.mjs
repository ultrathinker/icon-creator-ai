// Accepting an image a provider returned: validate the container and the
// dimensions, then normalise to PNG on disk (the pack builder needs PNG).
// JPEG is decoded by the bundled baseline decoder (Google's image models
// return JPEG only — verified live on 2026-10-03). A WebP or a JPEG variant
// the decoder does not handle (progressive, 12-bit) is kept raw with a
// warning instead of guessed at; PNG always goes through the bundled codec.

import { validateImage } from '../../scripts/lib/imagecheck.mjs';
import { decodePng, encodePng } from '../../scripts/lib/png.mjs';
import { decodeJpeg } from '../../scripts/lib/jpeg.mjs';

/**
 * Returns one of:
 *   { ok: true, png, width, height, mediaType: 'image/png' }
 *   { ok: false, keepRaw: true, format, width, height, reason }
 *   { ok: false, keepRaw: false, reason }   (unusable: nothing is written)
 */
export function acceptImage(buffer) {
  let info;
  try {
    info = validateImage(buffer);
  } catch (error) {
    return { ok: false, keepRaw: false, reason: error.message };
  }
  if (info.format === 'png') {
    let decoded;
    try {
      decoded = decodePng(buffer);
    } catch (error) {
      return {
        ok: false,
        keepRaw: true,
        format: 'png',
        width: info.width,
        height: info.height,
        reason: `the returned PNG cannot be decoded by the built-in codec (${error.message}); the raw file is kept`,
      };
    }
    return {
      ok: true,
      png: encodePng(decoded.width, decoded.height, decoded.rgba),
      width: decoded.width,
      height: decoded.height,
      mediaType: 'image/png',
    };
  }
  if (info.format === 'jpeg') {
    let decoded;
    try {
      decoded = decodeJpeg(buffer);
    } catch (error) {
      return {
        ok: false,
        keepRaw: true,
        format: 'jpeg',
        width: info.width,
        height: info.height,
        reason: `the returned JPEG cannot be decoded by the built-in baseline decoder (${error.message}); the raw file is kept`,
      };
    }
    return {
      ok: true,
      png: encodePng(decoded.width, decoded.height, decoded.rgba),
      width: decoded.width,
      height: decoded.height,
      mediaType: 'image/png',
    };
  }
  return {
    ok: false,
    keepRaw: true,
    format: info.format,
    width: info.width,
    height: info.height,
    reason:
      `the provider returned ${info.format.toUpperCase()} (${info.width}x${info.height}), which this plugin cannot decode ` +
      'without extra software; the raw file is kept and the pack builder skips it',
  };
}
