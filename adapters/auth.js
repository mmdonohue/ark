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
}

module.exports = AuthAdapter;
