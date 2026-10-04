// What a run folder says about itself: run.json (the first round) and one batch-<n>.json per later round, read together.
// Used by the MCP server (to continue a run and to answer list_run) and by pack.mjs (to know, for example, which candidates
// were asked to keep their own background). Pure reads, nothing is ever written here.

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ID = 'icon-creator-ai';
const RECORD_MAX_BYTES = 4 * 1024 * 1024;

/** The plain objects of a list from a record (a hand-edited or damaged file may hold nulls and numbers); anything else is dropped. */
const objectsOnly = (list) => (Array.isArray(list) ? list.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)) : []);

/** run.json in the shape with `batches`; the older flat shape (one batch, fields at the top) is converted. */
export function normalizeRun(parsed) {
  if (Array.isArray(parsed.batches)) {
    return { ...parsed, batches: objectsOnly(parsed.batches), candidates: objectsOnly(parsed.candidates) };
  }
  const candidates = objectsOnly(parsed.candidates).map((candidate) => ({ ...candidate, batch: 1 }));
  const batch = {
    number: 1,
    created: parsed.created,
    prompt: parsed.prompt,
    provider: parsed.provider,
    model: parsed.model,
    size: parsed.size,
    styles: parsed.styles,
    candidates: candidates.map((candidate) => candidate.index),
    failures: parsed.failures ?? [],
    usage: parsed.usage ?? null,
    notes: parsed.notes ?? [],
    stopped: parsed.stopped ?? null,
  };
  return { created: parsed.created, plugin: parsed.plugin, batches: [batch], candidates, next: parsed.next };
}

function regularFile(absolute) {
  let stat = null;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    stat = null;
  }
  return stat !== null && !stat.isSymbolicLink() && stat.isFile() ? stat : null;
}

/**
 * Read run.json and every batch-<n>.json of `runDir` into one view:
 * { run: { created, plugin, batches, candidates }, nextIndex, nextBatch, problems }.
 * `strict` (the server) throws an Error on the first problem; otherwise (pack.mjs) a missing or damaged record
 * is skipped, listed in `problems`, and `run` is null when run.json itself is unusable.
 */
export function readRunRecords(runDir, { strict = true } = {}) {
  const problems = [];
  const bad = (message) => {
    if (strict) throw new Error(message);
    problems.push(message);
    return null;
  };
  const runJson = path.join(runDir, 'run.json');
  const stat = regularFile(runJson);
  if (stat === null) {
    bad(`${runDir} has no run.json of its own: it is not a run folder made by this plugin`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  if (stat.size > RECORD_MAX_BYTES) {
    bad(`${runJson} is too large to be a run.json`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(runJson, 'utf8'));
  } catch {
    bad(`${runJson} is not valid JSON`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.plugin !== PLUGIN_ID) {
    bad(`${runDir} is not a run folder made by this plugin (run.json does not say so)`);
    return { run: null, nextIndex: 1, nextBatch: 1, problems };
  }
  const run = normalizeRun(parsed);
  // A continued run keeps run.json exactly as it was written and adds a batch-<n>.json per later round.
  const batchFiles = fs.readdirSync(runDir)
    .map((entry) => ({ entry, match: /^batch-(\d+)\.json$/.exec(entry) }))
    .filter(({ match }) => match !== null)
    .map(({ entry, match }) => ({ entry, number: Number(match[1]) }))
    .sort((a, b) => a.number - b.number);
  for (const { entry, number } of batchFiles) {
    const absolute = path.join(runDir, entry);
    const batchStat = regularFile(absolute);
    if (batchStat === null || batchStat.size > RECORD_MAX_BYTES) {
      bad(`${absolute} is not a regular batch file of this plugin`);
      continue;
    }
    let batchParsed;
    try {
      batchParsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    } catch {
      bad(`${absolute} is not valid JSON`);
      continue;
    }
    if (batchParsed === null || typeof batchParsed !== 'object' || batchParsed.plugin !== PLUGIN_ID ||
        batchParsed.batch === null || typeof batchParsed.batch !== 'object' || batchParsed.batch.number !== number ||
        !Array.isArray(batchParsed.candidates)) {
      bad(`${absolute} is not a batch file made by this plugin`);
      continue;
    }
    run.batches.push(batchParsed.batch);
    run.candidates.push(...objectsOnly(batchParsed.candidates));
  }
  let highest = 0;
  for (const candidate of run.candidates) if (Number.isInteger(candidate.index) && candidate.index > highest) highest = candidate.index;
  for (const entry of fs.readdirSync(runDir)) {
    const match = /^candidate-(\d+)\.[a-z]+$/i.exec(entry);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  const nextBatch = Math.max(0, ...run.batches.map((batch) => (Number.isInteger(batch.number) ? batch.number : 0))) + 1;
  return { run, nextIndex: highest + 1, nextBatch, problems };
}

/** candidate number -> { style, background, batch } from the records (empty when there are none). */
export function candidateInfo(run) {
  const info = new Map();
  if (run === null) return info;
  for (const candidate of run.candidates) {
    if (Number.isInteger(candidate.index)) info.set(candidate.index, { style: candidate.style ?? null, background: candidate.background ?? null, batch: candidate.batch ?? null });
  }
  return info;
}

/**
 * The file name the packs of this run were built with (windows/<name>.ico of the first pack that has one), or null.
 * A later round reuses it, so round 2 does not produce app.ico beside chess-clock.ico.
 */
export function inferPackName(runDir) {
  let entries;
  try {
    entries = fs.readdirSync(runDir).filter((entry) => /^pack-\d+(-[a-z0-9-]+)?$/.test(entry)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  } catch {
    return null;
  }
  for (const entry of entries) {
    try {
      const ico = fs.readdirSync(path.join(runDir, entry, 'windows')).find((file) => file.endsWith('.ico'));
      if (ico !== undefined) return ico.slice(0, -4);
    } catch {
      // no windows folder in this pack
    }
  }
  return null;
}

/** The pack folders and sheet files that exist in the run folder (names only). */
export function listBuilt(runDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(runDir);
  } catch {
    entries = [];
  }
  const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  return {
    packs: entries.filter((entry) => /^pack-\d+(-[a-z0-9-]+)?$/.test(entry)).sort(byNumber),
    sheets: entries.filter((entry) => /^sheet-([a-z0-9-]+-)?\d+\.png$/.test(entry)).sort(byNumber),
  };
}
