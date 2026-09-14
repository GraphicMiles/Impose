/* Intent/capability orchestration regressions. Run: node agent/tests/orchestrator.js */
"use strict";
var O = require("../orchestrator.js");
var tests = [];
function test(name, fn) { tests.push([name, fn]); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "not equal") + "\n" + JSON.stringify(a) + " !== " + JSON.stringify(b)); }
function tool(id, capabilities, run, extra) {
  return Object.assign({ id: id, name: id, description: "Provides " + capabilities.join(", "),
    capabilities: capabilities, inputs: {}, outputs: { result: "object" }, prerequisites: [], permissions: [],
    sideEffects: "none", requiresApproval: false, cost: { latency: "low", monetary: "none" }, reliability: 0.8,
    environments: ["browser"], composable: true, mutability: "read-only", failureModes: ["unavailable"], run: run }, extra || {});
}
function intent(goal, requirements, extra) {
  return O.normalizeIntent(Object.assign({ goal: goal, confidence: 0.95, risk: "low", constraints: {},
    desiredOutput: { type: "chat" }, successCriteria: ["requested outcome verified"],
    subgoals: [{ id: "g1", goal: goal, requirements: requirements.map(function (capability, i) {
      return { id: "r" + i, capability: capability, required: true, successCriterion: capability + " verified" };
    }) }] }, extra || {}), goal);
}

test("substantially different phrasings resolve to the same capability", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("current-info", ["search_current_information"], function () { return {}; }));
  function semantic() { return JSON.stringify(intent("discover current hiring", ["search_current_information"])); }
  var a = await orch.interpret({ request: "Can you see who is hiring right now?", interpreter: semantic });
  var b = await orch.interpret({ request: "Look around for firms currently taking on developers.", interpreter: semantic });
  eq(a.plan.steps.map(function (s) { return s.toolId; }), b.plan.steps.map(function (s) { return s.toolId; }));
});

test("planner composes multiple tools without a named scenario", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("discover", ["discover_records"], function () { return { rows: [1] }; }));
  orch.registry.register(tool("rank", ["evaluate_relevance"], function () { return { ranked: [1] }; }));
  orch.registry.register(tool("deliver", ["compose_result"], function () { return { answer: "done" }; }));
  var plan = orch.planner.plan(intent("novel composed outcome", ["discover_records", "evaluate_relevance", "compose_result"]));
  eq(plan.steps.map(function (s) { return s.toolId; }), ["discover", "rank", "deliver"]);
  eq(plan.steps[2].dependsOn, ["step-2"]);
});

test("registering capability metadata makes a new tool discoverable", function () {
  var registry = new O.CapabilityRegistry();
  registry.register(tool("pdf.analyze", ["extract_pdf_tables"], function () { return {}; }));
  eq(registry.discover("extract_pdf_tables", { environment: "browser" }).map(function (x) { return x.tool.id; }), ["pdf.analyze"]);
});

test("provider id in structured capability field is repaired through metadata", function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("videos.search", ["discover_playable_media", "verify_live_status"], function () { return {}; },
    { primaryCapability: "discover_playable_media" }));
  var parsed = intent("find current live media", ["videos.search"], { constraints: { live: true } });
  var plan = orch.planner.plan(parsed);
  eq(plan.status, "planned");
  eq(plan.steps[0].toolId, "videos.search");
  eq(plan.steps[0].capability, "discover_playable_media");
  eq(parsed.subgoals[0].requirements[0].capability, "discover_playable_media");
  ok(plan.trace[1].decisions[0].repair.fromProviderId === "videos.search");
});

test("typed constraints expand verification requirements through metadata", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("videos.search", ["discover_playable_media", "verify_live_status"], function () { return {}; },
    { primaryCapability: "discover_playable_media", constraintCapabilities: { live: "verify_live_status" } }));
  var decision = await orch.interpret({ request: "Find current broadcasts", interpreter: function () {
    return intent("find current broadcasts", ["videos.search"], { constraints: { live: true } });
  } });
  eq(decision.intent.subgoals[0].requirements.map(function (r) { return r.capability; }),
    ["discover_playable_media", "verify_live_status"]);
  eq(decision.plan.steps.map(function (s) { return s.toolId; }), ["videos.search", "videos.search"]);
});

test("tool names in user text do not select irrelevant tools", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("email", ["send_message"], function () { throw new Error("must not run"); }, { reliability: 0.99 }));
  orch.registry.register(tool("reader", ["read_file"], function () { return { text: "x" }; }));
  var decision = await orch.interpret({ request: "The email tool is broken; summarize this file.",
    interpreter: function () { return intent("summarize supplied file", ["read_file"]); } });
  eq(decision.plan.steps.map(function (s) { return s.toolId; }), ["reader"]);
});

test("failed preferred provider recovers through an alternative", async function () {
  var orch = O.createOrchestrator(), calls = [];
  orch.registry.register(tool("primary", ["lookup"], function () { calls.push("primary"); throw new Error("down"); }, { reliability: 0.95 }));
  orch.registry.register(tool("fallback", ["lookup"], function () { calls.push("fallback"); return { rows: [1] }; },
    { reliability: 0.8, verify: function (out) { return { ok: out.rows.length === 1, evidence: "one row" }; } }));
  var task = orch.planner.plan(intent("look up data", ["lookup"]));
  var done = await orch.executor.run(task);
  eq(calls, ["primary", "fallback"]); eq(done.status, "succeeded");
  ok(done.trace.some(function (x) { return x.type === "replan" && x.nextTool === "fallback"; }));
});

test("successful invocation is not successful completion without verification", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("sender", ["deliver"], function () { return { accepted: true }; },
    { verify: function () { return { ok: false, reason: "provider supplied no message id" }; } }));
  var done = await orch.executor.run(orch.planner.plan(intent("deliver item", ["deliver"])));
  eq(done.status, "failed");
  ok(done.failures[0].error.indexOf("message id") !== -1);
});

test("verification failure can replan to another provider", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("weak", ["download"], function () { return { ok: true }; },
    { reliability: 0.9, verify: function () { return { ok: false, reason: "file absent" }; } }));
  orch.registry.register(tool("strong", ["download"], function () { return { path: "/file" }; },
    { reliability: 0.8, verify: function (out) { return { ok: out.path === "/file", evidence: out.path }; } }));
  var done = await orch.executor.run(orch.planner.plan(intent("obtain file", ["download"])));
  eq(done.status, "succeeded"); eq(done.steps[0].toolId, "strong");
});

test("active task and failures are supplied to semantic understanding", async function () {
  var orch = O.createOrchestrator(), seen = "";
  orch.registry.register(tool("jobs", ["filter_records"], function () { return {}; }));
  await orch.interpret({ request: "Only remote ones", context: "user: Find roles", activeTask: { id: "task-old", goal: "find roles" },
    previousFailures: [{ tool: "old-search", error: "timeout" }], interpreter: function (prompt) {
      seen = prompt; return intent("refine existing role search", ["filter_records"], { continuationOf: "task-old" });
    } });
  ok(seen.indexOf("task-old") !== -1 && seen.indexOf("timeout") !== -1);
});

test("low-confidence risky intent asks for clarification", function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("delete", ["delete_files"], function () { return {}; },
    { sideEffects: "destructive", mutability: "mutating", requiresApproval: true }));
  var plan = orch.planner.plan(intent("delete old files", ["delete_files"], {
    confidence: 0.35, risk: "high", clarification: "Which directory and what age counts as old?" }));
  eq(plan.status, "needs_clarification");
});

test("high-risk side effects wait for approval and then verify", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("message.send", ["send_message"], function () { return { messageId: "m1", recipient: "professor" }; },
    { sideEffects: "external", mutability: "mutating", requiresApproval: true, permissions: ["send_message"],
      verify: function (out) { return { ok: !!out.messageId && out.recipient === "professor", evidence: out.messageId }; } }));
  var plan = orch.planner.plan(intent("send prepared note", ["send_message"], { risk: "high" }),
    { environment: "browser", permissions: ["send_message"] });
  eq(plan.status, "needs_approval");
  var waiting = await orch.executor.run(plan, { approvedSteps: [] }); eq(waiting.status, "needs_approval");
  var done = await orch.executor.run(waiting, { approvedSteps: ["step-1"] }); eq(done.status, "succeeded");
});

test("task state is checkpointed and inspectable across failure", async function () {
  var store = new O.MemoryTaskStore(), orch = O.createOrchestrator({ store: store });
  orch.registry.register(tool("broken", ["work"], function () { throw new Error("network offline"); }));
  var done = await orch.executor.run(orch.planner.plan(intent("perform work", ["work"])));
  eq(done.status, "failed"); eq(store.load().status, "failed");
  ok(store.load().trace.some(function (x) { return x.type === "tool_failure"; }));
});

test("developer trace exposes intent, candidates, plan, observations and verification", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("source", ["inspect"], function () { return { value: 1 }; },
    { verify: function (out) { return { ok: out.value === 1, evidence: "value=1" }; } }));
  var task = orch.planner.plan(intent("inspect value", ["inspect"], { rationale: "Need current value" }));
  var done = await orch.executor.run(task);
  ok(done.trace.some(function (x) { return x.type === "intent"; }));
  ok(done.trace.some(function (x) { return x.type === "resolution"; }));
  ok(done.trace.some(function (x) { return x.type === "tool_start"; }));
  ok(done.trace.some(function (x) { return x.type === "verified"; }));
  ok(done.observations.length === 1 && done.verification.length === 1);
});

(async function () {
  var pass = 0;
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i][1](); console.log("PASS: " + tests[i][0]); pass++; }
    catch (error) { console.error("FAIL: " + tests[i][0] + "\n" + (error && error.stack || error)); }
  }
  console.log(pass + " passed, " + (tests.length - pass) + " failed");
  if (pass !== tests.length) process.exit(1);
})();
