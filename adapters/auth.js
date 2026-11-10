// AuthAdapter — Phase 1: passthrough authorization.
// Phase 3+: row-level ACL rules per artifact_type and action.

class AuthAdapter {
  constructor(config = {}) {
    this.config = config;
  }

  async connect() {}

  // authorize({ action, packet, context })
  // Returns true or throws with { code: 'FORBIDDEN' }
  async authorize({ action, packet, context }) {
    // Phase 1: if context has an actor (user_id, or ark_actor_id for a
    // local-only actor with no cloud account) + store_id, the request
    // already passed resolveUserContext() or the CLI's local identity
    // resolution — trust it. GUEST (anonymous — see TraceActions.verify)
    // has neither by design; declared anonymity is its own valid actor
    // declaration, not a missing one.
    const hasActor = context?.user_id || context?.ark_actor_id || context?.role === 'GUEST';
    if (!hasActor || !context?.store_id) {
      const err = new Error('Unauthorized');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    return true;
  }

  // Short-lived sessions for a caller that can't carry its own — e.g. the
  // headless browser cinema.render_reel drives, which must see exactly what
  // the triggering user can. Sessions are the host's (its auth tables, its
  // token checks), so the host provides them:
  //   config.sessions = { mint(ctx, { ttl_ms }) → token, revoke(token) }
  // Without one, mintSession returns null and the caller proceeds anonymously.
  async mintSession(ctx, opts = {}) {
    return this.config.sessions ? this.config.sessions.mint(ctx, opts) : null;
  }

  async revokeSession(token) {
    if (token && this.config.sessions) await this.config.sessions.revoke(token);
  }
}

module.exports = AuthAdapter;
