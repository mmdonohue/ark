'use strict';

// chatParser — parse chat export formats into a normalized structure.
//
// Supported sources:
//   'chatgpt' — conversations.json from ChatGPT data export
//   (future: 'claude', 'generic')
//
// Output per conversation:
//   {
//     id, title, source,
//     started_at,   — conv.create_time (first message)
//     updated_at,   — conv.update_time (last message)
//     messages: [{
//       id, role, body, sequence, created_at,
//       model_slug,   — assistant messages only, from msg.metadata.model_slug
//       source_hash,
//     }]
//   }

const crypto = require('crypto');

// ── Public API ────────────────────────────────────────────────────────────────

// parseExport(raw, source) — parse a full export file.
// raw    : parsed JSON (array of conversations, or single conversation object)
// source : 'chatgpt' | string
// Returns: [NormalizedConversation]
function parseExport(raw, source = 'chatgpt') {
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map(item => parseConversation(item, source)).filter(Boolean);
}

// parseConversation(raw, source) — parse a single conversation.
// Returns NormalizedConversation or null if unparseable.
function parseConversation(raw, source = 'chatgpt') {
  if (!raw || typeof raw !== 'object') return null;

  try {
    if (source === 'chatgpt') return _parseChatGPT(raw);
    // Extensible: add 'claude', 'generic' parsers here
    return null;
  } catch (err) {
    return null;
  }
}

// ── ChatGPT format ────────────────────────────────────────────────────────────

function _parseChatGPT(conv) {
  if (!conv.mapping || typeof conv.mapping !== 'object') return null;

  const messages = _orderChatGPTMessages(conv.mapping, conv.current_node);
  if (!messages.length) return null;

  const started_at = conv.create_time
    ? new Date(conv.create_time * 1000).toISOString()
    : null;

  const updated_at = conv.update_time
    ? new Date(conv.update_time * 1000).toISOString()
    : null;

  return {
    id:         conv.id        || null,
    title:      conv.title     || 'Untitled',
    source:     'chatgpt',
    started_at,
    updated_at,
    messages,
  };
}

// Walk from current_node up to root, reverse, extract ordered messages.
function _orderChatGPTMessages(mapping, currentNodeId) {
  if (!currentNodeId || !mapping[currentNodeId]) return [];

  // Build chain: leaf → root
  const chain = [];
  let nodeId = currentNodeId;
  const visited = new Set();

  while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
    visited.add(nodeId);
    chain.push(nodeId);
    nodeId = mapping[nodeId].parent || null;
  }

  chain.reverse(); // root → leaf

  const messages = [];
  let sequence = 0;

  for (const id of chain) {
    const node = mapping[id];
    if (!node?.message?.content) continue;

    const msg  = node.message;
    const role = msg.author?.role || 'unknown';

    // Skip system/root nodes with no useful content
    if (role === 'system' && !_extractBody(msg)) continue;

    const body = _extractBody(msg);
    if (!body) continue;

    const created_at = msg.create_time
      ? new Date(msg.create_time * 1000).toISOString()
      : null;

    const model_slug = role === 'assistant'
      ? (msg.metadata?.model_slug || null)
      : null;

    messages.push({
      id:          msg.id,
      role,
      body,
      sequence,
      created_at,
      model_slug,
      source_hash: _msgHash(msg.id, role, body),
    });
    sequence++;
  }

  return messages;
}

function _extractBody(msg) {
  const parts = msg.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(p => typeof p === 'string')
    .join('\n')
    .trim();
}

// ── Hashing ───────────────────────────────────────────────────────────────────

// Stable hash for a single message — independent of ARK IDs or timestamps.
function _msgHash(sourceId, role, body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ sourceId: sourceId || '', role, body }))
    .digest('hex');
}

// Stable hash for an entire conversation — used for duplicate detection.
// Built from the ordered message hashes, so content changes invalidate it.
function conversationHash(messages) {
  const canonical = messages.map(m => m.source_hash);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

module.exports = { parseExport, parseConversation, conversationHash };
module.exports._internals = { _parseChatGPT, _orderChatGPTMessages, _msgHash };
