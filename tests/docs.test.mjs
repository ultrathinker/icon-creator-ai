// Documentation and manifest invariants: what the plugin promises must match
// what it ships. These tests fail when a file is renamed, a rule in the skill
// drifts from the code, or a personal detail slips into a tracked file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** The files Git tracks — what a published clone would actually contain. */
function trackedFiles() {
  // In a copy without .git (a zip or `git archive` checkout, a folder copied to another machine) there is nothing to ask
  // Git, so every file under the folder counts.
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
  } catch {
    return walk('.').map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  }
}

function walk(relative, predicate = () => true) {
  const entries = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'tmp') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (predicate(full)) entries.push(full);
    }
  };
  visit(path.join(ROOT, relative));
  return entries;
}

test('the manifest declares the plugin the directory expects', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'icon-creator-ai');
  assert.equal(manifest.displayName, 'Icon Creator AI');
  assert.equal(manifest.version, '0.1.7');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.author.name, 'ultrathinker');
  assert.equal(manifest.repository, 'https://github.com/ultrathinker/icon-creator-ai');
  for (const field of ['documentationUrl', 'supportUrl', 'privacyPolicyUrl']) {
    assert.ok(manifest[field]?.startsWith('https://'), `${field} is an https URL`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, '.claude-plugin', 'icon.svg')));
  const svg = read('.claude-plugin/icon.svg');
  assert.match(svg, /viewBox="0 0 256 256"/);

  const userConfig = manifest.userConfig;
  assert.deepEqual(Object.keys(userConfig).sort(), ['google_api_key', 'model', 'openrouter_api_key', 'provider']);
  for (const key of ['google_api_key', 'openrouter_api_key']) {
    assert.equal(userConfig[key].type, 'string');
    assert.equal(userConfig[key].sensitive, true, `${key} must be sensitive`);
    assert.notEqual(userConfig[key].required, true, 'keys are optional: either provider works');
  }
  assert.deepEqual(userConfig.provider.options, ['auto', 'google', 'openrouter']);
  assert.equal(userConfig.provider.default, 'auto');

  const server = manifest.mcpServers['icon-creator-ai'];
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs']);
  assert.ok(fs.existsSync(path.join(ROOT, 'mcp', 'server.mjs')));
  assert.equal(server.env.ICON_AI_GOOGLE_KEY, '${user_config.google_api_key}');
  assert.equal(server.env.ICON_AI_OPENROUTER_KEY, '${user_config.openrouter_api_key}');
  assert.equal(server.env.ICON_AI_PROVIDER, '${user_config.provider}');
  assert.equal(server.env.ICON_AI_MODEL, '${user_config.model}');
});

test('the marketplace entry matches the manifest', () => {
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(marketplace.name, 'icon-creator-ai');
  assert.equal(marketplace.owner.name, 'ultrathinker');
  assert.equal(marketplace.plugins[0].name, 'icon-creator-ai');
  assert.equal(marketplace.plugins[0].source, '.');
});

test('README, PRIVACY, SECURITY, CHANGELOG and CONTRIBUTING exist and are honest-sized', () => {
  for (const file of ['README.md', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', '.editorconfig']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  }
  const readme = read('README.md');
  const outsideCodeBlocks = readme.replace(/```[\s\S]*?```/g, '');
  const words = outsideCodeBlocks.split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 40, `README has ${words} words outside code blocks`);
  assert.match(readme, /Known caveat/);
  assert.match(readme, /watermark/);
  assert.match(readme, /never upscaled|never enlarged|not.*upscale/i);
  assert.match(readme, /Verified by running/);
  assert.match(readme, /Node 18/);
  assert.match(read('SECURITY.md'), /Report a vulnerability/i);
});

test('the skill states the rules the code enforces', () => {
  // Normalize line endings: a Windows checkout with core.autocrlf=true has
  // CRLF in the worktree, and the front-matter shape must hold either way.
  const skill = read('skills/icon-creator-ai/SKILL.md').replace(/\r\n/g, '\n');
  assert.match(skill, /^---\nname: icon-creator-ai\ndescription: .+\n---/m);
  assert.ok(skill.includes('${CLAUDE_PLUGIN_ROOT}/scripts/pack.mjs'), 'scripts run through the plugin root');
  assert.match(skill, /Never ask for or accept an API key in the chat/);
  assert.match(skill, /Exactly one question/);
  assert.match(skill, /check_setup/);
  assert.match(skill, /generate_images/);
  assert.match(skill, /size.*draft/i);
  assert.match(skill, /16 (and|px|pixels)/);
  assert.match(skill, /#62442/);
  assert.match(skill, /watermark/);
  // Follow-up flows reference the real parameters.
  assert.match(skill, /styles: \["/);
  assert.match(skill, /size: "large"/);
  const command = read('commands/icons.md').replace(/\r\n/g, '\n');
  assert.match(command, /^---\ndescription: .+\nargument-hint:/m);
  assert.match(command, /icon-creator-ai/);
  assert.match(command, /adds no question of its own/, 'the command must not ask a second question');
  // One question only (the count): a bare command infers the app from the project instead of asking for it.
  assert.doesNotMatch(skill, /What is the app the icon is for\?/, 'the skill must not ask for the app in chat');
  assert.match(skill, /do NOT ask/, 'step 1 tells the model not to ask');
  assert.match(skill, /Assuming the app is/, 'step 1 states its assumption instead');
  assert.equal((skill.match(/AskUserQuestion tool with exactly one question/g) ?? []).length, 1, 'exactly one structured question');
});

test('the docs promise only the two hard-coded hosts', () => {
  for (const file of ['README.md', 'PRIVACY.md', 'SECURITY.md']) {
    const text = read(file);
    assert.ok(text.includes('generativelanguage.googleapis.com'), `${file} names the Google host`);
    assert.ok(text.includes('openrouter.ai'), `${file} names the OpenRouter host`);
  }
  const code = trackedFiles().filter((file) => /\.(mjs|md|json)$/.test(file));
  const hosts = new Set();
  for (const file of code) {
    for (const match of read(file).matchAll(/https:\/\/([a-z0-9.-]+)/g)) {
      hosts.add(match[1]);
    }
  }
  const allowed = new Set([
    'generativelanguage.googleapis.com',
    'openrouter.ai',
    'github.com',
    'claude.com',
    'code.claude.com',
    'ai.google.dev',
    'aistudio.google.com',
    'keepachangelog.com',
    'semver.org',
    'x', // the placeholder host used by the http unit tests
  ]);
  const unexpected = [...hosts].filter((host) => !allowed.has(host));
  assert.deepEqual(unexpected, [], `only expected hosts are mentioned in tracked files: ${unexpected}`);
});

test('no personal data or agent material is tracked', () => {
  const tracked = trackedFiles().filter((file) => !/\.png$|\.svg$/.test(file));
  // The identity pattern is assembled from pieces so this file does not
  // contain the literal it scans for.
  const identity = new RegExp(['universe', 'issilent'].join(''), 'i');
  const patterns = [/C:\\Users\\/i, identity, /@[a-z0-9.-]+\.(com|net|org|io|ru)/i, /[\u0400-\u04FF]/];
  for (const file of tracked) {
    const text = read(file);
    for (const pattern of patterns) {
      assert.ok(!pattern.test(text), `${file} matches ${pattern.source}`);
    }
  }
});

test('every tracked non-asset file is small, readable text (no minified blobs)', () => {
  for (const file of walk('.', (f) => !/\.png$/.test(f))) {
    const size = fs.statSync(file).size;
    assert.ok(size < 256 * 1024, `${path.relative(ROOT, file)} is under 256 KiB`);
    if (file.endsWith('.mjs')) {
      const longest = read(path.relative(ROOT, file)).split('\n').reduce((max, line) => Math.max(max, line.length), 0);
      assert.ok(longest < 400, `${path.relative(ROOT, file)} has no minified-looking lines (${longest} chars)`);
    }
  }
});
