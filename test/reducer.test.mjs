import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialState, reduce } from '../src/state/reducer.mjs';
import { phaseFromCommand, phaseFromPrompt, phaseFromSkill, stepOf } from '../src/openspec/phases.mjs';

let clock = 1000;
const ev = (type, fields = {}) => ({ type, at: (clock += 1000), ...fields });
const mcpStart = (id, extra = {}) =>
  ev('tool.start', { toolUseId: id, kind: 'mcp', toolName: 'mcp__context7__get-library-docs', key: 'k-mcp', server: 'context7', tool: 'get-library-docs', ...extra });
const artifactStart = (id, artifact, extra = {}) =>
  ev('tool.start', { toolUseId: id, callId: `call-${id}`, kind: 'artifact', toolName: 'write_file', key: `k-${artifact}`, artifact, path: `/p/openspec/changes/add-auth/${artifact}.md`, ...extra });

test('commands, skills and prompts map onto phases; others are ignored', () => {
  assert.equal(phaseFromCommand('opsx-propose'), 'propose');
  assert.equal(phaseFromCommand('/opsx-apply'), 'apply');
  assert.equal(phaseFromCommand('opsx:explore'), 'explore');
  assert.equal(phaseFromCommand('opsx-ff'), 'propose');
  assert.equal(phaseFromCommand('review'), null);
  assert.equal(phaseFromCommand(undefined), null);
  assert.equal(phaseFromSkill('openspec-explore'), 'explore');
  assert.equal(phaseFromSkill('openspec-update-change'), 'update');
  assert.equal(phaseFromSkill('pdf'), null);
  assert.equal(phaseFromPrompt('/opsx-propose добавить авторизацию'), 'propose');
  assert.equal(phaseFromPrompt('please /opsx-propose'), null);
  assert.equal(phaseFromPrompt('/review'), null);
  assert.deepEqual(stepOf('update'), { step: 'propose', label: 'update' });
  assert.deepEqual(stepOf('sync'), { step: 'archive', label: 'sync' });
  assert.deepEqual(stepOf('apply'), { step: 'apply', label: null });
});

test('a new phase replaces the previous one and resets the current artifact', () => {
  const state = reduce([
    ev('phase', { phase: 'propose' }),
    ev('change', { change: 'add-auth', root: '/p' }),
    ev('artifact.current', { artifact: 'design' }),
    ev('phase', { phase: 'apply' }),
  ]);
  assert.equal(state.phase, 'apply');
  assert.equal(state.currentArtifact, null);
  assert.equal(state.change, 'add-auth');
});

test('events without a phase do not change it', () => {
  const state = reduce([ev('phase', { phase: 'propose' }), ev('phase', { phase: null })]);
  assert.equal(state.phase, 'propose');
});

test('the latest referenced change wins and resets per-change marks', () => {
  let state = reduce([
    ev('change', { change: 'add-auth', root: '/p' }),
    artifactStart('w1', 'design'),
    ev('tool.cancelled', { callId: 'call-w1' }),
  ]);
  assert.deepEqual(state.marks, { design: 'rejected' });
  state = applyEvent(state, ev('change', { change: 'fix-login', root: '/p' }));
  assert.equal(state.change, 'fix-login');
  assert.deepEqual(state.marks, {});
  assert.equal(state.currentArtifact, null);
});

test('re-referencing the same change keeps its marks', () => {
  const state = reduce([
    ev('change', { change: 'add-auth', root: '/p' }),
    artifactStart('w1', 'design'),
    ev('tool.cancelled', { callId: 'call-w1' }),
    ev('change', { change: 'add-auth' }),
  ]);
  assert.deepEqual(state.marks, { design: 'rejected' });
  assert.equal(state.root, '/p');
});

test('instructions make an artifact current; an approved write clears it', () => {
  let state = reduce([ev('change', { change: 'add-auth', root: '/p' }), ev('artifact.current', { artifact: 'design' })]);
  assert.equal(state.currentArtifact, 'design');
  state = applyEvent(state, artifactStart('w1', 'design'));
  state = applyEvent(state, ev('tool.awaiting', { key: 'k-design' }));
  assert.equal(state.marks.design, 'awaiting');
  state = applyEvent(state, ev('tool.end', { toolUseId: 'w1', ok: true }));
  assert.equal(state.currentArtifact, null);
  assert.equal(state.marks.design, 'approved');
  assert.deepEqual(state.pending, {});
});

test('a write attempt makes its artifact current', () => {
  const state = reduce([artifactStart('w1', 'tasks')]);
  assert.equal(state.currentArtifact, 'tasks');
});

test('a rejected artifact stays rejected until written and approved', () => {
  let state = reduce([artifactStart('w1', 'design'), ev('tool.awaiting', { key: 'k-design' }), ev('tool.cancelled', { callId: 'call-w1' })]);
  assert.equal(state.marks.design, 'rejected');
  state = applyEvent(state, ev('turn.end'));
  assert.equal(state.marks.design, 'rejected');
  state = applyEvent(state, artifactStart('w2', 'design'));
  state = applyEvent(state, ev('tool.end', { toolUseId: 'w2', ok: true }));
  assert.equal(state.marks.design, 'approved');
});

test('a rejected artifact is no longer shown as being written', () => {
  const state = reduce([ev('artifact.current', { artifact: 'tasks' }), artifactStart('w1', 'tasks'), ev('tool.cancelled', { callId: 'call-w1' })]);
  assert.equal(state.currentArtifact, null);
  assert.equal(state.marks.tasks, 'rejected');
});

test('a failed write clears awaiting but does not mark approval', () => {
  const state = reduce([artifactStart('w1', 'design'), ev('tool.awaiting', { key: 'k-design' }), ev('tool.end', { toolUseId: 'w1', ok: false })]);
  assert.deepEqual(state.marks, {});
  assert.deepEqual(state.pending, {});
});

test('MCP calls are tracked from start to end with duration', () => {
  let state = reduce([mcpStart('m1')]);
  assert.equal(state.pending.m1.server, 'context7');
  assert.equal(state.pending.m1.tool, 'get-library-docs');
  assert.equal(typeof state.pending.m1.startedAt, 'number');
  state = applyEvent(state, ev('tool.end', { toolUseId: 'm1', ok: true, durationMs: 2006 }));
  assert.deepEqual(state.pending, {});
  assert.equal(state.lastMcp?.durationMs, 2006);
});

test('an MCP call waiting for permission is marked as awaiting approval', () => {
  const state = reduce([mcpStart('m1'), ev('tool.awaiting', { key: 'k-mcp' })]);
  assert.equal(state.pending.m1.awaitingApproval, true);
});

test('permission matches the latest call with the same key', () => {
  const state = reduce([mcpStart('m1'), mcpStart('m2'), ev('tool.awaiting', { key: 'k-mcp' })]);
  assert.equal(state.pending.m1.awaitingApproval, false);
  assert.equal(state.pending.m2.awaitingApproval, true);
});

test('a failed MCP call is no longer pending', () => {
  const state = reduce([mcpStart('m1'), ev('tool.end', { toolUseId: 'm1', ok: false })]);
  assert.deepEqual(state.pending, {});
});

test('turn end (Stop, cancel, new prompt) clears everything pending', () => {
  const state = reduce([mcpStart('m1'), artifactStart('w1', 'design'), ev('tool.awaiting', { key: 'k-design' }), ev('turn.end')]);
  assert.deepEqual(state.pending, {});
  assert.equal(state.marks.design, undefined);
});

test('a cancelled MCP call is dropped', () => {
  const state = reduce([mcpStart('m1', { callId: 'call-m1' }), ev('tool.cancelled', { callId: 'call-m1' })]);
  assert.deepEqual(state.pending, {});
});

test('session resume drops calls from the previous process but keeps the flow', () => {
  const state = reduce([
    ev('phase', { phase: 'propose' }),
    ev('change', { change: 'add-auth', root: '/p' }),
    mcpStart('m1'),
    ev('session.start', { source: 'resume' }),
  ]);
  assert.equal(state.phase, 'propose');
  assert.equal(state.change, 'add-auth');
  assert.deepEqual(state.pending, {});
});

test('session end marks the state ended', () => {
  assert.equal(reduce([ev('phase', { phase: 'explore' }), ev('session.end')]).ended, true);
});

test('notices queue once and disappear when flushed', () => {
  const state = reduce([
    ev('notice', { id: 'n1', text: '✓ opsx: design.md принят' }),
    ev('notice', { id: 'n1', text: 'duplicate' }),
    ev('notice', { id: 'n2', text: '✓ opsx: tasks.md принят' }),
    ev('notice.flushed', { ids: ['n1'] }),
  ]);
  assert.deepEqual(state.notices, [{ id: 'n2', text: '✓ opsx: tasks.md принят' }]);
});

test('state after a snapshot equals the state before compaction', () => {
  const events = [
    ev('phase', { phase: 'propose' }),
    ev('change', { change: 'add-auth', root: '/p' }),
    ev('artifact.current', { artifact: 'specs' }),
    artifactStart('w1', 'design'),
    ev('tool.cancelled', { callId: 'call-w1' }),
    mcpStart('m1'),
    ev('notice', { id: 'n1', text: 'hello' }),
  ];
  const before = reduce(events);
  const after = reduce([{ type: 'snapshot', at: clock, state: before }]);
  assert.deepEqual(after, before);
  const tail = ev('tool.end', { toolUseId: 'm1', ok: true, durationMs: 5 });
  assert.deepEqual(applyEvent(after, tail), applyEvent(before, tail));
});

test('unknown events are ignored', () => {
  assert.deepEqual({ ...reduce([ev('weird')]), updatedAt: 0 }, initialState());
});
