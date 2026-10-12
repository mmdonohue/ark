const Packet = require('../core/Packet');

class ArtifactRelation extends Packet {
  static table = 'artifact_relations';

  async prepare() {
    if (!this.id) {
      if (!this.data.metadata) this.set('metadata', {});
    }
  }

  // ── Static finders ─────────────────────────────────────────────────────────

  static async findBySource(sourceId, relationType = null, { select = '*', order } = {}) {
    if (!sourceId) return [];
    let q = ArtifactRelation.db
      .from('artifact_relations')
      .select(select)
      .eq('source_artifact_id', sourceId);
    if (relationType) q = q.eq('relation_type', relationType);
    if (order) q = q.order(order.column, { ascending: order.ascending ?? true });
    const { data } = await q;
    return data || [];
  }

  static async maxOrderIndex(sourceId, relationType) {
    const { data } = await ArtifactRelation.db
      .from('artifact_relations')
      .select('order_index')
      .eq('source_artifact_id', sourceId)
      .eq('relation_type', relationType)
      .order('order_index', { ascending: false })
      .limit(1);
    return data?.length ? (data[0].order_index ?? -1) : -1;
  }

  static async deleteWhere({ source_id, target_id, relation_type }) {
    let q = ArtifactRelation.db.from('artifact_relations').delete();
    if (source_id)     q = q.eq('source_artifact_id', source_id);
    if (target_id)     q = q.eq('target_artifact_id', target_id);
    if (relation_type) q = q.eq('relation_type', relation_type);
    const { error } = await q;
    if (error) throw new Error(error.message);
    return true;
  }
}

module.exports = ArtifactRelation;
