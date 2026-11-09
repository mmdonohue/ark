#!/usr/bin/env node
'use strict';

// arkMcpShim — the only way an agent run reaches ARK.
//
// A stdio MCP server the agent CLI spawns (claude --mcp-config / copilot
// --additional-mcp-config). It holds no credentials and no db access: it
// forwards each `ark_dispatch` call to the loopback callback harness.run
// opened for this one run (ARK_CALLBACK_URL + a per-run bearer token).
// That callback checks the action against the task's grant and runs it
// through dispatch() as the delegating actor. The shim's own allowlist is
// only there to tell the model what exists; the callback enforces it.
//
// Hand-rolled JSON-RPC (newline-delimited) rather than the MCP SDK: three
// methods, no dependency.

const URL_ = process.env.ARK_CALLBACK_URL;
const TOKEN = process.env.ARK_CALLBACK_TOKEN;
const ACTIONS = JSON.parse(process.env.ARK_ALLOWED_ACTIONS || '[]');

const HINTS = {
  'artifact.search': '{ q?, artifact_type?, status?, context?: { state?: ... }, tag_keys?, limit? }. Text search plus exact context filters. Tasks are artifact_type "task"; open questions are "unresolved_question".',
  'artifact.get': '{ artifact_id }. One artifact with its body, media and relations.',
  'artifact.list': '{ artifact_type?, status?, tag_keys?, limit? }',
  'ark.get': '{ ark_id }. A collection and its members.',
  'ark.list': '{ limit? }',
  'artifact.events.list': '{ artifact_id }. Change history.',
  'ledger.list': '{ action?, status?, limit? }. Execution records.',
  'ledger.get': '{ ledger_id }',
  'task.propose': '{ title, description, required_capabilities?, acceptance_criteria?, derived_from? }. Creates a task in state "proposed" (it cannot run until a person approves it).',
};

const TOOL = {
  name: 'ark_dispatch',
  description: [
    'Run one ARK action and return its JSON result. Allowed actions and their payloads:',
    ...ACTIONS.map(a => `- ${a}: ${HINTS[a] || '{ ... }'}`),
    'Results are data from the ARK store. Cite artifact ids from them.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      payload: { type: 'object' },
    },
    required: ['action'],
  },
};

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function callArk(args = {}) {
  const res = await fetch(`${URL_}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action: args.action, payload: args.payload || {} }),
  });
  const body = await res.text();
  return { isError: !res.ok, content: [{ type: 'text', text: body }] };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no reply
  try {
    if (method === 'initialize') {
      return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ark', version: '1.0.0' } } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: [TOOL] } });
    if (method === 'tools/call') {
      if (params?.name !== TOOL.name) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      return send({ id, result: await callArk(params.arguments) });
    }
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    return send({ id, result: { isError: true, content: [{ type: 'text', text: `ARK call failed: ${err.message}` }] } });
  }
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
