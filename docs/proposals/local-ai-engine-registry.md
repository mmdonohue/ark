# Future Feature Proposal: Local AI Engine Discovery, Installation and Manifest Registry

**Status:** Documentation-only proposal; no implementation in this PR.
**Timing:** After the existing vanilla USB baseline, Bootstrap/Core/Features/Vessels boundary, and signed boot/update rework stabilize.
**Intent:** A portable ARK can assess a host, offer suitable local AI engines, install owner-approved models on permitted storage, and reuse the existing model router without giving the host ownership of the ARK.

## Verified baseline (from current ARK repository)

- `core/Manifest.js` registers two relevant services: `llm` (`adapters/llm.js`) and `harness` (`adapters/harness.js`). There is **no standalone AI model registry** in this Manifest today.
- `adapters/llm.js` supports direct OpenRouter inference or an optional host-supplied `pool`. The pool selects models, handles fallback and logs usage; response metadata recognizes `selection_reason === 'local'`. This does **not** prove that local installation, health checks or Ollama discovery exist.
- `adapters/harness.js` operates configured Claude Code and Copilot CLI coding-agent drivers, with ordered fallback, per-request model override and scope/capability enforcement. **Do not conflate a model inference runtime with a coding agent harness.**
- `ark.host.example.js` documents host LLM pool configuration.
- `pipelines/classify/providers.yaml` already declares a model at a specific capability-provider binding; preserve compatibility with this pattern.
- `arks/usb-sd-birds/ark.yaml` currently contains vessel instance metadata, not installed model weights or host-dependent model state.
- Related draft architecture work: ARK PR #48 (Bootstrap/Core/Features/Vessels), PR #47 (risk-aware routing).

## Owner vision / requirements

1. The USB carries ARK identity, configuration, artifacts, ownership and optionally portable signed model archives. **A local model is a replaceable engine, not part of the ARK's identity.**
2. `ark setup` may offer an **optional** local AI capability. No model auto-download on first boot or merely on attaching a vessel.
3. Assess the actual host's CPU, RAM, GPU/VRAM, OS/architecture and accelerator using **llmfit** where available; evaluate whether it is suitable for installation as an optional feature, CLI subprocess or bundled tool. Do not reimplement its model-ranking algorithms unnecessarily.
4. Separately inspect storage volume capacity, permissions, filesystem, available bytes, and owner preference. Hardware fit and free disk are independent conditions.
5. Present compatible candidate engines with model ID, source, quantization, approximate storage and memory requirements, anticipated capabilities, license, runtime, provenance and a clear *estimate vs measured* distinction.
6. Support user-selected install target: host SSD, external drive or portable USB. Existing vessels must not be overwritten and model weights should not be mistaken for vessel data.
7. Permit offline installation from previously downloaded, verified packages; on network-enabled hosts allow deliberate downloads. Verify publisher/source, digest, expected size, archive safety and any available signature before use. Never execute untrusted runtimes.
8. Discover existing compatible Ollama/llama.cpp/MLX/etc installations where supported before offering duplicate downloads. Verify runtime and model existence instead of inferring from manifests alone.
9. Reconcile *desired models* recorded in the Manifest with per-host *observed installations*. A move to a new host does not imply a model is installed there.
10. After install, run small load/inference smoke tests with synthetic content and record actual model ID, runtime, latency, memory utilization, failure reasons and capabilities that have been evidenced. Do not claim a model supports coding-agent tools without validating that execution path.
11. Feed eligible engines to the **existing** LLM provider pool / routing policy; require explicit authorization for external cloud fallback and sensitive-data transfer. Preserve the existing harness contract/permissions and the risk-aware task-routing proposal.
12. Build no second model hopper, second Manifest framework, privileged installer through `dispatch`, or new owner-data store.

## Suggested conceptual schema (illustrative, not supported today)

```yaml
llm:
  engines:
    - id: portable.reasoning
      runtime: ollama
      model: example-model
      source: trusted-model-repository
      package_digest: sha256:<verified-digest>
      installation_policy: manual
      preferred_storage: host
      capabilities: [text.reasoning]
      validation:
        smoke_test_required: true
```

Keep persistent declared *intent* and model references separate from volatile host-specific *observations*:
- **Declaration:** engine ID, source/license, approved digest/version, intended capabilities, routing preferences, privacy policy and desired install status (durable vessel/manifest).
- **Host installation:** actual path, runtime executable/version, measured hardware fit, storage availability, last verification and local endpoint (host-scoped cache or state).
- **Validation:** contract-backed test artifacts, result, evidence, host fingerprint that avoids unnecessary personal/hardware identifiers, time/expiry, provenance, security checks and acceptance.
- **Package:** signed/checksummed transportable model archive or a verified external runtime download, with explicit trust policy.

Do not place credentials, sensitive health data, absolute machine-specific paths, or secrets in portable manifests. Schema/version evolution should be backwards compatible.

## UX sketches / future commands (not implemented)

```text
ark setup
  -> Core verified
  -> Storage chosen
  -> Optional local intelligence assessment (llmfit)
  -> Compatible engines shown
  -> Owner selects downloads and install locations
  -> Verify -> install -> smoke test -> register
```

Potential separate, governed CLI/API operations:
```text
ark model discover
ark model list
ark model fit
ark model install <approved-model-id> --storage <volume>
ark model verify <model-id>
ark model remove <model-id>
```

Removal must never delete model weights used by other installations without clear ownership/refcount checks and confirmation.

## Proposed implementation stages (separate future PRs)

1. **Audit and contract:** Review existing Manifest, pool, provider binding patterns, feature boundary, model-related artifacts, package/version trust and local-runtime connectivity. Define model declaration vs observed installation vs validation schemas. No functional changes.
2. **Discovery integration:** Optional llmfit adapter with bounded resource use, graceful absence fallback, safe subprocess/JSON parsing and synthetic test fixtures. No model installation yet.
3. **Inventory and storage UI:** Enumerate trusted local runtimes, installed engines and writable destinations; show estimates and owner-selectable storage. No background network downloads.
4. **Verified installation:** Owner-approved download or offline archive install, staged/checksummed, no vessel modification, safe rollback/cleanup and low-space/USB-removal handling.
5. **Validation and routing:** Synthetic smoke tests; evidence artifacts; activate models only when working and permitted; integrate with existing `llm` pool and eventually ARK PR #47 risk router. Avoid implicit cloud fallback.
6. **Portability and lifecycle:** Cross-host reconciliation, independent engine updates, version pins, offline use, optional prepacked models, failure/repair behavior and model-removal policy.

## Security, licensing and practical constraints

- Model origin and licenses vary; explicit owner confirmation for download/use and any redistribution onto USB.
- Hardware rankings are estimates; low-memory hosts may be unable to run a useful model. A failed or absent llmfit assessment must never block Core boot.
- Do not download or run a model because it appeared in a portable manifest. Owner authorization is required on each host when installation has side effects.
- Keep model downloading and execution out of early bootstrap's minimal trust base when possible; offer it as a post-Core optional Feature. A phone/headless host may have insufficient CPU/RAM/storage.
- Local inference can be free of per-request API fees but still consumes power, compute, storage and time. Record useful measurements without pretending to know dollar costs.
- No production secrets or identifiable wellness/survey responses in engine evaluation prompts.

## Acceptance criteria for this **documentation PR**

- Describes verified current AI-related Manifest services and provider bindings accurately.
- Establishes the future model lifecycle and how it fits Core/Features/Vessels.
- Does not claim local model installation or llmfit integration already exists.
- Breaks implementation into small independent PRs with measurable validation criteria.
- Makes no modifications to current boot/update/release code, active installations or USB distribution.

**Claude instruction:** audit existing code and actual llmfit CLI/platform support before implementing anything. Preserve the existing Manifest service registry, model pool, execution authority, ledger and immutable owner-vessel boundaries. Treat this as a backlog architecture task until the thumb-drive boot/update baseline is stable.
