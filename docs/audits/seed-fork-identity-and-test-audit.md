# Audit Proposal: Seed, Fork, and Vessel Identity Invariants

**Status:** Audit/backlog capture only. Documentation-only PR; no behavior or tests changed.
**Priority:** Post-USB boot/update stabilization. Audit first; any remediation should use small independent PRs.
**Scope:** Local vessel creation and identity bootstrapping, `ark fork`, existing template seeding, and terminology around proposed `ark seed` / `ark clone`.

## Why revisit this

ARK's early local-vessel operations were designed before the current owner-absolute, governed contracts, portability and provenance architecture. Audit whether the old operations meet today's invariants, rather than assume that directory copies are safe merely because they work.

**Vocabulary decision to evaluate, not implement in this PR:**
- `ark seed`: create a fresh ARK/vessel and new identity from a minimal foundation (proposed; not currently a standalone command).
- `ark fork`: create an independently evolving ARK with its **own identity**, explicitly authorized owner, and recorded ancestry (command exists but must be audited).
- `ark expand`: grow an existing ARK's available capabilities without changing its identity (future feature).
- `ark clone`: do **not** add casually. Identity-preserving replication entails conflicting authorities and a synchronization/handoff protocol; portability of the same USB is not a clone.
- Existing `ark seed-projects` is **template provisioning**, not vessel seeding. Preserve that distinct meaning.

## Evidence reviewed on main

1. `cli/ark.js` implements `runFork` as an out-of-dispatch filesystem operation. It checks source/destination presence and rejects Supabase manifests; makes a best-effort SQLite WAL checkpoint; performs `fs.cpSync(sourceDir, destDir, { recursive: true })`; rewrites only `ark.yaml` fields `name`, `version`, `forked_from`, `created_at`. No explicit re-key/re-ID, owner grant, artifact lineage rewrite, policy gate, atomic staged copy or post-copy verification is visible in this code path. **Risk, not proof of exploit**: the copied SQLite database may preserve actors/IDs/credentials/authority from the original. Verify schema and runtime behavior before concluding an invariant is violated.
2. `cli/localIdentity.js` implements `ensureLocalIdentity`: provisions roles, a vessel persona artifact and first local owner actor; deliberately uses a privileged bootstrap exception on the first creation; subsequent calls reuse an existing actor. Inspect how this behaves if a whole database is copied and whether an attacker could spoof local owner context.
3. `cli/seedProjects.js` provides idempotent developer/base template provisioning via `dispatch`. `tests/projects.test.js` includes meaningful assertions for idempotence, template upgrades, base-shell inheritance and pinned template provenance. These are **not** tests for fresh-vessel seeding or fork lineage.
4. A search for `runFork` and `forked_from` found implementation and manifest references, but no dedicated fork-specific test file in the inspected results. **Verify full suite and CI names before claiming no coverage exists.**
5. No standalone `ark clone` or `ark seed` was found in the inspected CLI; the `ark fork` command should not be renamed or removed until migration/backward compatibility is assessed.

References: `CONSTITUTION.md`, `CHARTER.md`, `core/dispatch.js`, `cli/ark.js`, `cli/localIdentity.js`, `cli/seedProjects.js`, `tests/projects.test.js`, relevant SQLite/identity/auth policy modules.

## Audit questions and expected evidence

### A. Identity and authority
- What is a vessel's canonical identity? Is it the manifest name, a persona artifact, a database ID, a cryptographic key, or a composition? Document all current identity-bearing fields.
- Which identifiers are duplicated by `fork` (owner actor IDs, artifact IDs, tokens, keys, service credentials, ledger correlation IDs)? Determine which must be **new**, which may retain historical references, and which must never be copied.
- Does a fork assign **new identity** and an explicitly approved owner? Can source and destination execute concurrently without overlapping authority?
- How do owner-absolute and caretaker/steward rules apply to inherited artifacts? Forking a vessel must not silently transfer ownership of objects held in custody or change original owners.
- Does first-run bootstrap's privileged exception remain tightly constrained? Is identity provisioning idempotent only within the correct vessel? Can a copy/move be distinguished from first-run seed?
- Identify the authorization/contract boundary for `fork`. Any unavoidable pre-identity bootstrap exception must be narrowly documented and tested. Simply asserting that a filesystem copy is outside the graph is not sufficient.

### B. Provenance and historical truth
- Record unambiguous ancestry: source vessel identity, fork point, source version, verified reference, authorized initiator and timestamp.
- Preserve audit history as **historical evidence**, without misrepresenting past source actions as newly authorized destination actions.
- Decide whether historical artifact IDs should remain immutable references, be remapped or be imported with provenance; test referential integrity and cross-vessel relationships.
- Validate lineage over repeated forks, forks of forks, and post-fork changes; an edit to either must not contaminate the other.

### C. Filesystem, SQLite and portability
- Audit active SQLite connections, WAL/SHM consistency, permission failures, partial copies, USB disconnects, disk full, symlinks/path traversal, unexpected names, and source/destination path containment.
- Require staged copy, verification and atomic exposure where supported; define safe recovery on filesystems without symlinks (e.g. exFAT).
- Verify copied caches, runtime references and machine-specific paths do not incorrectly bind the destination to the source machine.
- Ensure fork or seed does not overwrite an existing vessel, mutate the source, or leak secrets by default.
- Confirm existing behavior using fixtures; keep source backups and review migration/rollback risk.

### D. Test quality (inspect existing tests first)
Construct a coverage matrix tagging each case **covered / partial / missing** with exact paths and assertions. Recommended cases:

| Scenario | Required assertion |
| --- | --- |
| Seed from empty storage | Unique owner/vessel identity; minimum records and manifest; no implicit cloud access |
| Re-run seed | Idempotent, preserves existing owner/artifacts and their references |
| Seed fails halfway | Safe resume, no usable half-initialized authority |
| Fork authorization | Non-owner/guest cannot fork; owner explicitly approves intent |
| Fork identity | Destination independently identifiable; no duplicated live authority |
| Fork ancestry | Source pointer/version/fork point provable; multiple generations correct |
| Source and destination isolation | Writes, credentials, actor changes and policies do not bleed across |
| Custodial artifacts | Caretaker/steward rights are not converted to owner rights |
| Ledger/graph integrity | Historical references remain meaningful; destination actions attributed correctly |
| Existing destination/path tricks | Rejected without modification to source or other paths |
| Live SQLite and WAL | Snapshot consistent or fail closed if consistency unavailable |
| Interrupted/full USB | Recoverable staged state; no partial advertised success |
| Secrets and host-specific config | Intentional migration policy; no accidental credential propagation |
| Template seeding | Existing `seed-projects` invariants and provenance tests still pass |
| Cross-host portability | Moving the *same* vessel does not create a fork or new identity |

Prefer small deterministic temporary-vessel fixtures, mocks/injected failure points for crash paths, and end-to-end CLI tests for real user-visible operations. Include negative cases and measure coverage of actual **invariants**, not just line coverage.

## Deliverables from the audit (future implementation work, NOT this PR)

1. Identity/authority field inventory and verified current behavior with code pointers.
2. Coverage matrix, reproducible failures and minimal red tests for demonstrable violations.
3. Risk assessment prioritized by owner-identity compromise, integrity, data loss and regression cost.
4. Proposed `seed/fork/expand` CLI contract consistent with current architecture, plus explicit decision on `clone` (likely deferred).
5. Incremental remediation PR plan (tests first; identity protocol; authorized fork; safe copy; lineage; CLI/docs migration), each reversible or guarded with explicit migration steps.

## Guardrails / acceptance for this documentation PR

- **No live `fork`, `seed-projects`, SQLite, USB, setup, release, update or identity behavior changed.**
- This is an audit request, not an assertion that existing test suite is broken or that existing owners have been compromised.
- Do not weaken constitutional authorization to accommodate the old filesystem path.
- Avoid a sweeping rewrite; audit existing code, reproduce specific issues and sequence small PRs behind current USB work.
- Existing `ark seed-projects` continues to mean *template seeding* until an explicit CLI-design decision is made.
- Track any new `seed` command separately from bootstrap installation: installing Core is not creating a new owner's identity.

**Claude handoff:** Before proposing implementation, read current Constitution and Charter, inventory all seed/fork/identity surfaces and tests (including not identified by text search), and report the exact contracts plus minimal failing validation cases. Keep this audit parked in the backlog while the signed thumb boot/update baseline is being proven.
