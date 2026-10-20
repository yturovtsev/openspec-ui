// @ts-check
// Extension settings. Environment variables win over files:
//   OPSX_UI_HOME      state/cache directory (default ~/.qwen/opsx-ui)
//   OPSX_UI_APPROVAL  approval gate mode: all | create | off   (file key: approval)
//   OPSX_UI_WIDTH     status line width in columns             (file key: width)
// Project file: <workspace>/.qwen/opsx-ui.json; user file: <home>/config.json.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @typedef {'all' | 'create' | 'off'} ApprovalMode */

export const APPROVAL_MODES = /** @type {const} */ (['all', 'create', 'off']);
export const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 40;

/** @param {NodeJS.ProcessEnv} [env] */
export function homeDir(env = process.env) {
  return env.OPSX_UI_HOME || join(homedir(), '.qwen', 'opsx-ui');
}

/** @param {string} workspace */
export function projectConfigPath(workspace) {
  return join(workspace, '.qwen', 'opsx-ui.json');
}

/** @param {NodeJS.ProcessEnv} [env] */
export function userConfigPath(env = process.env) {
  return join(homeDir(env), 'config.json');
}

/**
 * Reads a JSON object; a missing or malformed file reads as {}.
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function readJsonObject(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ workspace?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {ApprovalMode}
 */
export function approvalMode({ workspace, env = process.env } = {}) {
  const raw = env.OPSX_UI_APPROVAL ?? (workspace ? readJsonObject(projectConfigPath(workspace)).approval : undefined);
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  // Unknown or missing values fall back to the strictest mode.
  return /** @type {ApprovalMode} */ (APPROVAL_MODES.includes(/** @type {any} */ (value)) ? value : 'all');
}

/**
 * @param {{ workspace?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 */
export function statusWidth({ workspace, env = process.env } = {}) {
  const raw = env.OPSX_UI_WIDTH ?? (workspace ? readJsonObject(projectConfigPath(workspace)).width : undefined);
  const value = Number(raw);
  return Number.isInteger(value) && value >= MIN_WIDTH ? value : DEFAULT_WIDTH;
}
