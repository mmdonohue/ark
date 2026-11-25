# Ask: Governed Git Worktrees for Writable Agent Tasks

**Status:** Proposed feature contract; not implemented in this PR.
**Priority:** Next step before concurrent automated coding-agent work intake.
**Owner:** ARK Dev / existing harness and workflow modules.

## Intent

ARK currently runs its review harness against pinned, **read-only** `git archive` snapshots. Keep that proven design for read-only review, analysis, and untrusted PR inspection.

Add an **explicitly authorized writable workspace mode** for implementation tasks using per-task Git worktrees. This provides independent working directories for concurrent agents without forcing them to switch branches in the owner's checkout.

**Important architectural constraint:** A worktree changes the source repository's shared `.git` metadata. It must not be substituted for the current read-only snapshot implementation. Worktrees isolate working files and indexes, *not* credentials, network access, processes, databases, or shared Git metadata.

## Verified starting points

- `utils/snapshot.js` explicitly chooses `git archive` over `git worktree add` to honor a no-repo-writes review contract; it excludes sensitive paths, fingerprints the snapshot and verifies no modifications.
- `adapters/harness.js` currently launches Claude Code/Copilot in read-only mode with an environment allowlist.
- Existing governance already models approved task scope, harness runs, ledgers, and workflows. Inspect current revisions before implementing and reuse these mechanisms.

## Desired lifecycle

1. **Discover/plan:** Resolve a task artifact, approved repository, base commit SHA, required operations, authorized actor, and approved task scope.
2. **Choose mode:** `review_snapshot` (existing, read-only) vs `implementation_worktree` (new, writable); selection is contract-governed and not agent-selected.
3. **Provision:** With appropriate filesystem and repo-write authority, create a uniquely named branch and worktree under a configured `allowed_roots` location, e.g. `ark/task-<id>-<attempt>`. Pin and record the base commit.
4. **Execute:** Hand the approved task, exact workspace path, allowed capabilities, budget, and timeout to the selected agent. Run in a genuine security sandbox if the PR/code is untrusted. No implicit access to host secrets or other worktrees.
5. **Validate:** Run relevant unit/integration/E2E tests in the task workspace and preserve results as test execution / test-validation evidence. Capture changed paths, diff, revision, and agent/model attempts.
6. **Propose:** Publish only an authorized branch/PR after checks and user approval policy; preserve a task → worktree/run → commits → PR relationship.
7. **Resolve:** Record outcome; clean up only after no unsaved work remains and the task/PR disposition authorizes cleanup. Support recovery after interruption.

## Worktree artifact / run fields

Suggested **derived projection**, not a new independent engine:
- `task_id`, `run_key`, `repository_id`, `base_sha`
- `branch_ref`, `worktree_path`, `mode`
- `workspace_status`: `provisioning | ready | running | needs_review | preserved | cleaning | cleaned | failed`
- `agent`, `scope_hash`, `started_at`, `completed_at`
- `result_sha`, `diff_hash`, `test_execution_ids`, `pr_ref`, `cleanup_reason`

Prefer recording this with existing artifact types / execution records unless a real template boundary justifies a workspace artifact.

## Governance and safety

- Distinct declared capabilities for workspace provision, write, publish, and cleanup; all privileged operations via the existing governed `dispatch()` path.
- Retain **read-only archive snapshots** for review tasks and untrusted intake.
- Do not run arbitrary unreviewed PR scripts on the host. Worktree isolation is **not** a security sandbox.
- Validate allowed root and repo path using canonical paths; protect against symlink escape, option/argument injection, branch collisions, and overwriting an existing worktree.
- Do not expose GitHub tokens, local secrets, `.env`, or host credentials in the agent environment. The writable workspace may include tracked sensitive files; review and constrain repo contents before authorizing.
- Worktree creation and cleanup mutate Git metadata; serialize these operations per repository to avoid races.
- One task attempt receives its own branch+worktree identity. Record retries, failover, leases/locks, and restart recovery. Do not reuse dirty worktrees without explicit policy.
- Safe cleanup must inspect dirty state, unpushed commits, open PRs, and active agents; never delete user work or force-prune without explicit consent.
- Owner review and merge authorization stay separate from agent execution. Branch creation is not merge authority.
- If `git worktree` is unavailable or filesystem permission is denied, fail with a governed explanation; do not silently fall back to working in the owner's checkout.

## Proposed incremental PRs

### Phase A — Audit and contract
Inspect actual CLI, snapshot, harness, task/approval, workflow, dispatch, and GitHub PR creation mechanisms. Specify minimum capabilities and mode selection with tests. Preserve old behavior unchanged.

### Phase B — Workspace provisioning
Implement create/list/status/recover/cleanup of task worktrees with lifecycle ledger entries, repository-scoped mutual exclusion, and disposable repo tests. No writable AI execution yet.

### Phase C — Writable harness mode
Connect specifically approved implementation tasks to worktree cwd and writable agent policy under a sandbox. Enforce filesystem/network/secret restrictions and provider compatibility. No broad permissions for read-only drivers.

### Phase D — PR handoff and test memory
Associate commits/diffs, appropriate E2E/smoke tests, test evidence, review status, and draft PR creation with the originating task. Cleanup only when safe.

### Phase E — Concurrent dev cycle
Integrate with scheduled PR/issue intake and agent assignment. Avoid duplicate work by external PR revision + task idempotency keys; ensure safe parallel execution and per-repo Git mutation locks.

## Acceptance criteria

1. Two approved implementation tasks can work on different branches concurrently without changing the user's primary checkout.
2. Read-only review path still uses immutable archive snapshots and rejects edits, with existing tests unchanged.
3. A worktree cannot be provisioned without declared and resolved authorization.
4. Agent cancellation or host interruption preserves recoverable workspace state and provenance.
5. Dirty/unpushed/PR-linked worktrees are not automatically destroyed.
6. A task can generate a reviewed draft PR with test results attached, but cannot merge it without separate authority.
7. Repeated cycle runs do not provision duplicate worktrees for the same task attempt.
8. Tests cover path escape, repository locks, branch collision, permissions, sandbox boundary, interruption, recovery, and safe cleanup.

## Out of scope for this proposal

Replacing `utils/snapshot.js`, creating a second task/workflow engine, silently launching concurrent coding agents, merging PRs, or promising that a Git worktree is a security boundary.

## Claude instructions

First verify current capabilities and relevant overlapping PRs; mark built vs proposed. If this document overlaps implemented work, revise its scope and propose the smallest missing implementation. Use ARK's Constitution and Charter; avoid new runtime primitives when existing artifact relationships, contracts, and workflows suffice.
