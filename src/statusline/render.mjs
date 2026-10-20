// @ts-check
// Pure rendering of the two status line rows from session state and change
// status. No I/O; `now` and sizes are passed in.
//
//   opsx  explore › ● propose › apply › archive   add-qwen-opsx-ui
//   proposal ✓  specs ✓  design ◐  tasks ·   ⏳ context7›get-library-docs 8s +1

import { STEPS, stepOf } from '../openspec/phases.mjs';

/** @typedef {import('../state/reducer.mjs').SessionState} SessionState */
/** @typedef {import('../openspec/status.mjs').ChangeStatus} ChangeStatus */

/**
 * @typedef {object} RenderInput
 * @property {SessionState} state
 * @property {ChangeStatus | null} [status]        null when unknown
 * @property {boolean} [statusUnavailable]          the CLI failed or is missing
 * @property {{ done: number, total: number } | null} [tasks]
 * @property {number} now
 * @property {number} width
 * @property {boolean} color
 */

export const GLYPHS = {
  done: '✓',
  current: '◐',
  awaiting: '⚠',
  rejected: '✗',
  ready: '○',
  blocked: '·',
  skipped: '–',
  step: '●',
  wait: '⏳',
};

const ANSI = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
/** The change name shrinks to this before step labels are abbreviated. */
const MIN_CHANGE_CHARS = 8;

/**
 * @param {boolean} color
 * @returns {(style: keyof typeof ANSI | null, text: string) => string}
 */
function painter(color) {
  return (style, text) => (color && style && text ? `${ANSI[style]}${text}${ANSI.reset}` : text);
}

/** Visible length: code points, without ANSI escapes. */
export function visibleLength(/** @type {string} */ text) {
  return [...text.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

/** @param {string} text @param {number} max */
function ellipsize(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  return max <= 1 ? '…'.slice(0, max) : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Status of each artifact as displayed.
 * @param {RenderInput} input
 * @returns {{ id: string, kind: keyof typeof GLYPHS }[]}
 */
export function artifactCells({ state, status }) {
  const artifacts = status?.artifacts ?? [];
  return artifacts.map(({ id, status: s }) => {
    const mark = state.marks[id];
    /** @type {keyof typeof GLYPHS} */
    let kind = s === 'done' ? 'done' : s === 'skipped' ? 'skipped' : s === 'blocked' ? 'blocked' : 'ready';
    if (mark === 'rejected') kind = 'rejected';
    if (state.currentArtifact === id && kind !== 'rejected') kind = 'current';
    if (mark === 'awaiting') kind = 'awaiting';
    return { id, kind };
  });
}

/**
 * Most important thing the agent is waiting for, as plain text.
 * @param {RenderInput} input
 * @returns {{ kind: 'approval' | 'mcp' | 'artifact' | 'none', text: string }}
 */
export function activity({ state, now }) {
  const pending = Object.values(state.pending);
  const approval = pending.filter((p) => p.awaitingApproval).sort((a, b) => a.startedAt - b.startedAt)[0];
  if (approval) {
    const what = approval.kind === 'artifact' ? approval.artifact : `${approval.server}›${approval.tool}`;
    return { kind: 'approval', text: `${GLYPHS.awaiting} подтвердите ${what} в диалоге` };
  }
  const mcp = pending.filter((p) => p.kind === 'mcp').sort((a, b) => a.startedAt - b.startedAt);
  if (mcp.length) {
    const seconds = Math.max(0, Math.floor((now - mcp[0].startedAt) / 1000));
    const more = mcp.length > 1 ? ` +${mcp.length - 1}` : '';
    return { kind: 'mcp', text: `${GLYPHS.wait} ${mcp[0].server}›${mcp[0].tool} ${seconds}s${more}` };
  }
  if (state.currentArtifact) return { kind: 'artifact', text: `пишется ${state.currentArtifact}` };
  return { kind: 'none', text: '' };
}

/**
 * Two rows for an active flow.
 * @param {RenderInput} input
 * @returns {[string, string]}
 */
export function renderFlow(input) {
  const { state, width, color } = input;
  const paint = painter(color);
  const phase = /** @type {import('../openspec/phases.mjs').Phase} */ (state.phase);
  const { step, label } = stepOf(phase);

  // Row 1: steps + change name. Shrink the change name first, then the step labels.
  const stepsText = (/** @type {boolean} */ short) => STEPS.map((s) => {
    const name = short ? s[0] : s;
    if (s !== step) return paint('dim', name);
    return paint('bold', `${GLYPHS.step} ${name}${label ? ` (${label})` : ''}`);
  }).join(paint('dim', ' › '));
  const prefix = paint('cyan', 'opsx');
  const longSteps = `${prefix}  ${stepsText(false)}`;
  const shortSteps = `${prefix}  ${stepsText(true)}`;
  let row1 = visibleLength(longSteps) <= width ? longSteps : shortSteps;
  if (state.change) {
    const keep = Math.min(MIN_CHANGE_CHARS, [...state.change].length);
    const steps = width - visibleLength(longSteps) - 3 >= keep ? longSteps : shortSteps;
    row1 = `${steps}   ${ellipsize(state.change, Math.max(1, width - visibleLength(steps) - 3))}`;
  }

  // Row 2: artifacts (or tasks/progress) + activity.
  const act = activity(input);
  const actText = act.kind === 'approval' ? paint('yellow', act.text) : act.kind === 'mcp' ? paint('cyan', act.text) : paint('dim', act.text);
  let left;
  if (!state.change) {
    left = paint('dim', 'нет активного change');
  } else if (input.statusUnavailable && !input.status) {
    left = paint('dim', 'статус недоступен');
  } else if (state.phase === 'apply' && input.tasks) {
    left = `задачи ${input.tasks.done}/${input.tasks.total}`;
  } else {
    /** @type {Record<string, keyof typeof ANSI | null>} */
    const style = { done: 'green', current: 'yellow', awaiting: 'yellow', rejected: 'red', ready: null, blocked: 'dim', skipped: 'dim' };
    left = artifactCells(input)
      .map(({ id, kind }) => `${id} ${paint(style[kind], GLYPHS[kind])}`)
      .join('  ');
    if (!left) left = paint('dim', 'статус недоступен');
  }
  let row2 = act.text ? `${left}   ${actText}` : left;
  if (visibleLength(row2) > width) row2 = fitRow(left, act.text, actText, width, paint);
  return [fit(row1, width), fit(row2, width)];
}

/**
 * Keeps the activity (it changes every second) and trims the artifact list.
 * @param {string} left
 * @param {string} actPlain
 * @param {string} actPainted
 * @param {number} width
 * @param {ReturnType<typeof painter>} paint
 */
function fitRow(left, actPlain, actPainted, width, paint) {
  if (!actPlain) return left;
  const room = width - visibleLength(actPlain) - 3;
  if (room < 10) return actPainted;
  const plainLeft = left.replace(/\x1b\[[0-9;]*m/g, '');
  return `${paint(null, ellipsize(plainLeft, room))}   ${actPainted}`;
}

/** Hard cap so a row never exceeds the width, whatever went into it. */
function fit(/** @type {string} */ row, /** @type {number} */ width) {
  if (visibleLength(row) <= width) return row;
  return ellipsize(row.replace(/\x1b\[[0-9;]*m/g, ''), width);
}

/**
 * Single compact row when no OpenSpec flow is active.
 * @param {{ project: string, branch?: string, model?: string, contextUsed?: number, width: number, color: boolean }} input
 */
export function renderIdle({ project, branch, model, contextUsed, width, color }) {
  const paint = painter(color);
  const parts = [project, branch && `⎇ ${branch}`, model, typeof contextUsed === 'number' && `ctx ${Math.round(contextUsed)}%`].filter(Boolean);
  return fit(parts.map((p, k) => (k === 0 ? String(p) : paint('dim', String(p)))).join(paint('dim', ' · ')), width);
}
