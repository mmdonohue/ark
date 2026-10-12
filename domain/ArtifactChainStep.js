const Packet = require('../core/Packet');

class ArtifactChainStep extends Packet {
  static table = 'artifact_chain_steps';

  async start() {
    this.assign({ status: 'running', started_at: new Date().toISOString() });
    return this.save();
  }

  async complete(result) {
    this.assign({
      status:       'completed',
      result:       result || null,
      completed_at: new Date().toISOString(),
    });
    return this.save();
  }

  async fail(err) {
    this.assign({
      status:       'failed',
      error:        { message: err.message, code: err.code || 'STEP_ERROR' },
      completed_at: new Date().toISOString(),
    });
    return this.save();
  }
}

module.exports = ArtifactChainStep;
