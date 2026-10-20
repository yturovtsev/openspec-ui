#!/usr/bin/env node
// @ts-check
// End-to-end check in a real Qwen Code TUI, driven by the scripted fake model
// (test/harness/fake-model.mjs) through a pseudo-terminal
// (test/harness/tui-driver.py). Follows the README from scratch in a
// throwaway HOME and project, then walks the checklist in CHECKLIST.md.
//
//   QWEN_BIN=/path/to/qwen npm run e2e      (needs python3 and openspec on PATH)

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QWEN = process.env.QWEN_BIN || 'qwen';
const WORK = mkdtempSync(join(tmpdir(), 'opsx-e2e-'));
const HOME = join(WORK, 'home');
const PROJ = join(WORK, 'proj');
const CHANGE = 'e2e-change';
const CH = join(PROJ, 'openspec', 'changes', CHANGE);
const ENV = { ...process.env, HOME, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' };
delete ENV.OPSX_UI_APPROVAL;
delete ENV.OPSX_UI_HOME;
delete ENV.NO_COLOR;

/** @type {{ item: string, ok: boolean, detail: string }[]} */
const results = [];
const check = (item, ok, detail = '') => {
  results.push({ item, ok: !!ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${item}${detail ? `  — ${detail}` : ''}\n`);
};

/** @param {string} cmd @param {string[]} args @param {object} [opts] */
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { env: ENV, encoding: 'utf8', ...opts });

const shell = (command) => ({ tool_calls: [{ name: 'run_shell_command', arguments: { command, description: command.split(' ').slice(0, 3).join(' ') } }] });
const write = (file, content) => ({ tool_calls: [{ name: 'write_file', arguments: { file_path: file, content } }] });
const read = (file) => ({ tool_calls: [{ name: 'read_file', arguments: { file_path: file } }] });
const edit = (file, old_string, new_string) => ({ tool_calls: [{ name: 'edit', arguments: { file_path: file, old_string, new_string } }] });
const mcpWait = (seconds) => [
  { tool_calls: [{ name: 'tool_search', arguments: { query: 'select:mcp__slow__wait' } }] },
  { tool_calls: [{ name: 'tool_call', arguments: { name: 'mcp__slow__wait', arguments: { seconds } } }] },
];
const text = (t) => ({ text: t });
const approveServer = { until: 'Approve this server', timeout: 8, then: '\r' };
const type = (line) => [{ send: line }, { wait: 1.5 }, { send: '\r' }];

/**
 * Runs one TUI session against a scripted model; resolves with the screen log.
 * @param {string} name
 * @param {{ steps: object[], actions: object[], args?: string[], logFull?: boolean }} scenario
 */
async function session(name, { steps, actions, args = [], logFull = false }) {
  const dir = join(WORK, 'runs', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps }));
  writeFileSync(join(dir, 'actions.json'), JSON.stringify(actions));
  const model = spawn(process.execPath, [join(REPO, 'test/harness/fake-model.mjs'), join(dir, 'scenario.json'), '--log', join(dir, 'requests.jsonl')], {
    env: { ...ENV, ...(logFull ? { FAKE_LOG_FULL: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve) => model.stdout.once('data', (d) => resolve(String(d).trim())));
  const screen = join(dir, 'screen.txt');
  await new Promise((resolve) => {
    const driver = spawn('python3', ['-I', join(REPO, 'test/harness/tui-driver.py'), join(dir, 'actions.json'), screen, '--',
      QWEN, '--auth-type', 'openai', '--openai-api-key', 'test', '--openai-base-url', `http://127.0.0.1:${port}/v1`, '-m', 'fake-model', ...args],
    { cwd: PROJ, env: ENV, stdio: 'inherit' });
    driver.on('exit', resolve);
  });
  model.kill();
  return {
    screen: existsSync(screen) ? readFileSync(screen, 'utf8') : '',
    requests: existsSync(join(dir, 'requests.jsonl')) ? readFileSync(join(dir, 'requests.jsonl'), 'utf8') : '',
  };
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

async function main() {
  const version = sh(QWEN, ['--version']).stdout.trim();
  const openspecVersion = sh('openspec', ['--version']).stdout.trim();
  process.stdout.write(`Qwen Code ${version || '?'}, OpenSpec ${openspecVersion || '?'}, work dir ${WORK}\n\n`);
  if (!version) throw new Error(`cannot run ${QWEN}; set QWEN_BIN`);

  // README, step by step, from scratch.
  mkdirSync(HOME, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  sh('git', ['init', '-q'], { cwd: PROJ });
  check('README: openspec init --tools qwen', sh('openspec', ['init', '--tools', 'qwen', '--no-animation', PROJ]).status === 0);
  sh('openspec', ['new', 'change', 'seed'], { cwd: PROJ });
  writeFileSync(join(PROJ, '.qwen', 'settings.json'), JSON.stringify({
    mcpServers: { slow: { command: 'node', args: [join(REPO, 'test/fixtures/slow-mcp.mjs')] } },
    ui: { statusLine: { type: 'command', command: 'echo PREV-STATUS-LINE' } },
  }, null, 2));
  const link = sh('/bin/sh', ['-c', `printf 'y\\n' | "${QWEN}" extensions link "${REPO}"`]);
  check('README: qwen extensions link', link.status === 0 && /linked successfully/.test(link.stdout + link.stderr));
  check('README: extension listed', /OpenSpec UI/.test(sh(QWEN, ['extensions', 'list']).stdout + ''));
  const setup = (...a) => sh(process.execPath, [join(REPO, 'bin/opsx-ui.mjs'), 'setup', ...a], { cwd: PROJ });
  const conflict = setup();
  check('setup refuses to replace a foreign status line without --force', conflict.status === 1 && /--force/.test(conflict.stdout));
  check('setup --force installs and keeps a backup', setup('--force').status === 0
    && JSON.parse(readFileSync(join(PROJ, '.qwen/opsx-ui.json'), 'utf8')).previousStatusLine?.command === 'echo PREV-STATUS-LINE');

  // 1. explore
  {
    const { screen } = await session('explore', {
      steps: [text('exploring the idea')],
      actions: [approveServer, { wait: 2 }, { mark: 'IDLE' }, ...type('/opsx-explore'), { until: 'exploring the idea', timeout: 30 }, { wait: 3 }],
      args: ['--approval-mode', 'default'],
    });
    const idle = screen.split('=== IDLE ===')[0];
    check('outside the flow the previous status line is shown', idle.includes('PREV-STATUS-LINE'));
    check('/opsx-explore highlights explore', screen.includes('● explore') && screen.includes('нет активного change'));
  }

  // 2. propose in YOLO: every artifact asks, MCP timer ticks, notices at Stop
  {
    const { screen } = await session('propose', {
      steps: [
        shell(`openspec new change "${CHANGE}"`),
        shell(`openspec instructions proposal --change "${CHANGE}" --json`),
        write(join(CH, 'proposal.md'), '## Why\n\nE2E.\n\n## What Changes\n\n- x\n'),
        ...mcpWait(4),
        shell(`openspec instructions design --change "${CHANGE}" --json`),
        shell('sleep 3'), // the fake model is instant; give the footer time to show "design ◐"
        write(join(CH, 'design.md'), '## Context\n\nE2E.\n'),
        text('propose-done'),
      ],
      actions: [
        approveServer, { wait: 2 }, ...type('/opsx-propose e2e'),
        { until: '«proposal»', timeout: 40 }, { wait: 1.5 }, { mark: 'PROPOSAL DIALOG' }, { send: '\r' },
        { until: '«design»', timeout: 60 }, { wait: 1.5 }, { mark: 'DESIGN DIALOG' }, { send: '\r' },
        { until: 'propose-done', timeout: 30 }, { wait: 4 },
      ],
      args: ['--approval-mode', 'yolo'],
    });
    check('/opsx-propose highlights propose with the change name', screen.includes('● propose') && screen.includes(CHANGE));
    check('YOLO: proposal write asks for confirmation', screen.includes('«proposal»') && screen.includes(`change ${CHANGE}`));
    check('YOLO: design write asks for confirmation', screen.includes('«design»'));
    check('artifact in progress shows ◐', /design ◐/.test(screen));
    check('accepted artifact shows ✓', /proposal ✓/.test(screen));
    const ticks = new Set([...screen.matchAll(/slow›wait (\d+)s/g)].map((m) => m[1]));
    check('MCP wait timer ticks', ticks.size >= 2, `seen: ${[...ticks].join(', ') || 'none'}`);
    check('Stop prints the accepted artifacts', screen.includes('✓ opsx: proposal.md принят') && screen.includes('✓ opsx: design.md принят'));
    check('artifacts were written after approval', existsSync(join(CH, 'proposal.md')) && existsSync(join(CH, 'design.md')));
  }

  // 3. resume restores phase and change
  {
    const { screen } = await session('resume', {
      steps: [text('resumed')],
      actions: [approveServer, { wait: 5 }],
      args: ['--continue', '--approval-mode', 'default'],
    });
    check('--continue restores phase and change in the footer', screen.includes('● propose') && screen.includes(CHANGE));
  }

  // 4. rejection: ✗ in the footer; the agent is told not to repeat the write
  {
    const { screen, requests } = await session('reject', {
      // No shell step here: auto-edit asks for shell commands, and only the artifact dialog is under test.
      steps: [write(join(CH, 'tasks.md'), '## 1. Do\n\n- [ ] 1.1 a\n'), text('after-reject')],
      actions: [approveServer, { wait: 2 }, ...type('/opsx-propose more'), { until: '«tasks»', timeout: 40 }, { wait: 1.5 }, { send: '\u001b' }, { wait: 5 }],
      args: ['--approval-mode', 'auto-edit'],
      logFull: true,
    });
    check('auto-edit: tasks write asks for confirmation', screen.includes('«tasks»'));
    check('rejected artifact shows ✗ and is no longer "being written"', /tasks ✗/.test(screen) && !/tasks ✗.*пишется tasks/.test(screen));
    check('rejected write did not touch the file', !existsSync(join(CH, 'tasks.md')));
    check('agent context asks not to repeat a rejected write', requests.includes('If an artifact write was not allowed'));
  }

  // 5. apply: task progress, no dialogs for ticking tasks off
  {
    writeFileSync(join(CH, 'tasks.md'), '## 1. Do\n\n- [ ] 1.1 a\n- [ ] 1.2 b\n- [ ] 1.3 c\n');
    const { screen } = await session('apply', {
      // Qwen refuses to edit a file that was not read in the session.
      steps: [shell(`openspec instructions apply --change "${CHANGE}" --json`), read(join(CH, 'tasks.md')), edit(join(CH, 'tasks.md'), '- [ ] 1.1 a', '- [x] 1.1 a'), text('apply-done')],
      actions: [approveServer, { wait: 2 }, ...type(`/opsx-apply ${CHANGE}`), { until: 'apply-done', timeout: 40 }, { wait: 3 }],
      args: ['--approval-mode', 'yolo'],
    });
    check('/opsx-apply highlights apply and shows task progress', screen.includes('● apply') && screen.includes('задачи 1/3'));
    check('ticking a task off does not ask', !screen.includes('OpenSpec: подтвердите') && readFileSync(join(CH, 'tasks.md'), 'utf8').includes('- [x] 1.1 a'));
  }

  // 6. two sessions in parallel stay isolated
  {
    const [a, b] = await Promise.all([
      session('parallel-a', { steps: [text('a-done')], actions: [approveServer, { wait: 2 }, ...type('/opsx-explore'), { until: 'a-done', timeout: 30 }, { wait: 4 }], args: ['--approval-mode', 'default'] }),
      session('parallel-b', { steps: [shell('openspec status --change "seed" --json'), text('b-done')], actions: [approveServer, { wait: 2 }, ...type('/opsx-propose b'), { until: 'b-done', timeout: 30 }, { wait: 4 }], args: ['--approval-mode', 'yolo'] }),
    ]);
    check('parallel session A sees only its own phase', a.screen.includes('● explore') && !a.screen.includes('● propose'));
    check('parallel session B sees only its own phase', b.screen.includes('● propose') && b.screen.includes('seed') && !b.screen.includes('● explore'));
  }

  // 7. setup --remove restores the previous status line
  {
    const removed = setup('--remove');
    const settings = JSON.parse(readFileSync(join(PROJ, '.qwen/settings.json'), 'utf8'));
    check('setup --remove restores the previous status line', removed.status === 0 && settings.ui.statusLine.command === 'echo PREV-STATUS-LINE');
    const { screen } = await session('after-remove', { steps: [text('x')], actions: [approveServer, { wait: 4 }], args: ['--approval-mode', 'default'] });
    check('after --remove the footer shows the previous status line again', screen.includes('PREV-STATUS-LINE') && !screen.includes('opsx  '));
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed. Screens and request logs: ${join(WORK, 'runs')}\n`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`e2e: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 2;
});
