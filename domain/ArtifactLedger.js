'use strict';

const Packet = require('../core/Packet');

class ArtifactLedger extends Packet {
  static table       = 'artifact_ledger';
  static storeScoped = true;

  async close({ resolution, chain_id, execution_trace, duration_ms } = {}) {
    this.assign({
      status:          'closed',
      closed_at:       new Date().toISOString(),
      resolution:      resolution      || 'success',
      chain_id:        chain_id        || null,
      execution_trace: execution_trace || [],
      duration_ms:     duration_ms     || null,
    });
    return this.save();
  }

  async error(err, { execution_trace, duration_ms } = {}) {
    this.assign({
      status:          'error',
      closed_at:       new Date().toISOString(),
      error: {
        message:    err.message,
        code:       err.code       || 'ERROR',
        pcer_stage: err.pcer_stage || null,
      },
      execution_trace: execution_trace || [],
      duration_ms:     duration_ms     || null,
    });
    return this.save();
  }
}

module.exports = ArtifactLedger;
