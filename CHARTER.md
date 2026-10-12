# ARK Architecture Charter

## Constitutional Runtime Reference + Next Implementation Charter for Claude

**Status:** Working architecture charter\
**Purpose:** Reconcile the existing ARK Constitution with the runtime
that is actually built, formalize the newly discovered composable
pipeline model, and define the next proof: governed import from an
attached USB media disk.

------------------------------------------------------------------------

# 1. Instruction to Claude

Read this document together with:

1.  `CLAUDE.md`
2.  `.claude/diary/relationship.md`
3.  the current ARK Constitution / `ark_contract.md`
4.  the current execution plan
5.  current `backend/core/`, `backend/actions/`,
    `backend/routes/action.js`, migrations, and tests

**Do not treat this document as permission to redesign working runtime
primitives.**

The current engine is real and tested. Extend it by composition.

Before implementation:

-   inspect current code and git state;
-   identify what already satisfies this charter;
-   identify the smallest generalization required;
-   preserve existing request lifecycle, provenance, capability
    enforcement, and ledger behavior;
-   propose migrations only where persistent state is genuinely
    required;
-   add tests with every runtime change.

The immediate goal is **not** Memorytown, PCT, social networking,
funding, subscriptions, ARK hardware, or global federation.

The immediate goal is:

> **Prove that ARK can ingest an attached media disk through a
> composable, governed, replayable pipeline without creating a
> privileged execution path.**

------------------------------------------------------------------------

# 2. ARK in One Sentence

> **ARK is a memory operating system in which immutable intent is
> resolved through contracts into governed execution, producing durable
> artifacts, provenance, and memory.**

The runtime must remain useful even when every current product idea is
removed.

------------------------------------------------------------------------

# 3. Constitutional Principles

These principles remain authoritative.

1.  **Everything is an Artifact.**
2.  **Everything meaningful is governed by Contracts.**
3.  **Canonical Packets are immutable.**
4.  **There are no privileged execution paths.**
5.  **Capabilities are declared before execution.**
6.  **Intent and execution must be independently auditable.**
7.  **History is durable; authority is not.**
8.  **Memory is intentional.**
9.  **Current state is a projection.**
10. **Observations evolve.**
11. **Execution must preserve provenance.**
12. **Everything composes.**
13. **Resolution should replace special-case orchestration wherever
    possible.**
14. **The Constitution defines invariants; the Manifest configures an
    implementation.**
15. **MemChart defines what a vessel intends to remember.**

New constitutional clarification:

> **Execution requirements are themselves resolvable contracts.**

And:

> **Executors define how code runs, never what code is authorized to
> do.**

------------------------------------------------------------------------

# 4. Existing Runtime Is the Baseline

The following are existing architecture, not speculative replacements:

-   `Manifest`
-   `Packet`
-   `CanonicalPacket`
-   `SchemaReflector`
-   `TemplateResolver`
-   `PCER`
-   `ExecutionPacket`
-   `ChainExecutor`
-   `ArtifactLedger`
-   capability-bearing `ACTION_REGISTRY`
-   `dispatch(packet, ctx)`
-   stable egress envelope
-   contract provenance:
    -   `template_id`
    -   `template_slug`
    -   `template_content_hash`
    -   `resolved_hash`
    -   `composed_from`
    -   `resolver_version`
-   stage result categories:
    -   `merge`
    -   `validate`
    -   `trace`
    -   `observe`
    -   `replace`
    -   `side_effect`
-   immutable raw chat import + later Librarian derivation
-   artifact/template composition

Do not create a parallel engine for pipelines.

The pipeline model must **generalize and compose with these
mechanisms**.

------------------------------------------------------------------------

# 5. Boot Model

The conceptual boot sequence remains:

``` text
Constitution
    ↓
MemChart
    ↓
Manifest
    ↓
Runtime
```

Interpretation:

### Constitution

Defines universal invariants.

### MemChart

Defines what this ARK/vessel values enough to preserve.

### Manifest

Declares available implementation capabilities, services, providers,
executors, policy bindings, defaults, and environment-specific
configuration.

### Runtime

Resolves and executes governed packets.

The Manifest may change between hosts.

The Constitution must not.

------------------------------------------------------------------------

# 6. The New Primitive: Pipeline

## 6.1 Definition

> **A Pipeline is an ordered, composable Artifact describing stages of
> resolution and/or execution.**

A pipeline is declarative.

A pipeline is not a script.

A pipeline is not a new privileged runtime.

A pipeline does not bypass `dispatch()`, PCER, capabilities, contracts,
provenance, or ledger execution.

## 6.2 Why Pipeline Becomes Explicit

ARK already contains pipeline-shaped concepts:

``` text
PCER
  stage → stage → stage

ChainExecutor
  step → step → step

Eye Group
  eye → eye → eye

Import
  discover → parse → preserve → derive
```

These should converge on common composition semantics where doing so
simplifies the architecture.

Do **not** force every mechanism into one class merely for conceptual
purity.

The goal is a shared model of:

-   ordered stages;
-   declared inputs/outputs;
-   composition;
-   capability requirements;
-   provider resolution;
-   provenance;
-   replay;
-   failure/resolution semantics.

------------------------------------------------------------------------

# 7. Pipeline Composition

A pipeline may compose stages and other pipelines.

Example:

``` yaml
artifact_type: pipeline
slug: media.import

stages:
  - source.mount
  - source.discover
  - pipeline: media.identify
  - media.preserve
  - memchart.assess
  - media.derive
  - librarian.route
```

A composed pipeline must retain provenance.

ARK must be able to answer:

-   Which pipeline was requested?
-   Which version/hash was resolved?
-   Which pipelines/stages were composed into it?
-   Which providers were selected?
-   Which executor satisfied each executable provider?
-   Which capabilities were granted or denied?
-   What source produced each resulting artifact?
-   What actually executed?

Composition must not erase lineage.

------------------------------------------------------------------------

# 8. Stage

A **Stage** is a declared unit within a pipeline.

A stage describes intent/capability, not necessarily implementation.

Example:

``` yaml
- capability: media.metadata
  input: discovered_media
  output: media_metadata
  result: merge
```

The pipeline should prefer:

``` text
media.metadata
```

over:

``` text
./bin/read_exif.py
```

The former expresses required capability.

The latter hardcodes implementation.

Existing PCER result categories should be reused where appropriate:

``` text
merge
validate
trace
observe
replace
side_effect
```

Do not invent new categories unless existing semantics cannot represent
the required behavior.

------------------------------------------------------------------------

# 9. Provider

> **A Provider is an implementation capable of satisfying a declared
> capability.**

Example:

``` yaml
provider:
  id: exif-python
  provides:
    - media.metadata
  executor: python
  entrypoint: bin/extract_metadata.py
```

A provider can be:

-   an ARK action;
-   a local executable;
-   a service adapter;
-   a remote service;
-   another governed implementation registered through the Manifest.

The requesting pipeline should not need to know which provider wins
unless its contract explicitly constrains selection.

Provider selection is resolution.

------------------------------------------------------------------------

# 10. `bin/` --- Executable Payloads

A pipeline/package may optionally contain a `bin/` directory.

Example:

``` text
media-import/
├── pipeline.yaml
├── schemas/
├── prompts/
├── rules/
├── tests/
└── bin/
    ├── extract_metadata.py
    ├── make_preview.js
    └── fingerprint
```

`bin/` is **language agnostic**.

Its contents are implementation payloads.

They do not gain authority merely because they are executable.

A pipeline must never become:

``` yaml
steps:
  - exec: ./bin/do_everything
```

That hides orchestration inside an opaque executable and bypasses ARK's
ability to reason about intent, capabilities, provenance, and
resolution.

Correct direction:

``` text
pipeline declares capability
        ↓
provider satisfies capability
        ↓
provider declares executor requirement
        ↓
executor is resolved
        ↓
ARK authorizes shaped execution
        ↓
provider runs
```

------------------------------------------------------------------------

# 11. Executor

> **An Executor defines how an executable provider runs.**

Examples:

-   `python`
-   `node`
-   `shell`
-   native binary
-   container
-   remote compute

Example provider:

``` yaml
provider:
  id: exif-reader
  provides: media.metadata
  executor:
    type: python
    version: ">=3.11,<3.14"
  entrypoint: bin/extract_metadata.py
```

Possible host binding:

``` yaml
executors:
  python:
    command: /usr/bin/python3
```

Another host could resolve the same requirement through:

``` text
uv
venv
conda
container
remote execution
```

The pipeline remains unchanged.

## Constitutional rule

> **Executor compatibility is not authorization.**

Finding Python 3.12 proves that an implementation can run.

It does not grant that implementation filesystem, network, device,
secret, service, or process authority.

Those remain governed capabilities.

------------------------------------------------------------------------

# 12. Pre-Resolution

Before consequential execution, ARK may perform advisory/resolution
stages that determine whether execution requirements can be satisfied.

Example:

``` text
media.metadata requested
       ↓
provider resolver
       ↓
provider requires python >= 3.11
       ↓
executor pre-resolver
       ↓
inspect available environment
       ↓
compatible executor found
       ↓
bind provider
       ↓
normal governed execution
```

Possible result:

``` text
Requirement: python >=3.11,<3.14
Found:       python 3.12.4
Binding:     /usr/bin/python3
Status:      compatible
```

Or:

``` text
Requirement: python >=3.11
Found:       python 3.9.18
Status:      incompatible

Alternate provider:
  available via container executor
```

Pre-resolution must not silently install dependencies or mutate the
host.

Installation itself would be consequential execution requiring its own
explicit contract and capabilities.

------------------------------------------------------------------------

# 13. Resolver Is a Role, Not Necessarily a Class

Preserve the Phase 8.5 insight:

> **A resolver can be a merge stage.**

Avoid multiplying named runtime subsystems such as:

``` text
ExecutorResolver
GatewayResolver
AccountResolver
SubscriptionResolver
FundingResolver
MediaResolver
```

unless a concrete implementation boundary justifies one.

Conceptually, these are all resolution roles:

``` text
requirement
    ↓
candidate facts/providers/contracts
    ↓
policy + capability constraints
    ↓
resolved binding/state
```

Prefer common stage semantics over special-case engines.

------------------------------------------------------------------------

# 14. Gateway

Gateway should be treated as a constitutional boundary concept, not as a
product-specific feature.

> **A Gateway is a governed boundary through which an ARK exposes or
> receives capabilities, catalogs, artifacts, services, or
> interactions.**

The current HTTP `/api/action` route is one implementation gateway.

Future gateways might include:

-   local CLI;
-   USB;
-   Bluetooth;
-   Wi-Fi peer discovery;
-   Memorytown;
-   another ARK;
-   a store;
-   a service;
-   a federation.

A gateway does not determine authority by itself.

Contracts do.

This distinction will matter later for public, Pal, subscriber,
federation, and paid access, but those applications are **not current
implementation scope**.

------------------------------------------------------------------------

# 15. Access Is Contractual

Future product ideas reveal a useful constitutional rule:

> **Access is a scoped capability granted by a contract, not a permanent
> property of an artifact.**

Do not model future access as a growing list of artifact flags such as:

``` text
public
friends
paid
followers
pct
private
```

A stronger general model is:

``` text
Artifact
   ↓ belongs/exposed through
Catalog
   ↓ exposed through
Gateway
   ↓ evaluated against
Access Contract
   ↓ grants
Scoped Capability
```

Examples such as Pal access, paid subscription, federation membership,
or follower access should be expressible by different contracts over the
same machinery.

Important:

> **History is durable. Authority is not.**

An ARK may preserve that access or a relationship existed while the
capability itself expires.

No implementation of these future applications is requested by this
charter.

------------------------------------------------------------------------

# 16. MemChart

MemChart remains constitutional.

> **MemChart defines what deserves to become memory for a vessel.**

It is not merely an import filter.

It can participate in pipelines as an assessment/intent stage.

For media import:

``` text
source preservation
      ↓
MemChart assessment
      ↓
derived understanding / routing
```

MemChart should not destroy provenance.

If policy says a source is not worth promoting into durable memory, ARK
should still be able to explain what was assessed and why, subject to
source retention policy.

------------------------------------------------------------------------

# 17. Preserve First, Understand Second

The existing chat importer established the correct pattern:

``` text
raw immutable source
        ↓
derived interpretation
```

Keep it.

For attached media:

> **Ingestion must not depend on successful semantic understanding.**

A photo should not fail preservation because:

-   the LLM is unavailable;
-   classification fails;
-   EXIF is malformed;
-   face/object analysis is unavailable;
-   the Librarian is offline;
-   a derived stage crashes.

The source layer and derived-memory layer are separate.

Derived artifacts can evolve.

The source's identity/provenance must remain stable.

------------------------------------------------------------------------

# 18. USB Media Disk --- Next Reference Pipeline

The next implementation target is an attached USB media disk.

This is deliberately mundane.

It should prove the architecture without requiring speculative product
work.

## 18.1 Desired conceptual pipeline

``` text
USB / Attached Media Source
        ↓
source.detect / source.mount
        ↓
source.discover
        ↓
media.identify
        ↓
media.fingerprint
        ↓
raw source preservation
        ↓
metadata extraction
        ↓
MemChart assessment
        ↓
derived media interpretation
        ↓
artifact creation / relations
        ↓
Librarian routing
        ↓
graph resolution
```

This is a conceptual target, not permission to implement every stage
immediately.

Claude should inspect existing import architecture and choose the
smallest first vertical slice.

------------------------------------------------------------------------

# 19. Recommended First Vertical Slice

Build the smallest end-to-end proof that demonstrates:

1.  attached/local media source can be specified;
2.  files can be discovered deterministically;
3.  supported media can be identified;
4.  raw bytes receive a media fingerprint;
5.  import is idempotent;
6.  source provenance is preserved;
7.  resulting artifacts are created through `dispatch()`;
8.  normal PCER/capability/ledger boundaries are used;
9.  pipeline/stage provenance is visible;
10. a provider can optionally demonstrate executor resolution.

Do **not** begin with AI classification.

Do **not** begin with automatic photo organization.

Do **not** begin with a polished UI.

Prove governed ingestion first.

------------------------------------------------------------------------

# 20. Suggested Package Shape

Do not adopt this blindly; reconcile it with the repository first.

Conceptually:

``` text
pipelines/
└── media-import/
    ├── pipeline.yaml
    ├── schemas/
    ├── prompts/
    ├── rules/
    ├── tests/
    └── bin/
        └── extract_metadata.py
```

If ARK's artifact/template system makes a filesystem `pipeline.yaml`
redundant, preserve the artifact-first architecture.

A filesystem package may be a distribution format.

The canonical pipeline should remain representable as an Artifact.

------------------------------------------------------------------------

# 21. Pipeline Artifact Shape --- Draft

This is a design target, not a mandatory schema.

``` yaml
artifact_type: pipeline
slug: media.import
version: 1

inputs:
  source:
    type: media_source

stages:
  - id: discover
    capability: source.discover
    result: merge

  - id: fingerprint
    capability: media.fingerprint
    result: merge

  - id: metadata
    capability: media.metadata
    result: merge
    optional: true

  - id: preserve
    capability: artifact.create
    result: side_effect

outputs:
  - imported_artifacts
```

Questions implementation should answer through existing architecture
rather than new special cases:

-   Is stage identity an Artifact?
-   Are pipeline stages embedded contract data or related artifacts?
-   How does `TemplateResolver` composition participate?
-   How does `ChainExecutor` persistence map to pipeline stages?
-   How are pipeline hashes represented in provenance?
-   How is replay expressed?
-   When does a pipeline compile/resolve into an executable chain?

------------------------------------------------------------------------

# 22. Pipeline vs Chain

Do not conflate these.

Proposed distinction:

> **Pipeline describes composition and intent. Chain records durable
> execution.**

Conceptually:

``` text
Pipeline
  declarative plan
       ↓ resolution
Executable stage plan
       ↓ execution
Chain
  durable runtime record
```

A pipeline can be reused.

A chain is an execution instance.

This should reuse `artifact_chains` and `artifact_chain_steps` if their
semantics fit.

Do not create parallel persistence without first proving why existing
chain records are insufficient.

------------------------------------------------------------------------

# 23. Pipeline vs Workflow

Likewise:

> **Pipeline is composition of processing/resolution stages. Workflow is
> business/process state involving tasks, decisions, or human
> progression.**

They may compose.

They are not automatically the same thing.

Example:

``` text
Workflow:
  "Review imported family archive"

may invoke:

Pipeline:
  "media.import"
```

A media pipeline should not become a BPM engine.

A BPM workflow should not need to know how Python executes EXIF
extraction.

------------------------------------------------------------------------

# 24. Pipeline vs Eye Group

The existing Eye model remains valuable:

> Lens defines perspective. Eye executes observation.

Do not delete this abstraction merely because pipelines now exist.

Investigate whether an Eye Group can **resolve into or invoke a
pipeline** while preserving its semantic role.

Example:

``` text
Canonical Packet
      ↓
Eye Group
      ↓
ordered observational stages
      ↓
Projection
```

The constitutional distinction remains:

-   Packet = canonical intent
-   Eye/Lens = perspective
-   Projection = shaped view
-   Pipeline = composable processing/execution
-   Workflow = process progression
-   Chain = durable execution instance

If implementation reveals redundancy, document the evidence before
collapsing concepts.

------------------------------------------------------------------------

# 25. Replay

Pipeline execution must remain replayable where side effects and source
availability permit.

Replay should distinguish:

``` text
re-evaluate
re-project
re-derive
re-execute side effects
```

Never casually replay consequential side effects.

A replayed import should not duplicate artifacts because
idempotency/source fingerprints must survive replay.

------------------------------------------------------------------------

# 26. Failure Semantics

Pipeline failure must preserve partial evidence.

ARK should be able to distinguish:

``` text
source discovery failed
provider unavailable
executor incompatible
capability denied
validation failed
optional stage skipped
side effect failed
pipeline partial
pipeline failed
pipeline resolved
```

Do not reduce every failure to an exception string.

Existing chain resolution semantics (`success`, `partial`, `failure`)
should be reused where appropriate.

------------------------------------------------------------------------

# 27. Cost and Resource Projection

Do not fully build economic accounting now, but preserve the
architecture needed for it.

Pre-resolution should eventually make it possible to know:

``` text
local provider available
remote provider required
LLM service required
network required
storage required
human review required
```

before consequential execution.

This supports future cost governance without embedding cost logic into
every provider.

------------------------------------------------------------------------

# 28. Portability

A pipeline should be portable across ARK environments when compatible
providers exist.

Example:

``` text
media.metadata
```

may resolve to:

``` text
Python provider on laptop
native binary on Mini ARK
container on server
remote provider on constrained hardware
```

The contract remains stable.

The implementation changes.

This is a core ARK property.

------------------------------------------------------------------------

# 29. Security Boundary for Executables

Executable providers are untrusted by default.

A provider may request capabilities such as:

``` text
filesystem.read
filesystem.write
network
device.usb
process.spawn
service.llm
secret.read
```

The resolved ExecutionPacket determines what is actually granted.

A provider must not inherit broad host authority merely because its
executor has it.

For the first implementation, perfect OS-level sandboxing is **not
required** unless already supported.

However, the architecture and ledger must clearly represent
intended/granted capability boundaries so stronger enforcement can be
added later.

Do not pretend application-level declarations equal a hardened sandbox.

------------------------------------------------------------------------

# 30. Architectural Proofs --- Not Current Scope

The following ideas are useful tests of abstraction but are **not
instructions to implement them now**.

## Memorytown Registry

An ARK may exist independently and optionally register with a canonical
registry.

Potential future distinction:

``` text
ark_id       permanent sovereign identity
ark_index    registry-assigned human index
```

This proves identity should not depend on a central service.

## Goals / Funding

A person may propose a Goal and receive staged funding.

This should eventually be expressible through:

``` text
Artifact + Arc + Contract + Account + Resolver
```

not a hardcoded crowdfunding engine.

## Pal

A Pal relationship may be a mutually accepted, scoped, expiring
relationship contract.

This should not require a special permanent `friend=true` primitive.

## Subscription

Free, paid, Pal-only, federation-only, or supporter access should be
different contract conditions over common gateway/access machinery.

## Guide / Creator / Curator / Store

These are future product roles and expressions.

They should not become constitutional runtime types unless
implementation proves they require a new primitive.

## PCT Expedition

If ARK requires a `HikerWorkflow` to support the PCT vision, the
abstraction is wrong.

The PCT should be expressible from generic primitives.

## Cinema / World / ARK DJ

These are future renderers and curation models.

They are valuable architectural stress tests, not current roadmap items.

------------------------------------------------------------------------

# 31. Anti-Patterns

Reject designs that introduce:

### Privileged import paths

``` text
script → database directly
```

Use:

``` text
script → dispatch() → governed runtime
```

### Opaque executable orchestration

``` text
pipeline → bin/do_everything.py
```

### Hardcoded host paths

``` text
/usr/bin/python3
```

inside portable pipeline intent.

### Artifact permission flags multiplying by product feature

``` text
is_pal
is_paid
is_follower
is_pct
```

### Product nouns becoming engine primitives without necessity

``` text
HikerEngine
DJResolver
CreatorRuntime
```

### AI on the preservation hot path

Raw source preservation must not depend on LLM availability.

### Silent environment mutation

A missing executor does not authorize ARK to install one.

### Parallel pipeline runtime

Do not build a second dispatch/ledger/capability engine.

------------------------------------------------------------------------

# 32. Questions Claude Must Resolve Against the Codebase

Before implementing the media pipeline, answer these from the current
repository:

1.  What is the smallest representation of a Pipeline that remains
    artifact-first?
2.  Can existing template composition represent pipeline composition?
3.  Can `ChainExecutor` serve as the durable execution instance of a
    resolved pipeline?
4.  How should stage result categories map onto ChainExecutor steps?
5.  Where should provider registration live?
6.  Can `ACTION_REGISTRY` itself be the first provider registry?
7.  What is the minimum Executor abstraction needed to prove Python
    execution?
8.  Where should executor compatibility resolution occur relative to
    PCER?
9.  What new provenance fields, if any, are actually required?
10. Can pipeline provenance be represented through existing
    template/composition hashes?
11. What capability should local media discovery require?
12. How should a source path/device be projected so arbitrary filesystem
    access is not implicitly granted?
13. What is the idempotency key for a media import?
14. How do raw media artifacts relate to `artifact_media`?
15. What remains source evidence versus derived Librarian memory?
16. Which stages can be replayed safely?
17. What tests prove there is still no privileged path?

Do not answer these from this document alone.

Answer them by inspecting the implementation.

------------------------------------------------------------------------

# 33. Implementation Sequence

Recommended order, subject to code inspection:

## Phase A --- Reconcile

-   inspect current runtime;
-   map this charter to existing classes;
-   identify zero-code conceptual matches;
-   document only genuine gaps.

## Phase B --- Minimal Pipeline Artifact

-   establish pipeline representation;
-   establish ordered stage declaration;
-   reuse composition/provenance mechanisms.

## Phase C --- Provider Binding

-   map capability to provider;
-   initially reuse existing action registry where possible;
-   avoid unnecessary abstraction.

## Phase D --- Minimal Executor Proof

-   support one language-agnostic executable provider;
-   Python is the first reference executor;
-   pre-resolve installed version compatibility;
-   no auto-install.

## Phase E --- USB Media Discovery

-   explicit source;
-   governed filesystem/device capability;
-   deterministic file discovery;
-   supported media detection.

## Phase F --- Preservation

-   raw byte fingerprint;
-   idempotent import;
-   source provenance;
-   Artifact/ArtifactMedia creation through `dispatch()`.

## Phase G --- Derived Metadata

-   EXIF/metadata provider;
-   optional stage;
-   failure does not invalidate preservation.

## Phase H --- MemChart + Librarian

-   only after raw preservation is proven;
-   derived interpretation/routing remains separable and replayable.

------------------------------------------------------------------------

# 34. Definition of Done for the First Proof

The first media pipeline proof is complete when:

-   a user can point ARK at an attached/local media source;
-   ARK resolves the declared pipeline;
-   required capabilities are visible before execution;
-   providers are selected through resolution;
-   at least one executable provider demonstrates executor resolution;
-   incompatible executor requirements fail before provider execution;
-   files are discovered deterministically;
-   media fingerprints are stable;
-   duplicate imports are idempotent;
-   source artifacts/media preserve provenance;
-   import travels through `dispatch()`;
-   PCER and capability gates remain active;
-   ledger records execution;
-   chain/stage execution is inspectable;
-   optional metadata failure can produce a partial result without
    losing raw preservation;
-   tests cover success, duplicate, denied capability, incompatible
    executor, partial metadata failure, and replay/idempotency;
-   existing tests remain green.

------------------------------------------------------------------------

# 35. The Test of the Architecture

The USB media importer is not important because importing photos is
novel.

It is important because it forces ARK to prove:

> **Can arbitrary real-world work be described as composable intent,
> resolved against the capabilities of the current vessel, executed
> through one governed boundary, and preserved with enough provenance to
> understand and replay what happened?**

If yes, the same architecture can later support much stranger things
without becoming a pile of product-specific engines.

That is the point.

------------------------------------------------------------------------

# 36. Final Guidance

Keep ARK small.

When a new idea appears, ask:

> **Is this a new primitive, or a composition of primitives we already
> have?**

Prefer composition.

When implementation depends on environment, ask:

> **Can this be expressed as a requirement and resolved?**

Prefer resolution.

When code wants authority, ask:

> **Which contract granted it?**

Prefer explicit capability.

When memory is created, ask:

> **What source did this come from, what transformed it, and can we
> reconstruct why it exists?**

Preserve provenance.

When a product idea demands a special engine, ask:

> **Would the same behavior emerge from Artifact + Contract + Pipeline +
> Gateway + Resolver + Ledger?**

If yes, do not create the special engine.

------------------------------------------------------------------------

# 37. Working Architectural Vocabulary

Use these terms consistently:

  -----------------------------------------------------------------------
  Term                                Meaning
  ----------------------------------- -----------------------------------
  **Artifact**                        Durable unit of
                                      content/state/reference

  **Contract**                        Declared rules governing intent,
                                      access, execution, or relationship

  **Canonical Packet**                Immutable statement of requested
                                      intent

  **ExecutionPacket**                 Minimal authorized projection used
                                      for execution

  **MemChart**                        Vessel-level intent for what
                                      deserves memory

  **Manifest**                        Host
                                      implementation/service/provider
                                      configuration

  **Pipeline**                        Ordered, composable declaration of
                                      stages

  **Stage**                           Declared unit of
                                      resolution/processing/execution

  **Provider**                        Implementation satisfying a
                                      capability

  **Executor**                        Mechanism by which executable
                                      provider code runs

  **Resolver**                        Role/stage that selects or merges a
                                      valid binding/state

  **Gateway**                         Governed boundary for
                                      interaction/exposure

  **Projection**                      Derived view of immutable canonical
                                      intent

  **Eye**                             Observational perspective that
                                      produces/shapes projection

  **Workflow**                        Process progression involving
                                      tasks/state/decisions

  **Chain**                           Durable instance/record of ordered
                                      execution

  **Ledger**                          Proof of authorized execution and
                                      resolution

  **Librarian**                       Derives/routes organized memory
                                      from preserved sources
  -----------------------------------------------------------------------

------------------------------------------------------------------------

# 38. North Star

> **ARK should be able to carry its intent, discover what the current
> vessel can do, resolve the smallest authorized execution necessary, do
> the work, and remember why it happened.**

Everything else composes from there.

------------------------------------------------------------------------

# 39. Addendum (2026-08-21): Phase A Reconcile Findings

A code-level reconcile pass was run against this charter before any
implementation began. Summary of what it found, so the charter and the
runtime do not silently drift apart:

**The diary is stale.** Every ARK commit after `5dc7bf1` — the Module
system, Peer/Catalog exchange, the Architect module, Constitution
Articles XX–XXIII — touched zero files under `backend/` or `frontend/`.
Confirmed via `git show --stat` on all nine commits: markdown only. So
Modules, Peer discovery, and "the Architect module" are currently
**100% design documents with no runtime implementation**. `Manifest.js`
has no `discover()`, no module registry — it is a flat hardcoded `Map`
of 9 adapters registered by literal `require()`.

**Two unrelated things are both called "the USB test."**
`ark_modules.md`'s test (can a module run on any host unmodified) and
this charter's target (import files from an attached USB media disk)
are different tests. Keep them named distinctly going forward.

**§4's claimed baseline is not fully accurate.** Provenance fields
(`template_id`, `template_slug`, `template_content_hash`,
`resolved_hash`, `composed_from`, `resolver_version`) are confirmed
real, in `PCER.js`. The claimed stage result categories are **not**:
`PCER.js` only implements `merge`, `gate`, `void` today.
`validate`/`trace`/`observe`/`replace`/`side_effect` are a Phase 8.5
*plan* recorded in `ark_execution_plan.md`, never built. Treat the
six-category model as a gap to close, not a baseline to assume.

**What's real and directly reusable:**

-   **Gateway** exists, just unnamed — `routes/action.js` +
    extracted `dispatch()` is already the single governed boundary;
    non-HTTP callers (`scripts/import-chats.js`) already call
    `dispatch()` directly, which is the exact proof pattern a media
    importer should replicate.
-   **Chain** is solid — `ChainExecutor` + `artifact_chains` /
    `artifact_chain_steps` durably persist and resume ordered
    execution. Nothing upstream resolves a declarative plan into the
    hook list it consumes — that gap is Pipeline's job.
-   **Provider shape** is half-right — `ACTION_REGISTRY` is already
    `{capability, handler}`, but it's exact-name lookup, one
    implementation per key, not capability → selection among
    competing providers.
-   **Idempotency precedent** — chat import's `source_hash` dedup
    (compute hash, look up by it, skip insert on match) is the pattern
    a media pipeline's fingerprinting should copy directly.
-   **Raw preservation precedent** — `artifact_media.content_hash` is
    already documented as "SHA-256 of the raw file bytes, computed by
    the caller," already separating raw fingerprint from semantic
    fingerprint. This is already the preserve-first layer §17 asks
    for; no new table needed for Phase F.
-   **Capability enforcement** is real and centralized
    (`_assertCapability` at the `dispatch()` boundary) but **scope
    narrowing is a stub** — `TraceActions.js` grants whatever scope is
    requested, with a comment marking Phase 8 (PolicyResolver) as the
    thing that's supposed to narrow it. Relevant for USB import:
    filesystem/device capabilities would today be all-or-nothing.
-   **Executor, pre-resolution, and policy-narrowed scope** are
    genuinely absent — no precedent anywhere in the codebase. These
    are real new subsystems, not generalizations of something that
    already exists.

------------------------------------------------------------------------

# 40. Addendum (2026-08-21): Pipeline Directories, Boot Registration, Install

Resolves §20's open question ("filesystem package vs. canonical
Artifact") and §32 Q1/Q5/Q13 concretely.

## 40.1 Directory is the authoring/distribution format; Artifact remains canonical

A pipeline is authored as a directory. It becomes real to ARK only once
registered as a `pipeline` artifact — the same `template_content_hash`
/ `composed_from` provenance mechanism `TemplateResolver` already uses
for templates. No new provenance fields are required.

``` text
pipelines/
  media-import/
    pipeline.yaml     # stages: ordered capability list, inputs/outputs, version
    providers.yaml     # capability -> { executor: {type, version}, entrypoint }
    bin/
      extract_metadata.py
    schemas/
    tests/
```

`bin/` contents are never copied into Postgres. They stay on disk,
referenced by path + a per-file content hash captured at registration
time, so drift is detectable: if `bin/extract_metadata.py` changes on
disk after registration, the hash no longer matches and ARK can refuse
to run stale/unreviewed code rather than silently executing whatever
is currently on disk.

## 40.2 Boot-time registration is not a governed action

Startup walks the local `pipelines/` directory, hashes each
`pipeline.yaml` (+ `bin/` file hashes), and registers/updates the
corresponding `pipeline` artifact. This is read-only against the
filesystem and only mutates ARK's own DB — the same tier of work
`Manifest.js` already does loading its hardcoded adapter list, just
directory-driven instead of hardcoded. It does **not** need to go
through `dispatch()` / capability gating; it is pre-governance
bootstrapping, not consequential execution.

Hash equality is the whole idempotency mechanism, mirroring chat
import's `source_hash` pattern:

-   unchanged hash → no-op, no new artifact version;
-   changed hash → new registered version.

This registration logic is a single standalone, idempotent function
(a "rescan"), not something inlined only into boot. Boot calls it once
at startup; `ark install` (below) calls the same function on demand so
a freshly installed pipeline is usable without a restart.

## 40.3 `ark install pipeline <git-repo>` is a governed action

Installing from a remote source is consequential (network access,
filesystem write) and must go through the normal path:
`ACTION_REGISTRY` entry, `network` + `filesystem.write` capabilities
declared, routed through `dispatch()` like every other action. Its job
is narrow — clone into `pipelines/<slug>/`, nothing else. It does not
duplicate registration logic; it clones, then calls the same rescan
function boot uses.

This keeps acquisition (`install`) and registration (`rescan`)
decoupled — install doesn't need to know how a pipeline becomes an
artifact, and rescan doesn't need to know where a directory came from.

## 40.4 Net effect against §32 questions

-   **Q1** (smallest artifact-first Pipeline representation): a
    `pipeline` artifact_type with `stages` in metadata, hashed the same
    way templates already are.
-   **Q5 / Q6** (provider registration location): `ACTION_REGISTRY`
    shape is correct; the directory's `providers.yaml` is what
    populates it with capability → executor → entrypoint bindings
    instead of hardcoded requires.
-   **Q9 / Q10** (new provenance fields / hash reuse): none required —
    reuses `template_content_hash` / `composed_from` verbatim.
-   **Q13** (idempotency key for media import): unchanged — still the
    raw-byte content hash on the media itself, independent of pipeline
    versioning.

------------------------------------------------------------------------

# 41. Addendum (2026-08-22): Pipelines as Rule Engines, Recipe Composition, Pluggable Sourcing/Execution

Reference implementation for everything below:
`backend/pipelines/usb-sd-birds/` and `backend/pipelines/classify/`.

## 41.1 Stages are the skeleton; rules are the decision logic

A pipeline's `stages:` list stays exactly what §8 already defines —
the ordered, capability-oriented backbone that compiles into
`ChainExecutor` hooks. That part doesn't change.

What changes is how a stage *decides* what to do. Rules are not config
that each capability handler re-interprets with bespoke JS. Rules are
evaluated by one small, shared, generic mechanism:

> **Given a fact set and an ordered list of `when`/`then` rules, apply
> matching rules in order, accumulating results into the fact set as
> you go.**

That is deliberately *not* a forward-chaining/production-rule engine
(no re-triggering, no conflict resolution, no cycles). It's a single
ordered pass — simple enough to build once and reuse everywhere,
matching §13 ("a resolver can be a merge stage") rather than
justifying a new runtime primitive. Any stage capability
(`source.filter`, `memchart.assess`, `classify`, `cache.partition`)
becomes a thin wrapper: gather relevant facts, hand them to the same
evaluator with the pipeline's rules, act on the result.

## 41.2 Composable rules are files, not inline blocks

A pipeline's `rules:` key is a list of *file references*, not one
inline block:

``` yaml
rules:
  - rules/source-selection.yaml
  - rules/preservation.yaml
  - rules/pairing.yaml
  - rules/routing.yaml
  - rules/derived-truth.yaml
```

Each file is a standalone, independently reviewable rule set, shaped
like:

``` yaml
rules:
  - id: likely-bird-or-yard
    when:
      likely_subject:
        in: [bird, wildlife, yard, garden]
    then:
      route_to_bucket: birds
```

Constitutional/execution-safety rules (executor resolution required,
no auto-install, `side_effect` stages require a granted capability —
§12, §29) are **never** one of these files. They are enforced globally
by the resolver for every pipeline, unconditionally — listing them as
an importable rule file would imply a pipeline author could forget to
import them. `usb-sd-birds/pipeline.yaml` documents this as a comment
rather than a rule file, on purpose.

## 41.3 The recipe pattern — small, reusable child pipelines

> **A pipeline folder is a recipe.** Small, self-contained, callable
> from many parents — not a monolith that grows a special case per
> scenario.

`pipelines/classify/` is the concrete example: a two-file pipeline
(`pipeline.yaml` + `providers.yaml` + a prompt) that does exactly one
thing — classify a single media file's subject via a vision-capable
LLM — and knows nothing about birds, yards, or `usb-sd-birds`. Any
future pipeline needing subject classification invokes it the same
way:

``` yaml
- id: classify
  pipeline: classify
  result: observe
  optional: true
  inputs:
    media: "{{fingerprint.media}}"
    candidate_subjects: [bird, wildlife, yard, ...]
```

This is §7's `pipeline: media.identify` composition syntax, now used
for real. The parent's *rules* (not the child) decide what to do with
the child's output — `usb-sd-birds/rules/routing.yaml` reads
`likely_subject`/`confidence` from `classify` and routes to
`birds/`/`ephemera/`/`review/`. The recipe stays reusable precisely
because it never makes that decision itself.

A rule's `then:` block can likewise name a child pipeline instead of
(or alongside) `route_to_bucket`/`annotate` — e.g. a promotion rule
whose consequence is `pipeline: artifact-promotion` rather than a
bespoke action. Composition is a rule *consequence*, not a special
mechanism bolted on separately.

## 41.4 A provider doesn't always need an executable

`pipelines/classify/providers.yaml` satisfies `media.classify.vision`
with a plain ARK action that calls the Manifest `llm` service — no
`bin/`, no executor resolution, because nothing gets spawned. Per §9,
"a provider can be an ARK action... a service adapter... a remote
service" — a governed internal service binding (`Packet.service('llm')`,
already capability-scoped via `service.bind`) is not in the same
category as running untrusted executable code, and shouldn't be forced
through the executor-compatibility machinery §11 built for that case.

`providers.yaml` still exists even with one provider today, precisely
so a second one (a different model, or a local vision model behind a
real executor) has somewhere to register later without touching
`pipeline.yaml` or anything that calls this pipeline.

## 41.5 Pipeline sourcing generalizes beyond a local directory

§20/§40 established the local directory as the authoring/distribution
format, registered by boot-time hash scan. Two more source shapes are
worth naming now, before implementing either:

-   **Git repo** — already speced (§40.3, `ark install pipeline
    <git-repo>`): clone into `pipelines/<slug>/`, let the existing
    rescan pick it up. No new mechanism.
-   **Container image** — a recipe's `pipeline.yaml`/`rules/`/`bin/`
    could be *packaged inside* a Docker image rather than a git repo.
    This has two distinct readings that must not be conflated:
    1.  **Image as distribution format** — pull the image, extract its
        files into `pipelines/<slug>/`, same rescan/registration as
        any other local directory. The image is just a delivery
        mechanism; execution is unchanged.
    2.  **Image as executor** — the pipeline's `bin/` payload *runs
        inside* the container at execution time (a `container` entry
        in §11's executor list, already anticipated but not yet
        built). This is a genuine executor resolution, not a source
        format — it changes *how* code runs, not where the pipeline
        definition came from.

    A future `providers.yaml` should be able to declare either
    independently — an image can be pure distribution with a `python`
    executor underneath, or a real `container` executor, and these are
    different facts about the same provider.

## 41.6 The rule executor is itself resolvable — not hardcoded

The ordered/accumulating evaluator in §41.1 is the **default** rule
executor, not the only permitted one. Nothing in this model requires
every pipeline's rules to run through ARK's built-in JS evaluator
forever. A pipeline could in principle declare it needs a different
rule executor — a real external production-rules engine, running as
its own process or container — resolved through the exact same
Provider/Executor machinery as any other executable capability (§9,
§11), not special-cased.

This is not a requirement to build now. It's a reminder that "rule
evaluation" is a capability like any other — `rules.evaluate` — with a
default provider (the built-in evaluator) that other providers can
compete for later, the same way `media.classify.vision` has one
provider today and room for more. Do not hardcode the assumption that
ARK's evaluator is the only possible implementation merely because
it's the first one.

------------------------------------------------------------------------

# 42. Addendum (2026-08-22): Persona, Role, and Audience — Four Words That Are Not Synonyms

Building the local-identity/persona/status work surfaced real confusion
between four things that all sound like "who is this for." Worth
pinning down precisely so the words don't drift back together.

## 42.1 The four concepts

| Term | Scope | Answers | Where it lives |
|---|---|---|---|
| **Persona** | vessel, persistent | "What *kind* of ARK device is this?" | `artifact_type` on the vessel-identity artifact (`hiker`, `store`, ...) — set once at provisioning, drives which pipeline recipes get preloaded (§41's persona → recipe manifest) |
| **ARK role** | actor, persistent | "What can this actor *do* on this vessel?" | `artifact_type: 'role'` artifacts (`owner`/`operator`/`guest`), ARK-native, rank in `metadata.rank` |
| **Seravanna role** | actor, persistent, cloud-only | Seravanna's own staff hierarchy | The real `roles` table in Seravanna's Postgres (`ADMIN`/`PARTNER`/`TECH`/`USER`) — only relevant when a caller supplies an explicit Seravanna-linked identity instead of a local `ark_actor_id` |
| **Audience** | packet, per-request | "Who/what should receive or see *this specific* result?" | A Packet-level field from the original design (`ARK_OS_DIAGRAM_GUIDE.md`: "packet carries... audience"; `phase_5_6.md`: "which audience consumed it?" as a provenance question). A *separate*, later use of the same word exists on artifacts (`ark_peer.md`: `audience: public/peer/private`, peer-sync visibility) — do not conflate the two `audience` fields; they're different mechanisms that happen to share a name. |

None of these four are interchangeable, and critically: **persona is
not a role**. It carries no capability information at all — a `hiker`
vessel's owner and a `store` vessel's owner both resolve rank 100 the
same way. Persona is identity/configuration; role is capability.

## 42.2 Persona pushes to audience — a default, not an identity

The real relationship: **the vessel's persona is the default source
for a dispatched packet's audience**, not the same field under a
different name.

``` text
vessel persona (persistent, one per vessel)
        ↓ defaults
packet audience (per-request, overridable)
```

A packet dispatched from a `hiker` vessel defaults `audience: hiker`
unless the packet/contract explicitly declares something more
specific — same override relationship every other scope dimension
already has (a contract's `execution_trace` can add stages beyond
`DEFAULT_TRACE`; nothing here is a new pattern).

If implemented, this resolves exactly like `role`/`rank` did in §40's
companion work: `audience` becomes a new PCER scope dimension,
declared in a stage's `scope: {...}`, projected by `_projectScope`,
carried flat on `ep.audience`. Same mechanism, one more dimension.

## 42.3 Not implemented — and should not be, yet

No current action reads `ep.audience` for anything. There is no
catalog exposure, no peer sync, no rendering that branches on
audience — that's `ark_peer.md`'s "media catalog populated from
`audience: public`" work, explicitly the same not-current-scope
bucket as subscriptions and budget accounts (§30).

Wiring an unused scope dimension into PCER now would be dead plumbing
— a field nothing reads, existing only to look complete. Per §36:
prefer resolution over hardcoding, but only once something needs
resolving. Build this when a real consumer exists (a Gateway that
actually exposes a catalog, a peer-sync action that actually reads
audience to decide what to announce) — at that point, wiring it in is
small and mechanical, exactly because the pattern (`role`/`rank`) is
already proven.

------------------------------------------------------------------------

# 43. Addendum (2026-08-22): Promise — Deferred Execution on Rule Conditions

Working out real hiker-persona scenarios (`update_mom`, `pre-order-food`
— see §43.4) surfaced a genuine gap: everything built so far runs when
told to (`ark pipeline <slug>`, `sync.push`). Nothing yet represents
*intent to run once a condition becomes true*. That's a real, small,
new primitive — not a special case of anything already built, but a
composition of two things that already exist.

## 43.1 Definition

> **A Promise is a durable record of intent to execute an action once
> a rule-based condition resolves true against the vessel's current
> facts.**

A promise is an artifact (`artifact_type: 'promise'`), not a new
table — same discipline as §41.5/role/store:

``` yaml
artifact_type: promise
action:  notify.email
payload: { to: 'mom@example.com', template: 'camp_update', ... }
when:
  - id: has-connectivity
    when: { connectivity: true }
    then: { fire: true }
cron:        '0 15 * * *'   # optional — see 43.1a
repeat:      true           # optional — see 43.1a
last_fired:  null
status: pending   # pending | fulfilled | expired
created_at: ...
```

`when` is a rule list, evaluated by the *exact same* `RuleEvaluator`
(§41.1) every pipeline's rules already use — not a second condition
language. A promise's rules just happen to match against a different
fact source (vessel/environment state) than a pipeline's rules match
against (discovered-file facts).

## 43.1a `cron` is explicit, not a `when` fact

Time-based recurrence ("repeat at 3pm") does not route through
`RuleEvaluator`. Reason: cron scheduling is not a fact-matching
problem, it's a *different-shaped* problem — parsing a schedule
expression, computing "does now match this occurrence," and tracking
which occurrence already fired so re-checking at 3:05 and 3:10 doesn't
fire twice. Building that out of `RuleEvaluator`'s generic
`above/below/in/exists` primitives would mean re-deriving cron badly,
one condition type at a time. §13's own test — a real implementation
boundary justifies a separate mechanism — is met here, so `cron` is
its own explicit field, evaluated by its own explicit mechanism (a
real cron-expression library, not hand-rolled — same posture as
`js-yaml`/`better-sqlite3`: a new dependency, called out before it's
added, not invented in-house).

`cron` and `when` are independent and compose by AND, not by
replacement: `cron` gates *when to even check*; `when` gates *whether
conditions are met at that moment*. `update_mom` only ever needs
`when: connectivity` (fires opportunistically, whenever signal
appears). A future "sync every day at 3pm, but only if I actually have
signal" promise needs both together — `cron` alone would fire into a
dead network, `when` alone has no time axis at all. Either field may
be present without the other; a promise with only `cron` is a pure
schedule, a promise with only `when` is a pure condition (today's
`update_mom`/`pre-order-food` shape, unchanged).

`repeat: true` controls what happens after a `cron`-bearing promise
fires: instead of moving to `fulfilled` for good, it resets to
`pending` for its next occurrence. `last_fired` records the most
recent fired occurrence so a boot-time check within the same window
doesn't double-dispatch. A `when`-only promise ignores both fields —
one-shot resolution, same as today.

**Honesty caveat, unchanged from the original design:** checking still
only happens when something invokes the check (CLI boot, or later, an
explicit `ark promises check`). Nothing in ARK wakes the machine up at
3pm on its own — that requires an OS-level scheduler (cron/launchd)
periodically invoking the CLI, which is infrastructure outside ARK
and is not implied by adding this field. `cron` describes *what
occurrence a promise is waiting for*, not a guarantee it fires
exactly then.

## 43.1b Invocation modes — on-demand vs runtime

The caveat above assumes something external invokes the check. What
invokes it is a vessel-level, persona-scoped choice — two modes, not
one:

- **On-demand** — a hiker vessel: battery-powered, mostly
  disconnected, not expected to run unattended. Checking happens at
  CLI boot, or via an OS-level scheduler (cron/launchd) calling `ark
  promises check` periodically. No persistent ARK process. This stays
  the default for every persona unless a persona explicitly opts into
  runtime mode.
- **Runtime** — a store vessel: plugged in, effectively always-on,
  like a POS terminal. Here ARK itself is the persistent process —
  `ark run` (name TBD) holds the vessel open and cycles through four
  concerns, one loop, one interval:

  ```
  loop:
    heartbeat            — liveness: refresh the connectivity fact
                            RuleEvaluator reads (43.2), don't wait for
                            a boot to find out signal came back
    discover nearby       — BLE/ANT+ scan for peer ARKs broadcasting
                            in range (ark_peer.md's Discovery
                            Protocols — "Nearby" view, ~10m, no
                            shared network required)
    maintain connections  — hold/refresh consented peer handshakes
                            already governed by ark_peer.md's own
                            trust/consent model; the loop invokes,
                            it does not grant
    drain work            — check promises (43.1), drain sync.push,
                            drain catalog pull (43.4)
    sleep(interval)
  ```

  This is the actual "ARK runtime" in the sense the vessel is meant
  to be running continuously, not invoked per-task — heartbeat is
  what makes "nearby" and "connectivity" living facts instead of a
  boot-time snapshot.

The key discipline: **runtime mode is an invocation wrapper, not a
second execution mechanism.** Every item in the loop calls the *exact
same* governed logic the on-demand path already calls once per
invocation — same `RuleEvaluator` fact-gather, same Promise
resolution, same `dispatch()`, same ark_peer.md consent/trust gating
on discovery. A cycling thread is not a new kind of ARK subsystem any
more than a `for` loop around a function is a new function. This
follows the same "invocation is pluggable, execution is not"
discipline as Provider/Executor (§9) — CLI-boot, OS-cron, and
runtime-loop are three invokers of one path, not three paths.

Which mode a vessel runs in is declared per persona (`personas.yaml`
or a future `--daemon` flag), not decided by Promise or by the
runtime core — a hiker vessel should never accidentally run a
battery-draining background loop, and a store vessel shouldn't have
to remember to re-invoke itself constantly by hand.

**Not built yet** — this is design only: no `ark run`/daemon command,
no interval loop, no persona-declared invocation-mode field. Folded
into 43.5.

## 43.2 How it resolves

Two existing mechanisms compose; nothing new is built underneath:

``` text
create intent          gather current facts        evaluate + dispatch
(promise artifact) ──▶  (connectivity, later:  ──▶  RuleEvaluator matches
                         time, battery, ...)         → real dispatch() call
                                                       → promise: fulfilled
```

- **Gathering facts** — for v1, exactly one fact: connectivity
  (a lightweight reachability check, true/false). More fact sources
  (battery, time-of-day; location *if* a real data source ever
  exists — §43.5 stays explicit that it doesn't yet) can be added
  later without changing the Promise shape, same extensibility
  pattern as Provider/Executor.
- **Checking** — for v1, at CLI boot: gather facts once, evaluate every
  `pending` promise's `when` against them, dispatch the ones that
  match. No background daemon/scheduler required yet — same "smallest
  generalization" restraint as everywhere else in this charter. A
  promise that doesn't match just stays `pending` and gets re-checked
  next boot.
- **Executing** — a fulfilled promise's `action`/`payload` goes through
  `dispatch()` exactly like anything else. A promise is not a
  privileged execution path; it's a deferred *request* to use the
  normal one.

This is also the correct relationship to draw against existing
concepts: a Promise is upstream of a Chain the same way a Pipeline is
(§22) — intent that *resolves into* durable execution, not durable
execution itself. `ChainExecutor`'s `pending`/`resume()` model already
proves the "durable, survives restart, drains later" half; Promise is
the missing "don't even start until a condition says so" half in
front of it.

## 43.3 The connectivity-queue idea *is* a promise

Two turns of design work — "jobs hit a cycling queue waiting for
signal" and "a generic promise that executes on rules" — converged on
the same mechanism from two directions. They are not two features:
connectivity-gated execution is Promise's first, and for v1 only,
concrete `when` condition. Do not build a separate bespoke "job queue"
alongside Promise; the queue *is* the set of `pending` promises.

## 43.4 Reference scenarios

- **`update_mom`** — reaching camp creates a `promise` (`action:
  notify.email`, `when: connectivity`) instead of sending immediately.
  Drains next time the vessel has signal. The notification provider
  already exists — Seravanna's Mailgun integration
  (`services/mailer.js`) — this needs no new external integration,
  only a `notify.email` action wired to it.
- **`pre-order-food`** — needs a *locally cached* catalog to browse
  (peer discovery is still explicitly not-current-scope, per the
  discovery-vs-catalog split already drawn this session), populated by
  a catalog **pull** — the mirror of `sync.push` (§ SyncActions),
  same shape, opposite direction: fetch another vessel's
  `audience: public/peer` artifacts down to local cache whenever
  connectivity is confirmed. Placing the order itself is then a
  `promise` the same way `update_mom` is.
- **Trip-highlight catalog + subscription** — not a Promise scenario at
  all; it's §14/§15's Access Contract, applied to a hiker's own trip
  content instead of a store's products. Noted here only to keep it
  out of the Promise bucket by mistake.

## 43.5 Explicitly not built

- No background scheduler/daemon — checking happens at CLI boot only,
  for now. `cron` (§43.1a) describes a schedule; it does not add a
  daemon that wakes the machine to honor it.
- No cron-expression library wired in yet, no `last_fired`/`repeat`
  bookkeeping implemented — §43.1a is design only, not built.
- No runtime/daemon invocation mode (§43.1b) — no `ark run`, no
  interval loop, no heartbeat, no persona-declared invocation-mode
  field. Every vessel today is on-demand only, regardless of persona.
  Peer discovery/connections (ark_peer.md) and Promise/sync draining
  each independently exist as *design*; nothing yet cycles them.
- No fact sources beyond connectivity — no location, no battery.
  `RuleEvaluator`'s condition vocabulary (§41.1) already supports what
  these would need (`exists`, `below`, `in`, ...) once a real fact
  source exists to feed it; do not build the fact source speculatively.
- No catalog **pull** implementation yet — named in §43.4 as the thing
  `pre-order-food` needs, not yet built.
- No `notify.email` action yet — the provider (Mailgun) exists; the
  governed action wrapping it does not.
