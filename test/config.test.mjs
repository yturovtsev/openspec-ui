import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { approvalMode, homeDir, statusWidth, userConfigPath, DEFAULT_WIDTH } from '../src/config.mjs';
import { tempDir, writeTree } from './helpers.mjs';

test('home directory defaults to ~/.qwen/opsx-ui and honours OPSX_UI_HOME', () => {
  assert.equal(homeDir({}), join(homedir(), '.qwen', 'opsx-ui'));
  assert.equal(homeDir({ OPSX_UI_HOME: '/x/y' }), '/x/y');
  assert.equal(userConfigPath({ OPSX_UI_HOME: '/x/y' }), '/x/y/config.json');
});

test('approval mode defaults to all', () => {
  const workspace = tempDir();
  assert.equal(approvalMode({ workspace, env: {} }), 'all');
  assert.equal(approvalMode({ env: {} }), 'all');
});

test('approval mode reads the project file', () => {
  const workspace = writeTree(tempDir(), { '.qwen/opsx-ui.json': { approval: 'create' } });
  assert.equal(approvalMode({ workspace, env: {} }), 'create');
});

test('environment wins over the project file', () => {
  const workspace = writeTree(tempDir(), { '.qwen/opsx-ui.json': { approval: 'create' } });
  assert.equal(approvalMode({ workspace, env: { OPSX_UI_APPROVAL: 'off' } }), 'off');
  assert.equal(approvalMode({ workspace, env: { OPSX_UI_APPROVAL: ' OFF ' } }), 'off');
});

test('unknown approval values are treated as all', () => {
  const workspace = writeTree(tempDir(), { '.qwen/opsx-ui.json': { approval: 'sometimes' } });
  assert.equal(approvalMode({ workspace, env: {} }), 'all');
  assert.equal(approvalMode({ workspace, env: { OPSX_UI_APPROVAL: 'never' } }), 'all');
});

test('malformed project file is ignored', () => {
  const workspace = writeTree(tempDir(), { '.qwen/opsx-ui.json': '{not json' });
  assert.equal(approvalMode({ workspace, env: {} }), 'all');
  assert.equal(statusWidth({ workspace, env: {} }), DEFAULT_WIDTH);
});

test('status width: default, file, env, and invalid values', () => {
  const workspace = writeTree(tempDir(), { '.qwen/opsx-ui.json': { width: 80 } });
  assert.equal(statusWidth({ env: {} }), 100);
  assert.equal(statusWidth({ workspace, env: {} }), 80);
  assert.equal(statusWidth({ workspace, env: { OPSX_UI_WIDTH: '120' } }), 120);
  assert.equal(statusWidth({ workspace, env: { OPSX_UI_WIDTH: 'wide' } }), 100);
  assert.equal(statusWidth({ workspace, env: { OPSX_UI_WIDTH: '10' } }), 100);
});
