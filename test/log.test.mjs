import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendEvent, readEvents, rewriteEvents, removeStaleSessions, sessionLogPath, sessionsDir, logDebug, MAX_LINE_BYTES,
} from '../src/state/log.mjs';
import { REPO, tempDir } from './helpers.mjs';

const envFor = () => ({ OPSX_UI_HOME: tempDir() });

test('append and read round-trip, with timestamps', () => {
  const env = envFor();
  appendEvent('s1', { type: 'phase', phase: 'propose' }, env);
  appendEvent('s1', { type: 'change', change: 'add-auth', at: 42 }, env);
  const events = readEvents('s1', env);
  assert.equal(events.length, 2);
  assert.equal(events[0].phase, 'propose');
  assert.equal(typeof events[0].at, 'number');
  assert.equal(events[1].at, 42);
});

test('missing log reads as empty', () => {
  assert.deepEqual(readEvents('nope', envFor()), []);
});

test('corrupted lines are skipped without throwing', () => {
  const env = envFor();
  appendEvent('s1', { type: 'phase', phase: 'explore' }, env);
  appendFileSync(sessionLogPath('s1', env), '{"type":"cha\n\u0000garbage\n[1,2]\n');
  appendEvent('s1', { type: 'phase', phase: 'propose' }, env);
  assert.deepEqual(readEvents('s1', env).map((e) => e.phase), ['explore', 'propose']);
});

test('session ids cannot escape the sessions directory', () => {
  const env = envFor();
  const file = sessionLogPath('../../etc/passwd', env);
  assert.equal(join(file, '..'), sessionsDir(env));
  assert.equal(sessionLogPath('..', env).startsWith(sessionsDir(env)), true);
});

test('oversized events are refused instead of risking a torn line', () => {
  const env = envFor();
  assert.throws(() => appendEvent('s1', { type: 'x', blob: 'a'.repeat(MAX_LINE_BYTES) }, env), /too large/);
});

test('20 concurrent writers produce 20 intact lines', async () => {
  const env = envFor();
  const script = `
    import { appendEvent } from ${JSON.stringify(join(REPO, 'src/state/log.mjs'))};
    for (let i = 0; i < 5; i++) appendEvent('shared', { type: 'mcp.start', tool_use_id: process.argv[1] + '-' + i, pad: 'x'.repeat(300) });
  `;
  await Promise.all(Array.from({ length: 20 }, (_, n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(n)], { env: { ...process.env, ...env } });
    child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`writer exited ${code}`))));
  })));
  const lines = readFileSync(sessionLogPath('shared', env), 'utf8').trim().split('\n');
  assert.equal(lines.length, 100);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(new Set(readEvents('shared', env).map((e) => e.tool_use_id)).size, 100);
});

test('rewrite replaces the log atomically and leaves no temp files', () => {
  const env = envFor();
  for (let i = 0; i < 10; i++) appendEvent('s1', { type: 'mcp.start', n: i }, env);
  rewriteEvents('s1', [{ type: 'snapshot', at: 1, state: { phase: 'apply' } }], env);
  assert.deepEqual(readEvents('s1', env), [{ type: 'snapshot', at: 1, state: { phase: 'apply' } }]);
  assert.deepEqual(readdirSync(sessionsDir(env)), ['s1.jsonl']);
});

test('stale sessions older than 7 days are removed, fresh ones kept', () => {
  const env = envFor();
  appendEvent('old', { type: 'phase', phase: 'explore' }, env);
  appendEvent('fresh', { type: 'phase', phase: 'explore' }, env);
  const eightDaysAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  utimesSync(sessionLogPath('old', env), eightDaysAgo, eightDaysAgo);
  assert.deepEqual(removeStaleSessions({ env }), ['old.jsonl']);
  assert.equal(existsSync(sessionLogPath('fresh', env)), true);
  assert.equal(existsSync(sessionLogPath('old', env)), false);
});

test('stale cleanup tolerates a missing directory', () => {
  assert.deepEqual(removeStaleSessions({ env: envFor() }), []);
});

test('debug log never throws and is bounded', () => {
  const env = envFor();
  mkdirSync(env.OPSX_UI_HOME, { recursive: true });
  writeFileSync(join(env.OPSX_UI_HOME, 'debug.log'), 'x'.repeat(1024 * 1024 + 1));
  logDebug('hello', env);
  const text = readFileSync(join(env.OPSX_UI_HOME, 'debug.log'), 'utf8');
  assert.match(text, /hello\n$/);
  assert.ok(text.length < 200);
  assert.doesNotThrow(() => logDebug('x', { OPSX_UI_HOME: '/dev/null/cannot' }));
});
