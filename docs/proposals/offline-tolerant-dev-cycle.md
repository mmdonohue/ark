# Ask: Offline-Tolerant ARK Dev Cycle and GitHub Reconciliation

**Status:** Proposed feature contract; documentation only. **Priority:** High, for the scheduled GitHub PR intake / agent work loop.

## Reconciled with `main` (2026-11-25)

**Built:**
- **Claims and staleness:** `system.cycle` claims at most once per occurrence (UUIDv5), reports stale claims, and settles each one as `occurred`, `dispatched`, `blocked` or `failed` (#13, #14).
- **Scheduled workflows** launch on a plan-pinned standing approval and are blocked when it's stale (#31).
- **Reported states:** agent attempts are recorded per driver with cooldowns and failover (`adapters/harness.js`), and the update check reports `unreachable` (#33).

**Not built:** GitHub intake of any kind. There is no GitHub client in ARK, so the deferred-operation queue and reconciliation (B–D) have nothing to reconcile yet.

**Order:** 4th. Do **PR A only** now: classify a network or provider outage (`blocked_by_network`) separately from a real failure, both in cycle outcomes and in harness attempts, plus a read-only status. B–E come once GitHub intake exists (with or after #38's PR handoff).


## User intent

ARK runs on a personal machine where Wi-Fi/internet may disappear unpredictably. Keep the scheduled dev cycle safe, useful and recoverable when connectivity is intermittent. Do not require the user to manually restart agents or manually reconcile duplicate PR operations after reconnecting.

**Desired behavior:** Poll GitHub for work when reachable; continue eligible local work when offline; preserve network-dependent work and uncertain external outcomes durably; reconcile on reconnect; avoid duplicate tasks, runs, comments, branches and PRs.

## Verified starting point (inspect HEAD again before implementation)

- `ark cycle [--dry-run] [--lookback hours]` already calls governed `system.cycle`; external clocks such as launchd/cron are supported conceptually; don't create a second scheduler.
- `actions/SystemActions.js` already claims event occurrences with deterministic UUIDv5 identities (`event_id|schedule_version|due_at`), uses at-most-once behavior, reports stale `claimed` work, and dispatches task/workflow actions under existing capabilities.
- `EventActions.js` already provides schedules, event state and standing workflow approval with plan-hash checks.
- Existing cycle behavior deliberately does **not** automatically retry an occurrence that remains `claimed` after interruption. Offline recovery cannot naively re-fire the occurrence or convert at-most-once into at-least-once execution.
- `tests/cycle.test.js` already exercises cycle behavior. Preserve its invariants.
- GitHub PR/issue intake and a periodic Dev Cycle may not yet exist as an implementation; inspect active PRs before adding code.
- Existing harness drivers may depend on cloud APIs. A local file being available is not proof that the chosen model is available offline.

## Proposed operational loop

1. An external local scheduler invokes the **existing** cycle command (e.g. `ark cycle --once` only if added as a documented alias; existing `ark cycle` is sufficient) on a configurable cadence.
2. A governed dev review event/workflow checks repository work and, when GitHub is reachable, reconciles incoming PRs/issues against known artifacts and approved tasks.
3. If remote endpoints are unavailable, classify remote work as **deferred** with durable state/retry metadata; do not treat lost connectivity as code failure.
4. Continue only locally executable, previously authorized work with all required dependencies available. Never grant permission simply because the system is offline.
5. On reconnect, read remote GitHub state before retrying writes whose result was uncertain; then resume or resolve deferred intents safely.
6. Preserve ledger/provenance for every attempt, deferral, reconciliation, and final resolution.

## Design boundaries

- **Connectivity is per dependency**, not a boolean Wi-Fi indicator: distinguish GitHub, model provider, package registry, publishing endpoint, local storage and any other requested service. Tests should be able to inject per-service connectivity results.
- Separate `blocked_by_network` / `deferred` / `remote_outcome_unknown` from `agent_failed`, `validation_failed`, and `unauthorized`. No provider hopping or repeated expensive invocations solely because the connection is down.
- Preserve event occurrence **at-most-once claims**. Do not reopen or replay claimed events. Add task/operation-level durable intents and reconciliation beneath that occurrence where necessary, using existing artifact / workflow primitives.
- An external operation's idempotency key should include source identity and revision (e.g. repo + PR number + head SHA + operation type); retries must reconcile external state. GitHub API may not supply an idempotency key for every write, so use remote lookup and a persistent local intent journal.
- Record correlation IDs/markers for created comments/PRs/branches to facilitate remote verification; avoid duplicate side effects.
- Persist queue, lease/claim state, retry-at, backoff, last reachability result, attempt count and service error category in existing governed artifacts/ledger or narrowly justified structures. Define retention via MemChart where appropriate.
- On restarts, distinguish a still-running job from an orphaned claim; never silently delete or rerun uncertain work.
- Use backoff with bounded jitter; avoid polling aggressively during outages. Do not create unbounded backlog or replay every missed periodic occurrence.
- Keep secrets in the appropriate host credentials store; never expose GitHub/API tokens to content review agents.
- No unapproved merges, publishing, or executions after reconnection. Recheck approvals and source head SHAs before acting.
- A local scheduler should not mutate the owner's environment unexpectedly; offer an explicit install/enable/disable/status mechanism only after auditing the host's existing scheduler configuration.

## Suggested configuration shape (illustrative, **not** current schema)

```yaml
dev_cycle:
  enabled: true
  interval_minutes: 10
  max_concurrent_tasks: 1
  dependency_health:
    github: required_for_remote_intake
    model_provider: check_per_task
  retry:
    initial_seconds: 30
    max_seconds: 900
    jitter: true
  offline:
    preserve_pending_intents: true
    continue_eligible_local_tasks: true
    defer_remote_operations: true
  reconcile:
    check_external_state_before_retry: true
    preserve_occurrence_claim_semantics: true
    require_approval_on_changed_scope: true
```

## Proposed phased delivery

### PR A — Audit, contracts, and failure classification
- Identify current event/cycle/workflow behavior, GitHub integration, harness dependency needs, host scheduler, and existing test evidence.
- Add testable network/transient vs permanent error classification and a read-only status view without changing event claim semantics.

### PR B — Durable deferred remote operations
- Persist remote operation intents and dependency blockers through existing governed artifacts.
- Add bounded retry scheduling and crash recovery with no implicit permission escalation.

### PR C — GitHub state reconciliation
- Discover new/updated PRs and issues with an authorized contributor policy, reconcile by source PR revision, and avoid duplicate actions.
- On uncertain write outcomes, query GitHub before retrying; record the external artifact identifiers.

### PR D — Scheduled loop integration
- Bind GitHub reconciliation to an existing event/workflow and the current `system.cycle`; use platform scheduler (launchd/cron) after explicit owner approval.
- Expose states and last successful sync in Mission Control.

### PR E — Fault-injection and E2E
- Run deterministic tests for offline/online flips, disconnect during Github writes, provider outage, crashes and restarts, stale claims, duplicate polls and no-op replays.
- Include one real isolated smoke workflow toggling network reachability using mocks/local server—do not disable actual host networking as a test side effect.
- Capture managed test artifacts / review dates if test memory is available.

## Acceptance criteria

1. Network loss while idle or while polling GitHub does not lose already recorded tasks, artifacts, approvals, or work.
2. Offline cycle ticks don't repeatedly fire the same event occurrence and don't create unbounded pending tasks.
3. GitHub actions with unknown completion reconcile remote state before another write.
4. Local work is attempted only if independently authorized and its services truly work offline.
5. A provider network outage cannot be mistaken for an ordinary coding failure or trigger unnecessary failover.
6. Reconnecting picks up valid deferred work without duplicating PRs/issues/comments or bypassing human review.
7. `system.cycle`'s existing tests and at-most-once occurrence guarantees continue to pass.
8. Offline behavior is visible: last successful sync, service-specific blockage, pending operations, stale/unknown claims and next retry.

## Explicit non-goals

Do not create a competing scheduler, blindly retry claimed occurrences, automatically replay missed events, invent an agent-specific permission path, or assume that worktrees/archives alone sandbox code.

## Claude instructions

First inspect what has changed since this proposal. If any part exists, cite the source and narrow implementation to the missing gaps. Mark built vs proposed. Use existing `system.cycle`, workflow/event/task artifacts, governed dispatch, and provenance; break implementation into small reviewed PRs rather than replacing the scheduler.
