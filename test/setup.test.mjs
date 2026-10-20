import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { olderThan } from '../src/setup.mjs';
import { BIN, REPO, tempDir, writeTree } from './helpers.mjs';

const OURS = (scope = 'project') => ({
  type: 'command',
  command: `node "${join(REPO, 'bin', 'opsx-ui.mjs')}" statusline --scope ${scope}`,
  refreshInterval: 1,
  respectUserColors: true,
});

function setup({ openspec = true, commands = true } = {}) {
  const project = tempDir('setup-proj-');
  if (commands) writeTree(project, { '.qwen/commands/opsx-propose.md': '---\n---\n' });
  const bin = tempDir('setup-bin-');
  if (openspec) {
    writeFileSync(join(bin, 'openspec'), '#!/bin/sh\necho 1.13.0\n');
    chmodSync(join(bin, 'openspec'), 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tempDir('setup-user-'), OPSX_UI_HOME: tempDir('setup-home-') };
  const run = (...args) => spawnSync(process.execPath, [BIN, 'setup', ...args], { cwd: project, env, encoding: 'utf8' });
  const settingsFile = join(project, '.qwen', 'settings.json');
  const read = (file = settingsFile) => JSON.parse(readFileSync(file, 'utf8'));
  return { project, env, run, settingsFile, read };
}

test('first install adds ui.statusLine and keeps the other keys', () => {
  const t = setup();
  writeTree(t.project, { '.qwen/settings.json': { $version: 4, mcpServers: { slow: { command: 'node' } }, ui: { theme: 'dark' } } });
  const result = t.run();
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(t.read(), { $version: 4, mcpServers: { slow: { command: 'node' } }, ui: { theme: 'dark', statusLine: OURS() } });
  assert.match(result.stdout, /прописан/);
});

test('install creates the settings file when missing', () => {
  const t = setup();
  assert.equal(t.run().status, 0);
  assert.deepEqual(t.read(), { ui: { statusLine: OURS() } });
});

test('running setup again changes nothing', () => {
  const t = setup();
  t.run();
  const before = readFileSync(t.settingsFile, 'utf8');
  const mtime = statSync(t.settingsFile).mtimeMs;
  const again = t.run();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /уже настроен/);
  assert.equal(readFileSync(t.settingsFile, 'utf8'), before);
  assert.equal(statSync(t.settingsFile).mtimeMs, mtime);
});

test('a foreign command status line is left alone without --force', () => {
  const t = setup();
  const theirs = { type: 'command', command: 'my-statusline.sh' };
  writeTree(t.project, { '.qwen/settings.json': { ui: { statusLine: theirs } } });
  const result = t.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /my-statusline\.sh/);
  assert.match(result.stdout, /--force/);
  assert.deepEqual(t.read().ui.statusLine, theirs);
});

test('--force replaces it and keeps a backup that --remove restores', () => {
  const t = setup();
  const theirs = { type: 'command', command: 'my-statusline.sh', refreshInterval: 5 };
  writeTree(t.project, { '.qwen/settings.json': { ui: { statusLine: theirs } } });
  assert.equal(t.run('--force').status, 0);
  assert.deepEqual(t.read().ui.statusLine, OURS());
  assert.deepEqual(t.read(join(t.project, '.qwen', 'opsx-ui.json')).previousStatusLine, theirs);
  const removed = t.run('--remove');
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, /возвращён/);
  assert.deepEqual(t.read().ui.statusLine, theirs);
  assert.equal('previousStatusLine' in t.read(join(t.project, '.qwen', 'opsx-ui.json')), false);
});

test('--remove without a backup deletes the key', () => {
  const t = setup();
  t.run();
  assert.equal(t.run('--remove').status, 0);
  assert.deepEqual(t.read(), {});
});

test('--remove when our status line is not there changes nothing', () => {
  const t = setup();
  writeTree(t.project, { '.qwen/settings.json': { ui: { statusLine: { type: 'command', command: 'x' } } } });
  const result = t.run('--remove');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ничего не меняю/);
  assert.deepEqual(t.read().ui.statusLine, { type: 'command', command: 'x' });
});

test('a preset or disabled status line is replaced without --force and restorable', () => {
  for (const previous of [{ type: 'preset', items: ['model', 'git-branch'] }, null]) {
    const t = setup();
    writeTree(t.project, { '.qwen/settings.json': { ui: { statusLine: previous } } });
    assert.equal(t.run().status, 0);
    assert.deepEqual(t.read().ui.statusLine, OURS());
    t.run('--remove');
    assert.deepEqual(t.read().ui.statusLine, previous);
  }
});

test('--user writes the user settings with user scope', () => {
  const t = setup();
  assert.equal(t.run('--user').status, 0);
  const userFile = join(t.env.HOME, '.qwen', 'settings.json');
  assert.deepEqual(t.read(userFile).ui.statusLine, OURS('user'));
  assert.equal(existsSync(t.settingsFile), false);
  writeTree(t.env.HOME, { '.qwen/settings.json': { ui: { statusLine: { type: 'command', command: 'theirs' } } } });
  t.run('--user', '--force');
  assert.deepEqual(t.read(join(t.env.OPSX_UI_HOME, 'config.json')).previousStatusLine, { type: 'command', command: 'theirs' });
});

test('settings with comments are not rewritten; a snippet is printed instead', () => {
  const t = setup();
  const text = '{\n  // my settings\n  "ui": { "theme": "dark" }\n}\n';
  writeTree(t.project, { '.qwen/settings.json': text });
  const result = t.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /комментарии/);
  assert.match(result.stdout, /"statusLine"/);
  assert.equal(readFileSync(t.settingsFile, 'utf8'), text);
});

test('unparseable settings are not rewritten', () => {
  const t = setup();
  writeTree(t.project, { '.qwen/settings.json': '{ "ui": ' });
  assert.equal(t.run().status, 1);
  assert.equal(readFileSync(t.settingsFile, 'utf8'), '{ "ui": ');
});

test('environment problems produce warnings with fix commands, but nothing is run', () => {
  const t = setup({ openspec: false, commands: false });
  const result = t.run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /OpenSpec CLI не найден.*npm install -g @fission-ai\/openspec/);
  assert.match(result.stdout, /openspec init --tools qwen/);
  assert.deepEqual(readdirSync(join(t.project, '.qwen')), ['settings.json']);
});

test('no warnings when the environment is fine', () => {
  const t = setup();
  assert.doesNotMatch(t.run().stdout, /^! /m);
});

test('unknown arguments are rejected', () => {
  const t = setup();
  assert.equal(t.run('--usr').status, 2);
  assert.equal(existsSync(t.settingsFile), false);
});

test('version comparison', () => {
  assert.equal(olderThan('0.25.1', [0, 25, 2]), true);
  assert.equal(olderThan('0.25.2', [0, 25, 2]), false);
  assert.equal(olderThan('0.26.0', [0, 25, 2]), false);
  assert.equal(olderThan('1.0.0', [0, 25, 2]), false);
  assert.equal(olderThan('0.9.9', [0, 25, 2]), true);
});
