// @ts-check
// Per-session append-only event log: <home>/sessions/<session_id>.jsonl.
// Qwen runs tool calls (and so hooks) in parallel; one appendFileSync of a
// short line is atomic under O_APPEND, so writers need no locks. Rewrites
// (compaction) happen only at quiet points: SessionStart and Stop.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from '../config.mjs';

/** @typedef {{ type: string, at: number, [key: string]: unknown }} LogEvent */

export const MAX_LINE_BYTES = 4000;
export const COMPACT_AFTER_LINES = 500;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEBUG_LOG_MAX_BYTES = 1024 * 1024;

/** @param {NodeJS.ProcessEnv} [env] */
export function sessionsDir(env = process.env) {
  return join(homeDir(env), 'sessions');
}

/**
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function sessionLogPath(sessionId, env = process.env) {
  // Session ids come from Qwen payloads; never let them escape the directory.
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return join(sessionsDir(env), `${safe}.jsonl`);
}

/**
 * @param {string} sessionId
 * @param {Omit<LogEvent, 'at'> & { at?: number }} event
 * @param {NodeJS.ProcessEnv} [env]
 */
export function appendEvent(sessionId, event, env = process.env) {
  const line = JSON.stringify({ ...event, at: event.at ?? Date.now() }) + '\n';
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`event ${event.type} is too large to append atomically`);
  mkdirSync(sessionsDir(env), { recursive: true });
  appendFileSync(sessionLogPath(sessionId, env), line);
}

/**
 * Reads all events; missing files read as [] and broken lines are skipped.
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {LogEvent[]}
 */
export function readEvents(sessionId, env = process.env) {
  let text;
  try {
    text = readFileSync(sessionLogPath(sessionId, env), 'utf8');
  } catch {
    return [];
  }
  /** @type {LogEvent[]} */
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.type === 'string') events.push(event);
    } catch {
      // A torn or corrupted line must not hide the rest of the session.
    }
  }
  return events;
}

/**
 * Atomically replaces the log with the given events (temp file + rename).
 * @param {string} sessionId
 * @param {LogEvent[]} events
 * @param {NodeJS.ProcessEnv} [env]
 */
export function rewriteEvents(sessionId, events, env = process.env) {
  const target = sessionLogPath(sessionId, env);
  const temp = `${target}.${process.pid}.tmp`;
  mkdirSync(sessionsDir(env), { recursive: true });
  writeFileSync(temp, events.map((event) => JSON.stringify(event) + '\n').join(''));
  renameSync(temp, target);
}

/**
 * Removes session logs (and stray temp files) older than the TTL.
 * @param {{ env?: NodeJS.ProcessEnv, now?: number, ttlMs?: number }} [options]
 * @returns {string[]} removed file names
 */
export function removeStaleSessions({ env = process.env, now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  const dir = sessionsDir(env);
  /** @type {string[]} */
  const removed = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl') && !name.endsWith('.tmp')) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > ttlMs) {
        unlinkSync(file);
        removed.push(name);
      }
    } catch {
      // Another session may be cleaning up at the same time.
    }
  }
  return removed;
}

/**
 * Best-effort debug log; never throws.
 * @param {string} message
 * @param {NodeJS.ProcessEnv} [env]
 */
export function logDebug(message, env = process.env) {
  try {
    const file = join(homeDir(env), 'debug.log');
    mkdirSync(homeDir(env), { recursive: true });
    try {
      if (statSync(file).size > DEBUG_LOG_MAX_BYTES) writeFileSync(file, '');
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
