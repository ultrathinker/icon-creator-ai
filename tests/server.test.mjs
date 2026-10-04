// Tests that drive the REAL server.mjs over stdio (spawned as a process):
// initialize with protocol version negotiation, tools/list, check_setup with
// no keys and with a sentinel key, generate_images with no key (a clear
// error), plus the JSON-RPC error paths. Network paths are tested through
// the library functions with an injected fetch (here and in the other files).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTmpDir } from './tmp.mjs';

// On macOS os.tmpdir() is behind the /var symlink, which the plugin refuses by design: tests use its real path.
const REAL_TMP = fs.realpathSync(os.tmpdir());

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SERVER = path.join(ROOT, 'mcp', 'server.mjs');

// A neutral sentinel key: no provider prefix, nothing a scanner would flag.
const SENTINEL_GOOGLE = 'gxgxgxgx-1111-gxgxgxgx-2222';

function tmpDir(label) {
  return makeTmpDir(`icon-ai-srv-${label}-`);
}

function minimalEnv() {
  const env = { PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP };
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function spawnServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...minimalEnv(), ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const pending = new Map();
  const notifications = [];
  let buffer = '';
  let nextId = 0;
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() === '') continue;
      const message = JSON.parse(line);
      if ((message.id === undefined || message.id === null) && message.method) notifications.push(message);
      else if (pending.has(message.id)) pending.get(message.id)(message);
    }
  });
  return {
    child,
    notifications,
    stderrText: () => stderr,
    stdoutText: () => stdout,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    request(method, params, { timeoutMs = 15_000 } = {}) {
      const id = nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} #${id} within ${timeoutMs} ms; stderr so far: ${stderr}`)), timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
        this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    close() {
      return new Promise((resolve) => {
        child.on('exit', () => resolve());
        child.stdin.end();
      });
    },
  };
}

test('initialize negotiates a supported protocol version and answers the basics', async () => {
  const server = spawnServer();
  const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.error, undefined);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'icon-creator-ai');
  assert.ok(init.result.capabilities.tools);
  const newer = await server.request('initialize', { protocolVersion: '2099-01-01' });
  assert.equal(newer.result.protocolVersion, '2025-06-18', 'an unknown version falls back to our latest');
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const pong = await server.request('ping');
  assert.deepEqual(pong.result, {});
  const bad = await server.request('no/such/method');
  assert.equal(bad.error.code, -32601);
  await server.close();
});

test('tools/list exposes exactly the four tools with JSON schemas', async () => {
  const server = spawnServer();
  const list = await server.request('tools/list');
  const tools = list.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['check_setup', 'list_styles', 'list_run', 'generate_images']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.description, 'string');
  }
  const generate = tools.find((tool) => tool.name === 'generate_images');
  assert.deepEqual(generate.inputSchema.required, ['prompt']);
  for (const property of ['out_dir', 'run_dir', 'background', 'styles', 'count', 'size']) assert.ok(property in generate.inputSchema.properties, property);
  assert.deepEqual(generate.inputSchema.properties.background.enum, ['auto', 'white', 'black', 'as-described']);
  await server.close();
});

test('check_setup with no keys reports booleans and the no-key reason', async () => {
  const server = spawnServer();
  const call = await server.request('tools/call', { name: 'check_setup', arguments: {} });
  assert.equal(call.result.isError, undefined);
  const setup = JSON.parse(call.result.content[0].text);
  assert.deepEqual(setup.providers, { google: { configured: false }, openrouter: { configured: false } });
  assert.equal(setup.resolved.provider, null);
  assert.match(setup.resolved.reason, /No provider key is configured/);
  assert.equal(setup.limits.maxParallel, 3);
  assert.equal(setup.limits.maxCount, 16);
  await server.close();
});

test('check_setup with a key reports configured: true and never the key', async () => {
  const server = spawnServer({ ICON_AI_GOOGLE_KEY: SENTINEL_GOOGLE });
  const call = await server.request('tools/call', { name: 'check_setup', arguments: {} });
  const setup = JSON.parse(call.result.content[0].text);
  assert.equal(setup.providers.google.configured, true);
  assert.equal(setup.resolved.provider, 'google');
  assert.equal(setup.resolved.model, 'gemini-3.1-flash-image');
  const everything = call.result.content[0].text + server.stderrText();
  assert.ok(!everything.includes(SENTINEL_GOOGLE), 'no key material in the result or stderr');
  await server.close();
});

test('ambient provider variables are ignored: only ICON_AI_* names are read', async () => {
  const server = spawnServer({
    GEMINI_API_KEY: SENTINEL_GOOGLE,
    GOOGLE_API_KEY: SENTINEL_GOOGLE,
    OPENROUTER_API_KEY: 'ambient-openrouter-shaped-value',
  });
  const call = await server.request('tools/call', { name: 'check_setup', arguments: {} });
  const setup = JSON.parse(call.result.content[0].text);
  assert.equal(setup.providers.google.configured, false, 'GEMINI_API_KEY/GOOGLE_API_KEY must be ignored');
  assert.equal(setup.providers.openrouter.configured, false, 'OPENROUTER_API_KEY must be ignored');
  await server.close();
});

test('the server starts normally when the env mapping delivers empty values', async () => {
  // What an unset user_config looks like on the server side: every mapped
  // variable present but empty. The plugin must load and answer regardless.
  const server = spawnServer({ ICON_AI_GOOGLE_KEY: '', ICON_AI_OPENROUTER_KEY: '', ICON_AI_PROVIDER: '', ICON_AI_MODEL: '' });
  const init = await server.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.error, undefined);
  const call = await server.request('tools/call', { name: 'check_setup', arguments: {} });
  const setup = JSON.parse(call.result.content[0].text);
  assert.equal(setup.providers.google.configured, false);
  assert.equal(setup.providers.openrouter.configured, false);
  assert.equal(setup.providerSetting, 'auto', 'an empty provider setting falls back to auto');
  await server.close();
});

test('generate_images with no key is a clear tool error that explains the fix', async () => {
  const server = spawnServer();
  const call = await server.request('tools/call', { name: 'generate_images', arguments: { prompt: 'a chess clock', out_dir: tmpDir('nokey') } });
  assert.equal(call.result.isError, true);
  const text = call.result.content[0].text;
  assert.match(text, /No provider key is configured/);
  assert.match(text, /\/plugin/);
  assert.match(text, /never|Never/);
  await server.close();
});

test('malformed JSON gets -32700 and an unknown tool gets a JSON-RPC invalid-params error', async () => {
  const server = spawnServer();
  try {
    server.child.stdin.write('this is not json\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lines = server.stdoutText().trim().split('\n').map((line) => JSON.parse(line));
    const parseError = lines.find((line) => line.error?.code === -32700);
    assert.ok(parseError, 'a parse error response was sent');
    const call = await server.request('tools/call', { name: 'no_such_tool', arguments: {} });
    assert.equal(call.result, undefined, 'an unknown tool is not a tool result');
    assert.equal(call.error.code, -32602);
    assert.match(call.error.message, /unknown tool "no_such_tool"/);
    // A tool that exists but fails is still a tool result with isError, not a protocol error.
    const failed = await server.request('tools/call', { name: 'generate_images', arguments: { prompt: 'an app', count: 99, out_dir: REAL_TMP } });
    assert.equal(failed.error, undefined);
    assert.equal(failed.result.isError, true);
  } finally {
    await server.close();
  }
});

test('list_styles returns the curated styles', async () => {
  const server = spawnServer();
  const call = await server.request('tools/call', { name: 'list_styles', arguments: {} });
  const styles = JSON.parse(call.result.content[0].text).styles;
  assert.ok(styles.length >= 16);
  assert.ok(new Set(styles.map((style) => style.id)).size === styles.length, 'ids are unique');
  await server.close();
});

test('the server never writes anything but JSON-RPC lines to stdout', async () => {
  const server = spawnServer({ ICON_AI_GOOGLE_KEY: SENTINEL_GOOGLE });
  await server.request('initialize', { protocolVersion: '2025-06-18' });
  await server.request('tools/call', { name: 'check_setup', arguments: { verify: false } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const line of server.stdoutText().split('\n')) {
    if (line.trim() === '') continue;
    assert.doesNotThrow(() => JSON.parse(line), `stdout line is JSON: ${line.slice(0, 80)}`);
  }
  await server.close();
});

test('a notification (no id) NEVER gets a response, whatever the method', async () => {
  const { makeServer } = await import('../mcp/server.mjs');
  const server = makeServer({ env: {} });
  for (const method of ['initialize', 'ping', 'tools/list']) {
    const response = await server.handleMessage({ jsonrpc: '2.0', method });
    assert.equal(response, null, `${method} as a notification produced a response`);
  }
  // tools/call as a notification still RUNS (side effects) but stays silent.
  const outDir = makeTmpDir('icon-ai-notif-');
  fs.rmSync(outDir, { recursive: true, force: true });
  const call = await server.handleMessage({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'check_setup', arguments: {} },
  });
  assert.equal(call, null, 'tools/call notification returned a response');
  const unknown = await server.handleMessage({ jsonrpc: '2.0', method: 'no/such' });
  assert.equal(unknown, null);
});

test('the server starts when the plugin folder is reached through a symbolic link or junction', async () => {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const holder = makeTmpDir('icon-ai-link-');
  const link = path.join(holder, 'plugin');
  try {
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    fs.rmSync(holder, { recursive: true, force: true });
    return; // links cannot be made here: nothing to prove
  }
  const child = spawn(process.execPath, [path.join(link, 'mcp', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Registered at once: a server that exits silently (the very defect this test guards) must FAIL the test, not hang it.
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.on('error', () => {});
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  const started = Date.now();
  while (!out.includes('\n') && child.exitCode === null && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 50));
  child.stdin.end();
  setTimeout(() => child.kill(), 3000).unref();
  await exited;
  fs.rmSync(link, { force: true });
  fs.rmSync(holder, { recursive: true, force: true });
  assert.ok(out.includes('\n'), 'the server answered at all although it was started through a link');
  const reply = JSON.parse(out.split('\n')[0]);
  assert.equal(reply.result.serverInfo.name, 'icon-creator-ai');
});
