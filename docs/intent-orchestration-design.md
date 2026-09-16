# Intent-driven capability orchestration

## Purpose

Impose now separates three records that had previously been conflated:

1. **User request** — the original text plus conversation and active-task context.
2. **Agent interpretation** — a normalized, hierarchical goal with subgoals, typed capability requirements, constraints, expected output, confidence, risk, assumptions, and success criteria.
3. **Execution plan** — eligible capability providers, ranked selections, alternatives, dependencies, approval gates, lifecycle state, observations, verification, failures, and recovery.

This is goal decomposition, not fixed-label intent classification. There is no request phrase dictionary or giant intent taxonomy.

## Audited integration boundaries

| Existing area | Classification | Treatment |
|---|---|---|
| Former tool `matches()` metadata and app-level phrase routing | Legacy routing | Removed. Compatibility-only request detectors remain inside the old direct `runAgent` adapter for callers that do not yet provide semantic intent; registered tools do not advertise wording. |
| Browser URL, origin, action, payload, repeat, and step-limit checks | Safety/permission policy | Preserved unchanged below orchestration. |
| Browser approval commands and persisted approval | Business/safety control protocol | Preserved. A browser capability selection enters the existing bounded browser planner and approval lifecycle. |
| Media ID, URL, live-state, recency, and provider-claim checks | Deterministic parsing and verification | Preserved. Structured intent constraints now reach the provider pipeline without reverse-engineering them from wording. |
| Search/read provider HTML and JSON parsing | Deterministic parsing | Preserved below capability execution. |
| Research source gates and untrusted-evidence prompt | Verification/safety policy | Preserved. Tool invocation is an observation; evidence gates determine outcome. |
| Relay adapter discovery in `backend/relay/capabilities.py` | Provider discovery | Kept separate. It chooses implementations *inside* a tool; client orchestration chooses tools for a user goal. |
| Hard-coded exact media follow-up rewrites | Legacy compatibility routing | Not used when a semantic intent is supplied; active intent supplies resolved context instead. |
| Direct slash/browser approval commands | Explicit control protocol | Preserved; these commands manipulate lifecycle state rather than infer a new user goal. |

## Architecture

```text
request + conversation + active task + failures + permissions
                         |
                  semantic IntentEngine
                         |
             normalized hierarchical intent
                         |
       requirement resolver + CapabilityRegistry
                         |
       ranked providers + alternatives + approvals
                         |
                  dependency-aware plan
                         |
       existing harness / browser / future tool runners
                         |
       observations -> independent verification
                         |
       success | partial | recovery | blocked | failed
```

`agent/orchestrator.js` owns the canonical registry and lifecycle. Tools advertise capability IDs, typed inputs/outputs, prerequisites, permissions, side effects, approval requirements, cost, reliability, supported environments, composability, mutability, failure modes, execution, and optional independent verification. A new provider becomes selectable by registration when its canonical capability matches a requirement; no intent handler is added.

The semantic interpreter may infer only capabilities present in the supplied catalog. Selection never compares user wording with tool IDs or tool names. Registry discovery is exact on canonical capability IDs emitted by interpretation, then filters environment/permissions and ranks eligible providers by reliability, latency, approval cost, and runtime preference.

## Lifecycle and uncertainty

Persisted task states are `planned`, `executing`, `waiting`, `succeeded`, `blocked`, `failed`, `partial`, `needs_approval`, `needs_clarification`, and `recovering`.

- Low-confidence, risky, or explicitly ambiguous goals pause for clarification.
- Side-effecting or approval-marked steps pause before execution.
- Safe high-confidence steps can proceed.
- Provider output becomes an observation, not proof of success.
- Verification failure is handled like provider failure: the planner tries an unused provider advertising the same capability.
- Every transition is checkpointed through the task store, allowing inspection and resume.

## Goal contract

Interpretation returns a full contract, not a label: `goal`, `confidence`, `risk`,
`constraints`, `desiredOutput` (type, presentation, autoplay, requested count),
`subgoals` with typed requirements, `successCriteria`, `failureConditions`,
`preferences`, and a bounded `budget` (`maxAppendedSteps`, `maxQueryRewrites`,
`maxProviderAttempts`, defaulted 3/2/3). The budget caps every recovery and
replan loop, so no task can spend unbounded attempts on a failing path.

## Utility ranking

Provider selection scores each available tool with
`utility = expected progress x probability of success / linearized cost`,
where progress is 1 for an exact-capability match, success is the tool's
audited reliability, and cost aggregates latency, approval interruption and
side-effect risk. Failure evidence reranks through the recovery tiers below
rather than through hard-coded provider order.

## Failure-classified recovery

Every tool or verification failure is classified before retry:

| Class | Trigger | Recovery |
|---|---|---|
| `empty` | verified output with no results | rewrite the query from `requirement.inputs.alternativeQueries`, same provider, budget-capped |
| `network` | transport errors (timeout, conn reset, fetch failed) | retry the same provider once, then alternatives |
| `auth` | 401/403/permission errors | alternatives, reranked toward environments with more access |
| `parse` | malformed JSON/HTML from a provider | alternatives with independent parsers |
| `provider` | anything else | alternatives in utility order |

Each transition is checkpointed as a `replan` trace event with its reason.

## Observation-driven replanning

A provider output may carry typed `unmetRequirements` (capability, inputs,
success criterion). Within `budget.maxAppendedSteps`, the executor discovers
providers for them and appends planned steps dependent on the observing step,
so execution stays a decide-after-observe loop instead of one frozen plan.

## Outcome verification

`OutcomeVerifier` is an independent component invoked when the step sequence
ends. Deterministic checks run in code: final per-step states, the last
verification record per step, and requested deliverable counts against
observed rows or artifacts. An optional caller-supplied `semanticVerifier`
judges meaning (for example whether a source is truly free for commercial
use) and its missing items merge into the same report. The result
(`satisfied`, `missing`, `recommendedAction`, `semantic`) is stored as
`task.outcome`, checkpointed as `outcome_verification`, and downgrades an
otherwise clean run to `partial` when the contract is unmet. When a failed
step still holds unused alternatives, an unsatisfied outcome routes the task
to `recovering` with the cursor on that step instead of declaring success.

## Persistence and resume

`PersistentTaskStore` checkpoints every lifecycle transition to
`localStorage` where a host provides it (memory otherwise). The harness wires
it into the orchestrator, and `resume()` continues a crashed or interrupted
task from its last checkpoint, promoting an unused alternative when the
failed step has one.

## Runtime integration

- `index.html` loads orchestration before the harness.
- `agent/harness.js` registers web search, web reading, image discovery, playable-media discovery, evidence synthesis, and the bounded browser agent in one registry.
- `app.js` semantically interprets each novel request, persists the interpreted goal and active plan, and dispatches by selected capability provider—not by request phrases.
- Existing optimized research/media pipelines remain as execution adapters, preserving source, media, and failure gates while receiving the semantic intent.
- Browser execution still uses `agent/browser-agent.js` and its existing explicit approval and origin bounds.
- Relay media requests accept bounded structured constraints (`subject`, `latest`, `live`, `creator`, and `platforms`) so provider verification does not depend on reconstructing intent from trigger words.
- The trace UI shows interpreted goal, requirements, and selected providers; stored task traces expose candidates, observations, verification, recovery, and final outcome.

## Incremental boundary

This is the smallest coherent foundation, not a rewrite of every runner. The old harness compatibility adapter remains for direct third-party/test callers without `intent`; the production app supplies semantic intent and does not call `detect()` for routing. Future email, file conversion, coding, and download tools should register metadata and an executor. Only genuinely new safety policy or deterministic parsing should require lower-layer code.
