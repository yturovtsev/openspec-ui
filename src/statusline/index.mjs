// @ts-check
// `opsx-ui statusline [--scope project|user]`: Qwen runs this every second
// with its status payload on stdin. Two rows during an OpenSpec flow; the
// user's previous status line (or a compact default) otherwise. Errors are
// never printed — Qwen would show them in the footer.

import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { projectConfigPath, readJsonObject, statusWidth, userConfigPath } from '../config.mjs';
import { findOpenspecRoot, getChangeStatus, tasksProgress } from '../openspec/status.mjs';
import { logDebug, readEvents } from '../state/log.mjs';
import { initialState, reduce } from '../state/reducer.mjs';
import { isOurStatusLine } from '../qwen/settings.mjs';
import { renderFlow, renderIdle } from './render.mjs';

export const FALLBACK_TIMEOUT_MS = 2000;
const MAX_ROWS = 2;

/**
 * @param {string[]} args
 */
function parseScope(args) {
  const index = args.indexOf('--scope');
  return args[index + 1] === 'user' ? 'user' : 'project';
}

/**
 * The status line that was configured before `setup --force`, if any.
 * @param {'project' | 'user'} scope
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function previousCommand(scope, workspace, env) {
  const config = readJsonObject(scope === 'user' ? userConfigPath(env) : projectConfigPath(workspace));
  const previous = config.previousStatusLine;
  if (!previous || previous.type !== 'command' || typeof previous.command !== 'string' || isOurStatusLine(previous)) return null;
  return previous.command;
}

/**
 * @param {string} command
 * @param {string} input
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string[]>}
 */
function runPrevious(command, input, cwd, env) {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], { cwd, env, timeout: FALLBACK_TIMEOUT_MS, maxBuffer: 10 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? [] : String(stdout).replace(/\r?\n$/, '').split(/\r?\n/).filter(Boolean).slice(0, MAX_ROWS));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/**
 * Rows for one tick.
 * @param {{ payload: any, raw: string, scope: 'project' | 'user', env?: NodeJS.ProcessEnv, now?: number }} options
 * @returns {Promise<string[]>}
 */
export async function statusRows({ payload, raw, scope, env = process.env, now = Date.now() }) {
  const workspace = String(payload?.workspace?.current_dir || process.cwd());
  const width = statusWidth({ workspace, env });
  const color = !env.NO_COLOR;
  let state = initialState();
  try {
    if (payload?.session_id) state = reduce(readEvents(String(payload.session_id), env));
  } catch {}

  if (!state.phase) {
    const previous = previousCommand(scope, workspace, env);
    if (previous) return runPrevious(previous, raw, workspace, env);
    return [renderIdle({
      project: basename(workspace),
      branch: payload?.git?.branch,
      model: payload?.model?.display_name,
      contextUsed: payload?.context_window?.used_percentage,
      width,
      color,
    })];
  }

  let status = null;
  let statusUnavailable = false;
  let tasks = null;
  const root = state.root ?? findOpenspecRoot(workspace);
  if (state.change && root) {
    const result = getChangeStatus({ root, change: state.change, env, now });
    status = result.status;
    statusUnavailable = !result.status;
    if (state.phase === 'apply') tasks = tasksProgress(root, state.change, status);
  } else if (state.change) {
    statusUnavailable = true;
  }
  return renderFlow({ state, status, statusUnavailable, tasks, now, width, color });
}

/** @returns {Promise<string>} */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * CLI entry. Always exits 0; prints nothing on internal errors.
 * @param {string[]} args
 */
export async function runStatusline(args) {
  try {
    const raw = await readStdin();
    let payload = {};
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {}
    const rows = await statusRows({ payload, raw, scope: parseScope(args) });
    if (rows.length) process.stdout.write(rows.slice(0, MAX_ROWS).join('\n') + '\n');
  } catch (error) {
    logDebug(`statusline: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
  return 0;
}
