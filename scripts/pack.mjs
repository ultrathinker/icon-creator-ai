#!/usr/bin/env node
// pack.mjs — build finished icon packs and contact sheets from a run folder
// produced by the icon-creator-ai MCP server.
//
//   node scripts/pack.mjs build --run <run folder> [--name app] [--fill 96] [--only 5-12] [--force]
//   node scripts/pack.mjs sheet --run <run folder> [--only 5-12] [--fill 96] [--force]
//
// Every output stays inside the run folder. Nothing is overwritten without
// --force, and symbolic links or junctions in the output path are refused.

import fs from 'node:fs';
import path from 'node:path';
import { prepareCandidate, buildPack, ensureRealDir, publishPackFile, sanitizeName, DEFAULT_TOLERANCE, DEFAULT_FILL } from './lib/packbuild.mjs';
import { MIN_FILL, MAX_FILL } from './lib/tightfit.mjs';
import { sheetsFromPrepared } from './lib/sheet.mjs';
import { readRunRecords, candidateInfo, inferPackName } from './lib/runrecords.mjs';
import { detectFormat } from './lib/imagecheck.mjs';

const USAGE = `pack.mjs — build icon packs and contact sheets from a run folder

Usage:
  node scripts/pack.mjs build --run <run folder> [--name <name>] [--title <text>] [--variant <label>] [--only <numbers>] [--fill <50-100>] [--no-crop] [--keep-tile] [--no-sharpen] [--tolerance <0-120>] [--force]
  node scripts/pack.mjs sheet --run <run folder> [--variant <label>] [--only <numbers>] [--fill <50-100>] [--no-crop] [--keep-tile] [--no-sharpen] [--tolerance <0-120>] [--force]

build  writes pack-<k>/ for every candidate-<k>.png in the run folder (only the
       numbers named by --only, such as 5-12 or 1,3,5-8, when a run was continued
       and just the new candidates need packs): the
       Windows .ico, macOS .icns (the slices a master of 256 px or more is big
       enough for), the Linux hicolor tree,
       web favicons and the master PNG. Sizes above the master are omitted and
       listed, never upscaled.
       Each candidate is first cropped to its subject, which then fills --fill
       percent of the square's longer side (default 96), so the picture stays
       readable at 32 and 16 px. The crop enlarges the generated pixels a little
       (the warnings say so when it is a lot). --no-crop keeps the generated
       margins; --no-sharpen leaves the 16..48 px renderings as the plain shrink
       (by default they get a light sharpening, so eyes and edges stay crisp);
       --keep-tile keeps an opaque tile as drawn instead of cropping to
       the picture inside it.
sheet  writes sheet-<n>.png contact sheets, eight candidates per sheet, each
       candidate shown on a checkerboard and a dark tile with its 64, 32 and
       16 px renderings. With --only the sheet shows just those candidates and is
       written to NEW files numbered after the existing sheets (sheet-2.png, ...):
       the sheets already there are never touched, so a later round of candidates
       gets its own sheet. Without --only the sheets start at sheet-1.png and an
       existing file needs --force.
--name   the file name inside the packs (windows/<name>.ico ...); without it the
         name of the packs already in the run folder is reused, else "app".
--title  the human title in the web manifest and the .desktop entry.
--variant <label>  builds a second version of the same candidates (another --fill,
         --no-crop ...) into pack-<k>-<label>/ and sheet-<label>-<n>.png beside the
         old ones, which stay untouched. The safe way to "rebuild with other settings".
A candidate whose prompt described its own background (background "as-described" in
the run records) keeps that background: it is not removed.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { command: null, run: null, name: null, force: false, tolerance: DEFAULT_TOLERANCE, fill: DEFAULT_FILL, crop: true, tile: 'crop', sharpen: true, only: null, onlyText: null, variant: null, title: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === 'build' || arg === 'sheet') {
      if (options.command !== null) throw new Error(`"${arg}" after "${options.command}": pick one command`);
      options.command = arg;
    } else if (arg === '--run') options.run = value();
    else if (arg === '--name') options.name = value();
    else if (arg === '--force') options.force = true;
    else if (arg === '--tolerance') options.tolerance = Number(value());
    else if (arg === '--fill') options.fill = Number(value()) / 100;
    else if (arg === '--no-crop') options.crop = false;
    else if (arg === '--keep-tile') options.tile = 'keep';
    else if (arg === '--no-sharpen') options.sharpen = false;
    else if (arg === '--variant') options.variant = value();
    else if (arg === '--title') options.title = value();
    else if (arg === '--only') {
      options.onlyText = value();
      options.only = parseOnly(options.onlyText);
    }
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new Error(`unknown option "${arg}"`);
  }
  if (options.command === null) throw new Error('pick a command: build or sheet');
  if (options.run === null) throw new Error('--run <run folder> is required');
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 120) {
    throw new Error('--tolerance must be a number from 0 to 120');
  }
  if (options.variant !== null && !/^(?=.*[a-z])[a-z0-9][a-z0-9-]{0,23}$/.test(options.variant)) {
    throw new Error('--variant must be a short label of lowercase letters, digits and "-" (at least one letter), for example fill90');
  }
  if (options.title !== null && (options.title.trim() === '' || options.title.length > 80)) throw new Error('--title must be 1 to 80 characters');
  if (!Number.isFinite(options.fill) || options.fill < MIN_FILL || options.fill > MAX_FILL) {
    throw new Error(`--fill must be a percentage from ${MIN_FILL * 100} to ${MAX_FILL * 100} (default ${DEFAULT_FILL * 100})`);
  }
  return options;
}

/** "5", "1,3" or "5-12" (and mixes of them) -> a Set of candidate numbers. */
function parseOnly(text) {
  const message = `--only must be candidate numbers such as 5, 1,3 or 5-12 (got "${text}")`;
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text)) throw new Error(message);
  const wanted = new Set();
  for (const part of text.split(',')) {
    const [from, to = from] = part.split('-').map(Number);
    if (to < from || to - from > 999) throw new Error(message);
    for (let k = from; k <= to; k += 1) wanted.add(k);
  }
  return wanted;
}

function prepareOptions(options, background = 'auto') {
  return { tolerance: options.tolerance, fill: options.fill, crop: options.crop, tile: options.tile, background };
}

/** Candidates whose prompt described their own background keep it (the run records say so). */
function backgroundOf(info, index) {
  return info.get(index)?.background === 'as-described' ? 'keep' : 'auto';
}

/** The run folder: every directory in the typed chain must be real (no link). */
function resolveRunFolder(typed) {
  const absolute = path.resolve(typed);
  const { root } = path.parse(absolute);
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let stat = null;
    try {
      stat = fs.lstatSync(next);
    } catch {
      throw new Error(`the run folder ${absolute} does not exist`);
    }
    if (stat.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.realpathSync(next);
      } catch {
        // dangling link
      }
      throw new Error(`${next} is a symbolic link or junction${target ? ` (it points to ${target})` : ''}: pass the real path instead`);
    }
    if (!stat.isDirectory()) throw new Error(`${next} exists and is not a directory`);
    current = next;
  }
  return absolute;
}

/** candidate-<k>.<ext> files in index order, split into PNG and other formats. */
function listCandidates(runFolder) {
  const entries = fs.readdirSync(runFolder);
  const found = [];
  for (const entry of entries) {
    const match = /^candidate-(\d+)\.(png|jpg|jpeg|webp)$/i.exec(entry);
    if (match === null) continue;
    // lstat BEFORE any read: a candidate that is a symbolic link, a junction or not a regular file would make the
    // pack read something outside the run folder, so it is refused (reported under `skipped`), never opened.
    const stat = fs.lstatSync(path.join(runFolder, entry));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      found.push({ file: entry, index: Number(match[1]), format: match[2].toLowerCase(), refused: stat.isSymbolicLink() ? 'a symbolic link or junction' : 'not a regular file' });
      continue;
    }
    found.push({ file: entry, index: Number(match[1]), format: detectFormat(fs.readFileSync(path.join(runFolder, entry))) ?? match[2].toLowerCase() });
  }
  found.sort((a, b) => a.index - b.index || a.file.localeCompare(b.file));
  const seen = new Set();
  for (const item of found) {
    if (seen.has(item.index)) throw new Error(`two candidates numbered ${item.index} in ${runFolder}`);
    seen.add(item.index);
  }
  return found;
}

function refusedReason(candidate) {
  return `${candidate.file} is ${candidate.refused}; pack input must be a regular file inside the run folder, so it is refused and never opened`;
}

function unsupportedReason(format) {
  return `the candidate is ${format.toUpperCase()}, which this tool cannot decode without extra software; ` +
    'the raw file is kept. Generate PNG output (the default) or convert it.';
}

function undecodableReason(error) {
  return `the PNG cannot be decoded (${error instanceof Error ? error.message : String(error)}); the raw file is kept`;
}

/** The number the next NEW sheet file gets: one after the highest sheet-<n>.png in the run folder. */
function nextSheetNumber(runFolder, variant = null) {
  let highest = 0;
  const pattern = variant === null ? /^sheet-(\d+)\.png$/ : new RegExp(`^sheet-${variant}-(\\d+)\\.png$`);
  for (const entry of fs.readdirSync(runFolder)) {
    const match = pattern.exec(entry);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function refuseOverwrite(target, force) {
  if (fs.existsSync(target) && !force) {
    throw new Error(
      `${target} already exists. Nothing existing is rewritten by default: --only <numbers> adds a new file for later candidates, ` +
        '--variant <label> writes a separate version beside it, --force overwrites on purpose.',
    );
  }
}

/**
 * A damaged or foreign batch record is skipped by the reader, and what that round said (such as an as-described background
 * to keep) is then not applied: say so on stderr and return the notes for the JSON. A folder with no run.json at all is
 * normal here (the user's own candidates), so only a damaged record of a real run is reported.
 */
function reportRecordProblems(records) {
  if (records.run === null) return [];
  for (const problem of records.problems) {
    process.stderr.write(`warning: ${problem}; it was skipped, so what that round recorded (such as a background to keep) is not applied\n`);
  }
  return records.problems;
}

function runBuild(options) {
  const runFolder = resolveRunFolder(options.run);
  const everyCandidate = listCandidates(runFolder);
  if (everyCandidate.length === 0) throw new Error(`no candidate-<k>.png files in ${runFolder}`);
  const candidates = options.only === null ? everyCandidate : everyCandidate.filter((candidate) => options.only.has(candidate.index));
  if (candidates.length === 0) throw new Error(`no candidate matches --only ${options.onlyText} in ${runFolder}`);
  const inferred = options.name === null ? inferPackName(runFolder) : null;
  const name = sanitizeName(options.name ?? inferred ?? 'app');
  const records = readRunRecords(runFolder, { strict: false });
  const recordProblems = reportRecordProblems(records);
  const info = candidateInfo(records.run);
  const packFolder = (index) => `pack-${index}${options.variant === null ? '' : `-${options.variant}`}`;
  // One clear refusal before anything is written: a build never half-overwrites a run folder.
  if (!options.force) {
    const existing = candidates.filter((candidate) => !candidate.refused && candidate.format === 'png' && fs.existsSync(path.join(runFolder, packFolder(candidate.index))));
    if (existing.length > 0) {
      throw new Error(
        `${existing.map((candidate) => `${packFolder(candidate.index)} already exists`).join('; ')}. Nothing was written. ` +
          'For the new candidates of a later round use --only <their numbers>; to rebuild with other settings (for example --fill 90) ' +
          'use --variant <label>, which writes pack-<k>-<label> folders beside the old ones; --force overwrites on purpose.',
      );
    }
  }
  const result = {
    run: runFolder,
    name,
    nameFrom: options.name !== null ? 'the --name option' : inferred !== null ? 'the packs already in this run folder' : 'the default',
    variant: options.variant,
    packs: [],
    skipped: [],
    ...(recordProblems.length > 0 ? { recordProblems } : {}),
  };
  for (const candidate of candidates) {
    if (candidate.refused) {
      result.skipped.push({ candidate: candidate.index, file: candidate.file, reason: refusedReason(candidate) });
      continue;
    }
    if (candidate.format !== 'png') {
      result.skipped.push({ candidate: candidate.index, file: candidate.file, reason: unsupportedReason(candidate.format) });
      continue;
    }
    // Decode first: a PNG the server kept raw (valid header, broken body) is skipped with its reason and the
    // usable candidates are still packed. Only the decoding is guarded; a failure while writing still aborts.
    let prepared;
    try {
      prepared = prepareCandidate(fs.readFileSync(path.join(runFolder, candidate.file)), prepareOptions(options, backgroundOf(info, candidate.index)));
    } catch (error) {
      result.skipped.push({ candidate: candidate.index, file: candidate.file, reason: undecodableReason(error) });
      continue;
    }
    const packDir = path.join(runFolder, packFolder(candidate.index));
    ensureRealDir(packDir);
    const pack = buildPack(prepared, {
      name,
      title: options.title,
      sharpen: options.sharpen,
      publish: (rel, buffer) => {
        const absolute = path.join(packDir, rel);
        ensureRealDir(path.dirname(absolute));
        refuseOverwrite(absolute, options.force);
        publishPackFile(absolute, buffer);
      },
    });
    result.packs.push({
      candidate: candidate.index,
      packDir,
      masterSize: pack.masterSize,
      facts: prepared.facts,
      warnings: prepared.warnings,
      files: pack.files,
      omitted: pack.omitted,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function runSheet(options) {
  const runFolder = resolveRunFolder(options.run);
  const everyCandidate = listCandidates(runFolder);
  if (!everyCandidate.some((candidate) => candidate.format === 'png')) throw new Error(`no candidate-<k>.png files in ${runFolder}`);
  const candidates = options.only === null ? everyCandidate : everyCandidate.filter((candidate) => options.only.has(candidate.index));
  if (candidates.length === 0) throw new Error(`no candidate matches --only ${options.onlyText} in ${runFolder}`);
  const records = readRunRecords(runFolder, { strict: false });
  const recordProblems = reportRecordProblems(records);
  const info = candidateInfo(records.run);
  const skipped = [];
  const items = [];
  for (const candidate of candidates) {
    if (candidate.refused) {
      skipped.push({ candidate: candidate.index, file: candidate.file, reason: refusedReason(candidate) });
      continue;
    }
    if (candidate.format !== 'png') {
      skipped.push({ candidate: candidate.index, file: candidate.file, reason: unsupportedReason(candidate.format) });
      continue;
    }
    try {
      // The sheet labels a candidate with its OWN number (the k of candidate-k), skipped files included.
      items.push({ number: candidate.index, prepared: prepareCandidate(fs.readFileSync(path.join(runFolder, candidate.file)), prepareOptions(options, backgroundOf(info, candidate.index))) });
    } catch (error) {
      skipped.push({ candidate: candidate.index, file: candidate.file, reason: undecodableReason(error) });
    }
  }
  if (items.length === 0) {
    throw new Error(`none of the candidate files in ${runFolder} can be used: ${skipped.map((entry) => entry.file).join(', ')}`);
  }
  // With --only the pages are new files after the existing sheets; without it they start at sheet-1.png.
  const sheets = sheetsFromPrepared(items, { firstSheet: options.only === null ? 1 : nextSheetNumber(runFolder, options.variant), sharpen: options.sharpen, series: options.variant });
  const result = { run: runFolder, sheets: [], skipped, ...(recordProblems.length > 0 ? { recordProblems } : {}) };
  for (const sheet of sheets) {
    const target = path.join(runFolder, sheet.file);
    refuseOverwrite(target, options.force);
    publishPackFile(target, sheet.png);
    result.sheets.push({ file: sheet.file, bytes: sheet.png.length, candidates: sheet.count });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'build') runBuild(options);
  else runSheet(options);
} catch (error) {
  fail(error.message);
}
