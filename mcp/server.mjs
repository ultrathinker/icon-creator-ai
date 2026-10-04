#!/usr/bin/env node
// The bundled MCP server of the icon-creator-ai plugin: stdio JSON-RPC, zero
// dependencies, Node 18+. It holds the provider keys (they arrive only
// through this plugin's own env mapping, never from the ambient environment
// and never from the chat), calls the two providers for image candidates,
// validates and normalises every returned image into a run folder, and writes
// a run.json that contains no secrets.
//
// Protocol discipline: nothing but JSON-RPC messages is ever written to
// stdout; diagnostics go to stderr and are scrubbed of key material first.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeRedactor, redactDeep, bufferHoldsSecret } from './lib/redact.mjs';
import { listStyles, pickStyles, backgroundFor } from './lib/styles.mjs';
import { buildPrompt, assertSubject, BACKGROUND_CHOICES } from './lib/prompt.mjs';
import { runBatch, MAX_PARALLEL } from './lib/pool.mjs';
import { createRunFolder, openRunFolder, writeFileExclusive } from './lib/paths.mjs';
import { acceptImage } from './lib/drop.mjs';
import { inferPackName, listBuilt } from '../scripts/lib/runrecords.mjs';
import { ProviderError, validateModelName } from './lib/http.mjs';
import * as google from './lib/provider-google.mjs';
import * as openrouter from './lib/provider-openrouter.mjs';

const SERVER_NAME = 'icon-creator-ai';
const SERVER_VERSION = '0.1.7';
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

export const MAX_COUNT = 16;
export const DEFAULT_COUNT = 4;
// The usage fields a provider answer may carry; each is aggregated on its own (see generateImages).
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cost'];

// The only environment this server reads. The values are set by this plugin's
// own env mapping (from userConfig); nothing ambient is consulted, so a key
// sitting in GEMINI_API_KEY or OPENROUTER_API_KEY is deliberately ignored.
const ENV_KEYS = Object.freeze({
  google: 'ICON_AI_GOOGLE_KEY',
  openrouter: 'ICON_AI_OPENROUTER_KEY',
  provider: 'ICON_AI_PROVIDER',
  model: 'ICON_AI_MODEL',
});

function readConfig(env = process.env) {
  const googleKey = (env[ENV_KEYS.google] ?? '').trim();
  const openrouterKey = (env[ENV_KEYS.openrouter] ?? '').trim();
  const providerSetting = (env[ENV_KEYS.provider] ?? '').trim().toLowerCase();
  const model = (env[ENV_KEYS.model] ?? '').trim();
  return {
    googleKey,
    openrouterKey,
    provider: ['auto', 'google', 'openrouter'].includes(providerSetting) ? providerSetting : 'auto',
    model: model === '' ? null : model,
  };
}

const NO_KEY_HELP =
  'No provider key is configured. Open /plugin -> Installed Plugins -> Icon Creator AI -> ' +
  'Configure options and paste a Google AI Studio key (aistudio.google.com/apikey) or an OpenRouter key ' +
  '(openrouter.ai/settings/keys) into the matching field, then save. Known caveat: sensitive values ' +
  'sometimes do not persist across Claude Code restarts (claude-code issue #62442); if check_setup still ' +
  'reports no key after a restart, enter it again the same way. Never paste a key into the chat.';

/** Which provider and model a call should use. Throws a ToolError when keyless. */
function resolveProvider(config, requested = null) {
  const choice = requested ?? config.provider;
  const build = (id, apiKey, fallbackModel, generate, verify, sizes) => {
    let model;
    try {
      model = validateModelName(config.model ?? fallbackModel);
    } catch (error) {
      throw new ToolError(error.message);
    }
    return { id, apiKey, model, generate, verify, sizes };
  };
  if (choice === 'google' || (choice === 'auto' && config.googleKey !== '')) {
    if (config.googleKey === '') throw new ToolError(choice === 'google' ? NO_KEY_HELP : `Google is selected but its key is empty. ${NO_KEY_HELP}`);
    return build('google', config.googleKey, google.DEFAULT_MODEL, google.googleGenerateImage, google.googleVerifyKey, google.SIZES);
  }
  if (choice === 'openrouter' || (choice === 'auto' && config.openrouterKey !== '')) {
    if (config.openrouterKey === '') throw new ToolError(choice === 'openrouter' ? NO_KEY_HELP : `OpenRouter is selected but its key is empty. ${NO_KEY_HELP}`);
    return build('openrouter', config.openrouterKey, openrouter.DEFAULT_MODEL, openrouter.openrouterGenerateImage, openrouter.openrouterVerifyKey, openrouter.SIZES);
  }
  throw new ToolError(NO_KEY_HELP);
}

/** An error that is reported to the caller as a tool result, not a protocol error. */
class ToolError extends Error {}

// --- Tool implementations ----------------------------------------------------

async function checkSetup(args, config, redact, fetchImpl = undefined) {
  const providers = {
    google: { configured: config.googleKey !== '' },
    openrouter: { configured: config.openrouterKey !== '' },
  };
  const base = {
    providers,
    providerSetting: config.provider,
    modelSetting: config.model,
    limits: { maxCount: MAX_COUNT, defaultCount: DEFAULT_COUNT, maxParallel: MAX_PARALLEL },
    sizes: { google: google.SIZES, openrouter: openrouter.SIZES },
  };
  let resolved;
  try {
    const chosen = resolveProvider(config);
    resolved = { provider: chosen.id, model: chosen.model };
  } catch (error) {
    resolved = { provider: null, model: null, reason: redact(error.message) };
  }
  if (args?.verify !== true) return { ...base, resolved };

  const verified = {};
  for (const id of ['google', 'openrouter']) {
    if (!providers[id].configured) {
      verified[id] = { configured: false };
      continue;
    }
    const provider = resolveProvider(config, id);
    try {
      await provider.verify({ apiKey: provider.apiKey, fetchImpl });
      verified[id] = { configured: true, verified: true };
    } catch (error) {
      verified[id] = {
        configured: true,
        verified: false,
        error: redact(error instanceof Error ? error.message : String(error)),
      };
    }
  }
  return { ...base, providers: verified, resolved };
}

function validateCount(value) {
  const count = value === undefined ? DEFAULT_COUNT : value;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new ToolError(`count must be a whole number from 1 to ${MAX_COUNT} (got ${JSON.stringify(value)})`);
  }
  return count;
}

async function generateImages(args, config, redact, notifyProgress, fetchImpl = undefined, { requestTimeoutMs } = {}) {
  let subject;
  try {
    subject = assertSubject(args.prompt);
  } catch (error) {
    throw new ToolError(error.message);
  }
  const count = validateCount(args.count);
  const size = args.size === undefined ? 'draft' : args.size;
  if (size !== 'draft' && size !== 'large') {
    throw new ToolError('size must be "draft" or "large"');
  }
  const continuing = args.run_dir !== undefined;
  if (continuing) {
    if (typeof args.run_dir !== 'string' || args.run_dir.trim() === '') throw new ToolError('run_dir must be the run folder to add candidates to');
    if (args.out_dir !== undefined) throw new ToolError('pass either run_dir (add to an existing run folder) or out_dir (start a new one), not both');
    rejectTilde(args.run_dir, 'run_dir');
  } else if (typeof args.out_dir !== 'string' || args.out_dir.trim() === '') {
    throw new ToolError('out_dir must be the folder the run is written to (or pass run_dir to add to an existing run folder)');
  } else {
    rejectTilde(args.out_dir, 'out_dir');
  }
  if (args.repeat_styles !== undefined && typeof args.repeat_styles !== 'boolean') throw new ToolError('repeat_styles must be true or false');
  const repeatStyles = args.repeat_styles === true;
  const explicitBackground = args.background;
  if (explicitBackground !== undefined && !BACKGROUND_CHOICES.includes(explicitBackground)) {
    throw new ToolError(`background must be one of ${BACKGROUND_CHOICES.map((choice) => `"${choice}"`).join(', ')}`);
  }
  if (args.provider !== undefined && !['auto', 'google', 'openrouter'].includes(args.provider)) {
    throw new ToolError('provider must be "auto", "google" or "openrouter"');
  }
  if (args.styles !== undefined && !Array.isArray(args.styles)) {
    throw new ToolError('styles must be an array of style ids (see list_styles)');
  }
  const provider = resolveProvider(config, args.provider);

  // A new run folder, or the existing one the candidates are added to (numbered on from its highest number).
  let runDir;
  let previous = null;
  let firstIndex = 1;
  let nextBatch = 1;
  try {
    if (continuing) {
      const opened = openRunFolder(args.run_dir);
      runDir = opened.runDir;
      previous = opened.run;
      firstIndex = opened.nextIndex;
      nextBatch = opened.nextBatch;
    } else {
      runDir = createRunFolder(args.out_dir).runDir;
    }
  } catch (error) {
    throw new ToolError(error.message);
  }
  // A continued round keeps the background choice of the round before it unless one is given: "more" and "the final in
  // high resolution" of a logo the user wanted on a blackboard stay on a blackboard (the choice is recorded per batch).
  const earlierBackground = previous === null ? undefined : previous.batches[previous.batches.length - 1]?.background;
  const inheritedBackground = explicitBackground === undefined && earlierBackground !== 'auto' && BACKGROUND_CHOICES.includes(earlierBackground) ? earlierBackground : null;
  const backgroundChoice = explicitBackground ?? inheritedBackground ?? 'auto';
  const usedStyles = previous === null ? [] : previous.candidates.map((candidate) => candidate.style).filter((id) => typeof id === 'string');
  const { styles, unknown } = pickStyles(count, { requested: args.styles ?? [], exclude: usedStyles, repeat: repeatStyles });
  const backgrounds = styles.map((style) => backgroundFor(style, backgroundChoice));
  const notes = [];
  if (unknown.length > 0) notes.push(`unknown style ids ignored: ${unknown.join(', ')}`);
  if (config.model !== null) notes.push(`model override in use: ${provider.model} on ${provider.id}`);
  if (inheritedBackground !== null) notes.push(`background "${inheritedBackground}" carried over from the earlier round (pass background: "auto" for white or black instead)`);

  const startedAt = new Date().toISOString();
  const worker = async (style, { signal }) =>
    provider.generate({
      apiKey: provider.apiKey,
      model: provider.model,
      prompt: buildPrompt(subject, style.hint, { background: backgroundFor(style, backgroundChoice) }),
      size,
      fetchImpl,
      signal,
      ...(requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs }),
    });

  const batch = await runBatch({
    tasks: styles,
    worker,
    onProgress: (_index, { done, total }) => notifyProgress?.(done, total),
  });

  const failures = [];
  for (const failure of batch.failures) {
    failures.push({
      style: styles[failure.index]?.id ?? null,
      code: failure.code,
      message: redact(failure.message),
      attempts: failure.attempts,
    });
  }

  const candidates = [];
  let sequence = firstIndex - 1;
  const batchNumber = nextBatch;
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
  // How many answers reported each field: a total is only claimed when EVERY answer reported it.
  const reported = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
  for (let index = 0; index < batch.results.length; index += 1) {
    const result = batch.results[index];
    if (result === null) continue;
    const style = styles[index];
    if (result.note !== undefined && !notes.includes(result.note)) notes.push(result.note);
    usage.requests += 1;
    for (const field of USAGE_FIELDS) {
      const value = result.usage?.[field];
      if (typeof value === 'number') {
        usage[field] += value;
        reported[field] += 1;
      }
    }
    const drop = acceptImage(result.image);
    if (drop.ok) {
      try {
        const placed = writeNumbered(runDir, sequence, 'png', drop.png);
        sequence = placed.sequence;
        candidates.push({ index: placed.sequence, batch: batchNumber, style: style.id, styleName: style.name, background: backgrounds[index], file: placed.file, width: drop.width, height: drop.height, bytes: drop.png.length });
      } catch (error) {
        failures.push({ style: style.id, code: 'write', message: redact(`the image was generated but could not be written: ${error.message}`), attempts: 1 });
      }
    } else if (drop.keepRaw && bufferHoldsSecret(result.image, [config.googleKey, config.openrouterKey])) {
      // Fail closed: raw provider bytes are written unchanged, so a payload that carries the key is never written.
      failures.push({
        style: style.id,
        code: 'response',
        message: 'the provider returned an image whose bytes contain the configured key; it was discarded and nothing was written',
        attempts: 1,
      });
    } else if (drop.keepRaw) {
      try {
        const placed = writeNumbered(runDir, sequence, drop.format, result.image);
        sequence = placed.sequence;
        candidates.push({
          index: placed.sequence, batch: batchNumber, style: style.id, styleName: style.name, background: backgrounds[index], file: placed.file,
          width: drop.width, height: drop.height, bytes: result.image.length,
          warning: redact(drop.reason),
        });
      } catch (error) {
        failures.push({ style: style.id, code: 'write', message: redact(`the image was generated but could not be written: ${error.message}`), attempts: 1 });
      }
    } else {
      failures.push({ style: style.id, code: 'response', message: redact(drop.reason), attempts: 1 });
    }
  }
  // A field some billed answer did not report is unknown (null), never zero and never a partial sum presented as a total.
  for (const field of USAGE_FIELDS) {
    if (reported[field] !== usage.requests) usage[field] = null;
  }
  usage.costKnown = usage.cost !== null;

  const stopped = batch.stopped === null ? null : { code: batch.stopped.code, message: redact(batch.stopped.message) };
  if (stopped !== null && stopped.code === 'deadline') notes.push('the run deadline passed; whatever finished is here, the rest was cut');

  // A new run writes run.json. A continued run never touches an existing file: its batch goes to a new batch-<n>.json
  // (a number taken meanwhile by a parallel call is skipped, so neither call loses its images).
  let finalBatch = batchNumber;
  const batchRecord = {
    number: batchNumber,
    created: startedAt,
    prompt: subject,
    provider: provider.id,
    model: provider.model,
    size,
    background: backgroundChoice,
    styles: styles.map((style) => style.id),
    candidates: candidates.map((candidate) => candidate.index),
    failures,
    usage,
    notes,
    stopped,
  };
  let batchFile = previous === null ? 'run.json' : `batch-${finalBatch}.json`;
  for (let attempt = 0; ; attempt += 1) {
    batchRecord.number = finalBatch;
    for (const candidate of candidates) candidate.batch = finalBatch;
    const written = redactDeep(
      previous === null
        ? {
          created: startedAt,
          plugin: SERVER_NAME,
          batches: [batchRecord],
          candidates,
          next: 'build packs and the contact sheet with scripts/pack.mjs (see the skill for the exact commands)',
        }
        : { plugin: SERVER_NAME, batch: batchRecord, candidates },
      redact,
    );
    try {
      writeFileExclusive(path.join(runDir, batchFile), Buffer.from(`${JSON.stringify(written, null, 2)}\n`, 'utf8'));
      break;
    } catch (error) {
      if (previous === null || attempt >= 50 || !/already exists/.test(error.message)) throw error;
      finalBatch += 1;
      batchFile = `batch-${finalBatch}.json`;
    }
  }

  if (candidates.length === 0) {
    const reason = stopped !== null ? stopped.message : failures[0]?.message ?? 'no image was generated';
    throw new ToolError(`No candidate was generated (run folder ${runDir}, details in ${batchFile}): ${reason}`);
  }
  const added = candidates.map((candidate) => candidate.index);
  const range = added.length === 1 || added[added.length - 1] - added[0] === added.length - 1
    ? (added.length === 1 ? `${added[0]}` : `${added[0]}-${added[added.length - 1]}`)
    : added.join(',');
  return {
    runDir,
    runJson: path.join(runDir, 'run.json'),
    batchJson: path.join(runDir, batchFile),
    batch: finalBatch,
    continued: previous !== null,
    provider: provider.id,
    model: provider.model,
    size,
    background: backgroundChoice,
    candidates,
    totalCandidatesInRun: (previous === null ? 0 : previous.candidates.length) + candidates.length,
    failures,
    usage,
    notes,
    stopped,
    nextSteps: nextSteps(runDir, previous === null ? null : range),
  };
}

/** Where this server's own pack script lives: an absolute path, so the steps work from any working directory. */
const PACK_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pack.mjs');

/**
 * The two commands that finish a round. A later round (`range` set) builds only its new candidates and gives them a new
 * sheet file; the pack name of the earlier rounds is reused so round 2 does not write app.ico beside chess-clock.ico.
 */
function nextSteps(runDir, range) {
  const name = inferPackName(runDir);
  const nameArg = ` --name "${name ?? '<app-slug>'}"`;
  const only = range === null ? '' : ` --only ${range}`;
  return [
    `node "${PACK_SCRIPT}" build --run "${runDir}"${nameArg}${only}`,
    `node "${PACK_SCRIPT}" sheet --run "${runDir}"${only}`,
  ];
}

/** Write candidate-<n>.<ext> under the first free number after `after`; a name taken meanwhile is skipped. */
function writeNumbered(runDir, after, ext, buffer) {
  let sequence = after;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    sequence += 1;
    const file = `candidate-${sequence}.${ext}`;
    try {
      writeFileExclusive(path.join(runDir, file), buffer);
      return { sequence, file };
    } catch (error) {
      if (!/already exists/.test(error.message)) throw error;
    }
  }
  throw new Error('no free candidate number found');
}

/** The server does not expand "~": a literal ~ folder would be created inside the project. */
function rejectTilde(value, field) {
  if (value.trim().startsWith('~')) throw new ToolError(`${field} must be an absolute path (the server does not expand "~")`);
}

/** A merged, read-only view of a run folder: every round, every candidate, what is built, the pack name. */
function listRun(args) {
  if (typeof args?.run_dir !== 'string' || args.run_dir.trim() === '') throw new ToolError('run_dir must be the run folder to describe');
  rejectTilde(args.run_dir, 'run_dir');
  let opened;
  try {
    opened = openRunFolder(args.run_dir);
  } catch (error) {
    throw new ToolError(error.message);
  }
  const built = listBuilt(opened.runDir);
  return {
    runDir: opened.runDir,
    packName: inferPackName(opened.runDir),
    batches: opened.run.batches.map((batch) => ({
      number: batch.number, created: batch.created, prompt: batch.prompt, provider: batch.provider, model: batch.model,
      size: batch.size, background: batch.background ?? null, styles: batch.styles, candidates: batch.candidates,
      failures: Array.isArray(batch.failures) ? batch.failures.length : 0,
    })),
    candidates: opened.run.candidates.map((candidate) => ({
      index: candidate.index, batch: candidate.batch ?? null, style: candidate.style ?? null, styleName: candidate.styleName ?? null,
      background: candidate.background ?? null, file: candidate.file, width: candidate.width ?? null, height: candidate.height ?? null,
      ...(candidate.warning === undefined ? {} : { warning: candidate.warning }),
    })),
    packs: built.packs,
    sheets: built.sheets,
    nextCandidate: opened.nextIndex,
    nextBatch: opened.nextBatch,
  };
}

// --- Tool descriptions --------------------------------------------------------

const TOOLS = [
  {
    name: 'check_setup',
    description:
      'Show which providers have a key configured (booleans only, never any key material), the selected provider and model, ' +
      'and the limits (16 candidates per run, 3 parallel). With verify: true, make one tiny free request per configured provider ' +
      'to prove the key works.',
    inputSchema: {
      type: 'object',
      properties: { verify: { type: 'boolean', description: 'Verify each configured key with one small request (default false).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_styles',
    description: 'List the curated art styles a run can draw from; pass their ids as styles in generate_images.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_run',
    description:
      'Describe a run folder of this plugin without changing anything: every round (prompt, provider, background, styles), every candidate ' +
      '(number, style, background, file), which packs and sheets exist, the pack name used so far and the next free candidate and round numbers. ' +
      'Use it instead of reading run.json and batch files yourself (a continued run keeps later rounds in batch-<n>.json).',
    inputSchema: {
      type: 'object',
      properties: { run_dir: { type: 'string', description: 'The run folder (absolute path).' } },
      required: ['run_dir'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_images',
    description:
      `Generate 1..${MAX_COUNT} icon candidates for one app description, at most 3 requests in flight, each with a different art ` +
      'style, and write them plus run.json into a fresh run folder under out_dir, or, with run_dir, add them to an existing run ' +
      'folder (numbered on from its highest candidate, styles not used there yet; "eight more" go here; nothing already in the ' +
      'folder is ever modified, the new round adds files only; "more like number 3" = styles: [that style], repeat_styles: true). The model is asked for a ' +
      'pure white or pure black flat background so it can be removed (per style, see background). Returns the candidate list, ' +
      'failures, usage and next steps.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'One sentence describing the app (the subject). Kept intact; wrapped automatically.' },
        count: { type: 'integer', minimum: 1, maximum: MAX_COUNT, description: `How many candidates (1..${MAX_COUNT}, default ${DEFAULT_COUNT}).` },
        size: { type: 'string', enum: ['draft', 'large'], description: 'draft = smallest supported size (cheap); large = 1K for finals.' },
        out_dir: { type: 'string', description: 'Folder a NEW run folder is created in (never overwritten). Omit when run_dir is given.' },
        run_dir: { type: 'string', description: 'An existing run folder of this plugin to add the candidates to (instead of out_dir): they are numbered after the existing ones; the round is recorded in a new batch-<n>.json and nothing existing is modified.' },
        background: { type: 'string', enum: BACKGROUND_CHOICES, description: 'auto (default): the model draws on pure white, or pure black for styles that need it, and the background is removed. white / black: force one. as-described: ask for no background at all because the prompt describes the one the user wants. With run_dir the earlier round\'s choice is kept unless this is given.' },
        provider: { type: 'string', enum: ['auto', 'google', 'openrouter'] },
        styles: { type: 'array', items: { type: 'string' }, description: 'Optional style ids (see list_styles) to use first.' },
        repeat_styles: { type: 'boolean', description: 'With styles: make every candidate in those styles, round-robin (more variations of one style), instead of filling up with other styles.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

// --- JSON-RPC over stdio ------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function makeServer({ env = process.env, fetchImpl = undefined, requestTimeoutMs = undefined } = {}) {
  const config = readConfig(env);
  const redact = makeRedactor([config.googleKey, config.openrouterKey]);
  const diag = (text) => process.stderr.write(`${redact(text)}\n`);

  async function callTool(name, args, notifyProgress) {
    if (name === 'check_setup') return checkSetup(args, config, redact, fetchImpl);
    if (name === 'list_styles') return { styles: listStyles() };
    if (name === 'list_run') return listRun(args);
    if (name === 'generate_images') {
      return generateImages(args, config, redact, notifyProgress, fetchImpl, { requestTimeoutMs });
    }
    throw new ToolError(`unknown tool "${name}"`);
  }

  async function handleCall(params) {
    const name = params?.name;
    if (typeof name !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32602, message: 'tools/call needs a tool name' } };
    // An unknown tool is a protocol error (invalid params), not a tool that ran and failed.
    if (!TOOLS.some((tool) => tool.name === name)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32602, message: `unknown tool ${JSON.stringify(name.slice(0, 80))}` } };
    }
    const args = params?.arguments ?? {};
    const progressToken = params?._meta?.progressToken;
    const notifyProgress =
      progressToken === undefined
        ? null
        : (progress, total) =>
            send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress, total } });
    try {
      const result = await callTool(name, args, notifyProgress);
      // Last line of defence: whatever a tool returns, every string in it passes the value-based redactor, so a
      // provider that echoes a key in any field of a successful answer cannot get it into the chat.
      return { jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text: JSON.stringify(redactDeep(result, redact), null, 2) }] } };
    } catch (error) {
      if (error instanceof ToolError) {
        return { jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text: redact(error.message) }], isError: true } };
      }
      diag(`tool ${name} failed: ${error instanceof Error ? error.stack : String(error)}`);
      const message = error instanceof ProviderError ? redact(error.message) : `internal error: ${redact(error instanceof Error ? error.message : String(error))}`;
      return { jsonrpc: '2.0', id: null, result: { content: [{ type: 'text', text: message }], isError: true } };
    }
  }

  async function handleMessage(message) {
    if (Array.isArray(message)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batching is not supported' } };
    }
    if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
    }
    const { method } = message;
    // A notification (no id) NEVER gets a response, whatever the method is —
    // but tools/call notifications still run, so their side effects happen.
    const isNotification = message.id === undefined || message.id === null;
    if (method === 'initialize') {
      if (isNotification) return null;
      const requested = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0', id: message.id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'Icon candidates from an image model: check_setup first, then generate_images, then the pack/sheet scripts named in its result.',
        },
      };
    }
    if (method.startsWith('notifications/')) return null;
    if (method === 'ping') return isNotification ? null : { jsonrpc: '2.0', id: message.id, result: {} };
    if (method === 'tools/list') return isNotification ? null : { jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } };
    if (method === 'tools/call') {
      const response = await handleCall(message.params);
      if (isNotification) return null;
      response.id = message.id;
      return response;
    }
    if (isNotification) return null;
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method "${method}"` } };
  }

  return { handleMessage, config, redact, diag };
}

// The real server reads stdin; tests drive handleMessage (or the process) directly.
export { makeServer, TOOLS, readConfig, NO_KEY_HELP, generateImages, checkSetup, ToolError };

async function main() {
  // Nothing but protocol messages may reach stdout, whatever a library does.
  const toStderr = (...args) => process.stderr.write(`${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.error = toStderr;

  const server = makeServer();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      replyError(null, -32700, 'parse error');
      return;
    }
    server
      .handleMessage(message)
      .then((response) => {
        if (response !== null) send(response);
      })
      .catch((error) => {
        server.diag(`internal error handling a message: ${error instanceof Error ? error.stack : String(error)}`);
        const id = message !== null && typeof message === 'object' ? message.id : null;
        replyError(id, -32603, 'internal error');
      });
  });
  lines.on('close', () => process.exit(0));
}

// Run as a process only when executed directly (a test that imports this
// module gets the exported functions instead of a stdio server).
// Both sides go through realpath: a plugin folder reached through a symbolic link or junction (a stow-managed ~/.claude,
// a CLAUDE_CONFIG_DIR on a junction) has argv[1] spelled with the link and import.meta.url with the real path.
function isInvokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}
const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  main();
}
