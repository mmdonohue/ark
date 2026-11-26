# ARK boundary proposal: Bootstrap / Core / Features / Vessels

**Status:** Architecture proposal only. This PR defines conceptual and packaging boundaries; it does not restructure the runtime, change release behavior, or modify the first signed USB build.

## Intent

ARK should have a small, independently recoverable bootstrap environment, a signed replaceable Core, optional installable Features, and owner-controlled persistent Vessels. The source repository and its development tooling must not be mistaken for the distributable runtime.

**Principle:** Hosts provide execution. Core provides governance. Features provide capabilities. Vessels retain ownership, state, and provenance.

## Four runtime domains

| Domain | Responsibility | Lifetime / upgrade | Authority |
|---|---|---|---|
| **Bootstrap** | Minimal offline-capable installer/recovery executable; `ark setup`, package verification, staged extraction, repair | Independently versioned, rarely changed | May install/repair verified Core; must not silently take ownership of existing Vessels |
| **Core** | Dispatch, Packet/contract resolution, artifact and relationship semantics, ledger, authentication/authorization primitives, capability/service registry, minimal storage | Signed, versioned, replaceable; `ark update` | Enforces all execution/ownership rules, even for Features |
| **Features** | Optional capabilities: agent harness, developer tooling, Studio, discovery/Bluetooth/LoRa, integrations, security audits | Signed packages with compatibility checks; `ark feature ...` (future) | Requests narrowly scoped capabilities from Core, never bypasses dispatch or ledger |
| **Vessels** | Owned artifacts, projects, local identity records, journals, credentials/configuration, durable data, lineage/provenance and memory | Persist across all runtime updates and host changes | Ownership is independent of the current host, feature or runtime version |

The **development checkout** is a separate distribution concern updated through git, not a fifth runtime domain. A release builder should eventually construct signed Core/Feature packages from an explicit verified include manifest rather than relying primarily on Git snapshot exclusions.

## Verified current implementation (do not regress)

- `scripts/release-build.js` packages the **committed** tree via `git archive HEAD`, excludes specified paths, and emits platform-specific bundles, `install.json`, and a signed release manifest when provided a signing key. Bundles currently include production dependencies and a pinned Node runtime.
- `scripts/make-usb.js` installs `runtime/<version>/`, `runtime/current.json`, launchers and `vessels/`, and verifies an adjacent signed release manifest when present; it warns on missing proof. It does not provide optional independent Feature package installation yet.
- `utils/arkHome.js` resolves the durable vessel root independently of runtime and rejects data roots within the runtime.
- `actions/RuntimeActions.js` implements `runtime.version` and signed-manifest `runtime.check`; the self-update specification `docs/proposals/cli-self-update.md` marks installation and rollback as **planned**, not built. Do not claim they exist.
- `adapters/harness.js` is currently a registered runtime adapter. Optional Feature extraction is a **proposal** and must preserve governance/capability boundaries.

## Minimum Core contract

Core owns:
- `dispatch` and authorization/permission enforcement (including owner-only and actor scope)
- canonical Packet and artifact/relationship/ledger invariants
- contract validation, minimal service/capability registry and package compatibility checks
- local data location rules, secure storage and fundamental auth interfaces
- signed update verification and rollback lifecycle where implemented
- a small usable offline CLI and deterministic failure behavior if optional Features are absent

Do not move a component into Core solely because it currently imports another module; first inventory runtime dependency edges. Core must be useful with zero optional Features.

## Feature contract (future schema; not implemented)

```yaml
feature:
  id: ark.agent-harness
  version: 0.1.0
  requires:
    core: ">=0.3.0"
  provides: [agent.review]
  requests: [repo.read, report.write, task.propose]
  platform: [linux-arm64, darwin-arm64]
```

A Feature is independently signed, versioned, staged and verified before activation. All APIs to Core must pass governed capability checks; installing a Feature does not grant requested permissions without owner approval. Missing Features must produce clear `CAPABILITY_UNAVAILABLE` results, not crash Core. Avoid hardcoding model credentials or owner state inside feature archives.

## Bootstrap / `ark setup` (future; explicitly *not* part of this PR)

Bootstrap should be able to work if Core is missing or broken. Proposed offline-first commands:
- `ark setup` — inspect host/disk, verify, stage and activate Core, offer optional Features, preserve existing vessels
- `ark setup --minimal`, `--offline`, `--verify`, `--repair` (design candidates, not shipped flags)
- `ark feature list/install/update` — Core-governed package management after setup (future)

Compressed signed packages can reside on the USB and extract on first use. Verify the signed manifest, package digest, archive traversal/symlinks and size limits before staged extraction. Never execute unverified packages, write over `vessels/`, or activate partial installs. Handle abrupt USB removal with idempotent recovery. No cloud connection is required to install already-trusted offline packages.

On hosts, support later *explicit* modes:
- **Portable:** runtime and vessels on USB.
- **Hosted/ephemeral:** runtime on consenting host, vessels on USB; remove host traces according to a documented cleanup policy, do not assume all traces can be eliminated.

## Local owner login (future separate security PRs)

Local offline login is a Core-level interface/contract, not a dependency on cloud accounts. Argon2id password verifier, encrypted vessel data, recovery-key handling, authenticated local sessions and revocable device pairing require separate threat modeling and incremental implementation. The bootstrap must **not** reset, claim or reassign ownership of an existing vessel based on possession of the USB. Bluetooth discovery and phone UI belong in Features, not Core. Do not ship an insecure temporary login as a shortcut.

## Release/upgrade compatibility

- `git` updates the developer checkout.
- `ark update` updates signed Core runtime versions; maintain immutable release provenance and explicit rollback.
- `ark feature ...` will manage independently signed/compatible optional packages once designed.
- Vessels evolve only through owner-authorized governed data operations or separately approved migrations, with backups and rollback planning.
- Core and Features negotiate manifest/interface versions; incompatible Features remain inactive.
- Trust-root changes, package signing, key rotation and compatibility handling require dedicated security review.
- Avoid silently switching active versions, mutating owner data or broadening authorization while installing.

## Incremental follow-on work (NOT requested in this PR)

1. **Inventory:** Map imports, boot-time dependencies, package sizes, and current Core-critical versus optional modules. Measure the existing *vanilla* USB baseline first (copy time, run, offline/persistence checks).
2. **Boundary tests:** Add a dependency rule/check that Core cannot import optional Features; validate Core-only smoke behavior on supported hardware.
3. **Core packaging:** Explicit signed runtime include manifest and minimal compressed distribution while preserving today's signed release validation.
4. **Feature loader:** Signed Feature manifests, capability registration, compatibility and permission negotiation. Pilot with agent harness only after dependency audit.
5. **Bootstrap:** Minimal independent `ark setup` and atomic extraction/recovery; ensure no-Node-host and platform constraints are documented/tested.
6. **Owner auth and headless access:** Independent threat-modeled PRs, followed by BLE discovery + local web access as optional Features.

## Definition of done *for this boundary PR only*

- One reviewed architecture document describing responsibility, authority, persistence and release boundary for each domain.
- Existing state and proposed architecture clearly distinguished.
- No source code, release scripts, dependency manifests, launchers, packages, signing keys, migrations, or USB installations changed.
- Claude can use this document to propose small implementation PRs without changing the first USB test baseline.

**Design review questions:** What is the actual dependency-closed minimum Core? Which adapters are required to boot versus deferred services? What is the signing and compatibility root for independently released Features? Which components must bootstrap implement independently of Node/ARK Core? What are measurable package-size and first-run latency goals after the vanilla USB baseline?
