// @ts-check
// OpenSpec workflow phases and how commands/skills map onto them. The core
// profile installs opsx-{explore,propose,apply,archive,update,sync}; the
// expanded profile adds new/continue/ff/verify/bulk-archive/onboard.

/** @typedef {'explore' | 'propose' | 'update' | 'apply' | 'sync' | 'archive'} Phase */
/** @typedef {'explore' | 'propose' | 'apply' | 'archive'} Step */

export const PHASES = /** @type {const} */ (['explore', 'propose', 'update', 'apply', 'sync', 'archive']);
export const STEPS = /** @type {const} */ (['explore', 'propose', 'apply', 'archive']);

/** @type {Record<string, Phase>} */
const COMMAND_PHASES = {
  'opsx-explore': 'explore',
  'opsx-onboard': 'explore',
  'opsx-propose': 'propose',
  'opsx-new': 'propose',
  'opsx-continue': 'propose',
  'opsx-ff': 'propose',
  'opsx-update': 'update',
  'opsx-apply': 'apply',
  'opsx-verify': 'apply',
  'opsx-sync': 'sync',
  'opsx-archive': 'archive',
  'opsx-bulk-archive': 'archive',
};

/** @type {Record<string, Phase>} */
const SKILL_PHASES = {
  'openspec-explore': 'explore',
  'openspec-onboard': 'explore',
  'openspec-propose': 'propose',
  'openspec-new-change': 'propose',
  'openspec-continue-change': 'propose',
  'openspec-ff-change': 'propose',
  'openspec-update-change': 'update',
  'openspec-apply-change': 'apply',
  'openspec-verify-change': 'apply',
  'openspec-sync-specs': 'sync',
  'openspec-archive-change': 'archive',
  'openspec-bulk-archive-change': 'archive',
};

/**
 * Slash command name (with or without the leading slash, e.g. "opsx-propose"
 * or the "opsx:propose" spelling) → phase, or null for non-OpenSpec commands.
 * @param {unknown} name
 * @returns {Phase | null}
 */
export function phaseFromCommand(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().replace(/^\//, '').replace(/^opsx:/, 'opsx-').toLowerCase();
  return COMMAND_PHASES[key] ?? null;
}

/**
 * @param {unknown} name
 * @returns {Phase | null}
 */
export function phaseFromSkill(name) {
  if (typeof name !== 'string') return null;
  return SKILL_PHASES[name.trim().toLowerCase()] ?? null;
}

/**
 * First word of a submitted prompt like "/opsx-propose add auth".
 * @param {unknown} prompt
 * @returns {Phase | null}
 */
export function phaseFromPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const match = /^\s*\/(\S+)/.exec(prompt);
  return match ? phaseFromCommand(match[1]) : null;
}

/**
 * The stepper only has four steps; update and sync ride on neighbours.
 * @param {Phase} phase
 * @returns {{ step: Step, label: string | null }}
 */
export function stepOf(phase) {
  if (phase === 'update') return { step: 'propose', label: 'update' };
  if (phase === 'sync') return { step: 'archive', label: 'sync' };
  return { step: phase, label: null };
}
