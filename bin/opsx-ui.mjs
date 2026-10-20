#!/usr/bin/env node
// @ts-check
// Entry point for the qwen-opsx-ui extension. Qwen runs it as a hook command
// and as the status line command; users run `setup` once per project.

const HELP = `opsx-ui — OpenSpec UI for Qwen Code

Usage:
  opsx-ui hook <EventName>        handle a Qwen hook event (JSON on stdin)
  opsx-ui statusline [--scope project|user]
                                  render the status line (Qwen payload on stdin)
  opsx-ui setup [--user] [--force] [--remove]
                                  install or remove the status line in Qwen settings
  opsx-ui --help                  show this help
`;

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'hook': {
      const { runHook } = await import('../src/hooks/index.mjs');
      return runHook(rest[0]);
    }
    case 'statusline': {
      const { runStatusline } = await import('../src/statusline/index.mjs');
      return runStatusline(rest);
    }
    case 'setup': {
      const { runSetup } = await import('../src/setup.mjs');
      return runSetup(rest);
    }
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`opsx-ui: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  },
  (error) => {
    // Hooks and the status line must never surface a stack trace to Qwen;
    // they handle their own errors. Anything reaching here is a setup bug.
    process.stderr.write(`opsx-ui: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
