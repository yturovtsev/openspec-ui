import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { askOutput, gateDecision } from '../src/gate.mjs';
import { fixture, tempDir, writeTree } from './helpers.mjs';

function project(files = {}) {
  return writeTree(tempDir('gate-'), {
    'openspec/config.yaml': 'schema: spec-driven\n',
    'openspec/changes/add-auth/.openspec.yaml': 'schema: spec-driven\n',
    ...files,
  });
}
const env = (extra = {}) => ({ OPSX_UI_HOME: tempDir(), ...extra });
const write = (cwd, rel, extra = {}) => ({ toolName: 'write_file', toolInput: { file_path: join(cwd, rel), content: 'x' }, cwd, env: env(), ...extra });

test('creating proposal.md in YOLO mode asks, naming artifact and change', () => {
  const cwd = project();
  const payload = fixture('PreToolUse-write_file-proposal', { project: cwd });
  payload.tool_input.file_path = join(cwd, 'openspec/changes/add-auth/proposal.md');
  assert.equal(payload.permission_mode, 'yolo');
  const decision = gateDecision({ toolName: payload.tool_name, toolInput: payload.tool_input, cwd: payload.cwd, env: env() });
  assert.equal(decision.ask, true);
  assert.match(decision.ask ? decision.reason : '', /«proposal».*add-auth/);
  assert.deepEqual(askOutput('r'), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r' } });
});

test('editing a delta spec asks for the specs artifact', () => {
  const cwd = project({ 'openspec/changes/add-auth/specs/auth/login/spec.md': '## ADDED Requirements\n' });
  const decision = gateDecision({ toolName: 'edit', toolInput: { file_path: join(cwd, 'openspec/changes/add-auth/specs/auth/login/spec.md'), old_string: 'a', new_string: 'b' }, cwd, env: env() });
  assert.equal(decision.ask, true);
  assert.equal(decision.targets[0].artifact, 'specs');
});

test('files outside OpenSpec changes are left alone', () => {
  const cwd = project();
  assert.equal(gateDecision(write(cwd, 'src/index.ts')).ask, false);
  assert.equal(gateDecision(write(cwd, 'openspec/specs/auth/spec.md')).ask, false);
  assert.equal(gateDecision({ toolName: 'read_file', toolInput: { file_path: join(cwd, 'openspec/changes/add-auth/proposal.md') }, cwd, env: env() }).ask, false);
});

test('a custom schema artifact from the status cache is gated', () => {
  const cwd = project();
  const status = { artifacts: [{ id: 'research', outputPath: 'research.md', status: 'ready' }] };
  const decision = gateDecision({ ...write(cwd, 'openspec/changes/add-auth/research.md'), readStatus: () => status });
  assert.equal(decision.ask, true);
  assert.equal(decision.targets[0].artifact, 'research');
});

test('without status, spec-driven paths are still gated', () => {
  const cwd = project();
  const decision = gateDecision(write(cwd, 'openspec/changes/add-auth/design.md'));
  assert.equal(decision.ask, true);
  assert.equal(decision.targets[0].artifact, 'design');
});

test('a failing status lookup still asks for the candidate path', () => {
  const cwd = project();
  const decision = gateDecision({ ...write(cwd, 'openspec/changes/add-auth/design.md'), readStatus: () => { throw new Error('boom'); } });
  assert.equal(decision.ask, true);
});

test('service files, archived changes and non-artifacts are not gated', () => {
  const cwd = project();
  assert.equal(gateDecision(write(cwd, 'openspec/changes/add-auth/.openspec.yaml')).ask, false);
  assert.equal(gateDecision(write(cwd, 'openspec/changes/archive/2026-01-01-old/design.md')).ask, false);
  assert.equal(gateDecision(write(cwd, 'openspec/changes/add-auth/notes.txt')).ask, false);
});

test('shell writes into artifacts ask; OpenSpec CLI calls do not', () => {
  const cwd = project();
  const heredoc = gateDecision({ toolName: 'run_shell_command', toolInput: { command: 'cat > openspec/changes/add-auth/tasks.md <<EOF\n- [ ] 1.1 x\nEOF' }, cwd, env: env() });
  assert.equal(heredoc.ask, true);
  assert.equal(heredoc.targets[0].artifact, 'tasks');
  const cli = gateDecision({ toolName: 'run_shell_command', toolInput: { command: 'openspec new change "add-auth"' }, cwd, env: env() });
  assert.equal(cli.ask, false);
});

test('ticking tasks off during apply never asks', () => {
  const cwd = project({ 'openspec/changes/add-auth/tasks.md': '- [ ] 1.1 x\n' });
  const edit = { toolName: 'edit', toolInput: { file_path: join(cwd, 'openspec/changes/add-auth/tasks.md'), old_string: '- [ ]', new_string: '- [x]' }, cwd, state: { phase: 'apply' } };
  for (const mode of ['all', 'create', 'off']) assert.equal(gateDecision({ ...edit, env: env({ OPSX_UI_APPROVAL: mode }) }).ask, false);
  assert.equal(gateDecision({ ...edit, state: { phase: 'propose' }, env: env() }).ask, true);
});

test('create mode only gates new artifact files', () => {
  const cwd = project({ 'openspec/changes/add-auth/proposal.md': '## Why\n' });
  const e = env({ OPSX_UI_APPROVAL: 'create' });
  assert.equal(gateDecision({ ...write(cwd, 'openspec/changes/add-auth/proposal.md'), env: e }).ask, false);
  assert.equal(gateDecision({ ...write(cwd, 'openspec/changes/add-auth/design.md'), env: e }).ask, true);
});

test('mode from the project file applies; off disables the gate', () => {
  const cwd = project({ '.qwen/opsx-ui.json': { approval: 'off' } });
  assert.equal(gateDecision(write(cwd, 'openspec/changes/add-auth/proposal.md')).ask, false);
  assert.equal(gateDecision({ ...write(cwd, 'openspec/changes/add-auth/proposal.md'), env: env({ OPSX_UI_APPROVAL: 'all' }) }).ask, true);
});

test('the reason tells headless users how to turn the gate off', () => {
  const cwd = project();
  const decision = gateDecision(write(cwd, 'openspec/changes/add-auth/proposal.md'));
  assert.match(decision.ask ? decision.reason : '', /OPSX_UI_APPROVAL=off/);
});

test('several gated targets are summarised', () => {
  const cwd = project();
  const decision = gateDecision({ toolName: 'run_shell_command', toolInput: { command: 'cp a.md openspec/changes/add-auth/design.md && echo x > openspec/changes/add-auth/tasks.md' }, cwd, env: env() });
  assert.equal(decision.ask, true);
  assert.match(decision.ask ? decision.reason : '', /«design» и ещё 1/);
});

test('relative file paths resolve against the hook cwd', () => {
  const cwd = project();
  assert.equal(gateDecision({ toolName: 'write_file', toolInput: { file_path: 'openspec/changes/add-auth/design.md' }, cwd, env: env() }).ask, true);
});
