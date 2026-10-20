// @ts-check
// Reading Qwen Code settings files (project `.qwen/settings.json`, user
// `~/.qwen/settings.json`) and recognising this extension's status line.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Matches every status line command this extension writes, quoted or not. */
export const STATUSLINE_PATTERN = /opsx-ui\.mjs['"]?\s+statusline\b/;

/** Absolute path of the extension's CLI, wherever the extension lives. */
export const EXTENSION_BIN = fileURLToPath(new URL('../../bin/opsx-ui.mjs', import.meta.url));

/** @param {NodeJS.ProcessEnv} [env] */
export function qwenHome(env = process.env) {
  return join(env.HOME || homedir(), '.qwen');
}

/** @param {NodeJS.ProcessEnv} [env] */
export function userSettingsPath(env = process.env) {
  return join(qwenHome(env), 'settings.json');
}

/** @param {string} workspace */
export function projectSettingsPath(workspace) {
  return join(workspace, '.qwen', 'settings.json');
}

/**
 * Removes // and /* *\/ comments outside strings, and trailing commas.
 * @param {string} text
 * @returns {{ text: string, hadComments: boolean }}
 */
export function stripJsonComments(text) {
  let out = '';
  let hadComments = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      hadComments = true;
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      hadComments = true;
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return { text: out.replace(/,(\s*[}\]])/g, '$1'), hadComments };
}

/**
 * @param {string} file
 * @returns {{ exists: boolean, value: Record<string, any> | null, hadComments: boolean, raw: string }}
 */
export function readSettings(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { exists: false, value: {}, hadComments: false, raw: '' };
  }
  if (!raw.trim()) return { exists: true, value: {}, hadComments: false, raw };
  const { text, hadComments } = stripJsonComments(raw);
  try {
    const value = JSON.parse(text);
    return { exists: true, value: value && typeof value === 'object' && !Array.isArray(value) ? value : null, hadComments, raw };
  } catch {
    return { exists: true, value: null, hadComments, raw };
  }
}

/** @param {unknown} statusLine */
export function isOurStatusLine(statusLine) {
  const command = statusLine && typeof statusLine === 'object' ? /** @type {any} */ (statusLine).command : undefined;
  return typeof command === 'string' && STATUSLINE_PATTERN.test(command);
}

/**
 * Whether this extension's status line is configured for the workspace or the user.
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 */
export function statusLineConfigured(workspace, env = process.env) {
  return [projectSettingsPath(workspace), userSettingsPath(env)].some((file) => isOurStatusLine(readSettings(file).value?.ui?.statusLine));
}
