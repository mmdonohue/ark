# The ARK Constitution
## Version 0.1

> ARK is a governed execution runtime.
>
> This document defines the architectural principles that all implementations of ARK should preserve.
> These principles are intentionally stable. APIs, languages, storage engines, and implementations may evolve, but these ideas should remain true.

---

# Preamble

Most software is built by composing independent frameworks for routing, authentication, authorization, logging, workflow, auditing, observability, AI, and persistence.

ARK takes a different approach.

Rather than layering governance onto execution, ARK treats governance as an intrinsic property of execution itself.

Every operation follows the same lifecycle.

Every execution is governed.

Every decision is traceable.

Every result has provenance.

This document defines those principles.

---

# Article I
## Execution is Governed

Every meaningful operation executes through the ARK runtime.

There are no privileged execution paths.

Governance is not middleware.

Governance is execution.

---

# Article II
## Intent Precedes Execution

Every operation begins as an immutable Canonical Packet.

The Canonical Packet represents intent.

Execution is derived from intent.

Intent is never modified.

Intent and execution must be independently auditable.

The ledger must be able to reconstruct what was requested separately from what was authorized and executed.

This is only possible if intent is preserved exactly as it arrived.

---

# Article III
## Contracts Declare Responsibility

Contracts declare what they are responsible for accomplishing.

They do not assemble execution context.

They do not discover services.

They do not determine authority.

The runtime prepares everything required before execution begins.

---

# Article IV
## Scope Precedes Behavior

Execution context is resolved before business logic executes.

Every contract receives only the smallest complete, authorized context required to fulfill its responsibility.

Scope is resolved by the runtime.

Not by application code.

---

# Article V
## Authority is Resolved

Authority is never assumed.

Authority is never inherited.

Authority is resolved through policy before execution.

Rules create intent.

They do not create authority.

---

# Article VI
## Execution is Prepared

Contracts never execute against Canonical Packets.

The runtime prepares a contract-specific Execution Packet.

Execution Packets define:

- scope
- capabilities
- context
- services
- provenance
- trace

The Execution Packet is the complete execution environment.

---

# Article VII
## Artifacts are the Primary Unit of Knowledge

Artifacts are the fundamental representation of persistent knowledge.

Everything meaningful within ARK is represented as an artifact or a relationship between artifacts.

Applications are built by composing artifacts rather than inventing new storage models.

---

# Article VIII
## Templates Define Meaning

Templates define the semantic structure of artifacts.

A template may define:

- schema
- defaults
- validation
- lifecycle
- workflow hooks
- relationships
- governance
- presentation metadata

Templates define meaning.

Renderers define appearance.

---

# Article IX
## Representation is Separate from Meaning

An artifact has one meaning.

It may have many representations.

The runtime governs artifacts.

Renderers govern presentation.

Changing presentation must never alter provenance or meaning.

---

# Article X
## Services are Runtime Dependencies

Contracts never perform service discovery.

The runtime binds only the services required for execution.

Service availability is part of the execution environment.

---

# Article XI
## Every Execution Produces Provenance

Every governed execution produces a ledger.

The ledger records:

- intent
- authority
- scope
- execution
- outcome
- provenance

The ledger is the proof of execution.

This includes what the execution was allowed to know and do.

Scope granted and scope denied are part of the record.

A ledger that records only outcome cannot answer whether that outcome was properly authorized.

---

# Article XII
## Rules Create Intent

Rules never execute business logic directly.

Rules produce new Canonical Packets.

Every rule activation enters the same governed execution lifecycle as every other request.

There are no privileged shortcuts.

---

# Article XIII
## Work is Resolved

Completion is not the goal.

Resolution is.

A workflow is considered resolved only when every required contract has reached a governed outcome.

The ledger records resolution.

---

# Article XIV
## AI is a Participant

Artificial intelligence is not a privileged subsystem.

AI participates through contracts.

AI receives scoped execution context.

AI follows the same governance model as every other participant.

---

# Article XV
## One Execution Model

New capabilities should compose with the existing runtime.

Avoid parallel execution models.

The preferred solution is the one that reduces architectural concepts while increasing capability.

---

# Article XVI
## Simplicity is a Feature

Every new abstraction must reduce overall system complexity.

When multiple designs satisfy the same requirements, prefer the one that:

- reduces duplicated execution paths
- reduces special cases
- reduces framework code
- increases determinism
- strengthens governance

Architecture should become simpler as capability grows.

---

# Article XVII
## Capability is Declared

Every action declares the minimum capability required to invoke it.

This declaration is part of the action's definition.

It is not a runtime check inside handler code.

Capability requirements can be audited, tested, and reasoned about without executing anything.

A system where capability checks are scattered across handler code cannot be consistently enforced, reviewed, or proved correct.

An action that cannot state what it requires cannot be governed.

---

# Article XVIII
## Contract Identity is Layered

A template defines a contract.

A resolved contract may compose from many templates.

The identity of a source template and the identity of a resolved contract are distinct things.

Provenance records both:

- the source template and its content at the time of resolution
- the final resolved contract — after all composition — that actually governed execution
- the composition chain between them

Knowing only the source template is not sufficient to reconstruct what governed execution.

Knowing only the resolved contract is not sufficient to trace its origin.

Both are required.

This is the only way to answer: what exact contract governed this execution?

---

# Article XIX
## Assessment Precedes Execution

A packet should be understandable before it is executable.

The runtime may assess whether a Canonical Packet contains sufficient structure, context, and semantic information to participate in governed execution before execution begins.

This assessment:

- is read-only and produces no side effects
- evaluates the packet against its declared contract without actor or tenant context
- returns a readiness report — not a decision

The readiness report is not an authorization.

It is a structural assessment.

Whether a ready packet is authorized to execute is determined separately by policy.

Assessment must never gate execution on the hot path.

Its purpose is to support migration, tooling, and pre-flight validation — not to add a mandatory step to every governed execution.

A system that can tell you what is wrong with a packet before attempting to execute it is a system that can be adopted incrementally.

Existing systems may submit packets for assessment while continuing to execute normally.

This is how ARK enters an existing system.

---

# Article XX
## Modules Are the Unit of Domain Ownership

A domain that cannot be expressed as a module is not a domain — it is ambient logic.

All domain behavior — actions, contracts, agents, rules — must be owned by a module and registered through the Manifest.

A module is a complete vertical slice of a domain. It declares the services it consumes, the contracts it defines, the agents it configures, the actions it registers, and the rules it activates. Loading a module makes a domain operational. Removing it makes the domain disappear. Nothing in the runtime changes either way.

Modules do not call each other directly. Cross-module behavior is expressed as a Canonical Packet dispatched through the governed runtime. This preserves the packet lifecycle for all inter-domain work.

Nothing domain-specific belongs in the runtime.

---

# Article XXI
## The Runtime Has No Knowledge of Deployments

The runtime does not know which modules are loaded or what they do.

It executes what is registered. A deployment is defined entirely by its module set and its service adapter configuration.

A deployment running three modules and a deployment running thirty use the same runtime. The difference is configuration, not code.

This is what makes ARK portable. The entire system — runtime, modules, state — can move to any environment that can run a process. Cloud, local, or USB. The runtime does not change. The module set does not change. Only the service adapters resolve differently.

A system that cannot run on a USB drive has made a dependency that was not declared.

---

# Article XXII
## Catalog Exchange Is Consent

When an ARK instance publishes a catalog, it declares what it is willing to do and for whom.

Publishing is an act of consent. Discovery is not permission.

A peer that discovers an ARK has not been granted access — they have received a declaration of what access is available. Trust is graduated and explicit. It is never assumed from proximity or discovery alone.

Both sides of every peer interaction earn a ledger entry. The exchange is auditable independently on each node. Neither party needs to trust the other's runtime — each governs its own execution.

A peer network of ARK instances is not a distributed system with a shared authority. It is a collection of sovereign nodes that have agreed, explicitly, to interact.

---

# Article XXIII
## The Constitution Must Be Derivable

The ARK Constitution is the authoritative specification of the runtime. It must be complete enough that a capable system — given only the constitution as context — can correctly derive the major components, execution flow, and trust boundaries of any governed capability.

A constitution that produces confident, accurate architecture derivations is a constitution that is doing its job.

Ambiguities that prevent confident derivation are not acceptable in a stable constitution. They are either gaps to fill or decisions to make explicit.

The architect agent exists to surface these gaps. Its benchmark outputs — assumptions, weaknesses, constitution_gaps — are the feedback loop that keeps the constitution honest.

A benchmark that is accepted without surfacing any gaps is either evidence of a mature constitution or evidence of an insufficiently probing prompt. Both are worth investigating.

---

# Closing Statement

ARK is not a framework.

ARK is an execution model.

The purpose of the runtime is not merely to execute code.

Its purpose is to execute governed work.

Every implementation of ARK should be judged by one question:

> Does this change make governed execution simpler, more deterministic, and more universally applicable?

If not, the change should be reconsidered.