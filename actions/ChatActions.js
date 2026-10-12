'use strict';

// ChatActions — import governed chat history into ARK as immutable source artifacts.
//
// chat.import
//   Accepts a ChatGPT (or generic) conversation export and creates:
//     - one `conversation` artifact (immutable source record)
//     - ordered `chat_message` artifacts (immutable source records)
//     - `contains` relations (conversation → each message, order_index = sequence)
//     - `follows` relations (message[n] → message[n-1])
//   Idempotent: source_hash detects duplicate conversations and returns early.

const Artifact         = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { parseExport, parseConversation, conversationHash } = require('../utils/chatParser');

async function importChat(ep, payload) {
  const {
    source = 'chatgpt',
    conversation: rawConv,   // single conversation object
    raw,                     // full export array (imports all)
    ark_id,                  // optional — place conversation artifact in this ark
  } = payload;

  // Normalise input: single conversation or full export array
  const parsed = rawConv
    ? [parseConversation(rawConv, source)].filter(Boolean)
    : parseExport(raw, source);

  if (!parsed.length) {
    throw Object.assign(new Error('No valid conversations found in payload'), {
      status: 400, code: 'CHAT_IMPORT_NO_CONVERSATIONS',
    });
  }

  const results = [];

  for (const conv of parsed) {
    const result = await _importOne(conv, ep, ark_id);
    results.push(result);
  }

  return {
    data: {
      imported:   results.filter(r => !r.was_duplicate).length,
      duplicates: results.filter(r =>  r.was_duplicate).length,
      results,
    },
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _importOne(conv, ep, ark_id) {
  const ctx        = ep;
  const src_hash   = conversationHash(conv.messages);
  const now        = new Date().toISOString();

  // Idempotency check — find existing conversation by source_hash + store
  const existing = await _findBySourceHash(src_hash, ctx);
  if (existing) {
    return {
      was_duplicate:   true,
      conversation_id: existing.id,
      source:          conv.source,
      external_id:     conv.id,
      message_count:   conv.messages.length,
    };
  }

  // ── Create conversation artifact ──────────────────────────────────────────
  const targetArkId = ark_id || await Artifact.getOrCreateEphemera(ctx);

  const convArtifact = new Artifact({
    artifact_type: 'conversation',
    title:          conv.title,
    status:         'published',
    metadata: {
      source:        conv.source,
      external_id:   conv.id,
      started_at:    conv.started_at,
      updated_at:    conv.updated_at   || null,
      imported_at:   now,
      source_hash:   src_hash,
      message_count: conv.messages.length,
    },
  }, { context: ctx });

  await convArtifact.save();

  // Place conversation in target ark
  if (targetArkId) {
    const order = (await ArtifactRelation.maxOrderIndex(targetArkId, 'contains')) + 1;
    const rel = new ArtifactRelation({
      source_artifact_id: targetArkId,
      target_artifact_id: convArtifact.id,
      relation_type:      'contains',
      order_index:        order,
    }, { context: ctx });
    await rel.save();
  }

  // ── Create chat_message artifacts + relations ─────────────────────────────
  const messageIds = [];

  for (const msg of conv.messages) {
    const msgArtifact = new Artifact({
      artifact_type: 'chat_message',
      body:           msg.body,
      status:         'published',
      metadata: {
        conversation_id:   convArtifact.id,
        source_message_id: msg.id,
        role:              msg.role,
        sequence:          msg.sequence,
        created_at:        msg.created_at,
        model_slug:        msg.model_slug  || null,
        source_hash:       msg.source_hash,
      },
    }, { context: ctx });

    await msgArtifact.save();
    messageIds.push(msgArtifact.id);

    // conversation contains chat_message (ordered by sequence)
    const containsRel = new ArtifactRelation({
      source_artifact_id: convArtifact.id,
      target_artifact_id: msgArtifact.id,
      relation_type:      'contains',
      order_index:        msg.sequence,
    }, { context: ctx });
    await containsRel.save();

    // chat_message follows previous chat_message
    if (messageIds.length > 1) {
      const followsRel = new ArtifactRelation({
        source_artifact_id: msgArtifact.id,
        target_artifact_id: messageIds[messageIds.length - 2],
        relation_type:      'follows',
        order_index:        msg.sequence,
      }, { context: ctx });
      await followsRel.save();
    }
  }

  return {
    was_duplicate:   false,
    conversation_id: convArtifact.id,
    source:          conv.source,
    external_id:     conv.id,
    message_count:   messageIds.length,
    imported_at:     now,
  };
}

// Query artifacts for a conversation with the given source_hash in this store.
async function _findBySourceHash(sourceHash, ctx) {
  const { supabase } = require('../services/supabase');
  const { data } = await supabase
    .from('artifacts')
    .select('id')
    .eq('artifact_type', 'conversation')
    .eq('store_id', ctx.store_id)
    .eq('metadata->>source_hash', sourceHash)
    .maybeSingle();
  return data || null;
}

module.exports = { importChat };
module.exports._internals = { _importOne, _findBySourceHash };
