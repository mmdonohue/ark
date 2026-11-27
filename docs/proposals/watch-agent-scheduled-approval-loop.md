# Scheduled watch loop with owner approvals (#41)

**Status (2026-11-27):** built: one tick (`ark cycle`), `ark schedule`, `approval.queue` / `review.dismiss`, Mission Control "Needs approval", `ark approvals`. Owner decisions: tick every 15 minutes by default; a portable drive may schedule itself, with a warning. Assessed against `main` at cf6a53c.

The loop this aims for: **tick → drift → agent review → owner approval → approved coding → validation → separate merge approval.** This proposal wires the first four with what already exists. The last three need writable worktrees (#38) and stay out of scope.

## What exists today

**Active trigger: none.** No launchd agent or cron entry is installed on the owner's machine. Every drift check so far was started by hand: `ark-dev watch`, `ark cycle`, or Mission Control's Run cycle button.

**Two clocks, both unscheduled:**

| | `ark-dev watch` | `ark cycle` (`system.cycle`) |
|---|---|---|
| Finds work by | scanning every ready task with `context.schedule` and `inputs.compare` | event artifacts whose schedule came due, claimed once per occurrence |
| Runs | `harness.watch` on each | the event's `action_ref`: `harness.watch` for a drift task, `harness.run` or a workflow launch otherwise |
| Scheduler | `--launchd` prints a daily 09:00 plist, never installed | none (the clock is external by design) |
| Ledger source | `cli` | `system.cycle`, with `event_id` and `due_at` |

Both end in `harness.watch`, whose own `schedule.every` check and drift baseline make a doubled tick harmless (the second returns `not_due`, or `unchanged` with no agent call). They are still two loops, though, and installing both would break the rule of one watch loop.

**Drift → review: built.** `harness.watch` calls an agent only when the drift signature moves. The review is an artifact on the task. A failed review leaves the baseline alone, so the next tick retries it.

**Approvals: built, but scattered.** Each lives on its own screen, and nothing gathers them:
- `task.approve`: proposed → ready
- `workflow.approve`: a proposed run
- gated workflow steps
- `event.approve_workflow`: a schedule's standing approval, and when it goes stale
- PR intents, proposed from a review with a manual button

A new drift review shows up only inside its task's history.

**Coding, validation, merge: not built.** Agents are read-only. A PR intent describes a change; nothing is pushed.

## Proposal

### 1. One tick: `ark cycle`

`system.cycle` becomes the only clock. It already claims each occurrence once, skips missed runs, records a ledger entry per action, and launches through `dispatch()`.

- A drift task is scheduled the same way as everything else: by an event whose `action_ref` is the task. `context.schedule.every` stays as `harness.watch`'s minimum interval, a guard rather than a clock.
- `ark-dev watch [task]` stays as a manual "check now". `--launchd` is removed and points to `ark schedule`.
- Drift tasks with `context.schedule` but no event pointing at them are listed by `ark schedule status` with a hint. Nothing is migrated automatically: creating the event is the owner's call.

### 2. An owner-run scheduler: `ark schedule`

```sh
ark schedule install [--every 15m] [--yes]   # asks first; writes and loads the agent
ark schedule status                          # loaded?, last run, exit, log tail, unscheduled drift tasks
ark schedule remove [--yes]                  # unloads and deletes it
```

- **macOS:** `~/Library/LaunchAgents/dev.ark.cycle.plist`, with `StartInterval` (default 15 min) and logs in `~/.ark/logs/`. It runs `ark cycle` the way this install runs: a portable install through its launcher, a checkout through `node cli/ark.js`. On other platforms, `install` prints the cron line instead.
- **Never automatic.** Nothing installs, enables or re-enables it except this command, which asks first (or takes `--yes`; with no terminal, `--yes` is required). `install` replaces the agent ARK made earlier and refuses to touch anything it didn't make.
- **Overlap is safe already.** A tick that runs while the last one is still going claims nothing twice, and a missed tick is caught up once.
- **Portable drive:** allowed, with a warning. When the stick is unplugged, the tick fails and does nothing; `status` reports it.
- **Lamb Mode (#40)** will stop the work at the `dispatch()` boundary, so the scheduler never has to change.

### 3. Needs approval: one queue

A read-only view over the approvals that already exist. It adds no new way to approve anything: each item links to its existing control.

- **`approval.queue`** (read, owner): proposed tasks, proposed workflow runs, gated steps waiting, proposed PR intents, events with a missing or stale workflow approval, and new drift reviews. Exposed through the gateway as a read.
- **Mission Control:** a "Needs approval" view at the top of the nav, with a count. **CLI:** `ark approvals`.
- **New drift reviews** stay in the queue until the owner makes a PR intent from one or dismisses it. That needs one new governed write, `review.dismiss` (owner, ledgered, with an optional note), the only runtime write this proposal adds.

### Out of scope here

- Approved coding, validation, merge approval: #38. Until then the loop ends at a proposed PR intent in the queue.
- Telling a network or provider outage from a real failure: #39-A. Until then, an offline tick shows as `failed` on the occurrence, and the next tick retries.

## Coordination

- **#40 Lamb Mode:** one check at `dispatch()` covers the scheduled tick too. The queue shows when the vessel is quiet.
- **#39-A:** classifies `harness.watch` failures into outage vs. real; the queue and `ark schedule status` show the difference.
- **#38:** picks up from an approved PR intent.

## Acceptance

- [x] `ark schedule install/status/remove`: asks first; refuses without `--yes` when there's no terminal; never touches a plist it didn't write; a plist round-trips (install → status → remove leaves nothing behind).
- [x] `ark-dev watch --launchd` removed; `ark-dev watch` still works by hand.
- [x] Two ticks at once fire each occurrence once, a scheduled drift task included.
- [x] `approval.queue` returns every kind listed above, owner-only, through `dispatch()`; the gateway exposes it as a read.
- [x] `review.dismiss`: owner-only, ledgered; a dismissed review leaves the queue, and one turned into a PR intent leaves it too.
- [x] Mission Control "Needs approval" view with a count; each item opens its existing approve control.
- [x] Nothing schedules itself: a fresh install has no agent until the owner runs `ark schedule install`.

## Decided

1. Default cadence: every 15 minutes (`--every` takes 5m to 24h). Drift tasks keep their own `every`.
2. A portable drive may schedule itself; `install` warns, and `status` reports when the drive is missing.
