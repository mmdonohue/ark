'use strict';

// ark.host.example.js — copy to ark.host.js to hand ARK your app's services
// (see core/host.js). bootstrap() loads ark.host.js for every entry point:
// the server you embed ARK in, both CLIs and the scripts. Every key is
// optional; without the file ARK runs on env defaults. ark.host.js is
// gitignored here because it belongs to the embedding app, not to ARK.

module.exports = () => ({
  // The cloud Supabase project: Postgres mode's db client and sync.push's
  // destination. A function is called on first use, so a local sqlite
  // vessel never builds it. Default: SUPABASE_URL / SUPABASE_KEY.
  // remote: { client: () => require('../my-app/supabase').supabase },

  // Your own LLM pool: anything with defineTask(task, { models }) and
  // complete(task, request) → { content, model_used, tokens_used, prompt_tokens, finish_reason }.
  // defaultModel applies when neither config nor OPENROUTER_MODEL names one.
  // Default: direct OpenRouter calls to anthropic/claude-3.5-sonnet.
  // llm: { pool: myPool, defaultModel: 'vendor/model:free' },

  // Short-lived sessions for headless renders (cinema.render_reel), so a
  // private Ark renders as the user who asked. Without it, renders are
  // anonymous (public arks only).
  // auth: { sessions: { mint: async (ctx, { ttl_ms }) => token, revoke: async token => {} } },
});
