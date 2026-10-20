import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  artifactForPath, artifactOutputs, changeFingerprint, findOpenspecRoot, getChangeStatus, locateChangePath,
  readStatusCache, tasksProgress, RETRY_AFTER_MS, STATUS_TIMEOUT_MS,
} from '../src/openspec/status.mjs';
import { tempDir, writeTree } from './helpers.mjs';

// Tests that are not about timing must not fail when the machine is busy.
const SLOW_OK = 10_000;

const STATUS = {
  changeName: 'add-auth',
  schemaName: 'spec-driven',
  artifacts: [
    { id: 'proposal', outputPath: 'proposal.md', status: 'done', requires: [] },
    { id: 'specs', outputPath: 'specs/**/*.md', status: 'ready', requires: ['proposal'] },
    { id: 'design', outputPath: 'design.md', status: 'ready', requires: ['proposal'] },
    { id: 'tasks', outputPath: 'tasks.md', status: 'blocked', requires: ['specs', 'design'] },
  ],
  artifactPaths: { proposal: { outputPath: 'proposal.md' }, specs: { outputPath: 'specs/**/*.md' }, design: { outputPath: 'design.md' }, tasks: { outputPath: 'tasks.md' } },
};

/** A fake `openspec` on PATH that counts calls and can fail or hang on demand. */
function fakeOpenspec({ mode = 'ok', payload = STATUS } = {}) {
  const bin = tempDir('fake-openspec-');
  const calls = join(bin, 'calls');
  const script = {
    ok: `printf '%s' '${JSON.stringify(payload)}'`,
    fail: 'echo "Error: change not found" >&2; exit 1',
    hang: 'sleep 3',
    garbage: 'echo "not json"',
  }[mode];
  writeFileSync(join(bin, 'openspec'), `#!/bin/sh\necho "$@" >> "${calls}"\n${script}\n`);
  chmodSync(join(bin, 'openspec'), 0o755);
  return {
    env: { PATH: `${bin}:/usr/bin:/bin`, OPSX_UI_HOME: tempDir() },
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0),
  };
}

function project() {
  return writeTree(tempDir('proj-'), {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/add-auth/.openspec.yaml': 'schema: spec-driven\n',
    'openspec/changes/add-auth/proposal.md': '## Why\n',
  });
}

test('locateChangePath splits change paths and ignores archive', () => {
  assert.deepEqual(locateChangePath('/p/openspec/changes/add-auth/specs/auth/spec.md'), { root: '/p', change: 'add-auth', rel: 'specs/auth/spec.md' });
  assert.deepEqual(locateChangePath('/p/openspec/changes/add-auth/design.md'), { root: '/p', change: 'add-auth', rel: 'design.md' });
  assert.equal(locateChangePath('/p/openspec/changes/archive/2026-01-01-old/design.md'), null);
  assert.equal(locateChangePath('/p/openspec/specs/auth/spec.md'), null);
  assert.equal(locateChangePath('/p/src/index.ts'), null);
  assert.deepEqual(locateChangePath('/p/openspec/changes/x'), { root: '/p', change: 'x', rel: '' });
});

test('findOpenspecRoot walks up to the nearest OpenSpec tree', () => {
  const root = project();
  assert.equal(findOpenspecRoot(join(root, 'openspec', 'changes', 'add-auth')), root);
  assert.equal(findOpenspecRoot(tempDir()), null);
});

test('artifactForPath uses schema outputs, globs and directory prefixes', () => {
  assert.equal(artifactForPath('proposal.md', STATUS), 'proposal');
  assert.equal(artifactForPath('specs/auth/login/spec.md', STATUS), 'specs');
  assert.equal(artifactForPath('specs/spec.md', STATUS), 'specs');
  assert.equal(artifactForPath('specs', STATUS), 'specs');
  assert.equal(artifactForPath('.openspec.yaml', STATUS), null);
  assert.equal(artifactForPath('specs/.DS_Store', STATUS), null);
  assert.equal(artifactForPath('notes.txt', STATUS), null);
  assert.equal(artifactForPath('', STATUS), null);
});

test('custom schema artifacts are recognised; spec-driven is the fallback', () => {
  const custom = { artifacts: [{ id: 'research', outputPath: 'research.md', status: 'ready' }] };
  assert.equal(artifactForPath('research.md', custom), 'research');
  assert.equal(artifactForPath('design.md', custom), null);
  assert.equal(artifactForPath('design.md', null), 'design');
  assert.equal(artifactForPath('specs/a/spec.md', undefined), 'specs');
  assert.deepEqual(Object.keys(artifactOutputs(null)), ['proposal', 'specs', 'design', 'tasks']);
});

test('fingerprint moves on edit, create and delete', () => {
  const root = project();
  const dir = join(root, 'openspec/changes/add-auth');
  const a = changeFingerprint(dir);
  writeFileSync(join(dir, 'design.md'), '## Context\n');
  const b = changeFingerprint(dir);
  assert.notEqual(a, b);
  rmSync(join(dir, 'design.md'));
  assert.notEqual(changeFingerprint(dir), b);
  assert.equal(changeFingerprint(join(root, 'nope')), 'missing');
});

test('status is fetched once and then served from cache while nothing changes', () => {
  const root = project();
  const fake = fakeOpenspec();
  const first = getChangeStatus({ root, change: 'add-auth', env: fake.env, timeoutMs: SLOW_OK });
  assert.equal(first.fromCache, false);
  assert.equal(first.status?.artifacts?.length, 4);
  const second = getChangeStatus({ root, change: 'add-auth', env: fake.env, timeoutMs: SLOW_OK });
  assert.equal(second.fromCache, true);
  assert.equal(fake.calls(), 1);
  assert.equal(readStatusCache(root, 'add-auth', fake.env)?.status?.schemaName, 'spec-driven');
});

test('editing the change refreshes the status', () => {
  const root = project();
  const fake = fakeOpenspec();
  getChangeStatus({ root, change: 'add-auth', env: fake.env, timeoutMs: SLOW_OK });
  writeFileSync(join(root, 'openspec/changes/add-auth/design.md'), 'x');
  const after = getChangeStatus({ root, change: 'add-auth', env: fake.env, timeoutMs: SLOW_OK });
  assert.equal(after.fromCache, false);
  assert.equal(fake.calls(), 2);
});

test('a failing CLI reports an error and backs off for 5 seconds', () => {
  const root = project();
  const fake = fakeOpenspec({ mode: 'fail' });
  const now = Date.now();
  const first = getChangeStatus({ root, change: 'add-auth', env: fake.env, now, timeoutMs: SLOW_OK });
  assert.equal(first.status, null);
  assert.match(String(first.error), /Command failed|exit/i);
  const soon = getChangeStatus({ root, change: 'add-auth', env: fake.env, now: now + 1000, timeoutMs: SLOW_OK });
  assert.equal(soon.fromCache, true);
  assert.equal(fake.calls(), 1);
  getChangeStatus({ root, change: 'add-auth', env: fake.env, now: now + RETRY_AFTER_MS + 1, timeoutMs: SLOW_OK });
  assert.equal(fake.calls(), 2);
});

test('a hanging CLI is cut off at the timeout (800 ms by default)', () => {
  assert.equal(STATUS_TIMEOUT_MS, 800);
  const root = project();
  const fake = fakeOpenspec({ mode: 'hang' });
  const started = Date.now();
  const result = getChangeStatus({ root, change: 'add-auth', env: fake.env, timeoutMs: 300 });
  assert.equal(result.status, null);
  assert.ok(result.error);
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms; the fake hangs for 3000 ms`);
});

test('missing CLI and garbage output are errors, not exceptions', () => {
  const root = project();
  const missing = getChangeStatus({ root, change: 'add-auth', env: { PATH: tempDir(), OPSX_UI_HOME: tempDir() }, timeoutMs: SLOW_OK });
  assert.equal(missing.status, null);
  assert.ok(missing.error);
  const garbage = getChangeStatus({ root, change: 'add-auth', env: fakeOpenspec({ mode: 'garbage' }).env, timeoutMs: SLOW_OK });
  assert.equal(garbage.status, null);
  assert.ok(garbage.error);
});

test('tasks progress counts checkboxes', () => {
  const root = writeTree(project(), {
    'openspec/changes/add-auth/tasks.md': '## 1\n\n- [x] 1.1 a\n- [ ] 1.2 b\n- [X] 1.3 c\n  - [ ] nested\n* [ ] star\nnot - [x] inline\n',
  });
  assert.deepEqual(tasksProgress(root, 'add-auth', STATUS), { done: 2, total: 5 });
  assert.equal(tasksProgress(root, 'other', STATUS), null);
});
