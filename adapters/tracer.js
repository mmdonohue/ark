// TracerAdapter — times internal Packet operations (save, delete, etc.)
// Quiet by default: only warns when a span exceeds the slow threshold.
// Gateway-level ingress/egress logging is handled separately in action.js.

const log4js = require('log4js');

class TracerAdapter {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.slowMs  = config.slowMs ?? 500;
    this.logger  = log4js.getLogger('tracer');
  }

  async connect() {}

  // Wraps a callback in a named span. Only emits a log line when:
  //   - the span exceeds slowMs (warn)
  //   - the span throws (error)
  async run(name, meta = {}, callback) {
    if (!this.enabled) return callback();

    const start = Date.now();
    const tag   = meta.request_id ? ` req=${meta.request_id}` : '';

    try {
      const result = await callback();
      const ms = Date.now() - start;
      if (ms >= this.slowMs) {
        this.logger.warn(`[slow] ${name} ${ms}ms${tag}`);
      }
      return result;
    } catch (err) {
      const ms = Date.now() - start;
      this.logger.error(`[span] ${name} error after ${ms}ms${tag}: ${err.message}`);
      throw err;
    }
  }
}

module.exports = TracerAdapter;
