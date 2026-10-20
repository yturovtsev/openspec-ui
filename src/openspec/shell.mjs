// @ts-check
// Conservative reading of `run_shell_command` strings: which OpenSpec CLI
// calls they make and which files they write via >, >>, tee, cp or mv.
// Anything it cannot read with confidence (variables, substitutions, nested
// shells) is ignored rather than guessed.

import { basename, isAbsolute, resolve } from 'node:path';

/**
 * @typedef {{ type: 'word', value: string, literal: boolean }
 *   | { type: 'op', value: string }
 *   | { type: 'redir', value: string }} Token
 * @typedef {{ argv: string[], literal: boolean[], redirects: { op: string, target: string, literal: boolean }[] }} SimpleCommand
 */

const TWO_CHAR_OPS = ['&&', '||', '|&', ';;'];
const ONE_CHAR_OPS = [';', '|', '&', '(', ')'];
const REDIRECT = /(\d*)(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/y;
const WORD_END = new Set([' ', '\t', '\n', ';', '|', '&', '(', ')', '<', '>']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'time', 'nohup']);

/**
 * @param {string} src
 * @returns {Token[]}
 */
export function tokenize(src) {
  /** @type {Token[]} */
  const tokens = [];
  /** @type {{ delimiter: string, stripTabs: boolean }[]} */
  const heredocs = [];
  let i = 0;
  const n = src.length;

  const readWord = () => {
    let value = '';
    let literal = true;
    while (i < n && !WORD_END.has(src[i])) {
      const c = src[i];
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        const stop = end === -1 ? n : end;
        value += src.slice(i + 1, stop);
        i = stop + 1;
      } else if (c === '"') {
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < n && '"\\$`\n'.includes(src[i + 1])) {
            value += src[i + 1];
            i += 2;
          } else {
            if (src[i] === '$' || src[i] === '`') literal = false;
            value += src[i++];
          }
        }
        i++;
      } else if (c === '\\') {
        if (src[i + 1] !== '\n') value += src[i + 1] ?? '';
        i += 2;
      } else if (c === '$' && src[i + 1] === '(') {
        literal = false;
        let depth = 0;
        const start = i;
        for (; i < n; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')' && --depth === 0) {
            i++;
            break;
          }
        }
        value += src.slice(start, i);
      } else if (c === '`') {
        literal = false;
        const end = src.indexOf('`', i + 1);
        const stop = end === -1 ? n : end + 1;
        value += src.slice(i, stop);
        i = stop;
      } else {
        if (c === '$' || c === '*' || c === '?' || (c === '~' && value === '')) literal = false;
        value += c;
        i++;
      }
    }
    return { value, literal };
  };

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      tokens.push({ type: 'op', value: '\n' });
      i++;
      // Heredoc bodies are data, not commands.
      for (const { delimiter, stripTabs } of heredocs.splice(0)) {
        while (i < n) {
          const end = src.indexOf('\n', i);
          const line = src.slice(i, end === -1 ? n : end);
          i = end === -1 ? n : end + 1;
          if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
        }
      }
      continue;
    }
    if (c === '#' && (tokens.length === 0 || tokens.at(-1)?.type === 'op')) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    REDIRECT.lastIndex = i;
    const redirect = REDIRECT.exec(src);
    if (redirect && (redirect[1] === '' || /[<>]/.test(src[i + redirect[1].length]))) {
      const op = redirect[2];
      i += redirect[0].length;
      tokens.push({ type: 'redir', value: op });
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        const { value } = readWord();
        heredocs.push({ delimiter: value, stripTabs: op === '<<-' });
        tokens.push({ type: 'word', value, literal: true });
      }
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    const { value, literal } = readWord();
    tokens.push({ type: 'word', value, literal });
  }
  return tokens;
}

/**
 * @param {string} src
 * @returns {SimpleCommand[]}
 */
export function parseCommands(src) {
  /** @type {SimpleCommand[]} */
  const commands = [];
  /** @type {SimpleCommand} */
  let current = { argv: [], literal: [], redirects: [] };
  const flush = () => {
    if (current.argv.length || current.redirects.length) commands.push(current);
    current = { argv: [], literal: [], redirects: [] };
  };
  const tokens = tokenize(src);
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type === 'op') {
      flush();
    } else if (token.type === 'redir') {
      const next = tokens[k + 1];
      if (next?.type === 'word') {
        current.redirects.push({ op: token.value, target: next.value, literal: next.literal });
        k++;
      }
    } else if (current.argv.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      // Leading NAME=value assignments are not the command.
    } else {
      current.argv.push(token.value);
      current.literal.push(token.literal);
    }
  }
  flush();
  return commands;
}

/**
 * Drops wrappers such as `sudo`, `env A=1`, `npx -y`, `pnpm exec`.
 * @param {SimpleCommand} command
 */
function unwrap(command) {
  let { argv, literal } = command;
  let changed = true;
  while (changed && argv.length) {
    changed = false;
    const head = argv[0];
    let skip = 0;
    if (WRAPPERS.has(head)) skip = 1;
    else if (head === 'env') {
      skip = 1;
      while (skip < argv.length && (argv[skip].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[skip]))) skip++;
    } else if (head === 'npx' || head === 'bunx' || head === 'pnpx') {
      skip = 1;
      while (skip < argv.length && argv[skip].startsWith('-')) skip++;
    } else if ((head === 'pnpm' || head === 'yarn' || head === 'npm') && ['exec', 'dlx', 'x'].includes(argv[1])) {
      skip = 2;
      while (skip < argv.length && argv[skip].startsWith('-')) skip++;
      if (argv[skip] === '--') skip++;
    }
    if (skip) {
      argv = argv.slice(skip);
      literal = literal.slice(skip);
      changed = true;
    }
  }
  return { argv, literal };
}

/** @param {string | undefined} word */
function isOpenspecBinary(word) {
  if (!word) return false;
  const name = basename(word).replace(/@[^/]*$/, '');
  return name === 'openspec' || word.replace(/@[\d^~][^/]*$/, '') === '@fission-ai/openspec';
}

/**
 * @typedef {object} ShellAnalysis
 * @property {string[]} changes       change names referenced, in order
 * @property {{ artifact: string, change: string | null }[]} instructions  `openspec instructions <id>` calls
 * @property {string[]} writes        absolute paths written outside the OpenSpec CLI
 * @property {boolean} openspec       whether any OpenSpec CLI call was made
 */

/**
 * @param {string} command
 * @param {string} cwd  directory the shell starts in
 * @returns {ShellAnalysis}
 */
export function analyzeShell(command, cwd) {
  /** @type {ShellAnalysis} */
  const result = { changes: [], instructions: [], writes: [], openspec: false };
  /** @type {string | null} */
  let dir = cwd;
  const target = (/** @type {string} */ path, /** @type {boolean} */ literal) => {
    if (!literal || !path || path.startsWith('&')) return;
    if (isAbsolute(path)) result.writes.push(resolve(path));
    else if (dir) result.writes.push(resolve(dir, path));
  };

  for (const raw of parseCommands(String(command ?? ''))) {
    const { argv, literal } = unwrap(raw);
    const head = argv[0];
    if (head === 'cd') {
      // After a cd we cannot follow (variables, ~, -), relative paths are unknown.
      const to = argv[1];
      if (!to || !literal[1] || to === '-') dir = null;
      else if (isAbsolute(to)) dir = resolve(to);
      else dir = dir ? resolve(dir, to) : null;
      continue;
    }
    if (isOpenspecBinary(head)) {
      result.openspec = true;
      readOpenspecCall(argv.slice(1), result);
      continue; // the CLI's own output files are never artifact writes
    }
    for (const r of raw.redirects) if (OUTPUT_REDIRECTS.has(r.op)) target(r.target, r.literal);
    const args = argv.slice(1);
    const lits = literal.slice(1);
    if (head === 'tee') {
      args.forEach((a, k) => !a.startsWith('-') && target(a, lits[k]));
    } else if (head === 'cp' || head === 'mv') {
      let destDir = null;
      let destLiteral = true;
      /** @type {{ path: string, literal: boolean }[]} */
      const positional = [];
      for (let k = 0; k < args.length; k++) {
        if (args[k] === '-t' || args[k] === '--target-directory') {
          destDir = args[k + 1] ?? null;
          destLiteral = lits[k + 1] ?? false;
          k++;
        } else if (args[k].startsWith('--target-directory=')) {
          destDir = args[k].slice('--target-directory='.length);
          destLiteral = lits[k];
        } else if (!args[k].startsWith('-')) {
          positional.push({ path: args[k], literal: lits[k] });
        }
      }
      if (destDir !== null) {
        for (const source of positional) target(`${destDir}/${basename(source.path)}`, destLiteral && source.literal);
      } else if (positional.length >= 2) {
        const dest = /** @type {{ path: string, literal: boolean }} */ (positional.at(-1));
        target(dest.path, dest.literal);
      }
    }
  }
  return result;
}

/**
 * @param {string[]} args  arguments after the openspec binary
 * @param {ShellAnalysis} result
 */
function readOpenspecCall(args, result) {
  let change = null;
  for (let k = 0; k < args.length; k++) {
    if (args[k] === '--change' && args[k + 1]) change = args[k + 1];
    else if (args[k].startsWith('--change=')) change = args[k].slice('--change='.length);
  }
  const positional = args.filter((a, k) => !a.startsWith('-') && !(k > 0 && ['--change', '--schema', '--store'].includes(args[k - 1])));
  const [sub, first, second] = positional;
  if (sub === 'new' && first === 'change' && second) change = second;
  if (sub === 'archive' && first && !change) change = first;
  if (change) result.changes.push(change);
  if (sub === 'instructions' && first) result.instructions.push({ artifact: first, change });
}
