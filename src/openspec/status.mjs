// @ts-check
// Where a path sits in an OpenSpec tree, and the cached answer of
// `openspec status --change <name> --json`. The CLI takes ~300 ms, so the
// status line reruns it only when the change directory's fingerprint moves;
// after a failure it waits RETRY_AFTER_MS before trying again. The gate hook
// only ever reads the cache.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homeDir, readJsonObject } from '../config.mjs';

export const STATUS_TIMEOUT_MS = 800;
export const RETRY_AFTER_MS = 5000;

/** Artifact outputs of the default `spec-driven` schema, used when status is unknown. */
export const SPEC_DRIVEN_OUTPUTS = { proposal: 'proposal.md', specs: 'specs/**/*.md', design: 'design.md', tasks: 'tasks.md' };

/**
 * @typedef {{ id: string, outputPath?: string, status: string, requires?: string[] }} ArtifactInfo
 * @typedef {{ changeName?: string, schemaName?: string, artifacts?: ArtifactInfo[], artifactPaths?: Record<string, { outputPath?: string }>, isComplete?: boolean }} ChangeStatus
 * @typedef {{ change: string, fingerprint: string, at: number, status?: ChangeStatus, error?: string }} CacheEntry
 */

/**
 * Splits a path inside `<root>/openspec/changes/<change>/<rel>`. Archived
 * changes and the change directory itself are not change paths.
 * @param {string} path absolute path
 * @returns {{ root: string, change: string, rel: string } | null}
 */
export function locateChangePath(path) {
  const parts = resolve(path).split(sep);
  for (let k = parts.length - 3; k >= 0; k--) {
    if (parts[k] === 'openspec' && parts[k + 1] === 'changes') {
      const change = parts[k + 2];
      if (!change || change === 'archive' || change.startsWith('.')) return null;
      return { root: parts.slice(0, k).join(sep) || sep, change, rel: parts.slice(k + 3).join('/') };
    }
  }
  return null;
}

/**
 * Nearest directory at or above `start` that holds an OpenSpec tree.
 * @param {string} start
 * @returns {string | null}
 */
export function findOpenspecRoot(start) {
  let dir = resolve(start);
  for (;;) {
    const os = join(dir, 'openspec');
    if (existsSync(join(os, 'changes')) || existsSync(join(os, 'specs')) || existsSync(join(os, 'config.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {string} glob  OpenSpec output pattern such as `specs/**\/*.md`
 */
function globToRegExp(glob) {
  let out = '';
  for (let k = 0; k < glob.length; k++) {
    const c = glob[k];
    if (c === '*' && glob[k + 1] === '*') {
      // `**/` matches zero or more directories.
      if (glob[k + 2] === '/') {
        out += '(?:.*/)?';
        k += 2;
      } else {
        out += '.*';
        k += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Artifact id for a path relative to the change directory, or null.
 * Hidden files (e.g. `.openspec.yaml`) are never artifacts. A directory that
 * contains an artifact's outputs (e.g. `specs`) maps to that artifact.
 * @param {string} rel
 * @param {ChangeStatus | null | undefined} status
 * @returns {string | null}
 */
export function artifactForPath(rel, status) {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean.split('/').some((segment) => segment.startsWith('.'))) return null;
  for (const [id, glob] of Object.entries(artifactOutputs(status))) {
    if (globToRegExp(glob).test(clean) || glob.startsWith(`${clean}/`)) return id;
  }
  return null;
}

/**
 * @param {ChangeStatus | null | undefined} status
 * @returns {Record<string, string>}
 */
export function artifactOutputs(status) {
  /** @type {Record<string, string>} */
  const outputs = {};
  for (const artifact of status?.artifacts ?? []) {
    const path = status?.artifactPaths?.[artifact.id]?.outputPath ?? artifact.outputPath;
    if (artifact.id && path) outputs[artifact.id] = path;
  }
  return Object.keys(outputs).length ? outputs : { ...SPEC_DRIVEN_OUTPUTS };
}

/**
 * Cheap change-detection key: file count, newest mtime and total size of
 * the change tree (directories included, so deletions are noticed).
 * @param {string} changeRoot
 */
export function changeFingerprint(changeRoot) {
  let count = 0;
  let newest = 0;
  let bytes = 0;
  const walk = (/** @type {string} */ dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
      const stat = statSync(dir);
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          const stat = statSync(full);
          count++;
          bytes += stat.size;
          newest = Math.max(newest, stat.mtimeMs);
        } catch {}
      }
    }
  };
  if (!existsSync(changeRoot)) return 'missing';
  walk(changeRoot);
  return `${count}:${bytes}:${newest}`;
}

/**
 * @param {string} changeRoot
 * @param {NodeJS.ProcessEnv} [env]
 */
export function statusCachePath(changeRoot, env = process.env) {
  const digest = createHash('sha1').update(resolve(changeRoot)).digest('hex');
  return join(homeDir(env), 'cache', `${digest}.json`);
}

/**
 * @param {string} root
 * @param {string} change
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {CacheEntry | null}
 */
export function readStatusCache(root, change, env = process.env) {
  const entry = readJsonObject(statusCachePath(changeRootOf(root, change), env));
  return entry.change === change ? /** @type {CacheEntry} */ (entry) : null;
}

/**
 * @param {string} root
 * @param {string} change
 */
export function changeRootOf(root, change) {
  return join(root, 'openspec', 'changes', change);
}

/**
 * @param {string} root
 * @param {string} change
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 * @returns {ChangeStatus}
 */
function runStatus(root, change, env, timeoutMs) {
  const stdout = execFileSync('openspec', ['status', '--change', change, '--json'], {
    cwd: root,
    env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const status = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (!status || !Array.isArray(status.artifacts)) throw new Error('unexpected openspec status output');
  return status;
}

/**
 * Status of a change, from cache when the change tree has not moved.
 * @param {{ root: string, change: string, env?: NodeJS.ProcessEnv, now?: number, timeoutMs?: number }} options
 * @returns {{ status: ChangeStatus | null, error: string | null, fromCache: boolean }}
 */
export function getChangeStatus({ root, change, env = process.env, now = Date.now(), timeoutMs = STATUS_TIMEOUT_MS }) {
  const changeRoot = changeRootOf(root, change);
  const fingerprint = changeFingerprint(changeRoot);
  const cached = readStatusCache(root, change, env);
  if (cached?.status && cached.fingerprint === fingerprint) return { status: cached.status, error: null, fromCache: true };
  if (cached?.error && now - cached.at < RETRY_AFTER_MS) return { status: null, error: cached.error, fromCache: true };

  /** @type {CacheEntry} */
  let entry;
  try {
    entry = { change, fingerprint, at: now, status: runStatus(root, change, env, timeoutMs) };
  } catch (error) {
    entry = { change, fingerprint, at: now, error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
  try {
    const file = statusCachePath(changeRoot, env);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entry));
    renameSync(temp, file);
  } catch {}
  return { status: entry.status ?? null, error: entry.error ?? null, fromCache: false };
}

/**
 * Checkbox progress of the change's task list.
 * @param {string} root
 * @param {string} change
 * @param {ChangeStatus | null | undefined} status
 * @returns {{ done: number, total: number } | null}
 */
export function tasksProgress(root, change, status) {
  const rel = status?.artifactPaths?.tasks?.outputPath ?? 'tasks.md';
  let text;
  try {
    text = readFileSync(join(changeRootOf(root, change), rel), 'utf8');
  } catch {
    return null;
  }
  let done = 0;
  let total = 0;
  for (const match of text.matchAll(/^\s*[-*] \[([ xX])\]/gm)) {
    total++;
    if (match[1] !== ' ') done++;
  }
  return { done, total };
}

/**
 * Display name of an artifact path, e.g. `design.md` or `specs/auth/spec.md`.
 * @param {string} root
 * @param {string} path
 */
export function displayPath(root, path) {
  const located = locateChangePath(path);
  return located ? located.rel : relative(root, path);
}
