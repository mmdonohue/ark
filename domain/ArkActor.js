const Packet = require('../core/Packet');

// ArkActor — ARK's own notion of "who." Deliberately not an Artifact:
// owner_id/created_by/updated_by across the whole schema are bigint,
// borrowed from Seravanna's users.id, and retyping them to UUID to make
// actors artifacts too would be a much larger migration than this warrants.
// Roles and vessels/stores ARE artifacts (artifact_type: 'role' / 'store') —
// only actor identity itself gets its own table.
class ArkActor extends Packet {
  static table       = 'ark_actors';
  static storeScoped  = true;

  async prepare() {
    if (!this.data.store_id && this.context.store_id) this.set('store_id', this.context.store_id);
  }

  static async findById(id, ctx = {}) {
    if (!id) return null;
    let q = ArkActor.db.from('ark_actors').select('*').eq('id', id);
    if (ctx.store_id) q = q.eq('store_id', ctx.store_id);
    const { data, error } = await q.single();
    if (error || !data) return null;
    return new ArkActor(data, { context: ctx });
  }
}

module.exports = ArkActor;
