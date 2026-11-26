# Proposal: Risk-Aware Task Routing and Independent Validation in ARK

**Status:** Proposed / not implemented by this documentation PR.  
**Motivating use case:** Seravanna Security Guardian and Health Privacy Auditor (Seravanna issue #85).  
**Architectural rule:** Extend the existing ARK governed execution plan; do not build a second model hopper or privileged router.

## Verified implementation baseline

Inspected ARK:
- `adapters/harness.js` implements two coding-agent drivers, `claude-code` and `copilot`, with ordered preference, optional per-task driver/model overrides, capability filtering, spend/usage limits, cooldowns, and failover on a defined class of provider errors. Timeout deliberately does **not** auto-failover.
- The harness limits agent filesystem tools to read-only and scopes agent MCP capabilities; it sanitizes child environment variables to avoid exposing backend credentials.
- `actions/HarnessActions.js` resolves an approved task execution policy, preserves attempts and creates `review` artifacts tied to tasks. Callers can narrow approved drivers, not expand their policy. It rejects `kind: pr` through `harness.run` because this is a read-only review path.
- `adapters/llm.js` supports direct inference, an optional host-provided model pool, usage metering, and `completeJSON` schema validation. This is **not** the same execution path as a coding-agent harness task.
- `actions/WorkflowActions.js` executes ordered governed workflow tasks; no second workflow engine is needed.
- **Not verified:** Which DeepSeek models are currently available through the operator's Copilot CLI subscription, local configured driver/model names, present historical quality scores, or a production task-risk resolver. Discover those first. Do not hardcode “deepseek” without checking the provider's actual model identifier.

## Objective

Enable ARK to assign tasks to a suitable *approved* provider/model based on declared capabilities, sensitivity, risk, cost budget, and validated historical outcomes, while keeping authority separate from model selection.

### Initial task classes
- `code.inventory`: low-risk repository discovery, evidence links.
- `security.tracking_audit`: read-only inventory of Pixel and event transmission with specific source evidence.
- `privacy.data_flow`: sensitive-context inventory with strict data-minimization constraints.
- `code.test_generation`: Playwright/CI test proposals (implementation via an explicitly approved coding/PR path, **not** `harness.run`).
- `security.remediation_review`: independently reviewed high-risk code changes.
- `privacy.legal_assessment`: human-qualified review required; no automated legal/compliance certification.

## Proposed task policy shape (illustrative, NOT current schema)

```yaml
routing:
  task_class: security.tracking_audit
  risk: medium
  data_classification: confidential_source
  constraints:
    external_data_allowed: false
    required_capabilities: [repo.read, code.review, report.write]
    execution_mode: read_only
  preferred_candidates:
    - driver: copilot
      model: discover_at_runtime  # may be DeepSeek if supported/approved
    - driver: claude
  validation:
    require_source_evidence: true
    require_contract_acceptance: true
    independent_review: false
  budget:
    max_usd_per_accepted_result: null
    max_attempts: 2
```

`max_usd_per_accepted_result` is an *optimization/reporting target*, not proof of acceptable quality or an authorization threshold. Provider quotas may be denominated in premium requests rather than USD.

For high-risk work, require independent evaluation and human approval regardless of which model ran. The model's self-reported success cannot count as independent acceptance.

## Routing algorithm / safety
1. Receive immutable task intent; determine source and data classification and the *approved* execution policy.
2. Enumerate only configured drivers/models; probe actual availability and declared required capabilities.
3. Filter out all candidates disallowed by authority, data-handling restrictions, required tool access, cost/time limits and task risk. **No fallback may widen the authorized set.**
4. Choose an allowed candidate based on explicit owner preference first, followed by evidence-backed fitness and cost where available. Unknown models stay unrated; no invented historical quality.
5. Record the routing decision as a traceable artifact/ledger event with candidate set, disqualification reasons, policies/versions, selected provider/model and estimated budgets.
6. Execute via existing `harness.run` or `llm.complete` as appropriate. Record attempts, failures, runtime, actual model, tokens/requests and cost without conflating units.
7. Validate outputs against task acceptance criteria and provenance requirements. A schema-valid JSON result is **not** equivalent to a correct security assessment.
8. Independently review high-risk results and gate resulting implementation/deploy/merge actions on explicit human authority.
9. Persist acceptance outcome and evaluator identity as artifacts/relationships so future routing can use recent, relevant evidence.

**Never route real health records, production credentials, survey answers, or other regulated/sensitive data to an unapproved provider.** Prefer synthetic fixtures and minimum repository context.

## Initial rollout — small PRs

### PR 0: Audit (read-only)
Inventory existing execution_policy, model override, CLI model availability, model usage archive, review artifacts, workflows, and test contracts. Explicitly classify present, partial, absent.

### PR 1: Task metadata + routing plan report
Introduce a narrow, versioned task classification and policy schema with backwards-compatible defaults; resolve an explainable routing plan in dry-run mode. Keep existing manual ordered-driver behavior unchanged.

### PR 2: Policy-aware candidate ordering
Add candidate filtering and optional routing preferences to existing harness plan construction without mutating the core `dispatch` authority lifecycle. Enforce no-widening during failover. Preserve explicit manual override semantics only within approved candidates.

### PR 3: Evidence-based model performance
Build acceptance evidence on existing task/review and usage artifacts. Separate provider errors, grading, E2E outcomes and human acceptance. Avoid ranking on tiny samples; disclose insufficient observations. Normalize request-based vs USD cost.

### PR 4: Independent review / governance
Add second-evaluator requirement for selected high-risk tasks, human sign-off and specific blockers for security/privacy changes. Keep legal compliance decisions human-owned. Workflows and PR intent still use their existing governed actions.

### PR 5: Pilot with Seravanna
Use the *read-only* portions of Seravanna issue #85 (Pixel inventory and data flow audit) with no real personal health data. Compare Copilot-accessible models, potentially DeepSeek, against incumbent on the same snapshot and evidence rubric. Capture accuracy, cost/requests, runtime, and denials. Do not permit any agent to deploy or modify production.

## Validation / acceptance
- Existing manually ordered driver configuration and fallback pass unchanged regression tests.
- Unknown/unavailable models are rejected or skipped transparently; no silent substitution.
- A risk policy cannot grant more permissions than actor/task authorization; run-time narrowing remains intact.
- High-risk classifications block inappropriate providers and require independent evidence.
- Simulation and real read-only tasks produce the same explainable eligibility decision with controlled environment inputs.
- Failover remains constrained to authorized candidates and supported failure codes; timeouts do not generate duplicate work by default.
- Privacy-sensitive fixtures cannot leak into model prompts, logs or external calls.
- Task provenance includes candidate selection reason and real provider/model; acceptance evidence can be separately audited.
- Integration test covers Copilot model probing when available and graceful failure when unavailable.
- New test evidence is preserved for future contract/test validation and review date; no fake “passed” status.

## Non-goals
- Do not implement a new agent framework, custom planner runtime, second model hopper, or second contract/ledger engine.
- Do not change the legal status of Seravanna or claim HIPAA certification.
- Do not remove human approval for PR merges, live campaign changes, or production privacy controls.
- Do not equate semantic quality validation with schema validation.

## Claude instructions

Audit first, propose incremental implementation PRs, and avoid replacing primitives with abstractions that already exist. When a candidate routing decision is not evidenced, retain existing explicit ordered preference rather than guessing. Use ARK's current artifact, contract, workflow and trace machinery. Explain every security/data-handling implication before requesting permission to enable new model providers.
