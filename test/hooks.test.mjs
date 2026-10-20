import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents, sessionLogPath } from '../src/state/log.mjs';
import { reduce } from '../src/state/reducer.mjs';
import { BIN, fixture, tempDir, writeTree } from './helpers.mjs';

const SESSION = 'test-session';

function setup() {
  const project = writeTree(tempDir('hooks-proj-'), {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/demo-change/.openspec.yaml': 'schema: spec-driven\n',
  });
  const env = { ...process.env, OPSX_UI_HOME: tempDir('hooks-home-'), HOME: tempDir('hooks-user-') };
  delete env.OPSX_UI_APPROVAL;
  /** @param {string} event @param {string | object} payload */
  const hook = (event, payload) => {
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const result = spawnSync(process.execPath, [BIN, 'hook', event], { input, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  /** @param {string} name @param {string} [sessionId] */
  const load = (name, sessionId = SESSION) => fixture(name, { project, sessionId });
  const events = () => readEvents(SESSION, env);
  const state = () => reduce(events());
  return { project, env, hook, load, events, state };
}

test('UserPromptExpansion for /opsx-propose sets the phase', () => {
  const t = setup();
  assert.deepEqual(t.hook('UserPromptExpansion', t.load('UserPromptExpansion-opsx-propose')), {});
  assert.equal(t.state().phase, 'propose');
});

test('UserPromptSubmit starts a turn and backs up the phase; continuations are ignored', () => {
  const t = setup();
  t.hook('UserPromptSubmit', t.load('UserPromptSubmit-opsx-propose'));
  assert.deepEqual(t.events().map((e) => e.type), ['turn.end', 'phase']);
  t.hook('UserPromptSubmit', t.load('UserPromptSubmit-continuation'));
  assert.equal(t.events().length, 2);
});

test('a non-OpenSpec command leaves the phase alone', () => {
  const t = setup();
  t.hook('UserPromptExpansion', t.load('UserPromptExpansion-opsx-propose'));
  t.hook('UserPromptExpansion', { ...t.load('UserPromptExpansion-opsx-propose'), command_name: 'review' });
  assert.equal(t.state().phase, 'propose');
});

test('skill openspec-explore sets the explore phase', () => {
  const t = setup();
  t.hook('PreToolUse', t.load('PreToolUse-skill-openspec-explore'));
  assert.equal(t.state().phase, 'explore');
});

test('openspec status --change and instructions track change and current artifact', () => {
  const t = setup();
  assert.deepEqual(t.hook('PreToolUse', t.load('PreToolUse-shell-openspec-status')), {});
  assert.equal(t.state().change, 'demo-change');
  assert.equal(t.state().root, t.project);
  t.hook('PreToolUse', t.load('PreToolUse-shell-openspec-instructions'));
  assert.equal(t.state().currentArtifact, 'proposal');
});

test('artifact write: ask → permission → accepted → notice shown on Stop once', () => {
  const t = setup();
  t.hook('UserPromptExpansion', t.load('UserPromptExpansion-opsx-propose'));
  const pre = t.hook('PreToolUse', t.load('PreToolUse-write_file-proposal'));
  assert.equal(pre.hookSpecificOutput?.permissionDecision, 'ask');
  assert.match(pre.hookSpecificOutput?.permissionDecisionReason, /«proposal».*demo-change/);
  assert.equal(t.state().currentArtifact, 'proposal');

  t.hook('PermissionRequest', t.load('PermissionRequest-write_file-yolo-ask'));
  assert.equal(t.state().marks.proposal, 'awaiting');

  assert.deepEqual(t.hook('PostToolUse', t.load('PostToolUse-write_file-proposal')), {});
  const after = t.state();
  assert.equal(after.marks.proposal, 'approved');
  assert.equal(after.currentArtifact, null);
  assert.deepEqual(after.notices.map((n) => n.text), ['✓ opsx: proposal.md принят']);

  assert.deepEqual(t.hook('Stop', t.load('Stop')), { systemMessage: '✓ opsx: proposal.md принят' });
  assert.deepEqual(t.hook('Stop', t.load('Stop')), {});
});

test('several accepted artifacts in one turn are printed together on Stop', () => {
  const t = setup();
  const writes = [
    ['w1', 'proposal.md'],
    ['w2', 'specs/auth/spec.md'],
  ];
  for (const [id, rel] of writes) {
    const tool_input = { file_path: join(t.project, 'openspec/changes/demo-change', rel), content: 'x' };
    t.hook('PreToolUse', { ...t.load('PreToolUse-write_file-proposal'), tool_use_id: id, tool_input });
    t.hook('PostToolUse', { ...t.load('PostToolUse-write_file-proposal'), tool_use_id: id, tool_input });
  }
  assert.deepEqual(t.hook('Stop', t.load('Stop')), { systemMessage: '✓ opsx: proposal.md принят\n✓ opsx: specs/auth/spec.md принят' });
});

test('with the gate off, a written artifact is reported as written, not accepted', () => {
  const t = setup();
  t.env.OPSX_UI_APPROVAL = 'off';
  assert.deepEqual(t.hook('PreToolUse', t.load('PreToolUse-write_file-proposal')), {});
  t.hook('PostToolUse', t.load('PostToolUse-write_file-proposal'));
  assert.deepEqual(t.hook('Stop', t.load('Stop')), { systemMessage: '✓ opsx: proposal.md записан' });
});

test('rejection in the dialog (cancelled batch) marks the artifact rejected', () => {
  const t = setup();
  const pre = t.load('PreToolUse-write_file-proposal');
  const batch = t.load('PostToolBatch-write_file-rejected');
  pre.tool_call_id = batch.tool_calls[0].tool_use_id;
  t.hook('PreToolUse', pre);
  t.hook('PermissionRequest', t.load('PermissionRequest-write_file-yolo-ask'));
  assert.deepEqual(t.hook('PostToolBatch', batch), {});
  assert.equal(t.state().marks.proposal, 'rejected');
  t.hook('Notification', t.load('Notification-idle-turn-end'));
  assert.equal(t.state().marks.proposal, 'rejected');
  assert.deepEqual(t.state().pending, {});
});

test('an approved batch does not reject anything', () => {
  const t = setup();
  t.hook('PreToolUse', t.load('PreToolUse-write_file-proposal'));
  t.hook('PostToolBatch', t.load('PostToolBatch-write_file-approved'));
  assert.notEqual(t.state().marks.proposal, 'rejected');
});

test('MCP calls: pending with server and tool, awaiting permission, then duration', () => {
  const t = setup();
  const pre = t.load('PreToolUse-mcp');
  assert.deepEqual(t.hook('PreToolUse', pre), {});
  const pending = t.state().pending[pre.tool_use_id];
  assert.equal(pending.server, 'slow');
  assert.equal(pending.tool, 'wait');
  t.hook('PermissionRequest', { ...t.load('PermissionRequest-mcp'), tool_input: pre.tool_input });
  assert.equal(t.state().pending[pre.tool_use_id].awaitingApproval, true);
  t.hook('PostToolUse', { ...t.load('PostToolUse-mcp'), tool_use_id: pre.tool_use_id });
  assert.deepEqual(t.state().pending, {});
  assert.equal(t.state().lastMcp?.durationMs, 2006);
});

test('a failed edit clears the pending write without approval', () => {
  const t = setup();
  const failure = t.load('PostToolUseFailure-edit');
  t.hook('PreToolUse', { ...t.load('PreToolUse-edit-proposal'), tool_use_id: failure.tool_use_id });
  t.hook('PostToolUseFailure', failure);
  assert.deepEqual(t.state().pending, {});
  assert.equal(t.state().marks.proposal, undefined);
});

test('idle notifications end the turn only when Qwen is back at the prompt', () => {
  const t = setup();
  t.hook('PreToolUse', t.load('PreToolUse-mcp'));
  t.hook('Notification', t.load('Notification-idle-in-turn'));
  t.hook('Notification', t.load('Notification-permission-prompt'));
  assert.equal(Object.keys(t.state().pending).length, 1);
  t.hook('Notification', t.load('Notification-idle-turn-end'));
  assert.deepEqual(t.state().pending, {});
});

test('Stop clears pending MCP calls', () => {
  const t = setup();
  t.hook('PreToolUse', t.load('PreToolUse-mcp'));
  t.hook('Stop', t.load('Stop'));
  assert.deepEqual(t.state().pending, {});
});

test('unrelated tool results are not logged', () => {
  const t = setup();
  t.hook('PostToolUse', t.load('PostToolUse-shell-openspec-status'));
  t.hook('PreToolUse', { ...t.load('PreToolUse-write_file-proposal'), tool_input: { file_path: join(t.project, 'src/a.ts'), content: 'x' } });
  t.hook('PostToolUse', { ...t.load('PostToolUse-write_file-proposal'), tool_input: { file_path: join(t.project, 'src/a.ts'), content: 'x' } });
  assert.deepEqual(t.events(), []);
});

test('session start (resume) and end are recorded; resume compacts the log', () => {
  const t = setup();
  t.hook('UserPromptExpansion', t.load('UserPromptExpansion-opsx-propose'));
  t.hook('PreToolUse', t.load('PreToolUse-shell-openspec-status'));
  t.hook('SessionStart', t.load('SessionStart-resume'));
  assert.deepEqual(t.events().map((e) => e.type), ['snapshot']);
  assert.equal(t.state().phase, 'propose');
  assert.equal(t.state().change, 'demo-change');
  t.hook('SessionEnd', t.load('SessionEnd'));
  assert.equal(t.state().ended, true);
});

test('prompt text, command arguments and file contents never reach the log', () => {
  const t = setup();
  for (const [event, name] of [
    ['UserPromptExpansion', 'UserPromptExpansion-opsx-propose'],
    ['UserPromptSubmit', 'UserPromptSubmit-opsx-propose'],
    ['PreToolUse', 'PreToolUse-write_file-proposal'],
    ['PreToolUse', 'PreToolUse-edit-proposal'],
    ['PostToolUse', 'PostToolUse-write_file-proposal'],
    ['PreToolUse', 'PreToolUse-mcp'],
    ['PostToolUse', 'PostToolUse-mcp'],
    ['Stop', 'Stop'],
  ]) t.hook(event, t.load(name));
  const log = readFileSync(sessionLogPath(SESSION, t.env), 'utf8');
  for (const secret of ['Planning boundary', 'demo change', '## Why', 'Demo edited', 'waited 2s', 'after-write']) {
    assert.equal(log.includes(secret), false, `log contains ${JSON.stringify(secret)}`);
  }
});

test('broken input still answers {} with exit 0', () => {
  const t = setup();
  assert.deepEqual(t.hook('PreToolUse', '{not json'), {});
  assert.deepEqual(t.hook('Stop', ''), {});
});

test('an unwritable state directory never blocks tools, but the gate still asks', () => {
  const t = setup();
  t.env.OPSX_UI_HOME = '/dev/null/opsx-ui';
  assert.deepEqual(t.hook('PreToolUse', t.load('PreToolUse-mcp')), {});
  assert.deepEqual(t.hook('Stop', t.load('Stop')), {});
  const pre = t.hook('PreToolUse', t.load('PreToolUse-write_file-proposal'));
  assert.equal(pre.hookSpecificOutput?.permissionDecision, 'ask');
});

test('shell write into an artifact asks', () => {
  const t = setup();
  const payload = t.load('PreToolUse-shell-openspec-status');
  payload.tool_input = { command: 'cat > openspec/changes/demo-change/tasks.md <<EOF\n- [ ] 1.1 x\nEOF' };
  const out = t.hook('PreToolUse', payload);
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput?.permissionDecisionReason, /«tasks»/);
});

test('setup hint: queued at the first session start, printed on Stop, then never again', () => {
  const t = setup();
  t.hook('SessionStart', t.load('SessionStart-startup', 's1'));
  const first = t.hook('Stop', t.load('Stop', 's1'));
  assert.match(String(first.systemMessage), /opsx-ui: .*node .*bin\/opsx-ui\.mjs.* setup/);
  t.hook('SessionStart', t.load('SessionStart-startup', 's2'));
  assert.deepEqual(t.hook('Stop', t.load('Stop', 's2')), {});
});

test('setup hint survives a session that never reached Stop', () => {
  const t = setup();
  t.hook('SessionStart', t.load('SessionStart-startup', 's1'));
  t.hook('SessionStart', t.load('SessionStart-startup', 's2'));
  assert.match(String(t.hook('Stop', t.load('Stop', 's2')).systemMessage), /setup/);
});

test('no setup hint when the status line is configured or outside OpenSpec projects', () => {
  const t = setup();
  writeTree(t.project, { '.qwen/settings.json': { ui: { statusLine: { type: 'command', command: 'node "/x/bin/opsx-ui.mjs" statusline --scope project' } } } });
  t.hook('SessionStart', t.load('SessionStart-startup', 's1'));
  assert.deepEqual(t.hook('Stop', t.load('Stop', 's1')), {});

  const u = setup();
  writeTree(u.env.HOME, { '.qwen/settings.json': '// user settings\n{ "ui": { "statusLine": { "type": "command", "command": "node /x/bin/opsx-ui.mjs statusline --scope user" } } }' });
  u.hook('SessionStart', u.load('SessionStart-startup', 's1'));
  assert.deepEqual(u.hook('Stop', u.load('Stop', 's1')), {});

  const v = setup();
  const plain = tempDir('plain-');
  v.hook('SessionStart', { ...v.load('SessionStart-startup', 's1'), cwd: plain });
  assert.deepEqual(v.hook('Stop', { ...v.load('Stop', 's1'), cwd: plain }), {});
});
