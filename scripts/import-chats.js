'use strict';

// import-chats.js — import ChatGPT conversations into ARK as immutable artifacts.
//
// Usage:
//   node backend/scripts/import-chats.js --first          # import oldest conversation only
//   node backend/scripts/import-chats.js --index 0        # import by position (0-based)
//   node backend/scripts/import-chats.js --index 0,1,2    # import multiple by position
//   node backend/scripts/import-chats.js --all            # import everything
//
// Default input: backend/data/chat_exports/conversations.json
// Override:      --file /path/to/conversations.json
//
// NOTE: The tenant table is named `store` (not `stores`). This trips up queries
// that assume a plural — always use .from('store') in Supabase calls.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const fs           = require('fs');
const { supabase } = require('../services/supabase');
const { parseExport, conversationHash } = require('../utils/chatParser');
const { dispatch } = require('../index');
const Artifact     = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const mode     = args.includes('--all')   ? 'all'
               : args.includes('--first') ? 'first'
               : args.includes('--index') ? 'index'
               : 'first'; // safe default

const indexArg = getArg('--index');
const indices  = indexArg ? indexArg.split(',').map(Number) : [0];
const filePath = getArg('--file')
  || path.resolve(__dirname, '../data/chat_exports/conversations.json');

// ── Context ───────────────────────────────────────────────────────────────────

const store_id = parseInt(process.env.ARK_DEFAULT_STORE_ID || '1', 10);
const user_id  = null; // system import — no user actor

const ctx = { store_id, user_id, source: 'system' };

// ── Ephemera Chats ark ────────────────────────────────────────────────────────

// Holds all raw imported conversations — unprocessed inbox.
// The Librarian reads from here and routes relevant conversations to topic arks.
// Returns the ark id, creating it on first run if absent.
async function getOrCreateEphemeraChats() {
  const { data: existing } = await supabase
    .from('artifacts')
    .select('id')
    .eq('store_id', store_id)
    .eq('artifact_type', 'ark')
    .eq('slug', 'ephemera-chats')
    .maybeSingle();

  if (existing?.id) return existing.id;

  const ark = new Artifact({
    artifact_type: 'ark',
    title:         'Ephemera Chats',
    slug:          'ephemera-chats',
    summary:       'Raw imported conversations. Unprocessed inbox for the Librarian.',
    status:        'published',
    context:       { visibility: 'private' },
  }, { context: ctx });

  await ark.save();
  console.log(`  Created "Ephemera Chats" ark (${ark.id})`);
  return ark.id;
}

// ── Document seeding ─────────────────────────────────────────────────────────

// Create an ARK artifact from a local markdown file.
// Idempotent — checks for existing artifact by slug before creating.
async function seedDocument({ filePath: docPath, title, slug, ark_id }) {
  if (!fs.existsSync(docPath)) return null;

  const { data: existing } = await supabase
    .from('artifacts')
    .select('id')
    .eq('store_id', store_id)
    .eq('artifact_type', 'document')
    .eq('slug', slug)
    .maybeSingle();

  if (existing?.id) return existing.id;

  const body = fs.readFileSync(docPath, 'utf8');
  const artifact = new Artifact({
    artifact_type: 'document',
    title,
    slug,
    body,
    status:  'published',
    context: { visibility: 'private' },
  }, { context: ctx });

  await artifact.save();

  if (ark_id) {
    const order = (await ArtifactRelation.maxOrderIndex(ark_id, 'contains')) + 1;
    const rel = new ArtifactRelation({
      source_artifact_id: ark_id,
      target_artifact_id: artifact.id,
      relation_type:      'contains',
      order_index:        order,
    }, { context: ctx });
    await rel.save();
  }

  console.log(`  Seeded document "${title}" (${artifact.id})`);
  return artifact.id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(rawItems) {
  const all = parseExport(rawItems, 'chatgpt');
  console.log(`\nLoaded ${all.length} conversations from export.`);

  const ephemeraChatsId = await getOrCreateEphemeraChats();
  console.log(`  Ephemera Chats ark: ${ephemeraChatsId}`);

  // Seed ARK design documents as artifacts on first run
  const plansDir = path.resolve(__dirname, '../../../.claude/plans/ark');
  await seedDocument({
    filePath: path.join(plansDir, 'packet_readiness_guide.md'),
    title:    'Packet Readiness Assessment',
    slug:     'ark-pra-guide',
    ark_id:   ephemeraChatsId,
  });
  await seedDocument({
    filePath: path.join(plansDir, 'CONSTITUTION.md'),
    title:    'ARK Constitution',
    slug:     'ark-constitution',
    ark_id:   ephemeraChatsId,
  });

  // Select subset to import
  let selected;
  if (mode === 'all') {
    selected = all;
    console.log('Mode: import all\n');
  } else if (mode === 'first') {
    selected = [all[0]].filter(Boolean);
    console.log('Mode: first conversation only\n');
  } else {
    selected = indices.map(i => all[i]).filter(Boolean);
    console.log(`Mode: index [${indices.join(', ')}]\n`);
  }

  if (!selected.length) {
    console.error('No conversations selected — check your index values.');
    process.exit(1);
  }

  // Import each selected conversation into the ARK Build ark
  let imported = 0, duplicates = 0, errors = 0;

  for (let i = 0; i < selected.length; i++) {
    const conv = selected[i];
    const hash = conversationHash(conv.messages);
    process.stdout.write(`[${i + 1}/${selected.length}] "${conv.title}" (${conv.messages.length} msgs, hash: ${hash.slice(0, 8)}…) `);

    try {
      const result = await dispatch(
        {
          action:  'chat.import',
          payload: { source: 'chatgpt', conversation: _toChatGPTRaw(conv), ark_id: ephemeraChatsId },
          meta:    { source: 'import_script', request_id: require('crypto').randomUUID() },
        },
        ctx,
      );

      const r = result.data.results[0];
      if (r.was_duplicate) {
        console.log(`→ duplicate (${r.conversation_id})`);
        duplicates++;
      } else {
        console.log(`→ imported (${r.conversation_id}, ${r.message_count} messages)`);
        imported++;
      }
    } catch (err) {
      console.log(`→ ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone. imported=${imported}  duplicates=${duplicates}  errors=${errors}\n`);
  process.exit(errors > 0 ? 1 : 0);
}

// The ChatActions.importChat handler accepts the raw ChatGPT conversation object
// and re-parses it — pass the original raw form, not the normalized one.
function _toChatGPTRaw(normalized) {
  return _rawById[normalized.id] || normalized;
}

(async () => {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`\nFile not found: ${filePath}`);
      console.error('Place your ChatGPT conversations.json export at:');
      console.error('  backend/data/chat_exports/conversations.json\n');
      process.exit(1);
    }
    if (filePath.endsWith('.zip')) {
      console.error('\nChatGPT exports as a zip — unzip it first and pass the conversations.json:');
      console.error('  unzip ~/Downloads/chatgpt-export.zip -d backend/data/chat_exports/');
      console.error('  node backend/scripts/import-chats.js\n');
      process.exit(1);
    }
    const rawItems = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    _rawById = Object.fromEntries(
      (Array.isArray(rawItems) ? rawItems : [rawItems]).map(c => [c.id, c])
    );
    await main(rawItems);
  } catch (err) {
    console.error('Fatal:', err.message);
    process.exit(1);
  }
})();

let _rawById = {};
