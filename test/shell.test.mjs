import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeShell, parseCommands } from '../src/openspec/shell.mjs';

const CWD = '/work/proj';
const CH = '/work/proj/openspec/changes/add-auth';

const cases = [
  // OpenSpec CLI calls
  ['new change', 'openspec new change "add-auth"', { changes: ['add-auth'], openspec: true }],
  ['new change single quotes', "openspec new change 'add-auth' --schema spec-driven", { changes: ['add-auth'], openspec: true }],
  ['--change flag', 'openspec status --change "fix-login" --json', { changes: ['fix-login'], openspec: true }],
  ['--change= flag', 'openspec status --change=fix-login --json', { changes: ['fix-login'], openspec: true }],
  ['instructions', 'openspec instructions design --change "add-auth" --json', {
    changes: ['add-auth'], instructions: [{ artifact: 'design', change: 'add-auth' }], openspec: true,
  }],
  ['instructions apply', 'openspec instructions apply --change add-auth --json', {
    changes: ['add-auth'], instructions: [{ artifact: 'apply', change: 'add-auth' }], openspec: true,
  }],
  ['archive positional', 'openspec archive add-auth -y', { changes: ['add-auth'], openspec: true }],
  ['npx wrapper', 'npx -y @fission-ai/openspec@latest status --change add-auth', { changes: ['add-auth'], openspec: true }],
  ['env + path binary', 'FORCE_COLOR=0 ./node_modules/.bin/openspec status --change add-auth', { changes: ['add-auth'], openspec: true }],
  ['chain', 'cd /work/proj && openspec new change "a" && openspec status --change "a" --json', { changes: ['a', 'a'], openspec: true }],
  ['openspec output redirect is not an artifact write', `openspec instructions proposal --change add-auth --json > ${CH}/proposal.md`, {
    changes: ['add-auth'], instructions: [{ artifact: 'proposal', change: 'add-auth' }], openspec: true,
  }],
  ['not openspec', 'openspecs status --change x', {}],
  ['--change in another tool', 'git log --change x', {}],

  // Writes
  ['redirect >', `echo hi > ${CH}/proposal.md`, { writes: [`${CH}/proposal.md`] }],
  ['redirect >> relative', 'echo hi >> openspec/changes/add-auth/tasks.md', { writes: [`${CH}/tasks.md`] }],
  ['quoted target', 'printf "x" > "openspec/changes/add-auth/design.md"', { writes: [`${CH}/design.md`] }],
  ['heredoc', 'cat > openspec/changes/add-auth/tasks.md <<EOF\n## 1. Do\n- [ ] 1.1 x > y.md\nrm -rf /\nEOF', { writes: [`${CH}/tasks.md`] }],
  ['quoted heredoc then command', "cat > a.md <<'EOF'\n> not a redirect\nEOF\necho ok > b.md", { writes: ['/work/proj/a.md', '/work/proj/b.md'] }],
  ['heredoc <<-', 'cat <<-END > x.md\n\tline\n\tEND\necho done', { writes: ['/work/proj/x.md'] }],
  ['tee', `echo x | tee -a ${CH}/design.md /tmp/other`, { writes: [`${CH}/design.md`, '/tmp/other'] }],
  ['sudo tee', 'echo x | sudo tee openspec/changes/add-auth/design.md', { writes: [`${CH}/design.md`] }],
  ['cp', 'cp -f draft.md openspec/changes/add-auth/proposal.md', { writes: [`${CH}/proposal.md`] }],
  ['mv into directory with -t', 'mv -t openspec/changes/add-auth draft/design.md', { writes: [`${CH}/design.md`] }],
  ['cp --target-directory=', 'cp --target-directory=openspec/changes/add-auth a/tasks.md b/design.md', { writes: [`${CH}/tasks.md`, `${CH}/design.md`] }],
  ['cd then relative write', 'cd openspec/changes/add-auth && echo x > design.md', { writes: [`${CH}/design.md`] }],
  ['cd to variable makes relative paths unknown', 'cd "$DIR" && echo x > design.md', {}],
  ['variable target ignored', 'echo x > "$CHANGE/design.md"', {}],
  ['substitution target ignored', 'echo x > $(pwd)/design.md', {}],
  ['stderr dup ignored', 'make 2>&1 | tee build.log', { writes: ['/work/proj/build.log'] }],
  ['fd redirect counts', 'cmd 2> openspec/changes/add-auth/err.md', { writes: [`${CH}/err.md`] }],
  ['input redirect ignored', 'wc -l < openspec/changes/add-auth/tasks.md', {}],
  ['comment ignored', '# echo x > design.md\necho y', {}],
  ['single cp arg is not a write', 'cp --help', {}],
  ['line continuation', 'echo hi \\\n  > openspec/changes/add-auth/design.md', { writes: [`${CH}/design.md`] }],
];

for (const [name, command, expected] of cases) {
  test(`analyzeShell: ${name}`, () => {
    const result = analyzeShell(command, CWD);
    assert.deepEqual(result, { changes: [], instructions: [], writes: [], openspec: false, ...expected });
  });
}

test('parseCommands splits on operators and keeps redirects', () => {
  const commands = parseCommands('A=1 echo "a b" > out.txt; ls | wc -l && true');
  assert.deepEqual(commands.map((c) => c.argv), [['echo', 'a b'], ['ls'], ['wc', '-l'], ['true']]);
  assert.deepEqual(commands[0].redirects, [{ op: '>', target: 'out.txt', literal: true }]);
});

test('long heredoc commands stay fast', () => {
  const body = Array.from({ length: 20000 }, (_, i) => `- [ ] ${i} task with > and | characters`).join('\n');
  const started = Date.now();
  const result = analyzeShell(`cat > openspec/changes/add-auth/tasks.md <<'EOF'\n${body}\nEOF`, CWD);
  assert.deepEqual(result.writes, [`${CH}/tasks.md`]);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('garbage input never throws', () => {
  for (const s of ['', '"unterminated', "'x", '$(', '`', '<<', '>', '\\', undefined, null]) {
    assert.doesNotThrow(() => analyzeShell(/** @type {any} */ (s), CWD));
  }
});
