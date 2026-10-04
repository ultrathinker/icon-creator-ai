// Safe output paths for runs. The rules: every directory in the path the user
// names must be a REAL directory — a symbolic link or junction anywhere in
// the typed chain (including the leaf the user named) is refused with the
// real path to use instead, so an alias can never redirect a run outside the
// folder the user meant. The run folder is created exactly once (never over
// anything existing), and every file is written through an exclusive create
// so a planted alias at the target name is refused instead of written
// through. Absolute and relative paths are both accepted.

import fs from 'node:fs';
import path from 'node:path';
import { readRunRecords } from '../../scripts/lib/runrecords.mjs';

/** Walk one path component; throws on a link, returns the real directory. */
function realStep(current, segment) {
  const next = path.join(current, segment);
  let stat = null;
  try {
    stat = fs.lstatSync(next);
  } catch {
    return { dir: next, exists: false }; // missing tail: created later as a real dir
  }
  if (stat.isSymbolicLink()) {
    let target = '';
    try {
      target = fs.realpathSync(next);
    } catch {
      // a dangling link: report it without a target
    }
    throw new Error(
      `${next} is a symbolic link or junction${target ? ` (it points to ${target})` : ''}: ` +
        'refusing to write through it - pass that real path instead',
    );
  }
  if (!stat.isDirectory()) throw new Error(`${next} exists and is not a directory`);
  return { dir: next, exists: true };
}

/**
 * Resolve the user-named output root, refusing links in the whole typed
 * chain. Missing components are fine (they are created as real directories);
 * a link anywhere is an error.
 */
export function resolveNamedRoot(typed) {
  const absolute = path.resolve(typed);
  const { root } = path.parse(absolute);
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = realStep(current, segment).dir;
  }
  return { path: current, typed: absolute };
}

/**
 * Make sure the named root exists as a chain of real directories. A symbolic
 * link or junction anywhere below the resolved root is refused: it could
 * redirect the run folder outside the folder the user named.
 */
export function ensureRealRoot(resolved) {
  const { root } = path.parse(resolved);
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new Error(`${current} is a symbolic link or junction: refusing to write through it; pass the real path instead`);
      }
      if (!stat.isDirectory()) throw new Error(`${current} exists and is not a directory`);
    } else {
      fs.mkdirSync(current);
    }
  }
  return current;
}

function pad(number, width = 2) {
  return String(number).padStart(width, '0');
}

function stampOf(date) {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

const randomSuffix = () => Math.random().toString(36).slice(2, 5);

/**
 * Create the run folder `<outDir>/run-<UTC timestamp>-<suffix>`. Never
 * overwrites: a name collision gets a fresh suffix. Returns
 * { runDir, name }.
 */
export function createRunFolder(outDirTyped, { now = () => new Date(), suffix = randomSuffix } = {}) {
  const resolved = resolveNamedRoot(outDirTyped);
  ensureRealRoot(resolved.path);
  const stamp = stampOf(now());
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `run-${stamp}-${suffix()}`;
    const target = path.join(resolved.path, name);
    let stat = null;
    try {
      stat = fs.lstatSync(target);
    } catch {
      stat = null;
    }
    if (stat !== null) continue; // astronomically unlikely; never overwrite
    fs.mkdirSync(target);
    return { runDir: target, name };
  }
  throw new Error(`could not create a fresh run folder under ${resolved.path}`);
}

/**
 * Open an existing run folder to add candidates to it ("eight more" continue the same folder instead of starting a
 * new one). The typed path must be a chain of real directories (no link anywhere), the folder must hold a regular
 * run.json that this plugin wrote, and candidate files are numbered on from the highest number already there.
 * Returns { runDir, run, nextIndex, nextBatch }: `run` is every batch of the folder (run.json plus the batch-<n>.json
 * files of later rounds), an older flat run.json converted. Nothing is ever written to an existing file.
 */
export function openRunFolder(typed) {
  const resolved = resolveNamedRoot(typed);
  let stat = null;
  try {
    stat = fs.lstatSync(resolved.path);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isDirectory()) throw new Error(`${resolved.path} is not an existing run folder`);
  const { run, nextIndex, nextBatch } = readRunRecords(resolved.path, { strict: true });
  return { runDir: resolved.path, run, nextIndex, nextBatch };
}

// Errors that mean "this volume cannot make hard links" (some network and FAT shares), not "the name is taken".
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/**
 * Give the finished temporary file its real name without ever replacing a file that is there. A hard link is created
 * atomically and fails with EEXIST when the name is taken, even when another process took it a moment ago (a rename would
 * silently replace it). Only on a volume without hard links is the last resort a check followed by a rename.
 */
function publishExclusive(staged, absolute) {
  try {
    fs.linkSync(staged, absolute);
    fs.rmSync(staged, { force: true });
    return;
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${absolute} already exists; refusing to overwrite it`);
    if (!LINK_UNSUPPORTED.has(error.code)) throw error;
  }
  let taken = true;
  try {
    fs.lstatSync(absolute);
  } catch {
    taken = false;
  }
  if (taken) throw new Error(`${absolute} already exists; refusing to overwrite it`);
  fs.renameSync(staged, absolute);
}

/**
 * Write `buffer` to `absolute` through an exclusive create (see publishExclusive), first
 * refusing an existing file or a symbolic link at the target. Existing files are never replaced
 * here, not even by a second process writing the same name at the same moment.
 */
export function writeFileExclusive(absolute, buffer) {
  let stat = null;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    stat = null;
  }
  if (stat !== null) {
    throw new Error(`${absolute} already exists; refusing to overwrite it`);
  }
  const staged = `${absolute}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const fd = fs.openSync(staged, 'wx');
  try {
    fs.writeFileSync(fd, buffer);
    fs.closeSync(fd);
    publishExclusive(staged, absolute);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    fs.rmSync(staged, { force: true });
    throw error;
  }
}
