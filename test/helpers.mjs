// @ts-check
// Shared test helpers (not a test file: the test script only runs *.test.mjs).

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = join(REPO, 'bin', 'opsx-ui.mjs');

/** @param {string} [prefix] */
export function tempDir(prefix = 'opsx-ui-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Writes files relative to root; values that are not strings are JSON-encoded.
 * @param {string} root
 * @param {Record<string, unknown>} files
 */
export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

/**
 * Loads a captured Qwen payload and re-roots `/work/proj` into a real directory.
 * @param {string} name fixture name without .json
 * @param {{ project?: string, sessionId?: string }} [options]
 */
export function fixture(name, { project, sessionId } = {}) {
  let text = readFileSync(join(REPO, 'test', 'fixtures', 'payloads', `${name}.json`), 'utf8');
  if (project) text = text.split('/work/proj').join(project);
  const payload = JSON.parse(text);
  if (sessionId) payload.session_id = sessionId;
  return payload;
}
