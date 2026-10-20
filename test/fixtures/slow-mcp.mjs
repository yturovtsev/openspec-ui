#!/usr/bin/env node
// @ts-check
// Minimal stdio MCP server with one tool, `wait`, that answers after N seconds.
// Used to see the "waiting for MCP" timer in the status line. Configure it in a
// test project's .qwen/settings.json only; the extension declares no MCP servers.

import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'wait',
    description: 'Waits the given number of seconds, then replies.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Delay in seconds' } },
    },
  },
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'slow', version: '1.0.0' },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const seconds = Math.max(0, Number(params?.arguments?.seconds ?? 3));
      setTimeout(() => reply(id, { content: [{ type: 'text', text: `waited ${seconds}s` }] }), seconds * 1000);
      return;
    }
    default:
      return fail(id, `Method not found: ${method}`);
  }
});
