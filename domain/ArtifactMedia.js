const Packet = require('../core/Packet');

class ArtifactMedia extends Packet {
  static table = 'artifact_media';

  async prepare() {
    if (!this.id) {
      if (!this.data.status)     this.set('status', 'active');
      if (!this.data.sort_order && this.data.sort_order !== 0) this.set('sort_order', 0);
    }
    // Media fingerprint: SHA-256 of the raw file bytes, computed by the caller
    // at upload time (when bytes are available) and passed in as content_hash.
    // This class stores it but does not derive it — a URL cannot substitute for bytes.
    if (this.data.content_hash) this.set('content_hash', this.data.content_hash);
    this.set('updated_at', new Date().toISOString());
  }

  // ── Static finders ─────────────────────────────────────────────────────────

  static async findByArtifact(artifactId) {
    if (!artifactId) return [];
    const { data } = await ArtifactMedia.db
      .from('artifact_media')
      .select('*')
      .eq('artifact_id', artifactId)
      .order('sort_order', { ascending: true });
    return data || [];
  }

  // Used for ownership verification (returns raw row with joined store_id)
  static async findWithOwner(mediaId) {
    if (!mediaId) return null;
    const { data } = await ArtifactMedia.db
      .from('artifact_media')
      .select('*, artifacts!inner(store_id)')
      .eq('id', mediaId)
      .single();
    return data || null;
  }

  static async nextSortOrder(artifactId) {
    const { data } = await ArtifactMedia.db
      .from('artifact_media')
      .select('sort_order')
      .eq('artifact_id', artifactId)
      .order('sort_order', { ascending: false })
      .limit(1);
    return data?.length ? (data[0].sort_order + 1) : 0;
  }
}

module.exports = ArtifactMedia;
