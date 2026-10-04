// Tests of the pack builder and the contact sheet, on synthetic candidates.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  prepareCandidate, planPack, buildPack, sanitizeName, renderSize,
  WINDOWS_ICO_SIZES, LINUX_SIZES, FAVICON_ICO_SIZES, WEB_PNG_SIZES,
} from '../scripts/lib/packbuild.mjs';
import { parseIco } from '../scripts/lib/ico.mjs';
import { parseIcns } from '../scripts/lib/icns.mjs';
import { decodePng, pngInfo, encodePng } from '../scripts/lib/png.mjs';
import { composeSheet, buildSheets, drawNumber, SHEET_PER_PAGE } from '../scripts/lib/sheet.mjs';
import {
  candidateTile, candidateNoisy, candidateGradient, candidateRinging, candidateTransparent,
} from './helpers.mjs';
import { makeTmpDir } from './tmp.mjs';

// On macOS os.tmpdir() is behind the /var symlink, which the plugin refuses by design: tests use its real path.
const REAL_TMP = fs.realpathSync(os.tmpdir());

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function tmpDir(label) {
  return makeTmpDir(`icon-ai-${label}-`);
}

test('prepareCandidate removes a flat background and keeps enclosed areas', () => {
  const prepared = prepareCandidate(candidateTile(512));
  assert.equal(prepared.size, 512);
  assert.equal(prepared.facts.background.action, 'remove');
  assert.ok(prepared.facts.madeTransparentPercent > 20, `removed ${prepared.facts.madeTransparentPercent}%`);
  assert.ok(prepared.facts.cornerAlphaAfter.every((alpha) => alpha === 0));
  // The enclosed white window inside the tile survives removal.
  const center = decodePng(prepared.png);
  const o = (Math.floor(512 / 2) * 512 + Math.floor(512 / 2)) * 4;
  assert.equal(center.rgba[o + 3], 255);
});

test('prepareCandidate survives noisy and gradient backgrounds', () => {
  const noisy = prepareCandidate(candidateNoisy(384));
  assert.equal(noisy.facts.background.action, 'remove');
  assert.ok(noisy.facts.cornerAlphaAfter.every((alpha) => alpha === 0));
  const gradient = prepareCandidate(candidateGradient(256));
  // A gradient is not one flat colour: kept, with the honest warning.
  assert.ok(['keep', 'remove'].includes(gradient.facts.background.action));
  assert.ok(gradient.warnings.some((warning) => warning.code === 'background-uncertain'));
});

test('prepareCandidate handles ringing edges and already transparent candidates', () => {
  const ringing = prepareCandidate(candidateRinging(320));
  assert.ok(ringing.facts.madeTransparentPercent > 10, 'the flat background around the halo is removed');
  const transparent = prepareCandidate(candidateTransparent(256));
  assert.equal(transparent.facts.background.action, 'keep');
  assert.equal(transparent.facts.madeTransparentPercent, 0);
});

test('prepareCandidate reports a non-square candidate as padded', () => {
  // A wide image: the pack builder must centre it, not stretch it.
  const rgba = Buffer.alloc(128 * 96 * 4, 0);
  for (let y = 0; y < 96; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      if (Math.hypot(x - 64, y - 48) <= 45) {
        const o = (y * 128 + x) * 4;
        rgba[o] = 10; rgba[o + 1] = 200; rgba[o + 2] = 100; rgba[o + 3] = 255;
      }
    }
  }
  // The legacy centred fit (crop: false) pads a non-square image; the default crop is covered in tightfit.test.mjs.
  const prepared = prepareCandidate(encodePng(128, 96, rgba), { crop: false });
  assert.equal(prepared.size, 128);
  assert.equal(prepared.facts.fit.content.height, 96);
  assert.equal(prepared.facts.fit.content.y, 16);
});

test('planPack omits sizes above the master and says why', () => {
  const big = planPack('myapp', 1024);
  assert.deepEqual(big.omitted, []);
  assert.ok(big.files.some((file) => file.rel === 'macos/myapp.icns'));
  assert.ok(big.files.some((file) => file.rel === 'icon-1024.png'));
  const small = planPack('myapp', 512);
  // A 512 px draft master makes an .icns with the slices it can honestly make (16..512) and names the missing 1024 px one.
  const icns = small.files.find((file) => file.rel === 'macos/myapp.icns');
  assert.deepEqual(icns.sizes, [16, 32, 64, 128, 256, 512]);
  assert.ok(small.omitted.some((line) => line.startsWith('macos/myapp.icns is missing the 1024 px slice')));
  assert.ok(!small.files.some((file) => file.rel === 'icon-1024.png'));
  // Below 256 px there is no useful .icns: omitted and named.
  const tiny = planPack('myapp', 128);
  assert.ok(!tiny.files.some((file) => file.rel === 'macos/myapp.icns'));
  assert.ok(tiny.omitted.some((line) => line.startsWith('macos/myapp.icns (needs a master of at least 256 px')));
  assert.ok(small.files.some((file) => file.rel === 'web/icon-512.png')); // 512 fits a 512 master
  assert.ok(small.files.some((file) => file.rel === 'windows/myapp.ico'));
  assert.deepEqual(small.files.filter((file) => file.kind === 'ico' && file.rel.startsWith('windows/'))[0].sizes,
    [16, 24, 32, 48, 64, 128, 256]);
});

test('sanitizeName refuses path separators and worse', () => {
  assert.equal(sanitizeName('my-app_1.0'), 'my-app_1.0');
  assert.throws(() => sanitizeName('../evil'), /not a safe file name/);
  assert.throws(() => sanitizeName('a b'), /not a safe file name/);
  assert.throws(() => sanitizeName(''), /not a safe file name/);
});

test('buildPack writes verifiable ico, icns and png files for a 1K master', () => {
  const prepared = prepareCandidate(candidateTile(1024));
  const written = new Map();
  const pack = buildPack(prepared, { name: 'demo', publish: (rel, buffer) => written.set(rel, buffer) });
  assert.ok(written.has('windows/demo.ico'));
  assert.ok(written.has('macos/demo.icns'));
  const ico = parseIco(written.get('windows/demo.ico'));
  assert.deepEqual(ico.entries.map((entry) => entry.declaredWidth), [16, 24, 32, 48, 64, 128, 256]);
  const icns = parseIcns(written.get('macos/demo.icns'));
  assert.equal(icns.chunks.length, 11);
  for (const [rel, buffer] of written) {
    if (rel.endsWith('.png')) {
      const info = pngInfo(buffer);
      assert.equal(info.width, info.height);
    }
  }
  assert.ok(pack.omitted.length === 0);
  assert.ok(renderSize(prepared, 16).length > 0);
  assert.throws(() => renderSize(prepared, 2048), /internal error/);
});

// Review 7: nothing a user might expect is dropped silently, and the web files never point at icons the pack lacks.
const PLAN_MASTERS = [16, 32, 64, 128, 180, 192, 256, 512, 1024];
const numbersIn = (text) => (text.match(/\d+/g) ?? []).map(Number);

function missingFrom(plan, prefix) {
  const line = plan.omitted.find((entry) => entry.startsWith(prefix));
  return line === undefined ? [] : numbersIn(line.slice(prefix.length).split('(')[0]);
}

test('planPack accounts for every standard size: it is made, or named as missing', () => {
  for (const master of PLAN_MASTERS) {
    const plan = planPack('app', master);
    const where = `${master} px master`;
    const made = (predicate) => plan.files.filter(predicate);
    const sorted = (list) => [...list].sort((a, b) => a - b);
    const ico = plan.files.find((file) => file.rel === 'windows/app.ico');
    assert.deepEqual(sorted([...ico.sizes, ...missingFrom(plan, 'windows/app.ico is missing the ')]), WINDOWS_ICO_SIZES, `${where}: Windows .ico`);
    const linuxMade = made((file) => file.rel.startsWith('linux/hicolor/')).map((file) => file.size);
    const linuxMissing = (plan.omitted.find((entry) => entry.startsWith('linux/hicolor is missing ')) ?? '').match(/(\d+)x\1/g)?.map((part) => parseInt(part, 10)) ?? [];
    assert.deepEqual(sorted([...linuxMade, ...linuxMissing]), LINUX_SIZES, `${where}: Linux hicolor tree`);
    const favicon = plan.files.find((file) => file.rel === 'web/favicon.ico');
    assert.deepEqual(sorted([...favicon.sizes, ...missingFrom(plan, 'web/favicon.ico is missing the ')]), FAVICON_ICO_SIZES, `${where}: favicon.ico`);
    for (const [name, size] of Object.entries(WEB_PNG_SIZES)) {
      const present = plan.files.some((file) => file.rel === `web/${name}`);
      const named = plan.omitted.some((entry) => entry.startsWith(`web/${name} `));
      assert.ok(present !== named, `${where}: web/${name} is either made or named as missing, not both and not neither (${size} px)`);
    }
  }
});

test('planPack leaves out the manifest, the head snippet and the desktop entry when there is nothing for them to point at', () => {
  for (const master of PLAN_MASTERS) {
    const plan = planPack('app', master);
    const where = `${master} px master`;
    const has = (rel) => plan.files.find((file) => file.rel === rel);
    const named = (prefix) => plan.omitted.some((entry) => entry.startsWith(prefix));
    const manifest = has('web/site.webmanifest');
    assert.ok(manifest !== undefined || named('web/site.webmanifest'), `${where}: manifest made or named`);
    if (manifest) {
      for (const size of manifest.sizes) assert.ok(has(`web/icon-${size}.png`), `${where}: manifest lists icon-${size}.png, which the pack has`);
    }
    const head = has('web/head.html');
    assert.ok(head !== undefined || named('web/head.html'), `${where}: head made or named`);
    if (head) {
      assert.equal(head.apple, has('web/apple-touch-icon.png') !== undefined, `${where}: the apple link follows the file`);
      assert.equal(head.manifest, manifest !== undefined, `${where}: the manifest link follows the file`);
      assert.deepEqual(head.favicon, has('web/favicon.ico')?.sizes ?? [], `${where}: the favicon link follows the file`);
    }
    assert.equal(has('linux/app.desktop') !== undefined, plan.files.some((file) => file.rel.startsWith('linux/hicolor/')), `${where}: the desktop entry needs a hicolor icon`);
  }
});

test('the written head.html and site.webmanifest reference only files that exist (32, 64, 128, 180, 192, 256 px)', () => {
  for (const master of [32, 64, 128, 180, 192, 256]) {
    const written = new Map();
    const pack = buildPack(prepareCandidate(candidateTile(master)), { name: 'demo', publish: (rel, buffer) => written.set(rel, buffer) });
    const where = `${master} px master`;
    if (written.has('web/head.html')) {
      const head = written.get('web/head.html').toString('utf8');
      for (const match of head.matchAll(/href="\/([^"]+)"/g)) {
        assert.ok(written.has(`web/${match[1]}`), `${where}: head.html links ${match[1]}, which the pack must have`);
      }
    }
    if (written.has('web/site.webmanifest')) {
      const manifest = JSON.parse(written.get('web/site.webmanifest').toString('utf8'));
      assert.ok(manifest.icons.length > 0, `${where}: a manifest with no icons is not written`);
      for (const icon of manifest.icons) assert.ok(written.has(`web/${icon.src.slice(1)}`), `${where}: the manifest lists ${icon.src}, which the pack must have`);
    }
    if (master === 128) {
      assert.ok(!written.has('web/site.webmanifest'), '128 px: no manifest, there is no 192 px icon for it');
      const head = written.get('web/head.html').toString('utf8');
      assert.ok(head.includes('favicon.ico') && !head.includes('site.webmanifest') && !head.includes('apple-touch-icon'), '128 px: only the favicon is linked');
      assert.ok(pack.omitted.some((line) => line.startsWith('web/site.webmanifest')));
      assert.ok(pack.omitted.some((line) => line.startsWith('windows/demo.ico is missing the 256')));
      assert.ok(pack.omitted.some((line) => line.startsWith('linux/hicolor is missing 192x192, 256x256, 512x512')));
    }
  }
});

test('buildPack for a 512 master writes an .icns without the 1024 px slice, omits icon-1024.png and lists both', () => {
  const prepared = prepareCandidate(candidateTile(512));
  const written = new Map();
  const pack = buildPack(prepared, { name: 'demo', publish: (rel, buffer) => written.set(rel, buffer) });
  assert.ok(written.has('macos/demo.icns'));
  const parsed = parseIcns(written.get('macos/demo.icns'));
  assert.deepEqual(parsed.chunks.map((chunk) => chunk.type), ['icp4', 'icp5', 'ic11', 'icp6', 'ic12', 'ic07', 'ic08', 'ic13', 'ic09', 'ic14'], 'every slice but ic10 (1024 px)');
  assert.ok(!written.has('icon-1024.png'));
  assert.ok(written.has('icon-512.png'));
  assert.ok(pack.omitted.some((line) => line.includes('1024 px slice')));
  assert.equal(pack.masterSize, 512);
});

test('composeSheet draws numbers, checkerboards and the size row', () => {
  // crop: false keeps the generated margin, so the sample points below sit on the checkerboard and the dark tile.
  const prepared = prepareCandidate(candidateTile(256), { crop: false });
  const png = composeSheet([{ number: 3, prepared }]);
  const decoded = decodePng(png);
  assert.ok(decoded.width > 600 && decoded.height > 250);
  // The header strip behind the number differs from the page background.
  const page = pixelAt(decoded, 5, 5);
  const header = pixelAt(decoded, 30, 14);
  assert.notDeepEqual(page, header);
  // The checkerboard tile starts at (24, 46): an 8 px cell pattern, so two
  // samples one cell apart differ.
  const checkerA = pixelAt(decoded, 30, 60); // local cell (0,1): dark square
  const checkerB = pixelAt(decoded, 34, 54); // local cell (1,1): light square
  assert.notDeepEqual(checkerA, checkerB);
  // The dark tile starts at x = 24 + 144 + 10 = 178; the icon fills its tile, so the 21 px margin of this
  // candidate (drawn at 70 % of its frame, crop off) is what shows the dark tile at x = 182.
  const dark = pixelAt(decoded, 182, 100);
  assert.ok(dark[0] < 60 && dark[1] < 60 && dark[2] < 70, `dark tile is ${dark}`);
});

function pixelAt(decoded, x, y) {
  const o = (y * decoded.width + x) * 4;
  return [decoded.rgba[o], decoded.rgba[o + 1], decoded.rgba[o + 2], decoded.rgba[o + 3]];
}

test('drawNumber renders digits and rejects nothing', () => {
  const width = 200;
  const canvas = Buffer.alloc(width * 60 * 4);
  const used = drawNumber(canvas, width, 10, 10, 16);
  assert.ok(used > 20, 'two digits are wider than one');
  let lit = 0;
  for (let i = 0; i < canvas.length; i += 4) if (canvas[i + 3] === 255) lit += 1;
  assert.ok(lit > 50);
});

test('buildSheets paginates: 16 candidates make two sheets', () => {
  const candidates = Array.from({ length: 16 }, (_, index) =>
    candidateTile(128, { tile: [(index * 37) % 255, (index * 91) % 255, (index * 53) % 255] }));
  const sheets = buildSheets(candidates);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].count, SHEET_PER_PAGE);
  assert.equal(sheets[1].count, SHEET_PER_PAGE);
  const five = buildSheets(candidates.slice(0, 5));
  assert.equal(five.length, 1);
  assert.equal(five[0].count, 5);
  assert.throws(() => composeSheet([]), /1..8/);
});

test('the CLI builds packs and sheets inside a run folder and refuses overwrites', async () => {
  const run = tmpDir('cli');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), candidateTile(512));
  fs.writeFileSync(path.join(run, 'candidate-2.png'), candidateNoisy(512));
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  const build1 = await execFileAsync(process.execPath, [packPath, 'build', '--run', run, '--name', 'demo-app']);
  const parsed = JSON.parse(build1.stdout);
  assert.equal(parsed.packs.length, 2);
  assert.ok(fs.existsSync(path.join(run, 'pack-1', 'windows', 'demo-app.ico')));
  assert.ok(fs.existsSync(path.join(run, 'pack-2', 'linux', 'hicolor', '512x512', 'apps', 'demo-app.png')));
  await assert.rejects(
    execFileAsync(process.execPath, [packPath, 'build', '--run', run, '--name', 'demo-app']),
    /already exists/,
  );
  const again = await execFileAsync(process.execPath, [packPath, 'build', '--run', run, '--name', 'demo-app', '--force']);
  assert.equal(JSON.parse(again.stdout).packs.length, 2);
  const sheet1 = await execFileAsync(process.execPath, [packPath, 'sheet', '--run', run]);
  const sheetParsed = JSON.parse(sheet1.stdout);
  assert.equal(sheetParsed.sheets.length, 1);
  assert.ok(fs.existsSync(path.join(run, 'sheet-1.png')));
  await assert.rejects(execFileAsync(process.execPath, [packPath, 'sheet', '--run', run]), /already exists/);
  fs.rmSync(run, { recursive: true, force: true });
});

test('the CLI reports non-PNG candidates as skipped, not crashed', async () => {
  const run = tmpDir('skip');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), candidateTile(256));
  fs.writeFileSync(path.join(run, 'candidate-2.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  fs.writeFileSync(path.join(run, 'run.json'), '{}');
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  const { stdout } = await execFileAsync(process.execPath, [packPath, 'build', '--run', run]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.packs.length, 1);
  assert.equal(parsed.skipped.length, 1);
  assert.match(parsed.skipped[0].reason, /cannot decode/);
  const sheetOut = await execFileAsync(process.execPath, [packPath, 'sheet', '--run', run]);
  const sheetSkipped = JSON.parse(sheetOut.stdout).skipped;
  assert.equal(sheetSkipped.length, 1);
  assert.equal(sheetSkipped[0].file, 'candidate-2.jpg');
  assert.match(sheetSkipped[0].reason, /cannot decode/);
  fs.rmSync(run, { recursive: true, force: true });
});

// Review 4: a PNG the server keeps raw (valid header, broken body) must not abort the next command.
function brokenPng() {
  const png = Buffer.from(candidateTile(256));
  png[Math.floor(png.length / 2)] ^= 0xff; // breaks an IDAT CRC: a valid header, an undecodable body
  return png;
}

test('an undecodable PNG kept raw is skipped by build and sheet, and a run of only such files says so', async () => {
  assert.throws(() => prepareCandidate(brokenPng()), 'the fixture really is undecodable');
  const run = tmpDir('broken-alone');
  fs.writeFileSync(path.join(run, 'candidate-1.png'), brokenPng());
  fs.writeFileSync(path.join(run, 'run.json'), '{}');
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  const built = JSON.parse((await execFileAsync(process.execPath, [packPath, 'build', '--run', run])).stdout);
  assert.equal(built.packs.length, 0);
  assert.equal(built.skipped.length, 1);
  assert.equal(built.skipped[0].candidate, 1);
  assert.match(built.skipped[0].reason, /cannot be decoded/);
  await assert.rejects(
    execFileAsync(process.execPath, [packPath, 'sheet', '--run', run]),
    (error) => /none of the candidate files .* can be used: candidate-1\.png/.test(error.stderr),
  );
  fs.rmSync(run, { recursive: true, force: true });
});

// Review 6: a candidate that is a link to a file outside the run folder must be refused, not read.
function makeFileLink(target, linkPath) {
  fs.symlinkSync(target, linkPath, 'file');
}

test('a candidate that is a symbolic link is refused by build and sheet, and never read', async (t) => {
  const outside = tmpDir('link-target');
  const run = tmpDir('link-run');
  const secretPng = path.join(outside, 'outside.png');
  fs.writeFileSync(secretPng, candidateTile(256));
  try {
    makeFileLink(secretPng, path.join(run, 'candidate-1.png'));
  } catch (error) {
    t.skip(`cannot create a file symlink here (${error.code})`);
    return;
  }
  fs.writeFileSync(path.join(run, 'candidate-2.png'), candidateGradient(256));
  fs.writeFileSync(path.join(run, 'run.json'), '{}');
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  const built = JSON.parse((await execFileAsync(process.execPath, [packPath, 'build', '--run', run])).stdout);
  assert.deepEqual(built.packs.map((pack) => pack.candidate), [2], 'only the regular file is packed');
  assert.deepEqual(built.skipped.map((entry) => entry.candidate), [1]);
  assert.match(built.skipped[0].reason, /symbolic link or junction/);
  assert.equal(fs.existsSync(path.join(run, 'pack-1')), false, 'nothing was built from the link');
  const sheeted = JSON.parse((await execFileAsync(process.execPath, [packPath, 'sheet', '--run', run])).stdout);
  assert.equal(sheeted.sheets[0].candidates, 1, 'the sheet shows one candidate, not the linked file');
  assert.deepEqual(sheeted.skipped.map((entry) => entry.candidate), [1]);
  assert.match(sheeted.skipped[0].reason, /symbolic link or junction/);
  fs.rmSync(run, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a run whose only candidate is a link says so and fails the sheet', async (t) => {
  const outside = tmpDir('link-target-only');
  const run = tmpDir('link-run-only');
  const target = path.join(outside, 'outside.png');
  fs.writeFileSync(target, candidateTile(256));
  try {
    makeFileLink(target, path.join(run, 'candidate-1.png'));
  } catch (error) {
    t.skip(`cannot create a file symlink here (${error.code})`);
    return;
  }
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  const built = JSON.parse((await execFileAsync(process.execPath, [packPath, 'build', '--run', run])).stdout);
  assert.equal(built.packs.length, 0);
  assert.match(built.skipped[0].reason, /symbolic link or junction/);
  await assert.rejects(
    execFileAsync(process.execPath, [packPath, 'sheet', '--run', run]),
    (error) => /none of the candidate files .* can be used: candidate-1\.png/.test(error.stderr),
  );
  fs.rmSync(run, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a mixed run packs and sheets the usable candidates and keeps their real numbers', async () => {
  const run = tmpDir('broken-mixed');
  const good1 = candidateTile(256);
  const good3 = candidateGradient(256);
  fs.writeFileSync(path.join(run, 'candidate-1.png'), good1);
  fs.writeFileSync(path.join(run, 'candidate-2.png'), brokenPng());
  fs.writeFileSync(path.join(run, 'candidate-3.png'), good3);
  fs.writeFileSync(path.join(run, 'run.json'), '{}');
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  const built = JSON.parse((await execFileAsync(process.execPath, [packPath, 'build', '--run', run])).stdout);
  assert.deepEqual(built.packs.map((pack) => pack.candidate), [1, 3]);
  assert.deepEqual(built.skipped.map((entry) => entry.candidate), [2]);
  assert.ok(fs.existsSync(path.join(run, 'pack-3')), 'pack-3 exists for the third candidate');
  const sheeted = JSON.parse((await execFileAsync(process.execPath, [packPath, 'sheet', '--run', run])).stdout);
  assert.equal(sheeted.sheets.length, 1);
  assert.equal(sheeted.sheets[0].candidates, 2);
  assert.deepEqual(sheeted.skipped.map((entry) => entry.candidate), [2]);
  // The second tile on the sheet is labelled 3 (as pack-3), not 2.
  const onDisk = fs.readFileSync(path.join(run, 'sheet-1.png'));
  const realNumbers = buildSheets([{ number: 1, buffer: good1 }, { number: 3, buffer: good3 }])[0].png;
  const positional = buildSheets([good1, good3])[0].png;
  assert.ok(onDisk.equals(realNumbers), 'the sheet labels candidates with their candidate-k numbers');
  assert.ok(!onDisk.equals(positional), 'and not with their position');
  fs.rmSync(run, { recursive: true, force: true });
});

test('buildSheets accepts explicit candidate numbers and still numbers plain buffers by position', () => {
  const a = candidateTile(256);
  const b = candidateGradient(256);
  const byPosition = buildSheets([a, b])[0].png;
  assert.ok(byPosition.equals(buildSheets([{ number: 1, buffer: a }, { number: 2, buffer: b }])[0].png));
  assert.ok(!byPosition.equals(buildSheets([{ number: 1, buffer: a }, { number: 3, buffer: b }])[0].png));
});

test('the CLI refuses a run folder that is a symlink', async () => {
  const real = tmpDir('realrun');
  const link = path.join(REAL_TMP, `icon-ai-link-${Date.now()}`);
  fs.writeFileSync(path.join(real, 'candidate-1.png'), candidateTile(128));
  fs.symlinkSync(real, link, 'dir');
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  await assert.rejects(execFileAsync(process.execPath, [packPath, 'build', '--run', link]), /symbolic link/);
  await assert.rejects(execFileAsync(process.execPath, [packPath, 'sheet', '--run', link]), /symbolic link/);
  fs.rmSync(link, { force: true });
  fs.rmSync(real, { recursive: true, force: true });
});

test('the CLI refuses a link anywhere in the run chain, both commands', async () => {
  const real = tmpDir('chain-real');
  fs.writeFileSync(path.join(real, 'candidate-1.png'), candidateTile(128));
  // A junction/POSIX link in the middle of the typed chain, with the run
  // folder below it.
  const link = path.join(REAL_TMP, `icon-ai-chain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const runThroughLink = path.join(link, 'run-x');
  const packPath = path.join(ROOT, 'scripts', 'pack.mjs');
  await assert.rejects(execFileAsync(process.execPath, [packPath, 'build', '--run', runThroughLink]), /symbolic link or junction/);
  await assert.rejects(execFileAsync(process.execPath, [packPath, 'sheet', '--run', runThroughLink]), /symbolic link or junction/);
  fs.rmSync(link, { force: true });
  fs.rmSync(real, { recursive: true, force: true });
});
