# Niche Autonomous Agent Harness: Web Search First

Source: user brief, 2026-09-12. This file is the working spec. The brief is
preserved here in condensed but faithful form so later phases do not lose it.

## Locked decisions

- UI: translate beautifului agent pipeline visualization only (Thinking trace
  plus Task rows, composed). Lucide icons, no shadows, Nova tokens.
- Runtime home: browser JS inside the Nova web app (`agent/` modules, no
  build step). Checkpoints in localStorage. Uses existing provider keys and
  the relay.
- Search provider: headless browser style, zero API keys. The provider
  adapter lives on the relay as `POST /v1/search` (server-side fetch, no
  secret in the browser). Phase 1 starts with lightweight server-side HTML
  fetch plus parse behind the provider interface; true Chromium (Docker)
  can slot in later without touching the agent.
- Strict phase order. No Phase 6 (second tool) without gate evidence.

## 1. Mission

Niche-focused autonomous agent: iterative reasoning, planning, tool
execution, observation, verification, recovery. First and only tool:

    web.search

Future tools (out of scope for Phase 1): web.open, browser, HTTP/API,
filesystem, code execution, terminal, database, messaging, domain tools.

## 2. Agent loop (the product foundation)

USER > UNDERSTAND > DEFINE OBJECTIVE > DEFINE SUCCESS CRITERIA > PLAN >
DECIDE > CHECK POLICY/BUDGET > EXECUTE WEB SEARCH > OBSERVE > EVALUATE >
VERIFY > SUCCESS ? DONE : RECOVER > REPLAN > DECIDE (loop).

Build Agent Runtime plus one excellent tool, not chatbot plus search button.

## 3. Non-negotiable rule

AgentRuntime must not know web search exists. It knows tools exist:

    AgentRuntime > ToolRegistry > ToolResolver > ToolExecutor > Tool

Adding a tool must not require rewriting AgentRuntime.

## 4. Phases

0. Architecture plus contracts.
1. Web Search Tool.
2. Agent Search Loop.
3. Verification plus Recovery.
4. Persistence plus Resume.
5. Real-world evaluation.
GATE. Only if successful: 6. Next tool.

## 5. Definition of "Web Search Works" (all 20 required)

1. Receive objective. 2. Understand it. 3. Decide research is needed.
4. Search plan. 5. Select web-search capability. 6. Construct queries.
7. Execute. 8. Process results. 9. Detect poor/incomplete results.
10. Search again when needed. 11. Store evidence. 12. Compare conflicts.
13. Judge sufficiency. 14. Verify vs success criteria. 15. Recover.
16. Stop when satisfied. 17. Grounded final answer. 18. Persist state.
19. Resume interrupted tasks. 20. Never claim success falsely.

## 6. Architecture

USER > AGENT API (start/continue/cancel/approve/resumeTask) > TASK MANAGER
(lifecycle, persistence, checkpoints) > AGENT RUNTIME (Objective
Interpreter, Planner, Decision Engine, Context Manager, Tool Resolver,
Execution Controller, Observation Processor, Verification Engine,
Recovery Engine) > TOOL INFRASTRUCTURE (Registry, Schemas, Policy,
Executor, Health) > WEB SEARCH TOOL > SEARCH PROVIDER.

## 7. Core components (initial boundaries, simple implementations)

AgentRuntime, TaskManager, ObjectiveInterpreter, Planner, DecisionEngine,
ContextManager, ToolRegistry, ToolResolver, ToolExecutor, WebSearchTool,
ObservationProcessor, EvidenceStore, VerificationEngine, RecoveryEngine,
BudgetManager, CheckpointStore, EventBus, ModelProvider.

## 8-11. Task, Objective, Success Criteria, Task State

Task: id, input, objective, status (queued|planning|running|verifying|
recovering|paused|completed|failed|cancelled), plan?, state, constraints,
budget, createdAt, updatedAt.

Objective: description, desiredOutcome, successCriteria[], constraints[],
priority (low|normal|high). Raw prompt is not the task definition.

SuccessCriterion: id, description, required, verificationMethod
(source|constraint|comparison|tool|model|hybrid). Know "done" before
starting. Prevents search > summarize > stop.

TaskState: currentStepId?, completedSteps[], failedSteps[],
observations[], evidence[], decisions[], assumptions[], unresolvedIssues[],
verificationResults[], retryCounts{}. History is not the source of truth.

## 12-13. Plan, dynamic planning

Plan: id, version, objectiveId, status
(draft|active|completed|failed|superseded), steps[], createdAt, updatedAt.

PlanStep: id, title, description, type
(reason|search|transform|verify|ask_user), dependencies[], expectedOutcome?,
successCriteria?, status (pending|ready|running|completed|failed|blocked).
Plan abstraction must not be search-specific. Plans version (v1 > v2...).

## 14-15. Structured decisions

AgentDecision: type (search|continue|replan|verify|ask_user|finish|abort),
toolCall?, expectedOutcome?, reason?. Model proposes, runtime validates:
schema > policy > budget > execution. Never free text to execution.

## 16-20. Tool contract, capability, registry, resolver, executor

AgentTool: id, name, version, description, capabilities[], inputSchema,
outputSchema, riskLevel (none|low|medium|high|critical),
execute(input, context), healthCheck?().

ToolCapability: SEARCH only at first. Registry: register/get/list/
findByCapability. Startup registers webSearchTool and nothing else.
Resolver maps SEARCH capability to a tool (never by concrete name).
ToolExecutor owns validation, policy, timeouts, cancellation, retries,
logging, metrics, normalization.

## 21-23. web.search I/O, provider abstraction, responsibilities

Input: query, limit?, domains?, freshness?, language?, region?.
Output: results[] of {title, url, snippet, source?, publishedAt?,
relevance?}.

WebSearchTool > WebSearchProvider > Provider. Provider replaceable
without agent changes. Tool validates, normalizes, calls, normalizes,
dedups obvious junk, returns structured results with metadata, reports
errors, respects timeout/cancellation, records metrics. Never judges
task completion.

## 24-26. Search strategy and pipeline

Iterative: query > results > gap analysis > follow-up > merge > evaluate.
Query types: discovery, specific, comparison, verification,
source-specific, freshness.

Pipeline: RAW > VALIDATE > NORMALIZE > DEDUPLICATE (URL, canonical,
domain, near-identical, syndicated) > RANK > EXTRACT EVIDENCE > STORE >
CONTEXT SELECTION.

## 27-29. Evidence, Observation, conflicts

Evidence: id, sourceType "web", url, title?, excerpt?, retrievedAt,
reliability?. Observation: id, type (fact|result|warning|error|
uncertainty), content, evidence[], timestamp. Tool Result > Observation
> interpretation. Conflicting claims become EvidenceConflict
(unresolved|resolved|reported): search again or report uncertainty.

## 30-32. Verification

VerificationEngine.verify(task, result). Asks "did we accomplish it",
not "does it sound good". Partial verification (4/5) is NOT COMPLETE:
recover > replan > search again, or clearly marked partial result.

## 33-35. Recovery, failures, retries

RecoveryEngine.recover(task, failure). Strategies: RETRY,
RETRY_WITH_BACKOFF, CHANGE_QUERY, SEARCH_AGAIN, REPLAN,
USE_ALTERNATIVE_PROVIDER (abstraction only at first), ASK_USER,
RETURN_PARTIAL, ABORT.

FailureType: INVALID_INPUT, INVALID_MODEL_OUTPUT, NETWORK_ERROR,
TIMEOUT, RATE_LIMIT, PROVIDER_ERROR, EMPTY_RESULTS,
LOW_QUALITY_RESULTS, VERIFICATION_FAILURE, POLICY_DENIED,
BUDGET_EXEEDED, CANCELLED, UNKNOWN.

RetryPolicy: maxAttempts, initialDelayMs, maxDelayMs,
backoffMultiplier. Never unbounded retry.

## 36. Budget (runtime-enforced, model cannot override)

Budget: maxSteps, maxSearches, maxRuntimeMs, maxModelCalls, maxRetries.
Example: maxSearches 10, maxSteps 20.

## 37-38. Context

AgentContext: objective, constraints, plan, currentStep?,
observations, evidence, unresolvedIssues, availableTools. Priority:
objective > success criteria > plan > current step > observations >
evidence > unresolved > previous decisions. Never append results
endlessly.

## 39-41. Model provider, responsibilities, runtime vs model

ModelProvider.generate(request). First one model; later small/strong/
local/cloud/specialist without runtime rewrites. MODEL is intelligence
and proposal (interpret, plan, query, interpret, decide, replan,
synthesize). RUNTIME is control and truth (state, permissions,
execution, budgets, timeouts, validation, persistence, verification,
recovery).

## 42. Task state machine (invalid transitions rejected)

QUEUED > PLANNING > RUNNING > VERIFYING > COMPLETED. Failure: RUNNING >
RECOVERING > RUNNING. Approval: RUNNING > PAUSED > RUNNING. Terminal:
COMPLETED, FAILED, CANCELLED.

## 43-45. Checkpoints, resume, idempotency

Checkpoint at: task/plan creation, plan update, step start, search
execution/result, observation, verification, recovery, completion.
Resume restores objective, plan, step, observations, evidence, budgets,
retries, verification state, then decides next (never blind repeat).
ToolExecutionContext: taskId, stepId, callId, idempotencyKey.

## 46-48. Events, audit, runs

AgentEvent: TaskCreated/Started, PlanCreated/Updated, StepStarted,
ToolCalled/Completed/Failed, ObservationCreated, VerificationStarted/
Completed, RecoveryStarted, CheckpointCreated, TaskCompleted/Failed.
Foundation for UI streaming. Keep a reconstructable audit trail and an
AgentRun record with metrics (model/search calls, retries, runtime,
tokens, verification failures).

## 49-50. Security

ToolPolicy.evaluate(task, tool, call). web.search is LOW RISK, allowed.
Secrets never in prompts, context, args, or logs: Tool > Credential
Provider > Secret. (Our mapping: search has no key; relay holds any
future provider secret.)

## 51. Project structure (adapted: browser JS, no TS build)

    agent/
      trace.js            pipeline visualization (this phase)
      trace.css
      types.js            Phase 0: domain contracts plus validation
      state-machine.js    Phase 0: task transitions
      tools.js            Phase 0: Tool interface, Registry, Resolver, Executor
      events.js           Phase 0: EventBus plus event constructors
      ... (planner, decision, context, observation, verification,
           recovery, budget, persistence per brief section 75 order)

Core must stay DOM-free so it runs under node for tests.

## 52-54. Phase 0, Phase 1, Phase 1 gate

Phase 0: define Task, Objective, Plan, PlanStep, AgentDecision,
AgentTool, ToolCall, ToolResult, Observation, Evidence,
VerificationResult, Failure, Budget, AgentEvent, ModelProvider. Test
serialization. No search yet.

Phase 1: web.search only (schema validation, provider adapter, timeout,
cancellation, normalized results, errors, metadata, health check,
structured ToolResult). Tested independent of the agent.

Phase 1 gate inputs: normal/empty/very long/special-char queries, no
results, many results, provider error, timeout, rate limit, malformed
response, duplicates, invalid params.

## 55-59. Phase 2-4 gates

Phase 2: Runtime > Registry > Resolver > Executor > web.search.
End-to-end: objective > plan > search > observation > answer. Must not
search once and stop. Test factual/multi-query/refinement/no-result and
poor-result recovery/extraction.

Phase 3: VerificationEngine. Test complete/incomplete/conflicting/
outdated/unsupported/insufficient results.

Phase 4: RecoveryEngine, then CheckpointStore, TaskRepository,
EventStore, EvidenceStore. Test crash > restart > resume > complete
with correct results.

## 60-62. Evaluation and promotion gate

Realistic benchmark (Easy/Medium/Hard/Ambiguous/Freshness/Comparison/
Multi-source/Conflict/No-result/Adversarial) as a permanent regression
suite. Metrics: accuracy, source quality, completeness, freshness,
query quality, wasted searches, verification/recovery success, latency,
cost, hallucination rate. NEXT TOOL stays LOCKED until unit,
integration, failure, recovery, resume, verification, benchmark, and
regression suites pass.

## 63-64. Second tool later (example: web.open)

Implement tool > register > schema > policy > tests > benchmark >
enable capability. No AgentRuntime changes. Driven by user friction,
not curiosity.

## 65-69. Future (not Phase 1)

Planner/Memory/Model Router/Scheduler evolution, optional tools,
sub-agents, long-term memory (distinct from task state), autonomy via
capability (not a flag).

## 70. Hard runtime invariants (enforced by code)

1. Model cannot directly execute tools. 2. Every call schema validated.
3. Every call passes policy. 4. Every call has task/step/call ID.
5. Every execution has a timeout. 6. Bounded retries. 7. Runtime
budgets. 8. Failures are structured. 9. Results become observations.
10. Evidence-backed claims need evidence. 11. Completion requires
verification when criteria require it. 12. State persisted apart from
history. 13. Cancellable. 14. Resumable. 15. Runtime has no concrete
tool dependency. 16. New tools need no core loop change. 17. No
fabricated execution. 18. Insufficient evidence means continue,
report uncertainty, or fail honestly.

## 71. Anti-patterns

No giant AgentEngine file. No `if (tool === "web.search")` spread
around. No LLM to arbitrary function execution. No history as task DB.
No unbounded loops. "LLM says done" is not verified completion. No
tools added for fun.

## 72. Runtime pseudocode (conceptual separation is mandatory)

Loop while non-terminal: check budget > build context > decide >
validate decision > finish (verify; pass ? complete : recover) >
replan (checkpoint) > search (resolve SEARCH > policy > execute >
observe > checkpoint > recover on failure) > ask_user (pause) >
abort (fail).

## 73-74. UX and observability

User sees: Understanding > Objective/Plan > Searching (results) >
evaluate > search again > Cross-checking > Verifying > RESULT plus
EVIDENCE plus UNCERTAINTIES. Debug UI exposes task, status, objective,
plan, step, calls, queries, results, observations, evidence,
verification, failures, retries, recovery, runtime, tokens. Structured
execution state, never private model reasoning.

## 75. Development order (exact)

1. Domain types. 2. Task state machine. 3. Tool interface. 4. Tool
registry. 5. Tool resolver. 6. Tool executor. 7. Web search provider.
8. WebSearchTool. 9. Objective interpreter. 10. Planner. 11. Decision
engine. 12. Context manager. 13. Observation processor. 14.
Verification engine. 15. Recovery engine. 16. Budget manager. 17.
Checkpointing. 18. Event system. 19. End-to-end tests. 20. Real-world
benchmark.

## 76. Final acceptance test

Complex objective > task > objective > criteria > plan > search >
normalize > evidence > gap found > refined query > second search >
compare > conflict handling > more search > verification passes >
answer > checkpoint > complete. Then break it: provider timeout
(retry/recover/continue), verification failure (replan/search/verify
again), crash (restart/resume/complete). Only then consider tool two.

## 77-78. Principle and first milestone

Build the agent brain and runtime once. Add capabilities incrementally.
Milestone one is a reliable research run (objective, re-search,
verify, recover, persist, grounded answer), not a plugin demo.
