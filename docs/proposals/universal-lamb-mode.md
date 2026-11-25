# ARK Ask: Universal Lamb Mode — Vessel-Wide Quiet Operations

**Status:** Proposal / implementation contract only. Not implemented here.

## Reconciled with `main` (2026-11-25)

**Built:** only per-event `event.pause` / `event.resume` (#11) and per-run `workflow.cancel` (#28). There's no vessel-wide mode.

**Fits as:**
- **One check at the existing `dispatch()` boundary.** That's where capabilities and the ledger already live, so there's no second gate. It defers non-essential actions using a declared table: agent runs, workflow launch and advance, cycle work, publishing. Reads, owner writes, and ledger and preservation work keep running.
- **Durable, owner-only state** in the vessel, so it works offline.
- **Agent callbacks can't clear it,** because the harness callback only exposes the actions it was granted.

**Order:** 3rd, before more automation runs unattended. The first PR is stages A–C: the decision table, durable state with `lamb.status` / `enable` / `disable`, and the dispatch check that records `deferred_by_lamb`. Running work and resume (D) and the Mission Control toggle (E) follow.


## Intent
Allow the owner to deliberately quiet an ARK vessel across Mission, Studio, Dev Cycle, publishing, scheduled events, and all nonessential background work. It must be safe even when offline and **must not automatically clear when Wi-Fi returns**.

Lamb Mode is a **universal operating policy**, not another scheduler or execution engine and not just a Dev Cycle setting.

## Existing implementation to reuse
- ARK already supports per-event `event.pause` / `event.resume`; this is not a vessel-wide mode.
- `system.cycle` already dispatches scheduled event and workflow work through governed execution.
- Workflows, tasks, capability declarations, immutable Canonical Packets, dispatch, scopes, and the ledger are the correct integration points.
- Inspect existing version-specific work in flight before implementation, and do not reinvent stop/pause primitives.

## Operational states
- `normal`: existing behavior.
- `lamb`: new **nonessential** work is paused; currently running work reaches a safe checkpoint, finishes under an explicit bounded policy, or is cancelled through existing authorized cancellation behavior.
- `resume`: only an authorized owner action returns the vessel to normal mode; Wi-Fi restoration, process restart, scheduled ticks, and agent actions **cannot** implicitly resume.

Start with explicit owner-controlled enable/disable. No automatic time-of-day exit unless independently approved.

## Requirements
1. **Persistent and local:** Lamb state is durable, can be read/set without internet, and survives restart. Reconcile host storage limits and fail closed for nonessential dispatch if mode cannot be read reliably.
2. **Universal enforcement:** Apply policy at the common governed dispatch / execution boundary (or another existing universal policy stage), not as scattered checks in every feature; assess whether read-only navigation, user-initiated local writing, or preservation operations remain available.
3. **Preserve intent:** Do not mutate Canonical Packets, delete queued work, revoke standing approvals, or rewrite due-event history. Record a clear `deferred_by_lamb` outcome and permit later authorized reconciliation.
4. **Safe running-task behavior:** Define a cooperative stop/checkpoint/finish policy for each task class. No force killing without a safe plan; no automatic continuation without explicit resume. Honor task ownership, secrets, and retry semantics.
5. **Critical exceptions must be narrow and declared:** Examples may include preserving state, safely finalizing ledger writes, and necessary local shutdown/recovery. No broad `critical=true` flag controlled by an agent and no exception for marketing or AI generation by default.
6. **No surprise catch-up storm:** On return to normal, reconcile pending requests and stale approvals, prioritize and rate-limit deferred work. Do not replay every missed recurring schedule. Retain `system.cycle` at-most-once claim guarantees.
7. **Offline independent:** Network health is orthogonal. Offline-to-online transitions never override Lamb Mode. Lamb to Normal while still offline does not imply remote-capable tasks are runnable.
8. **Owner controls:** Expose state, reason, actor, activation time, paused work counts, and pending work in CLI and Mission Control; Studio must display the same state. Provide a prominent, accessible toggle with confirmation for resume, and a clear indication of which work remains active.
9. **No privilege escalation:** `lamb.enable`/`lamb.disable` names are illustrative only; identify exact actions and declared capabilities after auditing code. All changes governed and ledgered. Agents cannot clear Lamb Mode using delegated task capabilities.
10. **Personal choice:** Quiet Mode serves deliberate human boundaries. No forced lockouts, punitive reminders, or hidden third-party control; only the authorized owner changes the vessel policy.

## Suggested implementation stages
- **A — Audit & policy contract:** Enumerate existing per-event pause, running-task cancellation, dispatch stages and offline deferral; define decision table for read, preservation, scheduled work, user-initiated writes, local agent runs, remote publishing and approvals.
- **B — Durable mode state & actions:** Add governed owner-only enable/disable/status with local persistence and provenance, no separate daemon.
- **C — Universal enforcement:** Gate new nonessential execution at the existing governed boundary; preserve immutable intent, record deferrals, and integrate with `system.cycle`, tasks/workflows and online/offline policy.
- **D — Running work & resumption:** Implement per-task safe checkpoint/finish/cancel dispositions and controlled, bounded resumption.
- **E — Mission + Studio controls & E2E:** Shared indicator, actions, pending counts, restart/offline tests, test-validity artifacts.

## Acceptance tests
1. Lamb on while online → new nonessential agent or publish requests defer with traceable outcome.
2. Network drops and reconnects while Lamb is active → Lamb remains active and no deferred remote operations run.
3. Restart ARK offline → Lamb state retained; owner can query it without remote services.
4. Existing event pause remains independent; Lamb doesn't permanently change event active state.
5. Scheduler ticks during Lamb never duplicate tasks or violate event claim invariants.
6. Already-running jobs checkpoint/finish/cancel consistently with documented policy; no orphaned work or silent loss.
7. Lamb off → approved work is reconciled, not blindly replayed; changed scope/PR revision requires reapproval.
8. Agents cannot turn off Lamb through a delegated callback or directly mutate its persistent state.
9. Local preservation and owner access continue as defined by a documented capability decision table.
10. Mission and Studio show the same vessel-wide state; UI smoke/E2E tests prove that the toggle is not merely cosmetic.

## Relationship to other asks
- **PR #39:** Offline-tolerant Dev Cycle: dependency outage recovery. Lamb Mode is an *intentional human policy*, not an outage classifier; they compose.
- **PR #38:** Worktree agent workspaces: a running writable agent must honor the stop/checkpoint policy.
- Future release factory, Meta campaigns, and Studio publishing must also honor the same mode.

## Claude handoff
Review what's merged and in flight; report built vs proposed; reuse the existing Constitution, Manifest, event/workflow contracts, packet/dispatch/ledger and local storage. Propose the smallest incremental PRs. Do not add a competing task engine or scheduler. This PR is a feature request document only.
