// Temporary folders of the test suite: created under the real path of the OS temp folder (macOS keeps it behind the /var
// symlink, which the plugin refuses by design) and removed when the test process ends, so a suite run leaves nothing behind
// even when a test fails half-way. Only folders made through makeTmpDir are removed, links inside them are unlinked, never followed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_TMP = fs.realpathSync(os.tmpdir());
const made = new Set();

function removeTree(dir) {
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    try {
      fs.rmSync(dir, { force: true });
    } catch {
      // a link or file that cannot be removed now is left, not chased
    }
    return;
  }
  for (const entry of fs.readdirSync(dir)) removeTree(path.join(dir, entry));
  try {
    fs.rmdirSync(dir);
  } catch {
    // still in use: left behind
  }
}

process.on('exit', () => {
  for (const dir of made) removeTree(dir);
});

export function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(REAL_TMP, prefix));
  made.add(dir);
  return dir;
}
