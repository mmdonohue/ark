// MetricsAdapter — Phase 1 in-memory counters.
// Replace with Datadog/Prometheus adapter later by matching this interface.

class MetricsAdapter {
  constructor(config = {}) {
    this.counters = new Map();
    this.gauges   = new Map();
    this.enabled  = config.enabled !== false;
  }

  async connect() {}

  increment(name, value = 1, tags = {}) {
    if (!this.enabled) return;
    const key = metricKey(name, tags);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  gauge(name, value, tags = {}) {
    if (!this.enabled) return;
    this.gauges.set(metricKey(name, tags), value);
  }

  // Returns a snapshot — useful for the runtime artifact
  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      gauges:   Object.fromEntries(this.gauges),
    };
  }
}

function metricKey(name, tags) {
  const tagStr = Object.entries(tags).map(([k, v]) => `${k}:${v}`).join(',');
  return tagStr ? `${name}{${tagStr}}` : name;
}

module.exports = MetricsAdapter;
