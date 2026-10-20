#!/usr/bin/env node
// @ts-check
// Debug hook: stores the raw hook payload so fixtures come from real Qwen
// sessions. Configure it only in a throwaway project, never in the manifest.
//
//   node test/harness/capture-hook.mjs <EventName>   (OPSX_CAPTURE_DIR=<dir>)

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const event = process.argv[2] ?? 'Unknown';
const dir = process.env.OPSX_CAPTURE_DIR;
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const n = readdirSync(dir).filter((f) => f.startsWith(`${event}-`)).length + 1;
    writeFileSync(join(dir, `${event}-${String(n).padStart(2, '0')}.json`), raw);
  }
  process.stdout.write('{}');
});
