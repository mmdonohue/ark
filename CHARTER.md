# ARK Architecture Charter

> ARK is a memory operating system in which immutable intent is resolved
> through contracts into governed execution, producing durable artifacts,
> provenance, and memory.

This is the architecture reference. README.md is the quick orientation;
this document is the thing to read before changing a runtime primitive,
and the place new primitives get argued for before they're built.

Two kinds of claim live in this document, and they are kept visually
distinct on purpose: **built** (grounded in a real file/behavior, checked
against the code as of this revision) and **proposed** (a design
direction, explicitly not yet implemented). Do not treat a proposed
section as permission to assume it exists — grep for it first.

------------------------------------------------------------------------

# 1. Constitutional Principles

These are invariants, not implementation choices. A Manifest can change
how a host satisfies them; nothing can opt out of them.

1.  **Everything is an Artifact.** Durable units of content/state/
    reference are the one substrate.
2.  **Everything meaningful is governed by Contracts.** Intent resolves
    into execution through declared rules, not ad hoc code paths.
3.  **Canonical Packets are immutable.** The requested intent doesn't
    mutate as it moves through resolution.
4.  **There are no privileged execution paths.** CLI, HTTP, scripts —
    every caller reaches the same `dispatch()`; none reach the database
    directly.
5.  **Capabilities are declared before execution, never assumed.** A
    provider being *able* to run is not the same as being *authorized*
    to.
6.  **Intent and execution must be independently auditable.** What was
    asked for and what actually happened are both reconstructable, and
    separately.
7.  **History is durable; authority is not.** What happened is preserved
    even after the permission that allowed it expires.
8.  **Memory is intentional.** Nothing becomes durable memory by
    accident — MemChart says what a vessel values enough to keep.
9.  **Current state is a projection.** What you query is a shaped view
    over immutable history, not the source of truth itself.
10. **Observations evolve.** Derived understanding can be revised
    without touching the source it was derived from.
11. **Execution must preserve provenance.** Every artifact can answer
    what produced it, from what source, through which contract.
12. **Everything composes.** Prefer combining existing primitives over
    inventing a new special-case engine for the next product idea.
13. **Resolution should replace special-case orchestration** wherever
    a resolver role can do the same job.
14. **The Constitution defines invariants; the Manifest configures an
    implementation.**
15. **MemChart defines what a vessel intends to remember.**
16. **Execution requirements are themselves resolvable contracts.**
17. **Executors define how code runs, never what code is authorized to
    do.** Compatibility is not authorization.

------------------------------------------------------------------------

# 2. Boot Model

```text
Constitution
    ↓
MemChart
    ↓
Manifest
    ↓
Runtime
```

Constitution defines universal invariants. MemChart defines what this
vessel values enough to preserve. Manifest declares the available
implementation — adapters, services, defaults, environment-specific
config. Runtime resolves and executes governed packets. The Manifest may
change between hosts; the Constitution must not.

------------------------------------------------------------------------

# 3. Primitives — Built Today

Everything in this section is real, grounded in the current code, not a
target.

| Term | Meaning | Lives in |
|---|---|---|
| **Artifact** | Durable unit of content/state/reference | `domain/Artifact.js` |
| **Contract** | Declared rules governing intent, access, execution | template artifacts, `TemplateResolver` |
| **Packet / CanonicalPacket** | Immutable statement of requested intent | `core/Packet.js` |
| **Manifest** | Host configuration — which adapters/services/providers this vessel has | `core/Manifest.js`, `core/bootstrap.js` |
| **PCER / ExecutionPacket** | The resolution trace a packet travels through before execution | `core/PCER.js` |
| **`dispatch(packet, ctx)`** | The single governed entry point — CLI, scripts, and any host's HTTP layer are all thin callers of this | `core/dispatch.js` |
| **ACTION_REGISTRY** | Capability → handler lookup, by exact name | `core/dispatch.js` |
| **ChainExecutor** | Durable record of an ordered execution instance; survives restart, resumable | `core/ChainExecutor.js` |
| **ArtifactLedger** | Proof of authorized execution and resolution | `actions/LedgerActions.js` |
| **Pipeline** | A real `artifact_type`, authored as a directory and registered idempotently by content hash | `core/PipelineRegistry.js`, `core/PipelineResolver.js`, `pipelines/` |
| **RuleEvaluator** | One shared mechanism: given a fact set and an ordered `when`/`then` rule list, apply matches in order | `core/RuleEvaluator.js` |
| **Persona** | What kind of vessel this is (`hiker`, `store`, ...) — set once at provisioning, drives which pipeline recipes preload | `pipelines/personas.yaml`, `cli/localIdentity.js` |
| **Role** | What an actor can do on this vessel — `artifact_type: 'role'`, rank-based | `domain/ArkActor.js`, `actions/ArkActorActions.js` |

**The real PCER trace, in order:**

```text
trace.open → auth.verify → ledger.open → scope.resolve → payload.project → service.bind
```

(`core/dispatch.js`, `core/PCER.js`.)

**Real stage result categories:** `merge`, `gate`, `void`, `side_effect`,
`observe`. `validate`, `trace`, and `replace` are not implemented — don't
assume them in new stage code.

**Real provenance fields:** `template_id`, `template_slug`,
`template_content_hash`, `resolved_hash`, `composed_from`,
`resolver_version` (`core/PCER.js`, `core/TemplateResolver.js`).

**What `ACTION_REGISTRY` actually is:** `{capability → handler}`, exact
name, one implementation per key. It is **not** a multi-candidate
resolver choosing among competing providers for a capability — see §4.

**What's real about Pipeline:** a pipeline is authored as a directory
(`pipeline.yaml` + `rules/*.yaml` + optional `memchart.yaml`), registered
as a `pipeline` artifact at boot via a content-hash rescan — unchanged
hash is a no-op, changed hash registers a new version. `bin/` payloads
stay on disk, referenced by path + file hash, so drift from what was
reviewed at registration is detectable. Rule files are a list of
`when`/`then` entries evaluated by the one shared `RuleEvaluator` — not
bespoke JS per stage, not a forward-chaining engine (single ordered
pass, no re-triggering, no cycles). A pipeline can invoke a child
pipeline as a stage (`pipeline: classify`); the parent's rules interpret
the child's output, so the child stays reusable and opinion-free.
Reference implementations: `pipelines/usb-sd-birds/` (the real USB/media
import pipeline — proven, not aspirational) and `pipelines/classify/`
(a two-file recipe: classify one media file's subject via a
vision-capable LLM, knows nothing about its callers).

**What's real about a Provider that isn't an executable:** a provider
can be a plain ARK action calling a Manifest service (e.g.
`pipelines/classify/providers.yaml` satisfies `media.classify.vision`
via the `llm` service, already capability-scoped through
`service.bind`) — no executor resolution needed, because nothing gets
spawned.

**What's a real, known stub:** scope narrowing. `TraceActions.js`
currently grants whatever scope is requested — the comment on that line
marks it explicitly: a future `PolicyResolver` is meant to narrow it.
Treat any capability that depends on narrowed scope (e.g. per-device
filesystem access) as all-or-nothing today.

------------------------------------------------------------------------

# 4. Primitives — Proposed, Not Built

These are real design directions, several with a concrete worked example
below them, but nothing here should be assumed present without checking.
Build only when a real caller needs it — a field or class that exists
"to look complete" is worse than not having it.

### Provider resolution (multi-candidate)

Today, `ACTION_REGISTRY` is exact-name, one implementation per
capability. The proposed model is a true resolver: a capability like
`media.metadata` could have several registered providers, and
resolution — not the caller — picks one, subject to contract
constraints. No precedent for this exists in the codebase yet; it's a
genuine new subsystem, not a generalization of something already there.

### Executor

> An Executor defines *how* an executable provider's code runs — python,
> node, shell, container, remote compute. Executor compatibility is not
> authorization: finding Python 3.12 proves code *can* run, not that it
> *may* touch the filesystem, network, or a service.

Nothing in the runtime currently resolves or checks executor
compatibility. The one real precedent for "a provider satisfies a
capability without an executor" is §3's plain-ARK-action providers —
useful evidence that most providers may never need this machinery at
all.

### Pipeline sourcing beyond a local directory

The local directory + boot-time rescan (§3) is the only sourcing
mechanism that exists. `ark install pipeline <git-repo>` — clone into
`pipelines/<slug>/`, then call the same rescan function — is specced as
a governed action (network + filesystem.write capabilities, routed
through `dispatch()` like anything else) but not implemented. A
container image as a *distribution format* (extract into
`pipelines/<slug>/`, same rescan) and a container as a real *executor*
(code runs inside the image at execution time) are different facts
about a provider and must not be conflated if either gets built.

### Promise — deferred execution on a rule condition

> A Promise is a durable record of intent to execute an action once a
> rule-based condition resolves true against the vessel's current facts.

Composition of two things that already exist — an artifact
(`artifact_type: 'promise'`) plus the same `RuleEvaluator` every pipeline
rule file already uses, matched against vessel/environment facts instead
of discovered-file facts. `cron` (time-based recurrence) would be a
separate explicit field evaluated by a real cron-expression library, not
forced through `RuleEvaluator`'s fact-matching — a genuine
implementation-boundary case per the "resolver is a role, not every
problem" discipline below. None of this is built: no `promise` artifact
type, no checker, no cron library, no `ark run`/daemon loop, no fact
source beyond the idea of "connectivity." Reference scenarios worth
keeping in mind when this gets built: a hiker vessel deferring a
notification until signal returns, or a store vessel's always-on loop
(heartbeat / peer discovery / drain work) — both are invocation
questions, not new execution mechanisms; whatever invokes the check
still calls the same `dispatch()` everything else does.

### Audience (packet-level)

A proposed PCER scope dimension — "who/what should receive this
result?" — distinct from **persona** (vessel-level, persistent, drives
preloaded recipes) and **role** (actor-level, persistent, capability).
The relationship, if built: a vessel's persona defaults a dispatched
packet's `audience`, overridable per packet/contract, the same way
`role`/`rank` already work as a scope dimension. Nothing currently reads
`ep.audience` — no catalog exposure, no peer sync, no audience-branching
render path. Wiring the field in before a real consumer exists is dead
plumbing; the mechanical part (mirroring `role`/`rank`) is proven and
small once something actually needs it.

### Resolver is a role, not necessarily a class

Avoid multiplying named subsystems (`ExecutorResolver`,
`GatewayResolver`, `PolicyResolver`, ...) unless a concrete
implementation boundary justifies a standalone one — most resolution is
just `requirement → candidates → constraints → resolved binding`, and a
merge stage can be that whole thing. `cron` above is the one place in
this document where a boundary *was* judged real (schedule-matching is
not a fact-matching problem); treat that as the bar, not the default.

------------------------------------------------------------------------

# 5. Preserve First, Understand Second

> Ingestion must not depend on successful semantic understanding.

A photo should not fail preservation because the LLM is unavailable,
classification fails, EXIF is malformed, or a derived stage crashes. The
source layer (raw bytes, content hash, provenance) and the derived-memory
layer (interpretation, routing) are separate. Derived artifacts can
evolve; the source's identity must stay stable. This is not aspirational
— it's the shape `pipelines/usb-sd-birds/` is already built around:
raw preservation happens regardless of whether classification succeeds.

------------------------------------------------------------------------

# 6. MemChart

> MemChart defines what deserves to become memory for a vessel.

It is not merely an import filter — it can participate as an assessment
stage inside a pipeline (`source preservation → MemChart assessment →
derived understanding/routing`), and it must not destroy provenance: if
policy says a source isn't worth promoting into durable memory, ARK
should still be able to explain what was assessed and why.

------------------------------------------------------------------------

# 7. Access Is Contractual (design direction)

> Access is a scoped capability granted by a contract, not a permanent
> property of an artifact.

Don't model future access as a growing list of artifact flags
(`public`, `friends`, `paid`, `followers`, ...). The stronger shape:

```text
Artifact → Catalog → Gateway → Access Contract → Scoped Capability
```

Paid subscription, federation membership, follower access — all should
be different contracts over the same machinery, not separate flag
systems. History is durable; authority is not: an ARK may preserve that
an access relationship existed after the capability itself expires. No
implementation of any specific access product is in scope here — this
is the shape future access work should take, not a roadmap item.

------------------------------------------------------------------------

# 8. Explicitly Out of Scope

Useful stress tests for whether the architecture is general enough —
not instructions to build:

- **Memorytown registry** — an ARK can exist sovereign and optionally
  register with a canonical registry; identity shouldn't depend on a
  central service.
- **Goals / funding** — should resolve from `Artifact + Contract +
  Account + Resolver`, not a hardcoded crowdfunding engine.
- **Pal** — a mutually accepted, scoped, expiring relationship contract,
  not a permanent `friend=true` flag.
- **Subscription** — different contract conditions over the Access
  Contract machinery in §7, not a separate billing primitive.
- **Guide / Creator / Curator / Store roles** — product-layer roles;
  should not become constitutional runtime types unless implementation
  actually proves a new primitive is required.
- **PCT Expedition** — if this needs a `HikerWorkflow`, the abstraction
  is wrong; it should express from generic primitives (this is also the
  actual origin of the real `hiker` persona in §3).
- **Cinema / World / ARK DJ** — future renderers/curation models, valid
  architectural stress tests, not current roadmap.

------------------------------------------------------------------------

# 9. Anti-Patterns

Reject designs that introduce:

- **Privileged import paths** — `script → database` directly. Always
  `script → dispatch() → governed runtime`.
- **Opaque executable orchestration** — `pipeline → bin/do_everything.py`
  hides decisions ARK can no longer reason about.
- **Hardcoded host paths** (`/usr/bin/python3`) inside portable pipeline
  intent.
- **Artifact permission flags multiplying per product feature**
  (`is_pal`, `is_paid`, `is_follower`, `is_pct`) instead of §7's
  contract model.
- **Product nouns becoming engine primitives without necessity**
  (`HikerEngine`, `DJResolver`, `CreatorRuntime`).
- **AI on the preservation hot path** — raw preservation must not depend
  on LLM availability (§5).
- **Silent environment mutation** — a missing executor does not
  authorize ARK to install one.
- **A parallel pipeline runtime** — a second dispatch/ledger/capability
  engine alongside the real one.

------------------------------------------------------------------------

# 10. Working Vocabulary

| Term | Status | Meaning |
|---|---|---|
| **Artifact** | built | Durable unit of content/state/reference |
| **Contract** | built | Declared rules governing intent, access, execution, or relationship |
| **Canonical Packet** | built | Immutable statement of requested intent |
| **ExecutionPacket** | built | Minimal authorized projection used for execution |
| **MemChart** | built | Vessel-level intent for what deserves memory |
| **Manifest** | built | Host implementation/service/provider configuration |
| **Pipeline** | built | Ordered, composable declaration of stages, registered as a real artifact |
| **Stage** | built | Declared unit of resolution/processing/execution within a pipeline |
| **Persona** | built | What kind of vessel this is; drives preloaded pipeline recipes |
| **Role** | built | What an actor can do on this vessel; rank-based |
| **Chain** | built | Durable instance/record of ordered execution |
| **Ledger** | built | Proof of authorized execution and resolution |
| **Provider (resolved, multi-candidate)** | proposed | An implementation selected among competitors for a capability |
| **Executor** | proposed | Mechanism by which executable provider code runs, pre-resolved for compatibility |
| **Promise** | proposed | Durable intent to execute once a rule condition resolves true |
| **Audience** | proposed | Packet-level "who should receive this" scope dimension |
| **Workflow** | conceptual only | Business/process progression involving tasks or human decisions — distinguish from Pipeline (processing/resolution stages); no `Workflow` class exists, and none should until a real caller needs process state rather than data processing |

Terms that appeared in earlier design notes and have zero implementation
or active use anywhere in this codebase — **Eye**, **Lens**,
**Projection**, **Librarian** — are dropped from this document. If one
of them gets built, it earns a row here grounded in a file reference,
same as everything else in §3.

------------------------------------------------------------------------

# 11. Final Guidance

Keep ARK small.

When a new idea appears, ask: **is this a new primitive, or a
composition of primitives we already have?** Prefer composition.

When implementation depends on environment, ask: **can this be
expressed as a requirement and resolved?** Prefer resolution — but only
once something real needs resolving (§4's `audience` is the cautionary
example: a resolvable field with no reader is dead plumbing).

When code wants authority, ask: **which contract granted it?** Prefer
explicit capability.

When memory is created, ask: **what source did this come from, what
transformed it, and can we reconstruct why it exists?** Preserve
provenance.

When a product idea demands a special engine, ask: **would the same
behavior emerge from Artifact + Contract + Pipeline + Gateway + Resolver
+ Ledger?** If yes, don't build the special engine.

------------------------------------------------------------------------

# 12. North Star

> ARK should be able to carry its intent, discover what the current
> vessel can do, resolve the smallest authorized execution necessary, do
> the work, and remember why it happened.

Everything else composes from there.
