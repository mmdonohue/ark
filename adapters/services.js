// ServicesAdapter — internal service bus for cross-domain calls.
//
// resolve({ input, verb, role? }) — Pass 1 of .claude/plans/ark/ark_goals.md:
// "code asks for a capability by input+verb(+role), not a vendor." Loads
// every ark/pipelines/*/providers.yaml once, indexes providers by
// (input, verb), and returns the first one whose backing service is
// actually available — declared file order IS the preference chain (§5's
// "GLiNER -> local model -> general LLM" shape), no separate priority
// field needed. Deliberately does NOT invoke anything and does NOT touch
// authorization (§6) — it only answers "what can do this"; the existing
// ACTION_REGISTRY/_assertCapability/assertOwnerOrAdmin path still
// exclusively answers "is this call allowed."
//
// call() below is the older, still-unwired Phase 4 cross-domain call bus —
// unrelated to resolve(), left as the same stub it always was.

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PIPELINES_DIR = path.resolve(__dirname, '../pipelines');

class ServicesAdapter {
  constructor(config = {}, manifest = null) {
    this.config = config;
    this.manifest = manifest; // set by Manifest.load() — needed to check e.g. the 'llm' service's own availability
    this._providerIndex = null; // Map<"input:verb", provider[]>, declared order preserved
  }

  async connect() {
    this._loadProviders();
  }

  // Scans every pipeline recipe's providers.yaml (today: just
  // pipelines/classify/providers.yaml) for entries that declare the new
  // input/verb resolution fields — a provider without them (shouldn't
  // exist once this lands, but defensively) is simply invisible to
  // resolve(), not an error; it just means nothing generalized has been
  // asked of it yet.
  _loadProviders() {
    const index = new Map();
    if (fs.existsSync(PIPELINES_DIR)) {
      const dirs = fs.readdirSync(PIPELINES_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
      for (const dir of dirs) {
        const file = path.join(PIPELINES_DIR, dir.name, 'providers.yaml');
        if (!fs.existsSync(file)) continue;
        const doc = yaml.load(fs.readFileSync(file, 'utf8'));
        for (const p of (doc?.providers || [])) {
          if (!p.input || !p.verb) continue;
          const key = `${p.input}:${p.verb}`;
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(p);
        }
      }
    }
    this._providerIndex = index;
  }

  // "Available" only has one real shape today: an action bound to the
  // Manifest 'llm' service (providers.yaml's own header comment explains
  // why an LLM call is a governed service binding, not spawned code) —
  // reuses the exact readiness signal LLMAdapter already carries
  // (this.apiKey), no new availability concept invented. A provider with
  // no `model` field has no known unavailability condition, so it passes.
  _isAvailable(provider) {
    if (provider.model && this.manifest?.has('llm')) {
      return !!this.manifest.get('llm').apiKey;
    }
    return true;
  }

  resolve({ input, verb, role } = {}) {
    if (!this._providerIndex) this._loadProviders(); // e.g. resolve() called before connect() in a test
    if (!input || !verb) throw new Error('ServicesAdapter.resolve: input and verb are required');

    const candidates = this._providerIndex.get(`${input}:${verb}`) || [];
    // A role match is preferred, never required — falling through to a
    // roleless provider is the intended behavior (§3's editor-resolver
    // example: specialized resolver first, general fallback after).
    const ordered = role
      ? [...candidates.filter(p => p.role === role), ...candidates.filter(p => p.role !== role)]
      : candidates;

    const found = ordered.find(p => this._isAvailable(p));
    if (!found) {
      throw Object.assign(
        new Error(`ServicesAdapter: no available resolver for input="${input}" verb="${verb}"${role ? ` role="${role}"` : ''}`),
        { code: 'NO_RESOLVER' },
      );
    }
    return found;
  }

  // call({ service, method, payload, packet, context })
  async call({ service, method, payload = {}, packet, context }) {
    // Phase 4: route through ActionGateway registry
    // For now, surface a clear error so missing wiring is obvious
    throw new Error(`ServicesAdapter: ${service}.${method} not yet wired. Implement in Phase 4.`);
  }
}

module.exports = ServicesAdapter;
