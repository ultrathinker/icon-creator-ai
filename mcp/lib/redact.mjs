// Secret redaction: a key must never appear in an error message, a log line,
// a tool result, run.json or any file this plugin writes. Every string that
// leaves the server through an error or a result passes through a redactor
// built from the key values the server actually holds, plus generic patterns
// for key-shaped strings (so a provider echoing an Authorization header in an
// error body is scrubbed even along paths we did not anticipate).

const KEY_PATTERNS = [
  /AIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /sk-or-[0-9A-Za-z-]{16,}/g, // OpenRouter keys
  /sk-[0-9A-Za-z-]{16,}/g, // other common API keys
  /ya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth tokens
];

const PLACEHOLDER = '***';
const PREFIX_LENGTH = 5; // the first characters of a key that are always hidden
const WINDOW_LENGTH = 8; // any run of this many characters of a key is hidden

/**
 * Build a redactor from the secret values this process holds (empty and very
 * short values are ignored: replacing "a" everywhere would destroy messages).
 *
 * A provider error body or an exception message may echo only a PART of a key,
 * so the redactor hides more than the whole value: the first five characters
 * of every key and any run of eight or more characters taken from inside it.
 * Overlapping hits merge into one placeholder. (Keys are random, so a normal
 * message never contains such a run.)
 */
export function makeRedactor(secrets) {
  const values = (Array.isArray(secrets) ? secrets : [secrets]).filter((value) => typeof value === 'string' && value.length >= 8);
  const prefixes = new Set(values.map((value) => value.slice(0, PREFIX_LENGTH)));
  const windows = new Set();
  for (const value of values) {
    for (let start = 0; start + WINDOW_LENGTH <= value.length; start += 1) windows.add(value.slice(start, start + WINDOW_LENGTH));
  }
  return function redact(text) {
    const source = String(text);
    let result = source;
    if (values.length > 0) {
      const hidden = new Uint8Array(source.length);
      for (let index = 0; index < source.length; index += 1) {
        if (index + PREFIX_LENGTH <= source.length && prefixes.has(source.slice(index, index + PREFIX_LENGTH))) hidden.fill(1, index, index + PREFIX_LENGTH);
        if (index + WINDOW_LENGTH <= source.length && windows.has(source.slice(index, index + WINDOW_LENGTH))) hidden.fill(1, index, index + WINDOW_LENGTH);
      }
      result = '';
      let inRun = false;
      for (let index = 0; index < source.length; index += 1) {
        if (hidden[index] === 1) {
          if (!inRun) result += PLACEHOLDER;
          inRun = true;
        } else {
          result += source[index];
          inRun = false;
        }
      }
    }
    for (const pattern of KEY_PATTERNS) result = result.replace(pattern, PLACEHOLDER);
    return result;
  };
}

/**
 * Does a binary payload hold a configured secret? Text redaction cannot clean
 * bytes, so anything a provider sent that is about to be written unchanged
 * (a WebP, a JPEG the decoder refuses, a PNG it cannot decode) is checked
 * first, and written only when this says no. It looks for the whole value, for
 * its first five characters and for any run of eight characters inside it, so
 * a partial echo is caught too.
 */
export function bufferHoldsSecret(buffer, secrets) {
  const values = (Array.isArray(secrets) ? secrets : [secrets]).filter((value) => typeof value === 'string' && value.length >= 8);
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    if (buffer.includes(bytes) || buffer.includes(bytes.subarray(0, 5))) return true;
    for (let start = 0; start + 8 <= bytes.length; start += 1) {
      if (buffer.includes(bytes.subarray(start, start + 8))) return true;
    }
  }
  return false;
}

/**
 * Redact every string inside a JSON-serialisable value (the run.json summary,
 * tool results, error details). Returns a plain new object.
 */
export function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[redact(key)] = redactDeep(item, redact);
    }
    return out;
  }
  return value;
}
