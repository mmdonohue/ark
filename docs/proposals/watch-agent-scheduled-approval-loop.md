# ARK Ask: Activate Code Watcher Through the Governed Dev-Cycle Approval Loop

**Status:** Proposed implementation contract. Documentation only, not a running scheduler.

## The missing factory connection

The code-watching agent already exists. **When does it actually run, and how does its output reach the owner for approval?** Establish a complete, observable chain from an external clock through the current watch task and review artifact to human action, without standing up a second orchestration engine.

Desired flow:

1. External local scheduler triggers the governed ARK cycle.
2. ARK checks approved watch tasks against their due times and dependencies.
3. For due tasks, compute git drift cheaply and record a check even if unchanged.
4. If meaningful drift exists, request an agent review **only within the approved scope**.
5. Persist review artifact, validation evidence, source revisions and costs.
6. Notify/show the owner in Mission Control with an actionable recommendation.
7. Owner approves, rejects, requests changes, or authorizes a separate implementation task.
8. Only approved implementation proceeds, using normal governed workflow; later code diff and tests return for another merge/release approval.

## Verified current implementation (reinspect when acting)

- `cli/ark-dev.js` exposes `ark-dev watch [task_id] [--force]` and `ark-dev watch --launchd`.
- `--launchd` **prints** a launchd plist (`dev.ark.watch`) with a daily **09:00** local calendar trigger. It does not install or enable it.
- `actions/HarnessActions.js` has `harness.watch`: `context.schedule.every` supports hours/days; early return `not_due`; computes and records git drift; only invokes agent review when signature changes.
- `actions/SystemActions.js` can dispatch `harness.watch` from a scheduled event's `action_ref` through `system.cycle`; event occurrences are deterministically claimed at most once. `ark cycle` waits for work to settle.
- `event.pause/resume`, `task.approve`, and workflow approval primitives exist.
- `ark-dev` currently boots against remote Supabase by design, so `watch` may not operate without internet. Do **not** equate a git-only diff with the whole watch operation being offline-capable.
- None of the above establishes that the scheduler is installed or active on the owner's Mac.

## Required audit and decisions before implementation

1. Which code-watching task was **just added**? Identify its artifact ID, approved scope, repositories, schedule, last check, provider, and intended review destination. Do not invent its identity or imply its schedule has been activated.
2. Clarify whether to use the existing `ark-dev watch --launchd` path or the `system.cycle` event path as the canonical factory tick. Avoid running both against the same watch task. Explain migration/deprecation if needed.
3. Inventory the current Mission Control approval queue, task review artifacts, notifications, and any workflow gating already present.
4. Determine the exact trigger semantics: wall-clock tick, drift detected, PR head SHA changed, explicit manual run; ensure a single owner-readable next-run / last-run status.
5. Verify owner identity, capability checks, approved scope fingerprint, spending/rate limits and test evidence.
6. Cross-check in-flight Claude implementation and PRs. Mark built / partial / proposed; do not create redundant machinery.

## Proposed requirements

- Canonical **single cycle entrypoint**, invoked by platform scheduling, with the system's existing `dispatch()`, ledger and capabilities.
- Watch tasks remain explicitly approved and scoped. Automatic checking may be allowed within approval; proposing a code change is **not** authorization to execute it.
- Record task/artifact IDs, timestamps, due status, baseline/head hashes, changed paths, agent output and whether any human action is waiting.
- Deduplicate on approved task + source revision + review intent. Repeated polls must not generate repeated agent reports or implementation jobs on unchanged code.
- Do not confuse *agent observed drift* with *agent authorized to fix drift*. Every implementation plan goes through owner review. Diff and merge get a second review gate.
- Keep review outputs visible in a Mission Control **Needs Approval** view (and via CLI). Do not make the owner mine logs.
- A temporarily unavailable GitHub, Supabase or model provider yields a visible deferred/blocked state, not an expensive failover storm or lost task.
- Honor vessel-wide Lamb Mode when implemented: no new nonessential work during Lamb, no implicit resume on connectivity restoration.
- Host scheduler creation/enablement is an explicit owner action, with `status`/`disable` and clear next-fire visibility; do **not** silently create a launch agent.
- Default to one active coding/review task at a time until the authorized worktree/concurrency contract (#38) is live.

## Proposed incremental delivery

1. **Inspect + report:** verify the new watcher artifact and actual existing scheduler presence; show the complete present trigger and approval path.
2. **Single scheduler + status:** unify the scheduled trigger contract and show last/next check; owner-controlled activation.
3. **Review handoff:** connect drift review artifacts to a governed approval queue and create an implementation intent only on approval.
4. **Implement/validate/approval:** within existing workflow, route approved work to coding agent, validation and second approval before merge.
5. **Resilience tests:** mock missing internet, interrupted watch, reconnect, duplicate ticks, unchanged drift, owner rejection, restart and Lamb Mode. Reuse managed test evidence where it exists.

## Acceptance checks

- With scheduler disabled, no spontaneous agent runs; manual watch/cycle works under authorization.
- With scheduler enabled and due, exactly one watch invocation for a given approved task and due/revision state.
- No changed code produces an auditable no-change check without an AI billing event.
- Changed code produces an attributed review artifact and actionable owner approval item, not an automatic code modification.
- Rejection ends or revises the request with trace; approval creates exactly one scoped implementation job.
- Implementation produces tests/PR evidence for separate owner merge approval, never auto-merges.
- Network loss and restarts do not erase or duplicate pending approvals; Lamb pauses applicable work.
- UI and CLI identify last run, next due, current blocker and what is awaiting the owner.

## Relationship to existing proposals

- **#38:** Governed writable worktrees are the execution isolation for approved coding, not required for read-only watch.
- **#39:** Offline-tolerant cycle and external-operation reconciliation.
- **#40:** Universal Lamb Mode, an intentional owner-controlled execution pause.

This PR is an **Ask** for a concrete factory trigger-and-approval integration, not a demand to build a new watch engine. Claude should reconcile with current phase work before deciding the smallest implementation steps.
