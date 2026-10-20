// @ts-check
// `opsx-ui setup [--user] [--force] [--remove]`: installs this extension's
// status line into Qwen settings (extensions cannot set `ui.statusLine`
// themselves). Keeps whatever else is in the file, never overwrites another
// command status line without --force, and remembers what it replaced so
// --remove can put it back.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectConfigPath, readJsonObject, userConfigPath } from './config.mjs';
import { EXTENSION_BIN, isOurStatusLine, projectSettingsPath, readSettings, userSettingsPath } from './qwen/settings.mjs';

const MIN_QWEN_VERSION = [0, 25, 2];

/**
 * @param {string} version  e.g. "0.25.2"
 * @param {number[]} min
 */
export function olderThan(version, min) {
  const parts = (version.match(/\d+/g) ?? []).map(Number);
  for (let k = 0; k < min.length; k++) {
    const v = parts[k] ?? 0;
    if (v !== min[k]) return v < min[k];
  }
  return false;
}

/** @param {'project' | 'user'} scope */
export function desiredStatusLine(scope) {
  return {
    type: 'command',
    command: `node "${EXTENSION_BIN}" statusline --scope ${scope}`,
    refreshInterval: 1,
    respectUserColors: true,
  };
}

/** @param {string} file @param {unknown} value */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, file);
}

/** @param {unknown} a @param {unknown} b */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @typedef {object} SetupOptions
 * @property {'project' | 'user'} scope
 * @property {boolean} force
 * @property {boolean} remove
 * @property {string} workspace
 * @property {NodeJS.ProcessEnv} env
 */

/**
 * Applies the change to settings. Returns messages and an exit code.
 * @param {SetupOptions} options
 * @returns {{ code: number, messages: string[], changed: boolean }}
 */
export function applySetup({ scope, force, remove, workspace, env }) {
  const settingsFile = scope === 'user' ? userSettingsPath(env) : projectSettingsPath(workspace);
  const backupFile = scope === 'user' ? userConfigPath(env) : projectConfigPath(workspace);
  const desired = desiredStatusLine(scope);
  const snippet = JSON.stringify({ ui: { statusLine: desired } }, null, 2);
  const settings = readSettings(settingsFile);

  if (settings.value === null) {
    return { code: 1, changed: false, messages: [`Не удалось разобрать ${settingsFile}. Файл не изменён. Добавьте вручную:`, snippet] };
  }
  if (settings.hadComments) {
    const manual = remove ? 'Удалите ключ ui.statusLine вручную.' : 'Добавьте вручную:';
    return { code: 1, changed: false, messages: [`${settingsFile} содержит комментарии — файл не изменён, чтобы их не потерять. ${manual}`, ...(remove ? [] : [snippet])] };
  }

  const value = /** @type {Record<string, any>} */ (settings.value);
  const current = value.ui?.statusLine;
  const backup = readJsonObject(backupFile);

  if (remove) {
    if (!isOurStatusLine(current)) {
      return { code: 0, changed: false, messages: [`В ${settingsFile} нет status line расширения — ничего не меняю.`] };
    }
    const ui = { ...value.ui };
    if ('previousStatusLine' in backup) ui.statusLine = backup.previousStatusLine;
    else delete ui.statusLine;
    const next = { ...value, ui };
    if (!Object.keys(ui).length) delete next.ui;
    writeJsonAtomic(settingsFile, next);
    const { previousStatusLine: _restored, ...rest } = backup;
    if (existsSync(backupFile)) writeJsonAtomic(backupFile, rest);
    const restored = 'previousStatusLine' in backup ? 'возвращён прежний status line' : 'ключ ui.statusLine удалён';
    return { code: 0, changed: true, messages: [`${settingsFile}: ${restored}.`] };
  }

  if (isOurStatusLine(current) && sameJson(current, desired)) {
    return { code: 0, changed: false, messages: [`Status line расширения уже настроен в ${settingsFile} — ничего не меняю.`] };
  }
  if (!isOurStatusLine(current) && current && typeof current === 'object' && current.type === 'command' && !force) {
    return {
      code: 1,
      changed: false,
      messages: [
        `В ${settingsFile} уже задан status line командой: ${current.command}`,
        'Файл не изменён. Чтобы заменить его (прежняя команда будет показываться вне OpenSpec-флоу и вернётся по --remove), запустите setup с --force.',
      ],
    };
  }

  // Remember what we replace, unless it is an older copy of our own line;
  // with nothing to replace, a stale backup must not be restored later.
  if (current !== undefined && !isOurStatusLine(current)) {
    writeJsonAtomic(backupFile, { ...backup, previousStatusLine: current });
  } else if (current === undefined && 'previousStatusLine' in backup) {
    const { previousStatusLine: _stale, ...rest } = backup;
    writeJsonAtomic(backupFile, rest);
  }
  writeJsonAtomic(settingsFile, { ...value, ui: { ...(value.ui ?? {}), statusLine: desired } });
  const replaced = current === undefined || isOurStatusLine(current) ? '' : ' Прежнее значение сохранено, вернуть его: setup --remove.';
  return { code: 0, changed: true, messages: [`Status line расширения прописан в ${settingsFile}.${replaced}`] };
}

/**
 * Warnings about the environment, each with a command that fixes it.
 * The checks never run the fixes.
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function environmentWarnings(workspace, env) {
  const warnings = [];
  try {
    execFileSync('openspec', ['--version'], { env, stdio: 'ignore', timeout: 5000 });
  } catch {
    warnings.push('OpenSpec CLI не найден в PATH. Установите: npm install -g @fission-ai/openspec');
  }
  const commandsDir = join(workspace, '.qwen', 'commands');
  let hasCommands = false;
  try {
    hasCommands = readdirSync(commandsDir).some((name) => /^opsx-.+\.md$/.test(name));
  } catch {}
  if (!hasCommands) warnings.push(`В ${commandsDir} нет команд opsx-*.md для Qwen. Создайте их: openspec init --tools qwen (или openspec update, если OpenSpec уже инициализирован)`);
  try {
    const version = execFileSync('qwen', ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
    if (olderThan(version, MIN_QWEN_VERSION)) warnings.push(`Qwen Code ${version} старше ${MIN_QWEN_VERSION.join('.')}; хуки расширения могут не работать. Обновите: npm install -g @qwen-code/qwen-code`);
  } catch {
    // qwen is often installed per project; skip the version check silently.
  }
  return warnings;
}

/**
 * CLI entry.
 * @param {string[]} args
 */
export async function runSetup(args) {
  const known = new Set(['--user', '--force', '--remove']);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length) {
    process.stderr.write(`opsx-ui setup: неизвестные аргументы: ${unknown.join(' ')}\nИспользование: opsx-ui setup [--user] [--force] [--remove]\n`);
    return 2;
  }
  const options = {
    scope: /** @type {'project' | 'user'} */ (args.includes('--user') ? 'user' : 'project'),
    force: args.includes('--force'),
    remove: args.includes('--remove'),
    workspace: process.cwd(),
    env: process.env,
  };
  const result = applySetup(options);
  for (const message of result.messages) process.stdout.write(`${message}\n`);
  if (!options.remove) {
    for (const warning of environmentWarnings(options.workspace, options.env)) process.stdout.write(`! ${warning}\n`);
    if (result.changed) process.stdout.write('Перезапустите Qwen Code, если status line не появился в текущей сессии.\n');
  }
  return result.code;
}
