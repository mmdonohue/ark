# Universal Operating Context and Mission Zero (proposal)

**Status:** Proposed; no runtime behavior is implemented by this document.  
**Scope:** Identity, tenant/context selection, vessel provisioning, domain profiles, views, and governed switching.  
**Constitutional decision:** Do not introduce Article XXIV until the design demonstrates an invariant not already covered by Articles IV, V, VII–IX, XV–XVI, XX–XXI.

## Problem

ARK should be able to manage personal life, a farm, an estate, a building, an organization, and multiple businesses without becoming separate applications. A person can participate in several contexts and see different views of the same governed artifacts. Boot should help the user establish the contexts and vessels they intend to operate; ordinary navigation should switch among them safely.

Today's implementation supplies useful starting points, but not universal context switching:

- `pipelines/personas.yaml` maps a single vessel persona (`hiker`, `store`) to initial pipeline recipes.
- `cli/localIdentity.js` provisions one persona-typed vessel identity artifact and an owner actor on first run; subsequent runs reuse the first existing actor and ignore a new persona request. It searches known persona artifact types instead of a stable vessel identity.
- `TraceActions.verify` requires actor, `store_id`, and role. `scope.resolve` projects tenant as `store_id`, but currently grants requested scope without policy narrowing.
- `CHARTER.md` defines persona (kind of vessel), role (actor capability), and a proposed audience dimension; these are not interchangeable.
- Local bootstrap and pipeline recipe registration currently write before the normal governed dispatch path, a documented first-identity exception. General vessel/context creation must **not** extend that exception.

## Vocabulary and boundaries

| Term | Meaning | Boundary |
| --- | --- | --- |
| Identity / actor | Who is interacting with ARK, including offline/local identity | An actor is not inherently authorized in every context |
| Operating context | A selected, durable relationship among actor, tenant scope, available vessels, domain capabilities, and preferred views | Selection is a request, not a grant of authority |
| Tenant | A policy and data scope in which an actor operates; currently projected as `store_id` | Do not assume tenant means artifact owner |
| Vessel | A durable operating environment with identity, MemChart, and configured capabilities | A vessel is not a persona and is not a tenant by definition |
| Domain | Composable module/recipe capabilities (farm, estate, building, org, personal, business) | Domain-specific logic stays out of the runtime (Article XX) |
| Persona | Vessel profile influencing initial recipes and defaults; existing concept | Do not overload it as actor identity or tenant membership |
| Role | Actor's authorized capacity within a scope | Re-resolve per selected context, never copy ranks across tenants |
| View | Presentation/projection of an authorized context and artifacts | Views cannot grant access or change meaning (Article IX) |
| Mission Zero | First-run, resumable provisioning experience | A consumer of governed primitives, not a second execution engine |

A single identity may access many contexts; a context may offer several vessels; a vessel may expose many views. These relationships are **proposed**, not claims about the current database. Whether tenant needs a distinct persistent artifact or can be expressed entirely as governed actor↔vessel relationships is an explicit design decision to validate before schema changes.

## Normative requirements for the target design

1. **Explicit selection.** Every operation binds a resolved operating context, including actor, tenant boundary, vessel (when applicable), and role. The UI's active context is never an authorization token.
2. **Authorization on every switch.** Switching verifies membership/relationship and current policy. A switch cannot inherit authority, services, data access, rank, cached queries, or capabilities from the prior context.
3. **No hidden cross-context execution.** In-flight operations remain bound to their original immutable request/authorized execution scope. Background jobs, event triggers, and agents declare their context explicitly; changing a user's view does not migrate a job.
4. **Provenance.** Ledger records the resolved actor, tenant, vessel and effective role/capabilities (plus requested versus granted/denied scope), so executions are reconstructable after switching. Never rewrite past events when a context changes.
5. **Ownership is independent.** No switch or provisioning event transfers artifact ownership. Cross-context sharing/transfer requires a distinct governed contract and audit trail.
6. **Portable and composable.** Domain packages are registered modules, templates and pipeline recipes, not special modes in the runtime. Offline/local vessels must not require cloud identity.
7. **Safe provisioning.** After the minimal root-of-trust bootstrap, creating additional contexts, vessels, roles, relationships, and recipes goes through canonical packets, contracts, policy, and ledger. Provisioning is idempotent and resumable.
8. **View separation.** Renderers can offer dashboards and perspectives appropriate to a selected context but receive only the authorized projection, never a privileged unfiltered tenant dataset.
9. **Do not silently reinterpret old data.** Existing `store_id`, persona-typed vessel artifacts, MemCharts and pipeline recipes remain readable until an explicit migration with tested compatibility exists.
10. **Validation before implementation.** Every proposed scope boundary must have negative tests; do not label a capability safe while the current `scope.resolve` still grants requested scope without narrowing.

## Proposed Mission Zero flow

1. **Discover:** enumerate installed, declared domain/profile packages and available recipe bundles. Display real installed options; absent farm/estate modules must not appear as operational promises.
2. **Identify:** establish or reuse the local actor/root trust; do not silently create a new actor for every context.
3. **Declare:** ask an accessible, non-binding opening question (e.g. personal/business), then offer combinations of domains such as farm, estate, building, organization. Categories are not mutually exclusive.
4. **Plan:** produce a preview of intended tenant/context relationship(s), vessel(s), persona defaults, MemCharts, registered pipelines, modules, views, and required approvals. Preview is read-only.
5. **Authorize and provision:** submit a governed provisioning intent, resolve policy, create the durable artifacts/relationships and register existing recipes idempotently, ledger every outcome.
6. **Enter:** activate one authorized context and its views. Offer a context switcher thereafter; allow creation of additional contexts using the same governed flow.

No dedicated Mission Zero bypass of `dispatch()`. The narrowly-scoped first-actor/bootstrap exception must be reviewed and bounded rather than repurposed.

## Context-switch contract (candidate, not an implemented API)

A switch request names a **target** operating context; ARK resolves it against the authenticated actor and policy. It returns the authorized selection and permitted view descriptors (or denies with a traceable outcome). Selection does not mutate underlying artifact ownership and should not depend on trusting a caller-provided `store_id` or rank.

The active selection may be UI/session state. The execution binding must be resolved independently on each dispatched packet. Do not add an ambient process-global mutable `currentTenant`: it would be unsafe for concurrent users, asynchronous work, and shared hosts.

## Architecture decisions to resolve before implementation

- **A. Tenant versus vessel:** Are these separate durable identities, or can tenant membership and vessel association be represented with existing governed artifacts and relationships? Test personal + farm on one local host and a shared organization with multiple actors.
- **B. Stable vessel identity:** Replace persona-as-`artifact_type` lookup without breaking existing hiker/store databases. Decide stable IDs and migration/versioning before changing schema.
- **C. Trust boundary:** What authorizes the first actor locally, and what exact governed action authorizes every subsequent context/vessel? Eliminate extra bootstrap privileges.
- **D. Scope isolation:** Implement and verify real policy narrowing at `scope.resolve` before exposing multi-tenant switches.
- **E. Domain registry:** Determine how installed modules and known pipeline recipes advertise suitable provisioning profiles without inventing an independent catalog subsystem.
- **F. Session/render layer:** Define explicit context binding and invalidation semantics for HTTP, CLI, agents, background tasks, and UI caches.

## Phased delivery and review gates

**Phase 0 — Inventory and threat model.** Document existing `store_id` scoping, local vs shared actors, persona artifact identity, provisioning bypasses, and any cross-tenant artifact access. Add failing isolation tests. No new feature flags until security boundaries are understood.

**Phase 1 — Stable context resolution.** Add an explicit context descriptor/relationship using existing primitives where possible. Authenticate actor and authorize target before resolving actions. Preserve backward compatibility with current `store_id` and current single-vessel CLI usage.

**Phase 2 — Governed switching.** Expose list/select context capabilities for CLI and UI; deny unauthorized contexts, isolate view/query caches, and bind active jobs to their original context. Ledger every effective execution context.

**Phase 3 — Governed vessel provisioning.** Model additional vessel/context creation as actions with idempotency, approvals, existing recipe registration, MemChart and provenance. Retire any bootstrap bypass beyond the minimum root-of-trust creation.

**Phase 4 — Mission Zero.** Build the onboarding helper on top of these capabilities. Discover real domain profiles, preview a plan, collect approval and provision the initial vessels; support a return/resume after interruption.

## Acceptance scenarios

- An actor in personal context switches to a farm they are authorized to operate; their farm views and pipelines appear without a runtime restart or code fork.
- The same actor cannot see or operate an unrelated organization's artifacts merely by changing a context ID or reusing a prior role/rank.
- An actor with owner privileges in Personal enters an Organization as a viewer; the Organization scope resolves viewer permissions, not owner.
- Switching while a long-running pipeline executes does not change that pipeline's tenant/vessel provenance or permissions.
- A farmer and a field worker share a farm vessel with different authorized views; the worker cannot infer restricted data through an alternate renderer.
- A building can be associated with an estate and organization without duplicating its underlying meaning or silently transferring ownership.
- Mission Zero can create two vessels, be interrupted, and resume without duplicate actors, vessels, or recipe registrations.
- An offline USB ARK can select its existing vessel without remote identity; a new context does not bypass the governed lifecycle.
- An old `hiker` or `store` persona vessel remains usable after any identity migration.
- Denied and allowed transitions generate adequate proof without exposing sensitive content in denial responses.

## Constitution review

Relevant existing invariants: **II** (immutable intent), **IV–V** (scope and authority), **VII–IX** (artifacts/templates/views), **XI** (ledger), **XV–XVI** (one model/simplicity), **XX–XXI** (module ownership/deployment independence).

**Recommendation:** treat this as a Charter/proposal first. Consider a new article, provisionally *Operating Context Is Declared*, only if the implementation review proves that actor↔context↔vessel binding and safe switching require a new universal invariant not already derivable from scope/authority/provenance articles. No amendment is proposed in this PR.

## Non-goals

- Shipping farm, estate, building, or organization domain modules.
- Changing the runtime to understand those nouns.
- Building a new tenancy database or separate workflow engine before proving existing artifact/contract composition insufficient.
- Adding permission-by-view, implied ownership transfers, automatic cross-tenant sharing, or a mandatory AI agent in the first-run path.
- Treating this proposal as evidence that multi-context security is implemented today.
