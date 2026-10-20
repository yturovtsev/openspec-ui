// @ts-check
// Approval gate: decides whether a tool call that writes a planning artifact
// must go through Qwen's confirmation dialog (`permissionDecision: "ask"`).
// Path classification is pure string work; when anything after that fails
// for a candidate path we still ask, because a silent bypass is worse than
// an extra dialog.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { approvalMode } from './config.mjs';
import { analyzeShell } from './openspec/shell.mjs';
import { artifactForPath, locateChangePath, readStatusCache } from './openspec/status.mjs';

/**
 * @typedef {object} GateTarget
 * @property {string} path
 * @property {string} root
 * @property {string} change
 * @property {string} rel
 * @property {string} artifact
 * @property {boolean} exists
 */

/**
 * @typedef {object} GateInput
 * @property {string} toolName
 * @property {any} toolInput
 * @property {string} cwd
 * @property {{ phase: string | null } | null} [state]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {(root: string, change: string) => any} [readStatus]  injectable for tests
 */

/**
 * Absolute paths a tool call writes.
 * @param {string} toolName
 * @param {any} toolInput
 * @param {string} cwd
 * @returns {string[]}
 */
export function writtenPaths(toolName, toolInput, cwd) {
  if (toolName === 'write_file' || toolName === 'edit') {
    const file = toolInput?.file_path;
    if (typeof file !== 'string' || !file) return [];
    return [isAbsolute(file) ? resolve(file) : resolve(cwd, file)];
  }
  if (toolName === 'run_shell_command') return analyzeShell(String(toolInput?.command ?? ''), cwd).writes;
  return [];
}

/**
 * Artifact files of OpenSpec changes that this call writes.
 * @param {GateInput} input
 * @returns {GateTarget[]}
 */
export function artifactTargets({ toolName, toolInput, cwd, env = process.env, readStatus }) {
  /** @type {GateTarget[]} */
  const targets = [];
  for (const path of writtenPaths(toolName, toolInput, cwd)) {
    const located = locateChangePath(path);
    if (!located || !located.rel) continue;
    if (located.rel.split('/').some((segment) => segment.startsWith('.'))) continue;
    let artifact;
    try {
      const status = (readStatus ?? ((root, change) => readStatusCache(root, change, env)?.status))(located.root, located.change);
      artifact = artifactForPath(located.rel, status);
    } catch {
      artifact = artifactForPath(located.rel, null) ?? located.rel;
    }
    if (artifact) targets.push({ path, ...located, artifact, exists: existsSync(path) });
  }
  return targets;
}

/**
 * @param {GateInput} input
 * @returns {{ ask: false, targets: GateTarget[] } | { ask: true, targets: GateTarget[], reason: string }}
 */
export function gateDecision(input) {
  const targets = artifactTargets(input);
  if (!targets.length) return { ask: false, targets };
  const mode = approvalMode({ workspace: input.cwd, env: input.env });
  if (mode === 'off') return { ask: false, targets };
  const gated = targets.filter((target) => {
    if (input.state?.phase === 'apply' && target.artifact === 'tasks') return false; // ticking tasks off
    if (mode === 'create' && target.exists) return false;
    return true;
  });
  if (!gated.length) return { ask: false, targets };
  return { ask: true, targets: gated, reason: reasonFor(gated) };
}

/** @param {GateTarget[]} gated */
function reasonFor(gated) {
  const [first] = gated;
  const more = gated.length > 1 ? ` и ещё ${gated.length - 1}` : '';
  return `OpenSpec: подтвердите артефакт «${first.artifact}»${more} (change ${first.change}). Для headless-запусков: OPSX_UI_APPROVAL=off`;
}

/**
 * Hook output that makes Qwen show its confirmation dialog in every approval mode.
 * @param {string} reason
 */
export function askOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
}
