import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appendEvent } from '../src/state/log.mjs';
import { BIN, tempDir, writeTree } from './helpers.mjs';

const STATUS = {
  changeName: 'add-auth',
  artifacts: [
    { id: 'proposal', outputPath: 'proposal.md', status: 'done' },
    { id: 'specs', outputPath: 'specs/**/*.md', status: 'ready' },
    { id: 'design', outputPath: 'design.md', status: 'ready' },
    { id: 'tasks', outputPath: 'tasks.md', status: 'blocked' },
  ],
};

function setup({ openspec = 'ok' } = {}) {
  const project = writeTree(tempDir('sl-proj-'), {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/add-auth/proposal.md': '## Why\n',
    'openspec/changes/add-auth/tasks.md': '- [x] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n',
  });
  const bin = tempDir('sl-bin-');
  const calls = join(bin, 'calls');
  if (openspec !== 'missing') {
    writeFileSync(join(bin, 'openspec'), `#!/bin/sh\necho "$@" >> "${calls}"\nprintf '%s' '${JSON.stringify(STATUS)}'\n`);
    chmodSync(join(bin, 'openspec'), 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, OPSX_UI_HOME: tempDir('sl-home-'), HOME: tempDir('sl-user-'), NO_COLOR: '1' };
  const payload = {
    session_id: 'sl-session',
    version: '0.25.2',
    model: { display_name: 'qwen3-coder-plus' },
    context_window: { context_window_size: 200000, used_percentage: 12.3, remaining_percentage: 87.7 },
    workspace: { current_dir: project },
    git: { branch: 'main' },
  };
  /** @param {string[]} [args] @param {string} [input] */
  const run = (args = [], input = JSON.stringify(payload)) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [BIN, 'statusline', ...args], { input, env, encoding: 'utf8', cwd: project });
    return { ...result, ms: Date.now() - started, rows: result.stdout.replace(/\n$/, '').split('\n') };
  };
  const flow = (/** @type {Record<string, unknown>[]} */ ...events) => {
    for (const event of events) appendEvent('sl-session', /** @type {any} */ (event), env);
  };
  return { project, env, payload, run, flow, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0) };
}

test('outside a flow: one compact default row', () => {
  const t = setup();
  const result = t.run();
  assert.equal(result.status, 0);
  assert.deepEqual(result.rows, [`${basename(t.project)} · ⎇ main · qwen3-coder-plus · ctx 12%`]);
});

test('outside a flow: the saved previous command gets the same stdin', () => {
  const t = setup();
  writeTree(t.project, { '.qwen/opsx-ui.json': { previousStatusLine: { type: 'command', command: "grep -o 'sl-session' | sed 's/^/prev:/'" } } });
  assert.deepEqual(t.run().rows, ['prev:sl-session']);
});

test('user scope reads the user backup', () => {
  const t = setup();
  writeTree(t.env.OPSX_UI_HOME, { 'config.json': { previousStatusLine: { type: 'command', command: 'echo user-prev' } } });
  assert.deepEqual(t.run(['--scope', 'user']).rows, ['user-prev']);
  assert.notDeepEqual(t.run(['--scope', 'project']).rows, ['user-prev']);
});

test('a slow previous command is cut off and does not break the footer', () => {
  const t = setup();
  writeTree(t.project, { '.qwen/opsx-ui.json': { previousStatusLine: { type: 'command', command: 'sleep 5' } } });
  const result = t.run();
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.ms < 4000, `took ${result.ms} ms`);
});

test('during propose: two rows with step, change and artifacts', () => {
  const t = setup();
  t.flow({ type: 'phase', phase: 'propose' }, { type: 'change', change: 'add-auth', root: t.project }, { type: 'artifact.current', artifact: 'design' });
  const result = t.run();
  assert.equal(result.status, 0);
  assert.deepEqual(result.rows, [
    'opsx  explore › ● propose › apply › archive   add-auth',
    'proposal ✓  specs ○  design ◐  tasks ·   пишется design',
  ]);
});

test('apply shows task progress from tasks.md', () => {
  const t = setup();
  t.flow({ type: 'phase', phase: 'apply' }, { type: 'change', change: 'add-auth', root: t.project });
  assert.equal(t.run().rows[1], 'задачи 1/3');
});

test('without the OpenSpec CLI the flow still renders, marked unavailable', () => {
  const t = setup({ openspec: 'missing' });
  t.flow({ type: 'phase', phase: 'propose' }, { type: 'change', change: 'add-auth', root: t.project });
  const result = t.run();
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.rows, ['opsx  explore › ● propose › apply › archive   add-auth', 'статус недоступен']);
});

test('a second tick without changes does not run openspec; a file change does', () => {
  const t = setup();
  t.flow({ type: 'phase', phase: 'propose' }, { type: 'change', change: 'add-auth', root: t.project });
  t.run();
  t.run();
  assert.equal(t.calls(), 1);
  writeFileSync(join(t.project, 'openspec/changes/add-auth/design.md'), '## Context\n');
  t.run();
  assert.equal(t.calls(), 2);
});

test('a warm tick finishes well under a second', () => {
  const t = setup();
  t.flow({ type: 'phase', phase: 'propose' }, { type: 'change', change: 'add-auth', root: t.project });
  t.run();
  const warm = t.run();
  assert.ok(warm.ms < 1000, `took ${warm.ms} ms`);
});

test('garbage on stdin: no error output, exit 0', () => {
  const t = setup();
  const result = t.run([], '{garbage');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.ok(result.rows.length <= 2);
});

test('colour unless NO_COLOR is set', () => {
  const t = setup();
  t.flow({ type: 'phase', phase: 'propose' }, { type: 'change', change: 'add-auth', root: t.project });
  delete t.env.NO_COLOR;
  assert.match(t.run().stdout, /\x1b\[/);
});
