# Lamb Mode: vessel-wide quiet operations (#40)

**Status (2026-11-27):** proposal. No runtime changes yet. Assessed against `main` after #41 (scheduled tick, approvals).

Lamb Mode is the owner saying "nothing runs in the background until I say so." It is a durable vessel setting. It isn't a network state: Wi-Fi coming back never ends it, and #39's outage handling is separate. It isn't a scheduler either: it gates the one that exists. Only the owner, explicitly, turns it off.

## What exists today

- **Every action goes through `dispatch()`:** PCER, a capability check, the handler, and a ledger entry. Scheduled work (`system.cycle`), agent runs (`harness.run`, `harness.watch`), workflow steps and the harness's MCP callbacks all re-enter it, with `ctx.source` and `ctx.delegation` saying where they came from.
- **Pausing is per event** (`event.pause` / `event.resume`, which resets `active_since`). There's no vessel-wide switch.
- **In-flight work:** `system.cycle` keeps its started work in an in-memory set (`drain()`, `running()`). Harness runs are tracked by run key and can be stopped with `harness.cancel`.
- **One path skips `dispatch()`:** `ChainExecutor.resume(registry)` re-runs pending chains by calling handlers directly. ARK itself never calls it, but **Seravanna's `backend/index.js` does, at boot.** Lamb Mode has to cover it.
- **Nothing called Studio exists in ARK yet.** The shared indicator lives in Mission Control, and a future Studio reads the same state.
- **Owner data is local:** each vessel's SQLite file, which works offline.

## Proposal

### 1. The setting: one artifact, changed only by two owner actions

- **Storage:** a singleton artifact, `artifact_type: 'vessel_mode'` with slug `vessel-mode`, holding `context: { mode: 'normal' | 'lamb', since, by, note }`. It lives in the vessel, so it persists offline and travels with the vessel. No new table is needed.
- **`vessel.quiet { note?, cancel_running? }`** and **`vessel.resume { note?, missed? }`:** new capability `vessel.mode`, owner only (rank 100). Each change writes the artifact's history and a ledger entry.
- **Agents can never change it:** both actions are refused when `ctx.delegation` is set or the source is `harness` or `system.cycle`, whatever rank the caller holds. This is checked in `dispatch()`, not left to callers.
- **`vessel.mode`** (read) returns the current state, so the CLI, Mission Control and the gateway all show the same thing.

### 2. One check at the `dispatch()` boundary

After the capability check, if the vessel is in Lamb Mode, dispatch looks up the action's quiet class (a new registry field). It refuses deferred work with **423 `LAMB_MODE`** before the handler runs. The refusal is ledgered like any other.

| Quiet class | Actions | In Lamb Mode |
|---|---|---|
| `background` | `system.cycle`; any action whose `ctx.source` is `system.cycle` or `harness`; an automated workflow step's action (`meta.workflow_run`) | deferred, always |
| `work` | `harness.run`, `harness.watch`, `workflow.advance`, `sync.push`, `pipeline.run`, `media.classify*`, `cinema.render_reel` | deferred, unless the owner overrides it (below) |
| everything else | reads; recording intent (`task.propose/approve/revise`, `event.*`, `workflow.launch/approve`, `artifact.*`); `vessel.*` | allowed: intent is kept, nothing runs |

Approving a workflow run while quiet records the approval, but no step does any work. An automated step's action is `background` and is refused, so the step stays waiting; `workflow.advance` picks it up after resume. An AI step waits for a `harness.run`, which is `work`. That keeps intent and provenance without a second engine.

**The owner override is the only exception.** The owner, in the foreground (Mission Control or the CLI, with no delegation), can run a `work` action anyway by passing `meta.quiet_override: true`. Mission Control asks inline first, and the CLI takes `--anyway`. The ledger records the override. Agents and the cycle can't send it. Nothing in the `background` class can be overridden.

### 3. Scheduled work

- **While quiet, `system.cycle` claims nothing.** It returns `{ quiet: true }`, so the launchd tick from #41 keeps firing and does nothing, and no occurrence is marked as fired or blocked.
- **`vessel.resume { missed }` decides about what came due while quiet:**
  - `latest` (default): each event fires its latest due occurrence once on the next tick. That's what `system.cycle` already does after a gap.
  - `skip`: resets each active event's `active_since` to now, the same rule `event.resume` uses, so nothing missed fires.
- **The resume preview:** `ark resume` (and Mission Control) first lists what the next tick would fire, using `system.cycle { dry_run }`, a read that's allowed while quiet. The owner picks before anything runs.

### 4. Work already running when Lamb Mode starts

- By default it **finishes**: a harness run, or a cycle's started work. Mission Control shows "quiet — n still finishing" until `running()` reaches zero.
- `vessel.quiet { cancel_running: true }` signals every in-flight harness run through the existing cancel path. Each one records `cancelled`, and its task stays approved, so it can run again after resume.

### 5. The path that skips dispatch

`ChainExecutor.resume()` checks the mode first. While quiet it leaves pending chains pending, logs that once, and resumes them on the next boot after `vessel.resume`. This change lands in ARK. Seravanna then picks it up through the normal port, with no Seravanna-only edit.

### 6. Where it shows

- **Mission Control:** a 🐑 **Quiet** pill in the top bar while Lamb Mode is on, with since when, who turned it on, and their note. The Needs approval view keeps working, since approving is allowed. Refused actions show "Lamb Mode is on" with the override where one is allowed.
- **CLI:** `ark quiet [--note] [--cancel-running] [--yes]`, `ark resume [--skip-missed] [--yes]` (preview first, then asks), and `ark mode`. `ark schedule status` notes that the tick is quiet.

## Pull requests (each one small and governed)

1. **State and check:** the `vessel_mode` artifact, `vessel.quiet/resume/mode`, the agent refusal, quiet classes on the registry, the 423 in `dispatch()`, the CLI, and tests. Cycle behavior is unchanged except that a refused cycle returns 423.
2. **Cycle and resume:** `system.cycle` returns `{ quiet: true }`, plus `missed: latest|skip` and the resume preview.
3. **Running work and chains:** `cancel_running`, the "still finishing" count, and the `ChainExecutor.resume()` gate.
4. **Mission Control:** the pill, the refusal message, and the inline override.

## Acceptance

- [ ] The mode survives a restart and works offline. Nothing network-related changes it.
- [ ] Only the owner, in the foreground, can change it; delegated or cycle contexts are refused even at rank 100.
- [ ] While quiet: `system.cycle` fires nothing; `background` actions are refused with 423 and ledgered; `work` actions are refused unless overridden, and the override is ledgered.
- [ ] While quiet, reads and intent (propose, approve, schedule) still work, and approved workflows don't start their steps.
- [ ] Resume previews what would fire; `latest` fires each event once, and `skip` fires nothing missed.
- [ ] Running work finishes, or is cancelled when asked, and its task stays approved.
- [ ] `ChainExecutor.resume()` leaves chains pending while quiet.
- [ ] Mission Control and the CLI show the same state.

## Open questions

1. **The owner override:** allow a foreground owner to run `work` anyway (with an inline confirm, ledgered), or should quiet mean no agents and no publishing at all until resume?
2. **When Lamb Mode starts:** let running work finish (default), or cancel it unless told otherwise?
3. **After resume:** fire the latest missed occurrence of each event (`latest`, matching today's catch-up), or skip missed ones by default?
