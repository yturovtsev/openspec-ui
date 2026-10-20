// @ts-check
// Qwen hook entry: payload on stdin → domain events in the session log, plus
// the hook's JSON answer on stdout. Only the approval gate ever changes what
// Qwen does; every other path answers `{}` whatever happens. Event payloads
// carry ids, OpenSpec paths and names only — never prompts, file contents or
// tool responses.

import { createHash } from 'node:crypto';
import { askOutput, gateDecision, writtenPaths } from '../gate.mjs';
import { analyzeShell } from '../openspec/shell.mjs';
import { findOpenspecRoot, locateChangePath } from '../openspec/status.mjs';
import { phaseFromCommand, phaseFromPrompt, phaseFromSkill } from '../openspec/phases.mjs';
import { appendEvent, COMPACT_AFTER_LINES, logDebug, readEvents, removeStaleSessions, rewriteEvents } from '../state/log.mjs';
import { reduce } from '../state/reducer.mjs';
import { markHintsShown, setupHintNotice } from './hint.mjs';

const WRITE_TOOLS = new Set(['write_file', 'edit']);

/**
 * Digest that ties PermissionRequest/PermissionDenied (which carry no
 * tool_use_id) back to the PreToolUse of the same call.
 * @param {string} toolName
 * @param {unknown} toolInput
 */
export function callKey(toolName, toolInput) {
  return `${toolName}:${createHash('sha1').update(stableJson(toolInput)).digest('hex').slice(0, 16)}`;
}

/** @param {unknown} value */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(/** @type {any} */ (value)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** @param {string} toolName */
function mcpParts(toolName) {
  const [, server = '', ...rest] = toolName.split('__');
  return { server, tool: rest.join('__') };
}

/**
 * Handles one hook payload. Returns the hook output object.
 * @param {string} eventName
 * @param {any} payload
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, unknown>}
 */
export function handleHook(eventName, payload, env = process.env) {
  const sessionId = String(payload?.session_id ?? '');
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  /** @type {Record<string, unknown>[]} */
  const events = [];
  /** @type {Record<string, unknown>} */
  let output = {};

  // The gate goes first and does not depend on the log being writable.
  if (eventName === 'PreToolUse' && (WRITE_TOOLS.has(payload?.tool_name) || payload?.tool_name === 'run_shell_command')) {
    const gate = safeGate(payload, cwd, sessionId, env);
    if (gate.ask) output = askOutput(gate.reason);
    for (const target of gate.targets) {
      events.push({ type: 'change', change: target.change, root: target.root });
      events.push({
        type: 'tool.start',
        kind: 'artifact',
        toolUseId: payload.tool_use_id,
        callId: payload.tool_call_id,
        toolName: payload.tool_name,
        key: callKey(payload.tool_name, payload.tool_input),
        artifact: target.artifact,
        path: target.path,
        rel: target.rel,
        gated: gate.ask && gate.gatedPaths.has(target.path),
      });
      break; // one tracked artifact per call keeps approval bookkeeping simple
    }
  }

  try {
    events.unshift(...trackingEvents(eventName, payload, cwd));
    if (eventName === 'SessionStart') {
      const hint = setupHintNotice(cwd, env);
      if (hint) events.push({ type: 'notice', ...hint });
    }
    if (sessionId) {
      if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') settleTool(eventName, payload, sessionId, env, events);
      if (eventName === 'Stop') output = { ...output, ...flushNotices(sessionId, env, events) };
      for (const event of events) appendEvent(sessionId, /** @type {any} */ (event), env);
      if (eventName === 'Stop') compactIfLong(sessionId, env);
    }
    if (eventName === 'SessionStart') sessionStart(sessionId, env);
  } catch (error) {
    logDebug(`hook ${eventName}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, env);
  }
  return output;
}

/**
 * @param {any} payload
 * @param {string} cwd
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ask: boolean, reason: string, targets: import('../gate.mjs').GateTarget[], gatedPaths: Set<string> }}
 */
function safeGate(payload, cwd, sessionId, env) {
  try {
    let state = null;
    try {
      state = sessionId ? reduce(readEvents(sessionId, env)) : null;
    } catch {}
    const decision = gateDecision({ toolName: payload.tool_name, toolInput: payload.tool_input, cwd, state, env });
    return decision.ask
      ? { ask: true, reason: decision.reason, targets: decision.targets, gatedPaths: new Set(decision.targets.map((t) => t.path)) }
      : { ask: false, reason: '', targets: decision.targets, gatedPaths: new Set() };
  } catch (error) {
    logDebug(`gate: ${error instanceof Error ? error.message : String(error)}`, env);
    // If the call touches a change directory at all, ask rather than let it through.
    const touches = writtenPaths(payload.tool_name, payload.tool_input, cwd).some((p) => locateChangePath(p)?.rel);
    return { ask: touches, reason: 'OpenSpec: подтвердите запись в каталог change. Для headless-запусков: OPSX_UI_APPROVAL=off', targets: [], gatedPaths: new Set() };
  }
}

/**
 * Domain events for everything except the gate's own artifact tracking.
 * @param {string} eventName
 * @param {any} payload
 * @param {string} cwd
 * @returns {Record<string, unknown>[]}
 */
function trackingEvents(eventName, payload, cwd) {
  const toolName = String(payload?.tool_name ?? '');
  switch (eventName) {
    case 'UserPromptExpansion': {
      const phase = phaseFromCommand(payload.command_name);
      return phase ? [{ type: 'phase', phase }] : [];
    }
    case 'UserPromptSubmit': {
      // Continuations of a turn have no submitted_prompt; only real user input starts a turn.
      if (typeof payload.submitted_prompt !== 'string') return [];
      const phase = phaseFromPrompt(payload.submitted_prompt);
      return [{ type: 'turn.end' }, ...(phase ? [{ type: 'phase', phase }] : [])];
    }
    case 'PreToolUse': {
      if (toolName === 'skill') {
        const phase = phaseFromSkill(payload.tool_input?.skill);
        return phase ? [{ type: 'phase', phase }] : [];
      }
      if (toolName === 'run_shell_command') {
        const shell = analyzeShell(String(payload.tool_input?.command ?? ''), cwd);
        if (!shell.openspec) return [];
        const root = findOpenspecRoot(cwd);
        return [
          ...shell.changes.map((change) => ({ type: 'change', change, root })),
          ...shell.instructions.filter((i) => i.artifact !== 'apply').map((i) => ({ type: 'artifact.current', artifact: i.artifact })),
        ];
      }
      if (toolName.startsWith('mcp__')) {
        return [{
          type: 'tool.start',
          kind: 'mcp',
          toolUseId: payload.tool_use_id,
          callId: payload.tool_call_id,
          toolName,
          key: callKey(toolName, payload.tool_input),
          ...mcpParts(toolName),
        }];
      }
      return [];
    }
    case 'PermissionRequest':
      return [{ type: 'tool.awaiting', key: callKey(toolName, payload.tool_input) }];
    case 'PermissionDenied':
      return [{ type: 'tool.denied', key: callKey(toolName, payload.tool_input) }];
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (!payload.tool_use_id || !(toolName.startsWith('mcp__') || WRITE_TOOLS.has(toolName) || toolName === 'run_shell_command')) return [];
      return [{ type: 'tool.end', toolUseId: payload.tool_use_id, ok: eventName === 'PostToolUse', durationMs: payload.duration_ms }];
    case 'PostToolBatch':
      return (Array.isArray(payload.tool_calls) ? payload.tool_calls : [])
        .filter((call) => call?.status === 'cancelled')
        .map((call) => ({ type: 'tool.cancelled', callId: call.tool_use_id ?? call.tool_call_id }));
    case 'Notification':
      // idle_prompt also fires mid-turn while a permission dialog waits; only
      // the one without prompt_id means Qwen is back at the input box.
      return payload.notification_type === 'idle_prompt' && !payload.prompt_id ? [{ type: 'turn.end' }] : [];
    case 'Stop':
      return [{ type: 'turn.end' }];
    case 'SessionStart':
      return [{ type: 'session.start', source: payload.source }];
    case 'SessionEnd':
      return [{ type: 'session.end' }];
    default:
      return [];
  }
}

/**
 * Keeps tool.end only for calls this session is tracking (the matchers also
 * see unrelated writes and shell commands) and queues an "accepted" notice
 * for a finished artifact write.
 * @param {string} eventName
 * @param {any} payload
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, unknown>[]} events  edited in place
 */
function settleTool(eventName, payload, sessionId, env, events) {
  const entry = reduce(readEvents(sessionId, env)).pending[payload.tool_use_id];
  if (!entry) {
    events.splice(0, events.length);
    return;
  }
  if (eventName === 'PostToolUse' && entry.kind === 'artifact') {
    const name = entry.rel || entry.artifact;
    events.push({ type: 'notice', id: String(payload.tool_use_id), text: `✓ opsx: ${name} ${entry.gated ? 'принят' : 'записан'}` });
  }
}

/**
 * Prints queued notices. Qwen shows systemMessage in the interactive feed
 * only for Stop hooks, so PostToolUse queues and Stop flushes.
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string, unknown>[]} events  appended to
 */
function flushNotices(sessionId, env, events) {
  const state = reduce(readEvents(sessionId, env));
  if (!state.notices.length) return {};
  const ids = state.notices.map((n) => n.id);
  events.push({ type: 'notice.flushed', ids });
  markHintsShown(ids, env);
  return { systemMessage: state.notices.map((n) => n.text).join('\n') };
}

/**
 * Housekeeping at a quiet point: drop old sessions, compact this one.
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} env
 */
function sessionStart(sessionId, env) {
  removeStaleSessions({ env });
  if (!sessionId) return;
  const events = readEvents(sessionId, env);
  if (events.length > 1) rewriteEvents(sessionId, [{ type: 'snapshot', at: Date.now(), state: reduce(events) }], env);
}

/**
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} env
 */
function compactIfLong(sessionId, env) {
  if (!sessionId) return;
  const events = readEvents(sessionId, env);
  if (events.length > COMPACT_AFTER_LINES) rewriteEvents(sessionId, [{ type: 'snapshot', at: Date.now(), state: reduce(events) }], env);
}

/** @returns {Promise<string>} */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

/**
 * CLI entry: `opsx-ui hook <EventName>`. Always exits 0.
 * @param {string | undefined} eventName
 */
export async function runHook(eventName) {
  let output = {};
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    output = handleHook(String(eventName ?? payload.hook_event_name ?? ''), payload);
  } catch (error) {
    logDebug(`hook ${eventName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.stdout.write(JSON.stringify(output));
  return 0;
}
