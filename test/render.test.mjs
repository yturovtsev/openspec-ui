import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activity, renderFlow, renderIdle, visibleLength } from '../src/statusline/render.mjs';
import { initialState } from '../src/state/reducer.mjs';

const NOW = 1_800_000_000_000;
const SPEC_DRIVEN = {
  artifacts: [
    { id: 'proposal', status: 'done' },
    { id: 'specs', status: 'done' },
    { id: 'design', status: 'ready' },
    { id: 'tasks', status: 'blocked' },
  ],
};
const state = (patch = {}) => ({ ...initialState(), phase: 'propose', change: 'add-auth', root: '/p', ...patch });
const mcp = (startedAt, extra = {}) => ({ kind: 'mcp', toolName: 'mcp__context7__get-library-docs', key: 'k', server: 'context7', tool: 'get-library-docs', startedAt, awaitingApproval: false, ...extra });
const render = (patch = {}, input = {}) => renderFlow({ state: state(patch), status: SPEC_DRIVEN, now: NOW, width: 100, color: false, ...input });

test('propose in progress: step, change, artifact statuses', () => {
  assert.deepEqual(render({ currentArtifact: 'design' }), [
    'opsx  explore › ● propose › apply › archive   add-auth',
    'proposal ✓  specs ✓  design ◐  tasks ·   пишется design',
  ]);
});

test('update rides on the propose step; sync on archive', () => {
  assert.match(render({ phase: 'update' })[0], /● propose \(update\)/);
  assert.match(render({ phase: 'sync' })[0], /● archive \(sync\)/);
  assert.match(render({ phase: 'explore' })[0], /^opsx {2}● explore › propose/);
});

test('only the artifacts of the change schema are shown', () => {
  const status = { artifacts: [{ id: 'proposal', status: 'done' }, { id: 'tasks', status: 'ready' }] };
  assert.equal(render({}, { status })[1], 'proposal ✓  tasks ○');
});

test('skipped, rejected and awaiting artifacts', () => {
  const status = { artifacts: [{ id: 'proposal', status: 'done' }, { id: 'specs', status: 'skipped' }, { id: 'design', status: 'ready' }, { id: 'tasks', status: 'ready' }] };
  assert.equal(render({ marks: { design: 'rejected', tasks: 'awaiting' } }, { status })[1].split('   ')[0], 'proposal ✓  specs –  design ✗  tasks ⚠');
});

test('MCP wait shows server, tool and seconds, ticking every second', () => {
  const pending = { m1: mcp(NOW - 8000) };
  assert.match(render({ pending })[1], /⏳ context7›get-library-docs 8s$/);
  assert.match(render({ pending }, { now: NOW + 1000 })[1], /get-library-docs 9s$/);
});

test('several MCP calls: the oldest plus a count', () => {
  const pending = { a: mcp(NOW - 3000, { server: 'b', tool: 'two' }), b: mcp(NOW - 9000), c: mcp(NOW - 1000, { server: 'c' }) };
  assert.match(render({ pending })[1], /⏳ context7›get-library-docs 9s \+2$/);
});

test('approval beats MCP and the artifact in progress', () => {
  const pending = {
    m1: mcp(NOW - 5000),
    w1: { kind: 'artifact', toolName: 'write_file', key: 'k2', artifact: 'design', startedAt: NOW - 1000, awaitingApproval: true },
  };
  const [, row2] = render({ pending, currentArtifact: 'design', marks: { design: 'awaiting' } });
  assert.match(row2, /design ⚠/);
  assert.match(row2, /⚠ подтвердите design в диалоге$/);
  assert.equal(activity({ state: state({ pending }), now: NOW }).kind, 'approval');
});

test('an MCP call waiting for permission says so', () => {
  assert.match(render({ pending: { m1: mcp(NOW - 5000, { awaitingApproval: true }) } })[1], /подтвердите context7›get-library-docs в диалоге/);
});

test('explore without a change', () => {
  assert.deepEqual(render({ phase: 'explore', change: null }, { status: null }), [
    'opsx  ● explore › propose › apply › archive',
    'нет активного change',
  ]);
});

test('apply shows task progress', () => {
  assert.equal(render({ phase: 'apply' }, { tasks: { done: 5, total: 12 } })[1], 'задачи 5/12');
});

test('status unavailable keeps phase, change and activity', () => {
  const [row1, row2] = render({ pending: { m1: mcp(NOW - 2000) } }, { status: null, statusUnavailable: true });
  assert.match(row1, /add-auth$/);
  assert.equal(row2, 'статус недоступен   ⏳ context7›get-library-docs 2s');
});

test('a long change name is shortened first, then step labels', () => {
  const change = 'add-a-really-long-change-name-that-does-not-fit-anywhere-at-all';
  const [row1] = render({ change }, { width: 60 });
  assert.equal(visibleLength(row1), 60);
  // Enough room for the full step labels: only the change name shrinks.
  assert.equal(row1, 'opsx  explore › ● propose › apply › archive   add-a-really-…');
  const [narrow] = render({ change }, { width: 40 });
  assert.ok(visibleLength(narrow) <= 40);
  assert.match(narrow, /^opsx {2}e › ● p › a › a {3}add-a-re/);
  assert.match(narrow, /…$/);
});

test('change name is kept whole when it fits', () => {
  assert.match(render({}, { width: 60 })[0], /archive {3}add-auth$/);
});

test('NO_COLOR output has no ANSI codes; colour output does', () => {
  const plain = render({ currentArtifact: 'design' }, { color: false }).join('\n');
  assert.equal(/\x1b\[/.test(plain), false);
  for (const glyph of ['✓', '◐', '·']) assert.ok(plain.includes(glyph));
  const colored = render({ currentArtifact: 'design' }, { color: true }).join('\n');
  assert.ok(/\x1b\[32m✓/.test(colored));
});

test('never more than two rows and never wider than the width', () => {
  const ids = ['proposal', 'specs', 'design', 'tasks', 'research', 'review', 'notes'];
  let seed = 7;
  const rand = (n) => (seed = (seed * 48271) % 2147483647) % n;
  for (let i = 0; i < 300; i++) {
    const width = 40 + rand(100);
    const artifacts = ids.slice(0, 1 + rand(ids.length)).map((id) => ({ id: `${id}${rand(2) ? '-extra-long-name' : ''}`, status: ['done', 'ready', 'blocked', 'skipped'][rand(4)] }));
    const pending = Object.fromEntries(Array.from({ length: rand(4) }, (_, k) => [`m${k}`, mcp(NOW - rand(100000), { server: 'server-with-a-long-name', awaitingApproval: rand(5) === 0 })]));
    const rows = renderFlow({
      state: state({ phase: ['explore', 'propose', 'update', 'apply', 'sync', 'archive'][rand(6)], change: rand(5) ? 'change-' + 'x'.repeat(rand(80)) : null, pending, currentArtifact: artifacts[0].id }),
      status: rand(6) ? { artifacts } : null,
      statusUnavailable: rand(2) === 0,
      tasks: rand(2) ? { done: rand(10), total: 10 } : null,
      now: NOW,
      width,
      color: rand(2) === 0,
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.includes('\n'), false);
      assert.ok(visibleLength(row) <= width, `row is ${visibleLength(row)} > ${width}: ${row}`);
    }
  }
});

test('idle row: project, branch, model, context', () => {
  assert.equal(renderIdle({ project: 'proj', branch: 'main', model: 'qwen3-coder', contextUsed: 23.4, width: 100, color: false }), 'proj · ⎇ main · qwen3-coder · ctx 23%');
  assert.equal(renderIdle({ project: 'proj', width: 100, color: false }), 'proj');
  assert.ok(visibleLength(renderIdle({ project: 'p'.repeat(200), width: 50, color: true })) <= 50);
});
