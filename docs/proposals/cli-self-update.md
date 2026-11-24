# P0 — Governed CLI Self-Update for Portable ARK

**Status:** Feature specification / implementation task. **No updater is implemented by this document.**

## Purpose
Enable owners of portable, local-first and USB-distributed ARK installations to check for, install and roll back verified runtime releases without losing their own artifacts, memory, configuration, or local sovereignty.

## Existing behavior and compatibility
- The repository exposes the `ark` executable from `cli/ark.js` via `package.json`.
- An existing action named `ark.update` updates an ARK artifact. **It is not a CLI self-updater.** Keep these semantics distinct; do not overload this action.
- Inspect the actual packaging/distribution and release process before choosing an install/update mechanism. Do not assume a signed release service, container image, auto-updater, or supported target matrix exists.
- Respect the Constitution and Charter: immutable Canonical Packet, scoped execution, declared capability, governed dispatch, ledger/provenance, and one execution model. Avoid a privileged second update engine.

## User-facing CLI contract

```sh
ark version
ark update --check
ark update
ark update --rollback
```

- `ark version`: display installed version, build hash, release channel, and installation type where discoverable; clearly mark unknown values.
- `ark update --check`: **read-only** query for candidate releases; display version, source, compatibility, and trust status; graceful error when offline.
- `ark update`: explicitly authorized update with independently verified release provenance, platform compatibility, sufficient disk, and writable staging; ask for confirmation if interactive or require explicit approval in noninteractive contexts.
- `ark update --rollback`: explicitly authorized restoration to the previous known-good runtime, subject to data compatibility checks.

## Safety, data, and authorization requirements
1. **Never overwrite owner data.** Preserve artifacts, SQLite databases, external storage, MemChart, Manifest, secrets, configuration, and user workspaces. Treat runtime and owner data as distinct roots. Back up any state affected by migration.
2. **Verify before executing.** Define an authenticated release manifest and trust root. Validate signed metadata/binaries or an equivalent documented trust chain, along with checksums and version/target constraints. A bare checksum fetched from the same untrusted endpoint is not sufficient authenticity proof.
3. **Stage, verify, activate, health-check, roll back.** Use atomic swaps where supported and ensure interrupted operation can recover. Do not treat a failed post-update health check as success.
4. **No privilege escalation.** Resolve required capabilities using the existing governed execution path. Filesystem or network adapter needs must be declared, not assumed.
5. **Never assume internet.** USB/offline/read-only installations must remain usable. Offline update check returns an intelligible result, not corruption.
6. **Migration caution.** Runtime rollback may be unsafe after irreversible data migration. Detect that condition, back up data, and fail closed unless an explicitly reviewed migration/rollback plan exists.
7. **Trace every attempted update.** Preserve immutable intent, actor, resolved authority, input release manifest/hash, outcome, and failure reason. Never log secrets.
8. No automatic download/install without the owner's authorization.

## Implementation plan — independently reviewable increments

### PR A: Audit and read-only foundation
- Audit CLI command routing, package installation patterns, supported platforms, release publishing, runtime/data layout, and GitHub actions/CI.
- Add the `ark version` and `ark update --check` read-only interfaces, using injected or mocked release discovery when no trusted release source exists.
- Document unsupported platforms and trust prerequisites.
- No binary replacement in this stage.

### PR B: Verified staging for one distribution channel
- Choose one real install/distribution mechanism based on the audit.
- Implement release metadata verification, checksum verification, compatibility checks, staging, and the distinct update capability/contract.
- Require explicit authorization; keep ownership data untouched.
- Do not add automatic network install fallback.

### PR C: Activation, rollback and smoke tests
- Implement reversible activation, health checks, failure recovery, last-known-good pointer, and conservative migration handling.
- Add isolated end-to-end tests using a disposable installation or USB-like filesystem fixture.
- Record test evidence and validation artifacts where test management is available.

### PR D: Extend compatibility
- Only after concrete evidence, add other distribution formats (npm, portable bundle, container) through narrow adapters rather than one giant updater.

## Acceptance tests
- Parsing, help, version metadata, and `--check` do not mutate local state.
- Offline, no release, malformed release metadata, read-only media, insufficient disk, unsupported target and permissions denied.
- Tampered binary and invalid/untrusted signature rejected before execution.
- Interrupt during download, staging, and activation leaves existing runtime usable or recovery available.
- Failed health check activates rollback safely.
- Owner artifact hashes, local database, Manifest, MemChart, secrets and configuration preserved across update and rollback.
- No bypass of `dispatch()`, capability resolution, or ledger.
- E2E smoke flow exercises a real isolated update and rollback.
- Tests have provenance; test-validation/review artifacts where supported.

## Definition of done
An isolated installation can check, securely update and roll back **one supported channel**, with no owner data loss, documented failure behaviors, evidence-backed tests and a reviewable ledger. Any unimplemented flags must return explicit unsupported responses, not pretend to work.

## Constraints for Claude
Start by examining current code. Mark implemented vs proposed. Avoid broad refactors or new engines. Make PR-sized changes and get owner review before any install mechanism modifies a real ARK instance.
