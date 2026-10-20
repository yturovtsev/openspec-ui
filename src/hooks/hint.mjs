// @ts-check
// One-time hint about installing the status line. Qwen 0.25 ignores
// systemMessage from SessionStart hooks, so SessionStart queues the hint and
// the first Stop prints it; it counts as shown only once printed.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir, readJsonObject } from '../config.mjs';
import { findOpenspecRoot } from '../openspec/status.mjs';
import { EXTENSION_BIN, statusLineConfigured } from '../qwen/settings.mjs';

const HINT_PREFIX = 'setup-hint:';

/** @param {NodeJS.ProcessEnv} env */
function statePath(env) {
  return join(homeDir(env), 'state.json');
}

/** @param {string} path */
function shellQuote(path) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hint notice to queue at session start, or null when not needed.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ id: string, text: string } | null}
 */
export function setupHintNotice(cwd, env) {
  const project = findOpenspecRoot(cwd);
  if (!project) return null;
  if (readJsonObject(statePath(env)).hints?.[project]) return null;
  if (statusLineConfigured(cwd, env) || (project !== cwd && statusLineConfigured(project, env))) return null;
  return {
    id: `${HINT_PREFIX}${project}`,
    text: `opsx-ui: чтобы видеть шаг OpenSpec-флоу в футере, выполните: node ${shellQuote(EXTENSION_BIN)} setup`,
  };
}

/**
 * Records that the hint for these notice ids has been printed.
 * @param {string[]} ids
 * @param {NodeJS.ProcessEnv} env
 */
export function markHintsShown(ids, env) {
  const projects = ids.filter((id) => id.startsWith(HINT_PREFIX)).map((id) => id.slice(HINT_PREFIX.length));
  if (!projects.length) return;
  const state = readJsonObject(statePath(env));
  const hints = { ...(state.hints ?? {}) };
  for (const project of projects) hints[project] = Date.now();
  mkdirSync(homeDir(env), { recursive: true });
  const temp = `${statePath(env)}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...state, hints }, null, 2));
  renameSync(temp, statePath(env));
}
