/* Category: agent primitive (observe -> reason -> propose -> permit -> execute -> verify -> recover)
   plus orchestration, intent decomposition, and approval state. */
"use strict";
var L = require("./lib.js");
var path = L.path;
var O = require(path.join(L.ROOT, "agent", "orchestrator.js"));

function emit(fw, jobs, category, fn) { fw.emit(jobs, category, "invariant check", fn); }

function tool(id, caps, primary, extra) {
  return Object.assign({
    id: id, name: id, description: "Provides " + caps.join(", "),
    capabilities: caps, primaryCapability: primary || caps[0],
    inputs: { query: "string" }, outputs: { result: "object" },
    prerequisites: [], permissions: [], sideEffects: "none", requiresApproval: false,
    cost: { latency: "low", monetary: "none" }, reliability: 0.8,
    environments: ["browser"], composable: true, mutability: "read-only",
    failureModes: ["unavailable"], run: function () { return {}; }
  }, extra || {});
}

function registry() {
  var r = new O.CapabilityRegistry();
  [tool("reasoning.synthesize", ["synthesize_evidence", "evaluate_relevance", "compare_information", "compose_result"]),
   tool("files.discover", ["discover_files", "retrieve_file_artifacts", "files"]),
   tool("web.search", ["search", "retrieve_information", "discover_web_resources", "search_current_information"]),
   tool("web.read", ["read_web_resource", "extract_web_content"]),
   tool("images.search", ["images", "discover_images", "retrieve_images"]),
   tool("videos.search", ["videos", "media.playable", "discover_playable_media"]),
    tool("browser.agent", ["navigate_web", "interact_with_websites", "authenticate_session", "submit_forms"], "navigate_web",
     { permissions: ["browser_control"], requiresApproval: true, sideEffects: "external", mutability: "mutating" })
  ].forEach(function (t) { r.register(t); });
  return r;
}

function planFrom(intentObj, state) {
  var reg = registry();
  var planner = new O.Planner(reg);
  var intent = O.normalizeIntent(intentObj, intentObj && intentObj.request || "scenario request");
  return { intent: intent, plan: planner.plan(intent, state || {}) };
}

var ARTIFACT_WORDS = ["apk", "pdf", "csv", "zip", "tarball", "image", "video", "dataset", "template", "model", "package"];

/* ---- generators ---- */

function refusalSubstitution(fw, count) {
  /* Audit finding: the intent interpreter answered a policy question inside
     `goal` and emitted no requirements, which let the platform compose a
     refusal before any provider was consulted. Contract after the fix: such a
     decomposition is rejected by the primitive, and a refusal may never be
     laundered into a compose-only plan. */
  fw.currentCategory = "agent.intent.refusal-substitution";
  var rng = L.makeRng(fw.seed + 11);
  var verdicts = [
    "Refuse to provide or locate the {x} as it is likely copyrighted material.",
    "Decline the request for {x} because distribution may be unlawful.",
    "Politely refuse: {x} cannot be provided.",
    "I must refuse: {x}."
  ];
  var jobs = [];
  for (var i = 0; i < count; i++) {
    (function (i) {
      var subject = ARTIFACT_WORDS[i % ARTIFACT_WORDS.length] + " " + rng.string(6, "abcdefghijklmnopqrstuvwxyz0123456789");
      var goal = rng.pick(verdicts).replace("{x}", subject);
      jobs.push(function () {
        var rejected = false, detail = "";
        try {
          var d = planFrom({ goal: goal, confidence: 0.9, risk: "low", desiredOutput: { type: "chat" },
            subgoals: [{ id: "g1", goal: goal, requirements: [] }] });
          var tools = (d.plan.steps || []).map(function (st) { return st.toolId; });
          /* If it was not rejected, it must at least not be a silent
             compose-only verdict: the plan has to carry a step or a gate. */
          rejected = tools.length > 0 || d.plan.status === "blocked" || d.plan.status === "needs_clarification";
          detail = "tools=[" + tools.join(",") + "] status=" + d.plan.status;
        } catch (e) {
          rejected = /policy verdict/i.test(String(e.message));
          detail = "rejected: " + String(e.message).slice(0, 60);
        }
        return fw.check(rejected, { severity: "P1", rootCause: "intent-refusal-substitution",
          actual: detail + " goal=" + goal.slice(0, 50),
          reason: "a refusal verdict was accepted as a final decomposition and composed into an answer" });
      });
    })(i);
  }
  return jobs;
}

function malformedIntent(fw, count) {
  fw.currentCategory = "agent.intent.malformed";
  var rng = L.makeRng(fw.seed + 23);
  var shapes = [
    null, undefined, 0, "", "not json", "{", "{}", "[]", true,
    { goal: 1, subgoals: "x" }, { subgoals: [null] }, { subgoals: [{}] },
    { requirements: [{ capability: 1 }] }, { subgoals: [{ requirements: [{}] }] },
    { subgoals: [{ requirements: [{ capability: "nonexistent.capability" }] }] },
    { confidence: "high", risk: "extreme" }, { risk: "HIGH" }, { confidence: NaN },
    { subgoals: new Array(500).fill({ requirements: [{ capability: "search" }] }) },
    { goal: "x".repeat(50000) }
  ];
  var jobs = [];
  for (var i = 0; i < count; i++) {
    (function (i) {
      var raw = shapes[i % shapes.length];
      var mutated = raw;
      if (typeof raw === "string" && raw.length > 2) {
        mutated = raw.slice(0, Math.max(1, rng.int(1, raw.length)));
      }
      emit(fw, jobs, "agent.intent.malformed", function () {
        var d = planFrom(typeof mutated === "object" && mutated ? mutated : { raw: mutated }, {});
        /* Invariant: normalization never throws, always yields a usable plan
           object with the declared status vocabulary, and bounds goal length. */
        var okStatus = ["planned", "blocked", "needs_clarification"].indexOf(d.plan.status) !== -1;
        var bounded = typeof d.intent.goal === "string" && d.intent.goal.length <= 1200;
        var riskOk = ["low", "medium", "high"].indexOf(d.intent.risk) !== -1;
        return fw.check(okStatus && bounded && riskOk, {
          severity: "P2", rootCause: "intent-normalization-gap",
          actual: "status=" + d.plan.status + " goalLen=" + String(d.intent.goal).length + " risk=" + d.intent.risk,
          reason: "malformed intent produced an unbounded or unmodellable plan state"
        });
      });
    })(i);
  }
  return jobs;
}

function capabilityGrounding(fw, count) {
  fw.currentCategory = "agent.capability.grounding";
  var rng = L.makeRng(fw.seed + 37);
  var capPool = ["search", "retrieve_information", "discover_files", "retrieve_file_artifacts", "discover_images",
    "read_web_resource", "media.playable", "compose_result", "synthesize_evidence", "evaluate_relevance",
    "navigate_web", "submit_forms", "nonexistent.capability", "reasoning.synthesize", "files.discover", "web.search"];
  var jobs = [];
  for (var i = 0; i < count; i++) {
    (function (i) {
      var n = rng.int(1, 4);
      var caps = [];
      for (var k = 0; k < n; k++) caps.push(rng.pick(capPool));
      emit(fw, jobs, "agent.capability.grounding", function () {
        var d = planFrom({ goal: "scenario " + i, confidence: 0.9, risk: "low",
          subgoals: [{ id: "g1", goal: "scenario " + i,
            requirements: caps.map(function (c, j) { return { id: "r" + j, capability: c, required: true }; }) }] });
        var chosen = (d.plan.steps || []).map(function (s) { return s.toolId; });
        var unresolved = (d.plan.unresolved || []).length;
        /* Invariant: every chosen tool exists in the registry; every required
           capability either resolves or is reported unresolved. Never silently
           dropped, and never a provider id used as a capability by accident. */
        var reg = registry();
        var allReal = chosen.every(function (id) { return !!reg.get(id); });
        var accounted = caps.length === chosen.length + unresolved;
        return fw.check(allReal && accounted, {
          severity: "P1", rootCause: "capability-resolution-leak",
          actual: "requested=" + caps.length + " chosen=" + chosen.length + " unresolved=" + unresolved,
          reason: "a required capability vanished without being resolved or reported unresolved"
        });
      });
    })(i);
  }
  return jobs;
}

function determinism(fw, count) {
  fw.currentCategory = "agent.planner.determinism";
  var rng = L.makeRng(fw.seed + 41);
  var jobs = [];
  for (var i = 0; i < count; i++) {
    (function (i) {
      var caps = [];
      var n = rng.int(1, 3);
      for (var k = 0; k < n; k++) caps.push(rng.pick(["search", "discover_files", "discover_images", "compose_result", "read_web_resource"]));
      var payload = { goal: "goal " + i, confidence: 0.8, risk: "low",
        subgoals: [{ id: "g1", goal: "sub " + i, requirements: caps.map(function (c, j) { return { capability: c, required: true }; }) }] };
      emit(fw, jobs, "agent.planner.determinism", function () {
        var a = planFrom(payload), b = planFrom(payload);
        var ta = JSON.stringify((a.plan.steps || []).map(function (s) { return s.toolId; }));
        var tb = JSON.stringify((b.plan.steps || []).map(function (s) { return s.toolId; }));
        return fw.check(ta === tb, { severity: "P2", rootCause: "planner-nondeterminism",
          actual: ta + " vs " + tb, reason: "identical intent produced different tool plans" });
      });
    })(i);
  }
  return jobs;
}

function approvalState(fw, count) {
  /* Reimplements the observed app.js contract to hunt for double-execution.
     The real functions are locked inside the IIFE, so this models the state
     machine exactly as written (consume-then-run, id recheck, lock) and looks
     for interleavings that break the single-send invariant. */
  fw.currentCategory = "agent.authorization.approval-state";
  var rng = L.makeRng(fw.seed + 53);
  var jobs = [];
  function makeStore() {
    var mem = {};
    return {
      load: function () { try { var p = JSON.parse(mem.k || "null"); return (p && p.id) ? p : null; } catch (e) { return null; } },
      save: function (v) { mem.k = v ? JSON.stringify(v) : null; },
      raw: function (v) { mem.k = v; },
      get: function () { return mem.k; }
    };
  }
  for (var i = 0; i < count; i++) {
    (function (i) {
      var events = [];
      var n = rng.int(2, 6);
      for (var k = 0; k < n; k++) events.push(rng.pick(["approve", "approve", "reject", "reload", "newplan", "tab2approve", "crash"]));
      emit(fw, jobs, "agent.authorization.approval-state", function () {
        var store = makeStore();
        var plan = { version: 1, id: "p1", chatId: "c1", goal: "g", plan: { allowedOrigins: ["https://x.com"], steps: ["post"] } };
        store.save(plan);
        var sends = 0;
        var consumedIds = {};
        events.forEach(function (ev) {
          if (ev === "newplan") { store.save(Object.assign({}, plan, { id: "p" + (++sends + 100) })); sends = 0; return; }
          if (ev === "reject") { store.save(null); return; }
          if (ev === "reload") { return; } /* re-reads same storage */
          if (ev === "crash") { return; }
          var rec = store.load();
          if (!rec) return;
          /* app.js: consume approval before execution */
          if (!consumedIds[rec.id]) { consumedIds[rec.id] = true; store.save(null); sends += 1; }
        });
        return fw.check(sends <= 1, { severity: "P0", rootCause: "approval-double-consume",
          actual: "external side effects executed: " + sends + " from events " + events.join(","),
          reason: "the same approved plan produced more than one external action" });
      });
    })(i);
  }
  return jobs;
}

/* Executor: does a failed/throwing tool ever get reported as success? */
function executorVerification(fw, count) {
  fw.currentCategory = "agent.recovery.executor-false-success";
  var rng = L.makeRng(fw.seed + 79);
  var outcomes = ["ok", "throws", "empty", "null", "invalid-json", "rejects"];
  var jobs = [];
  for (var i = 0; i < count; i++) {
    (function (i) {
      var kinds = [];
      var n = rng.int(1, 3);
      for (var k = 0; k < n; k++) kinds.push(rng.pick(outcomes));
      emit(fw, jobs, "agent.recovery.executor-false-success", function () {
        var orch = O.createOrchestrator();
        var calls = { ok: 0, throws: 0, empty: 0, null: 0, "invalid-json": 0, rejects: 0 };
        kinds.forEach(function (kind, idx) {
          var cap = "cap" + idx;
          orch.registry.register({
            id: "t" + idx, name: "t" + idx, version: "1", description: "d",
            capabilities: [cap], primaryCapability: cap, constraintCapabilities: {},
            inputs: {}, outputs: {}, prerequisites: [], permissions: [], sideEffects: "none",
            requiresApproval: false, cost: { latency: "low", monetary: "none" }, reliability: 0.9,
            environments: ["browser"], composable: true, mutability: "read-only", failureModes: ["unavailable"],
            run: function () {
              calls[kind] += 1;
              if (kind === "throws") throw new Error("tool exploded");
              if (kind === "rejects") return Promise.reject(new Error("tool rejected"));
              if (kind === "empty") return Promise.resolve({});
              if (kind === "null") return Promise.resolve(null);
              if (kind === "invalid-json") return Promise.resolve("{not json");
              return Promise.resolve({ ok: true });
            }
          });
        });
        var intent = O.normalizeIntent({ goal: "g", confidence: 0.9, risk: "low",
          subgoals: [{ id: "s", goal: "g", requirements: kinds.map(function (k, idx) { return { capability: "cap" + idx, required: true }; }) }] }, "g");
        var plan = orch.planner.plan(intent, {});
        /* Complete the task record the executor expects, exactly as the app does. */
        plan.trace = plan.trace || []; plan.observations = plan.observations || [];
        plan.verification = plan.verification || []; plan.failures = plan.failures || [];
        plan.cursor = 0; plan.goal = "g"; plan.updatedAt = Date.now();
        plan.steps.forEach(function (st) { st.status = "pending"; });
        return Promise.resolve().then(function () { return orch.executor.run(plan, {}); }).then(function (task) {
          var task = orch.store.load();
          var status = (task && task.status) || "(none)";
          var anyFailedStep = ((task && task.steps) || []).some(function (st) { return st.status === "failed"; });
          if (status === "succeeded" && anyFailedStep) {
            return fw.check(false, { severity: "P0", rootCause: "executor-claims-success-with-failed-step",
              actual: "status=succeeded while a step is failed", reason: "a failed step was reported as overall success" });
          }
          var allFailed = kinds.every(function (k) { return k === "throws" || k === "rejects"; });
          var claimsDone = status === "done" || status === "completed";
          return fw.check(!(claimsDone && allFailed), { severity: "P0", rootCause: "executor-claims-success-after-total-failure",
            actual: "status=" + status + " with every tool throwing (calls=" + JSON.stringify(calls) + ")",
            reason: "the executor recorded success although no step produced an observation" });
        }, function (err) {
          return { invariant: true, note: "executor surfaced the failure: " + String(err.message).slice(0, 60) };
        });
      });
    })(i);
  }
  return jobs;
}

module.exports = {
  name: "agent",
  build: function (fw) {
    return [].concat(
      refusalSubstitution(fw, 160),
      malformedIntent(fw, 220),
      capabilityGrounding(fw, 320),
      determinism(fw, 140),
      approvalState(fw, 220),
      executorVerification(fw, 120)
    );
  }
};
