const Packet = require('../core/Packet');

class ArtifactChain extends Packet {
  static table = 'artifact_chains';

  async start() {
    this.assign({ status: 'running', started_at: new Date().toISOString() });
    return this.save();
  }

  async complete(resolution = 'success') {
    this.assign({
      status:       'completed',
      completed_at: new Date().toISOString(),
      context:      { ...(this.get('context') || {}), resolution },
    });
    return this.save();
  }

  async fail(err) {
    this.assign({
      status:       'failed',
      completed_at: new Date().toISOString(),
      error:        { message: err.message, code: err.code || 'CHAIN_ERROR' },
    });
    return this.save();
  }

  static async findById(id) {
    const { data, error } = await ArtifactChain.db
      .from('artifact_chains')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !data) return null;
    return new ArtifactChain(data);
  }
}

module.exports = ArtifactChain;
