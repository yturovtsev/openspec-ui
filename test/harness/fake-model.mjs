#!/usr/bin/env node
// @ts-check
// Scripted OpenAI-compatible chat endpoint used to drive a real Qwen Code
// session without a real model (payload capture and end-to-end checks).
//
//   node test/harness/fake-model.mjs <scenario.json> [--port 0] [--log requests.jsonl]
//
// scenario.json: { "steps": [ { "tool_calls": [{ "name": "...", "arguments": {...} }] }, { "text": "..." } ] }
// A main-agent request gets step N, where N is the number of assistant
// messages already in its history. Side requests (titles, summaries,
// background agents) get a short text reply so they never consume a step.

import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const scenarioPath = args[0];
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
if (!scenarioPath) {
  process.stderr.write('usage: fake-model.mjs <scenario.json> [--port N] [--log file]\n');
  process.exit(2);
}
const port = Number(flag('--port') ?? 0);
const logPath = flag('--log');

function loadSteps() {
  // Re-read on every request so a driver can swap scenarios mid-session.
  return JSON.parse(readFileSync(scenarioPath, 'utf8')).steps ?? [];
}

function pickReply(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  // Background agents (auto-memory and the like) also get tools, but only the
  // main agent is offered `skill`; everyone else must not consume a step.
  if (!tools.some((t) => t.function?.name === 'skill')) return { text: 'ok' };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const index = messages.filter((m) => m.role === 'assistant').length;
  return loadSteps()[index] ?? { text: 'done' };
}

function toolCalls(step) {
  return (step.tool_calls ?? []).map((call, i) => ({
    index: i,
    id: `call_${Date.now()}_${i}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }));
}

function send(res, body, step) {
  const created = Math.floor(Date.now() / 1000);
  const calls = toolCalls(step);
  const finish = calls.length ? 'tool_calls' : 'stop';
  const message = calls.length
    ? { role: 'assistant', content: null, tool_calls: calls }
    : { role: 'assistant', content: step.text ?? '' };
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fake', object: 'chat.completion', created, model: body.model,
      choices: [{ index: 0, message, finish_reason: finish }], usage,
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunk = (choice, extra = {}) =>
    res.write(`data: ${JSON.stringify({
      id: 'chatcmpl-fake', object: 'chat.completion.chunk', created, model: body.model,
      choices: [choice], ...extra,
    })}\n\n`);
  chunk({ index: 0, delta: message, finish_reason: null });
  chunk({ index: 0, delta: {}, finish_reason: finish }, { usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {}
    const step = pickReply(body);
    if (logPath) {
      appendFileSync(logPath, JSON.stringify({
        at: new Date().toISOString(), url: req.url,
        tools: process.env.FAKE_LOG_SCHEMAS ? body.tools : (body.tools ?? []).map((t) => t.function?.name),
        assistantTurns: (body.messages ?? []).filter((m) => m.role === 'assistant').length,
        lastMessage: (body.messages ?? []).at(-1),
        ...(process.env.FAKE_LOG_FULL ? { messages: body.messages } : {}),
        reply: step,
      }) + '\n');
    }
    send(res, body, step);
  });
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${typeof address === 'object' && address ? address.port : port}\n`);
});
