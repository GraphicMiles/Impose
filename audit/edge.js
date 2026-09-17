/* Category: edge, 5000 seeded edge-case prompts, ambiguous follow-ups,
   unforeseen requests, hostile interpreter outputs, execution failures and
   persistence corruption, driven through the real orchestrator primitives.
   Deterministic: same seed, same 5000 scenarios, same verdicts. */
"use strict";
var L = require("./lib.js");
var O = require(L.path.join(L.ROOT, "agent", "orchestrator.js"));

var name = "edge";

function tool(id, caps, extra) {
  return Object.assign({
    id: id, name: id, description: "Provides " + caps.join(", "),
    capabilities: caps, primaryCapability: caps[0],
    inputs: { query: "string" }, outputs: { result: "object" },
    prerequisites: [], permissions: [], sideEffects: "none", requiresApproval: false,
    cost: { latency: "low", monetary: "none" }, reliability: 0.8,
    environments: ["browser"], composable: true, mutability: "read-only",
    failureModes: ["unavailable"], run: function () { return Promise.resolve({ rows: [1] }); }
  }, extra || {});
}

function registry() {
  var r = new O.CapabilityRegistry();
  [tool("web.search", ["search", "search_current_information", "discover_web_resources"]),
   tool("web.read", ["read_web_resource", "extract_web_content"]),
   tool("images.search", ["images", "discover_images"]),
   tool("files.discover", ["discover_files", "retrieve_file_artifacts"]),
   tool("videos.search", ["videos", "media.playable", "discover_playable_media",
     "verify_media_recency", "verify_live_status"], {
     primaryCapability: "discover_playable_media",
     constraintCapabilities: { live: "verify_live_status", latest: "verify_media_recency" } }),
   tool("reasoning.synthesize", ["synthesize_evidence", "compose_result"]),
   tool("browser.agent", ["navigate_web", "submit_forms"], {
     permissions: ["browser_control"], requiresApproval: true, sideEffects: "external", mutability: "mutating" })
  ].forEach(function (t) { r.register(t); });
  return r;
}

function orchestrator() {
  return O.createOrchestrator({ registry: registry() });
}

function okStatus(task) { return O.TASK_STATES.indexOf(task.status) !== -1; }

/* ---------------- prompt pools ---------------- */
var AMBIGUOUS = [
  "something for my project", "that thing we talked about", "help me with stuff",
  "you know, the usual", "idk maybe icons?", "free??", "the other one", "cheaper pls",
  "again but better", "hmm", "wait no", "asap ok", "for my friend", "something legal and free",
  "whatever works", "not sure yet", "can you do the thing", "more of that", "less corporate",
  "my boss wants it today", "the good kind", "proper one", "small but good", "quick look?",
  "necesito iconos free", "icônes svg gratuites", "アイコン free", "svg iconen gratis",
  "brauche ich was dafür?", "does it even exist", "is that possible?", "why not both",
  "🎨✨?", "…?", "ok?", "pls", "ty in advance", "no rush but actually rush",
  "the one everyone uses", "not the famous one", "obscure but reliable", "something nobody knows",
  "for a school thing", "client demo tmrw", "side project, no budget", "startup, pre-seed",
  "check if it's safe", "is this legit?", "should I trust it", "vet it for me",
  "make it offline", "works without internet?", "portable version?", "self-hosted maybe"
];
var FOLLOWUPS = [
  "the first one", "no, the other", "again but live", "just the free ones", "cheaper",
  "smaller file", "send it to me", "now the second topic", "skip that, do the video",
  "ok and the license?", "more like that", "not that one", "same but newer", "older version",
  "without the watermark", "higher quality", "the thread, not the post", "author's own page",
  "only official sources", "exclude forums", "include forums actually", "translate the answer",
  "summarize it instead", "give me five", "just one is fine", "wait, is it really free?",
  "does it need signup?", "no signup ones", "works in nigeria?", "local mirror?"
];
var CAPS = ["search_current_information", "discover_images", "discover_files",
  "discover_playable_media", "read_web_resource", "compose_result"];

function ambiguousIntent(rng, request) {
  var requirementCount = rng.pick([0, 1, 1, 2]);
  var confidence = rng.pick([0.2, 0.4, 0.55, 0.7, 0.9, 0.97]);
  var risk = rng.pick(["low", "low", "medium", "high"]);
  var intent = {
    goal: request, confidence: confidence, risk: risk, constraints: {},
    desiredOutput: { type: "chat" }, successCriteria: ["requested outcome verified"],
    assumptions: [], subgoals: []
  };
  if (confidence < 0.5 && rng.bool(0.8)) intent.clarification = rng.pick([
    "Which format do you need?", "Free as in price, or free as in license?",
    "Which of the two topics should I start with?"]);
  var requirements = [];
  for (var i = 0; i < requirementCount; i++) {
    requirements.push({ id: "r" + i, capability: rng.pick(CAPS), required: true,
      inputs: { query: request }, successCriterion: "capability verified" });
  }
  if (requirements.length) intent.subgoals = [{ id: "g1", goal: request, requirements: requirements }];
  return intent;
}

function safe(fn) {
  return function () {
    return Promise.resolve().then(fn).then(function (value) { return value; },
      function (error) {
        return { invariant: false, actual: String((error && error.message) || error).slice(0, 200),
          reason: "scenario shape rejected instead of settling", rootCause: "shape-rejected" };
      });
  };
}

function build(fw) {
  var jobs = [];
  var rng = L.makeRng(fw.seed + 5000);

  /* ---------- A: 1200 ambiguous single-turn prompts ---------- */
  for (var a = 0; a < 1200; a++) {
    (function (i) {
      var request = rng.pick(AMBIGUOUS) + (rng.bool(0.3) ? " " + rng.string(rng.int(0, 14)) : "");
      fw.emit(jobs, "edge.ambiguous-prompt", "ambiguous prompt flows to a bounded verdict", function () {
        var orch = orchestrator();
        var calls = 0;
        orch.registry.register(Object.assign(tool("counted", ["count_probe"]), {
          run: function () { calls++; return Promise.resolve({ rows: [1] }); }
        }));
        var local = L.makeRng(fw.seed + 7000 + i);
        return orch.interpret({
          request: request,
          interpreter: function () { return JSON.stringify(ambiguousIntent(local, request)); }
        }).then(function (decision) {
          var plan = decision.plan;
          if (!okStatus(plan)) return fw.check(false, { actual: plan.status, reason: "plan status outside lifecycle", rootCause: "invalid-status" });
          if (plan.status === "needs_clarification") {
            return orch.executor.run(plan, {}).then(function (task) {
              return fw.check(task.status === "needs_clarification" && calls === 0,
                { actual: task.status + "/" + calls, reason: "clarification must pause without executing", rootCause: "clarification-executes" });
            });
          }
          return orch.executor.run(plan, {}).then(function (task) {
            if (!okStatus(task)) return fw.check(false, { actual: task.status, reason: "final status outside lifecycle", rootCause: "invalid-status" });
            var approvalLeak = plan.steps.some(function (s) { return s.requiresApproval; }) &&
              task.status !== "needs_approval" && task.status !== "succeeded" && task.status !== "partial" && task.status !== "failed";
            return fw.check(!approvalLeak && decision.intent.goal.length <= 1200,
              { actual: task.status, reason: "approval or contract bound violated", rootCause: "approval-leak" });
          });
        });
      });
    })(a);
  }

  /* ---------- B: 1200 ambiguous follow-up chains ---------- */
  for (var b = 0; b < 1200; b++) {
    (function (i) {
      var local = L.makeRng(fw.seed + 9000 + i);
      var turns = local.int(2, 4);
      var first = local.pick(AMBIGUOUS);
      fw.emit(jobs, "edge.followup-chain", "follow-up chain resolves from active task without wording routing", function () {
        var orch = orchestrator();
        var activeTask = null;
        var chain = Promise.resolve();
        for (var t = 0; t < turns; t++) {
          (function (turn) {
            chain = chain.then(function () {
              var request = turn === 0 ? first : local.pick(FOLLOWUPS);
              var wantsLive = turn > 0 && local.bool(0.35);
              var wantsCount = turn > 0 && local.bool(0.25) ? local.int(2, 5) : 0;
              return orch.interpret({
                request: request,
                activeTask: activeTask,
                context: turn === 0 ? "" : "previous turn asked: " + first,
                interpreter: function () {
                  var intent = ambiguousIntent(local, request);
                  if (wantsLive && intent.subgoals.length) {
                    intent.subgoals[0].requirements[0].capability = "discover_playable_media";
                  }
                  if (!intent.subgoals.length) {
                    intent.subgoals = [{ id: "g1", goal: request, requirements: [{ id: "r0",
                      capability: "discover_playable_media", required: true, inputs: { query: request },
                      successCriterion: "playable verified" }] }];
                  }
                  if (wantsLive) intent.constraints.live = true;
                  if (wantsCount) intent.desiredOutput = { type: "list", count: wantsCount };
                  if (turn > 0) intent.continuationOf = activeTask ? activeTask.id : "";
                  return JSON.stringify(intent);
                }
              }).then(function (decision) {
                activeTask = decision.plan;
                if (!okStatus(activeTask)) throw new Error("invalid status " + activeTask.status);
                if (activeTask.status === "needs_clarification" || activeTask.status === "blocked") return activeTask;
                return orch.executor.run(activeTask, {}).then(function (task) {
                  activeTask = task;
                  if (wantsLive && task.steps.length) {
                    var hasLiveStep = task.steps.some(function (s) { return s.capability === "verify_live_status"; });
                    if (!hasLiveStep) throw new Error("live constraint did not expand a verification step");
                  }
                  return task;
                });
              });
            });
          })(t);
        }
        return chain.then(function (task) {
          return fw.check(okStatus(task), { actual: task && task.status, reason: "chain ended outside lifecycle", rootCause: "invalid-status" });
        }, function (error) {
          return fw.check(false, { actual: String(error && error.message).slice(0, 160), reason: "chain threw", rootCause: "chain-threw" });
        });
      });
    })(b);
  }

  /* ---------- C: 1000 hostile or malformed interpreter outputs ---------- */
  var hostile = [
    function malformedOnce(orch, i) {
      var good = JSON.stringify(ambiguousIntent(L.makeRng(i), "find icons"));
      var calls = 0;
      return orch.interpret({ request: "find icons", interpreter: function () {
        calls++; return calls === 1 ? "{not valid json" : good;
      } }).then(function (d) {
        return fw.check(calls === 2 && d.plan.status !== "", { actual: calls, reason: "bounded repair must run exactly once", rootCause: "repair-count" });
      });
    },
    function malformedAlways(orch, i) {
      return orch.interpret({ request: "x", interpreter: function () { return "nope"; } })
        .then(function () { return fw.check(false, { actual: "resolved", reason: "double-malformed must reject", rootCause: "no-reject" }); },
          function () { return fw.check(true); });
    },
    function jsonArray(orch) {
      return orch.interpret({ request: "x", interpreter: function () { return "[]"; } })
        .then(function () { return fw.check(false, { actual: "resolved", reason: "array intent must reject", rootCause: "no-reject" }); },
          function () { return fw.check(true); });
    },
    function policyVerdict(orch) {
      var verdict = JSON.stringify({ goal: "I cannot provide copyrighted icons.", confidence: 0.9, risk: "low", subgoals: [] });
      return orch.interpret({ request: "pirated icons", interpreter: function () { return verdict; } })
        .then(function () { return fw.check(false, { actual: "resolved", reason: "policy verdict must reject", rootCause: "verdict-accepted" }); },
          function () { return fw.check(true); });
    },
    function policyVerdictWithClarification(orch) {
      var verdict = JSON.stringify({ goal: "I cannot provide that.", clarification: "Which license do you need?", confidence: 0.4, risk: "medium", subgoals: [] });
      return orch.interpret({ request: "grey-area icons", interpreter: function () { return verdict; } })
        .then(function (d) { return fw.check(d.plan.status === "needs_clarification", { actual: d.plan.status, reason: "clarification is a legitimate outcome", rootCause: "clarification-dropped" }); });
    },
    function unknownCapability(orch) {
      var intent = JSON.stringify({ goal: "teleport a file", confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: "teleport", requirements: [{ capability: "teleport.matter", required: true }] }] });
      return orch.interpret({ request: "teleport", interpreter: function () { return intent; } })
        .then(function (d) { return fw.check(d.plan.status === "blocked", { actual: d.plan.status, reason: "unknown capability must block", rootCause: "unknown-capability-ran" }); });
    },
    function providerIdInCapability(orch) {
      var intent = JSON.stringify({ goal: "live stream", confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: "live", requirements: [{ capability: "videos.search", required: true }] }] });
      return orch.interpret({ request: "live stream", interpreter: function () { return intent; } })
        .then(function (d) { return fw.check(d.plan.steps[0] && d.plan.steps[0].capability === "discover_playable_media",
          { actual: d.plan.steps[0] && d.plan.steps[0].capability, reason: "provider id must repair to primary capability", rootCause: "repair-missing" }); });
    },
    function stringRequirements(orch) {
      var intent = JSON.stringify({ goal: "search then compose", confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: "g", requirements: ["search_current_information", "compose_result"] }] });
      return orch.interpret({ request: "s", interpreter: function () { return intent; } })
        .then(function (d) { return fw.check(d.plan.steps.length === 2, { actual: d.plan.steps.length, reason: "string requirements must normalize", rootCause: "string-req" }); });
    },
    function wildScalars(orch) {
      var intent = JSON.stringify({ goal: "g", confidence: "0.8", risk: "extreme",
        budget: { maxAppendedSteps: "4", maxQueryRewrites: -1, maxProviderAttempts: 99 },
        subgoals: [{ id: "g1", goal: "g", requirements: ["search_current_information"] }] });
      return orch.interpret({ request: "s", interpreter: function () { return intent; } })
        .then(function (d) {
          var bgt = d.intent.budget;
          return fw.check(d.intent.confidence === 0.8 && d.intent.risk === "medium" &&
            bgt.maxAppendedSteps === 4 && bgt.maxQueryRewrites === 2 && bgt.maxProviderAttempts === 6,
            { actual: JSON.stringify(bgt), reason: "scalars must clamp", rootCause: "scalar-clamp" });
        });
    },
    function hugeGoal(orch) {
      var big = new Array(30000).join("a");
      var intent = JSON.stringify({ goal: big, confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: big, requirements: ["search_current_information"] }] });
      return orch.interpret({ request: big, interpreter: function () { return intent; } })
        .then(function (d) { return fw.check(d.intent.goal.length <= 1200, { actual: d.intent.goal.length, reason: "goal must cap", rootCause: "goal-cap" }); })
        .then(function () {
          /* Beyond the 100k interpreter ceiling the payload truncates; the
             contract is a bounded repair and a clean rejection, not a hang. */
          var monster = new Array(60000).join("a");
          var huge = JSON.stringify({ goal: monster, confidence: 0.9, risk: "low",
            subgoals: [{ id: "g1", goal: monster, requirements: ["search_current_information"] }] });
          var calls = 0;
          return orch.interpret({ request: "x", interpreter: function () { calls++; return huge; } })
            .then(function () { return fw.check(false, { actual: "resolved", reason: "oversized payload must reject", rootCause: "oversize-resolved" }); },
              function () { return fw.check(calls === 2, { actual: calls, reason: "oversized payload gets exactly one bounded repair", rootCause: "oversize-repair" }); });
        });
    },
    function unicodeGoal(orch) {
      var intent = JSON.stringify({ goal: "图标 🎨rtl שלום", confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: "图标", requirements: ["discover_images"] }] });
      return orch.interpret({ request: "图标 🎨", interpreter: function () { return intent; } })
        .then(function (d) { return fw.check(d.plan.status === "planned", { actual: d.plan.status, reason: "unicode must plan", rootCause: "unicode" }); });
    },
    function manyRequirements(orch) {
      var reqs = [];
      for (var i = 0; i < 120; i++) reqs.push({ capability: "search_current_information", required: true });
      var intent = JSON.stringify({ goal: "many", confidence: 0.9, risk: "low", subgoals: [{ id: "g1", goal: "many", requirements: reqs }] });
      return orch.interpret({ request: "many", interpreter: function () { return intent; } })
        .then(function (d) { return orch.executor.run(d.plan, {}); })
        .then(function (task) { return fw.check(task.status === "succeeded" && task.steps.length === 120,
          { actual: task.status + "/" + task.steps.length, reason: "wide plan must complete", rootCause: "wide-plan" }); });
    },
    function emptyIntent(orch) {
      return orch.interpret({ request: "", interpreter: function () { return JSON.stringify({ goal: "chat reply", confidence: 0.9, risk: "low", subgoals: [] }); } })
        .then(function (d) { return orch.executor.run(d.plan, {}); })
        .then(function (task) { return fw.check(task.status === "succeeded" && task.steps.length === 0 && task.outcome.satisfied === true,
          { actual: task.status, reason: "conversational no-requirement task settles clean", rootCause: "empty-intent" }); });
    },
    function clarificationOnly(orch) {
      var intent = JSON.stringify({ goal: "ambiguous", clarification: "Which one?", confidence: 0.3, risk: "high", subgoals: [] });
      return orch.interpret({ request: "that one", interpreter: function () { return intent; } })
        .then(function (d) { return fw.check(d.plan.status === "needs_clarification", { actual: d.plan.status, reason: "clarification gate", rootCause: "clarification" }); });
    },
    function duplicateTool(orch) {
      var threw = false;
      try { orch.registry.register(tool("web.search", ["dup_cap"])); } catch (e) { threw = true; }
      return Promise.resolve(fw.check(threw, { actual: "registered", reason: "duplicate ids must throw", rootCause: "dup-tool" }));
    },
    function countAsString(orch) {
      var intent = JSON.stringify({ goal: "five", confidence: 0.9, risk: "low", desiredOutput: { type: "list", count: "5" },
        subgoals: [{ id: "g1", goal: "five", requirements: [{ capability: "search_current_information", required: true, inputs: { query: "q" } }] }] });
      return orch.interpret({ request: "five", interpreter: function () { return intent; } })
        .then(function (d) { return orch.executor.run(d.plan, {}); })
        .then(function (task) { return fw.check(task.outcome.satisfied === false && task.status === "partial",
          { actual: task.status, reason: "string count still enforces deliverable contract", rootCause: "count-string" }); });
    },
    function negativeCount(orch) {
      var intent = JSON.stringify({ goal: "neg", confidence: 0.9, risk: "low", desiredOutput: { type: "list", count: -2 },
        subgoals: [{ id: "g1", goal: "neg", requirements: ["search_current_information"] }] });
      return orch.interpret({ request: "neg", interpreter: function () { return intent; } })
        .then(function (d) { return orch.executor.run(d.plan, {}); })
        .then(function (task) { return fw.check(task.status === "succeeded", { actual: task.status, reason: "negative count ignored", rootCause: "count-negative" }); });
    },
    function markdownFencedJson(orch) {
      var good = JSON.stringify({ goal: "g", confidence: 0.9, risk: "low", subgoals: [{ id: "g1", goal: "g", requirements: ["search_current_information"] }] });
      return orch.interpret({ request: "s", interpreter: function () { return "```json\n" + good + "\n```"; } })
        .then(function (d) { return fw.check(d.plan.status === "planned", { actual: d.plan.status, reason: "fenced json must parse", rootCause: "fence" }); });
    },
    function nullIntent(orch) {
      return orch.interpret({ request: "s", interpreter: function () { return "null"; } })
        .then(function () { return fw.check(false, { actual: "resolved", reason: "null intent must reject", rootCause: "null-intent" }); },
          function () { return fw.check(true); });
    },
    function inputsAsString(orch) {
      var intent = JSON.stringify({ goal: "g", confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: "g", requirements: [{ capability: "search_current_information", required: true, inputs: "not-an-object" }] }] });
      var seen = null;
      var intentPatched = intent.replace("search_current_information", "edge.inputs");
      var orch2 = O.createOrchestrator({ registry: (function () {
        var r = registry();
        r.register(tool("probe.inputs", ["edge.inputs"], {
          run: function (input) { seen = input; return Promise.resolve({ rows: [1] }); }
        }));
        return r;
      })() });
      return orch2.interpret({ request: "s", interpreter: function () { return intentPatched; } })
        .then(function (d) {
          return orch2.executor.run(d.plan, {});
        })
        .then(function (task) {
          return fw.check(task.status === "succeeded" && seen && !Object.prototype.hasOwnProperty.call(seen, "0"),
            { actual: JSON.stringify(seen).slice(0, 80), reason: "non-object inputs must not spread into tool input", rootCause: "inputs-spread" });
        });
    }
  ];
  for (var c = 0; c < 1000; c++) {
    (function (i) {
      var shape = hostile[i % hostile.length];
      fw.emit(jobs, "edge.hostile-interpreter", "hostile interpreter output #" + (i % hostile.length), safe(function () {
        return shape(orchestrator(), fw.seed + i);
      }));
    })(c);
  }

  /* ---------- D: 1000 execution failure and recovery edges ---------- */
  function countingOrchestrator(runFactory, verifyFactory, extraTools) {
    var calls = [];
    var r = registry();
    r.register(tool("probe.main", ["edge.probe"], {
      run: function (input) { calls.push(["main", input.query || null]); return runFactory(calls.length, input); },
      verify: verifyFactory ? verifyFactory("main") : undefined,
      alternatives: []
    }));
    (extraTools || []).forEach(function (t) { r.register(t); });
    return { orch: O.createOrchestrator({ registry: r }), calls: calls };
  }
  function simplePlan(orch, inputs, capability) {
    var intent = O.normalizeIntent({ goal: "probe", confidence: 0.9, risk: "low",
      subgoals: [{ id: "g1", goal: "probe", requirements: [{ id: "r1", capability: capability || "edge.probe",
        required: true, inputs: inputs || { query: "q", alternativeQueries: ["q2", "q3", "q4", "q5"] },
        successCriterion: "verified" }] }] }, "probe");
    var plan = orch.planner.plan(intent, {});
    return plan;
  }
  var executions = [
    function syncThrow() {
      var env = countingOrchestrator(function () { throw new Error("sync boom"); });
      return env.orch.executor.run(simplePlan(env.orch), {}).then(function (t) {
        return fw.check(t.status === "failed" && t.failures[0].kind === "provider" && env.calls.length === 1,
          { actual: t.status + "/" + env.calls.length, reason: "sync throw must classify and bound", rootCause: "sync-throw" });
      });
    },
    function authReorder() {
      var r = registry();
      var order = [];
      r.register(tool("probe.main", ["edge.probe"], {
        run: function () { order.push("main"); return Promise.reject(new Error("403 forbidden")); } }));
      r.register(tool("alt.node", ["edge.probe"], {
        environments: ["node"], run: function () { order.push("node"); return Promise.reject(new Error("403 forbidden")); } }));
      r.register(tool("alt.browser", ["edge.probe"], {
        environments: ["browser"], run: function () { order.push("browser"); return Promise.resolve({ rows: [1] }); } }));
      var orch = O.createOrchestrator({ registry: r });
      return orch.executor.run(simplePlan(orch), {}).then(function (t) {
        return fw.check(t.status === "succeeded" && order.join(",") === "main,browser,node" || order.join(",") === "main,browser",
          { actual: order.join(","), reason: "auth failures rerank toward browser environments", rootCause: "auth-reorder" });
      });
    },
    function rewriteExhaustion() {
      var env = countingOrchestrator(function () { return Promise.resolve({ rows: [] }); },
        function () { return function (out) { return { ok: (out.rows || []).length > 0, reason: "no results" }; }; });
      return env.orch.executor.run(simplePlan(env.orch), {}).then(function (t) {
        /* 1 initial + 2 rewrites on main, then 1 call per alternative-less plan:
           main only => 3 calls then failed */
        return fw.check(t.status === "failed" && env.calls.length === 3 &&
          env.calls.map(function (c) { return c[1]; }).join("|") === "q|q2|q3",
          { actual: env.calls.map(function (c) { return c[1]; }).join("|"), reason: "rewrite budget exact", rootCause: "rewrite-budget" });
      });
    },
    function networkThenSuccess() {
      var env = countingOrchestrator(function (n) {
        return n === 1 ? Promise.reject(new Error("connect ETIMEDOUT")) : Promise.resolve({ rows: [1] });
      });
      return env.orch.executor.run(simplePlan(env.orch), {}).then(function (t) {
        return fw.check(t.status === "succeeded" && env.calls.length === 2,
          { actual: env.calls.length, reason: "one transport retry", rootCause: "network-retry" });
      });
    },
    function verifyThrows() {
      var env = countingOrchestrator(function () { return Promise.resolve({ rows: [1] }); },
        function () { return function () { throw new Error("verifier boom"); }; });
      return env.orch.executor.run(simplePlan(env.orch), {}).then(function (t) {
        return fw.check(t.status === "failed" && t.failures[0].kind === "provider",
          { actual: t.status, reason: "throwing verifier is a provider failure", rootCause: "verify-throw" });
      });
    },
    function falsyOutputs() {
      var values = [undefined, null, false, 0, ""];
      var chain = Promise.resolve();
      values.forEach(function (value) {
        chain = chain.then(function () {
          var env = countingOrchestrator(function () { return Promise.resolve(value); });
          return env.orch.executor.run(simplePlan(env.orch), {}).then(function (t) {
            if (t.status !== "failed") throw new Error("falsy output " + String(value) + " settled " + t.status);
          });
        });
      });
      return chain.then(function () { return fw.check(true); },
        function (e) { return fw.check(false, { actual: e.message, reason: "falsy outputs must fail verification", rootCause: "falsy-output" }); });
    },
    function unmetEveryTime() {
      var r = registry();
      r.register(tool("probe.main", ["edge.probe"], {
        run: function () { return Promise.resolve({ rows: [1], unmetRequirements: [
          { capability: "compose_result" }, { capability: "compose_result" },
          { capability: "compose_result" }, { capability: "compose_result" },
          { capability: "teleport.matter" }, { capability: "compose_result" } ] }); } }));
      var orch = O.createOrchestrator({ registry: r });
      return orch.executor.run(simplePlan(orch), {}).then(function (t) {
        return fw.check(t.appendedSteps <= 3 && t.steps.length <= 4 && t.status === "succeeded",
          { actual: (t.appendedSteps || 0) + "/" + t.steps.length, reason: "append budget caps observation replans", rootCause: "append-cap" });
      });
    },
    function unmetApproval() {
      var r = registry();
      r.register(tool("probe.main", ["edge.probe"], {
        run: function () { return Promise.resolve({ rows: [1], unmetRequirements: [{ capability: "navigate_web" }] }); } }));
      var orch = O.createOrchestrator({ registry: r });
      return orch.executor.run(simplePlan(orch), { permissions: ["browser_control"] }).then(function (t) {
        return fw.check(t.status === "needs_approval",
          { actual: t.status, reason: "appended approval step must pause", rootCause: "append-approval" });
      });
    },
    function priorObservations() {
      var r = registry();
      var seen = null;
      r.register(tool("one", ["edge.chain.a"], { run: function () { return Promise.resolve({ rows: [1] }); } }));
      r.register(tool("two", ["edge.chain.b"], { run: function (input) { seen = input; return Promise.resolve({ answer: "x" }); } }));
      var orch = O.createOrchestrator({ registry: r });
      var intent = O.normalizeIntent({ goal: "chain", confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: "chain", requirements: ["edge.chain.a", "edge.chain.b"] }] }, "chain");
      return orch.executor.run(orch.planner.plan(intent, {}), {}).then(function (t) {
        return fw.check(t.status === "succeeded" && seen && Array.isArray(seen.priorObservations) && seen.priorObservations.length === 1,
          { actual: seen && seen.priorObservations && seen.priorObservations.length, reason: "prior observations flow forward", rootCause: "prior-obs" });
      });
    },
    function approvalGranted() {
      var r = registry();
      var calls = 0;
      r.register(tool("probe.main", ["edge.probe"], {
        requiresApproval: true, sideEffects: "external",
        run: function () { calls++; return Promise.resolve({ rows: [1] }); } }));
      var orch = O.createOrchestrator({ registry: r });
      var plan = simplePlan(orch);
      return orch.executor.run(plan, {}).then(function (t) {
        if (t.status !== "needs_approval" || calls !== 0) throw new Error("unguarded execution");
        return orch.executor.run(t, { approvedSteps: ["step-1"] });
      }).then(function (t) {
        return fw.check(t.status === "succeeded" && calls === 1,
          { actual: t.status + "/" + calls, reason: "approval then execute exactly once", rootCause: "approval-flow" });
      });
    }
  ];
  for (var d = 0; d < 1000; d++) {
    (function (i) {
      var shape = executions[i % executions.length];
      fw.emit(jobs, "edge.execution-recovery", "execution recovery edge #" + (i % executions.length), safe(shape));
    })(d);
  }

  /* ---------- E: 600 persistence and resume edges ---------- */
  function backend(behaviour, data) {
    data = data || Object.create(null);
    return {
      data: data,
      getItem: function (k) {
        if (behaviour === "get-throws") throw new Error("private mode");
        return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
      },
      setItem: function (k, v) {
        if (behaviour === "set-throws") throw new Error("quota");
        data[k] = String(v);
      },
      removeItem: function (k) { delete data[k]; }
    };
  }
  var persistence = [
    function corruptedJson() {
      var store = new O.PersistentTaskStore("k", backend(null, { k: "{{{corrupt" }));
      return Promise.resolve(fw.check(store.load() === null, { actual: "loaded", reason: "corrupt checkpoint must load null", rootCause: "corrupt-load" }));
    },
    function getThrows() {
      var store = new O.PersistentTaskStore("k", backend("get-throws"));
      return Promise.resolve(fw.check(store.load() === null, { actual: "threw", reason: "throwing backend must degrade", rootCause: "backend-get" }));
    },
    function setThrows() {
      var store = new O.PersistentTaskStore("k", backend("set-throws"));
      var task = { status: "planned", steps: [] };
      store.save(task);
      return Promise.resolve(fw.check(store.load() && store.load().status === "planned",
        { actual: "lost", reason: "memory fallback must survive quota errors", rootCause: "backend-set" }));
    },
    function resumeEmpty() {
      var orch = O.createOrchestrator({ store: new O.PersistentTaskStore("k", backend()) });
      return orch.executor.resume({}).then(function () {
        return fw.check(false, { actual: "resolved", reason: "empty store must reject", rootCause: "resume-empty" });
      }, function (e) {
        return fw.check(/No persisted task/.test(e.message), { actual: e.message, reason: "clear reject message", rootCause: "resume-empty-msg" });
      });
    },
    function resumeSucceededNoop() {
      var store = new O.PersistentTaskStore("k", backend());
      var orch = O.createOrchestrator({ registry: registry(), store: store });
      var plan = simplePlan(orch, undefined, "search_current_information");
      return orch.executor.run(plan, {}).then(function (t) {
        var calls = 0;
        var orch2 = O.createOrchestrator({ registry: registry(), store: store });
        orch2.registry.register(tool("probe.main", ["search_current_information"], {
          run: function () { calls++; return Promise.resolve({ rows: [1] }); } }));
        return orch2.executor.resume({}).then(function (t2) {
          return fw.check(t2.status === "succeeded" && calls === 0,
            { actual: t2.status + "/" + calls, reason: "finished tasks resume as no-ops", rootCause: "resume-noop" });
        });
      });
    },
    function corruptedShape() {
      var store = new O.PersistentTaskStore("k", backend(null, { k: JSON.stringify({ status: "executing", cursor: 0 }) }));
      var orch = O.createOrchestrator({ registry: registry(), store: store });
      return orch.executor.resume({}).then(function () {
        return fw.check(false, { actual: "resolved", reason: "shape-corrupt checkpoint must reject cleanly", rootCause: "shape-corrupt" });
      }, function (e) {
        return fw.check(/Invalid task shape/.test(e.message), { actual: e.message, reason: "contract error, not TypeError", rootCause: "shape-error" });
      });
    },
    function crashMidChain() {
      var store = new O.PersistentTaskStore("k", backend());
      var r = registry();
      var stage = { n: 0 };
      r.register(tool("one", ["edge.crash.a"], {
        run: function () { stage.n++; if (stage.n === 1) return Promise.reject(new Error("crash")); return Promise.resolve({ rows: [1] }); } }));
      r.register(tool("two", ["edge.crash.b"], { run: function () { return Promise.resolve({ answer: "done" }); } }));
      var orch = O.createOrchestrator({ registry: r, store: store });
      var intent = O.normalizeIntent({ goal: "chain", confidence: 0.9, risk: "low",
        subgoals: [{ id: "g1", goal: "chain", requirements: ["edge.crash.a", "edge.crash.b"] }] }, "chain");
      return orch.executor.run(orch.planner.plan(intent, {}), {}).then(function (t) {
        if (t.status !== "failed") throw new Error("expected first-run failure, got " + t.status);
        var orch2 = O.createOrchestrator({ registry: registry(), store: store });
        orch2.registry.register(tool("one", ["edge.crash.a"], { run: function () { return Promise.resolve({ rows: [1] }); } }));
        orch2.registry.register(tool("two", ["edge.crash.b"], { run: function () { return Promise.resolve({ answer: "done" }); } }));
        return orch2.executor.resume({});
      }).then(function (t) {
        return fw.check(t.status === "succeeded" && t.steps.every(function (s) { return s.status === "succeeded"; }),
          { actual: t.status, reason: "crashed chain resumes to completion", rootCause: "resume-chain" });
      });
    },
    function unicodeKey() {
      var store = new O.PersistentTaskStore("ключ🔑", backend());
      store.save({ status: "planned", steps: [] });
      return Promise.resolve(fw.check(store.load().status === "planned", { actual: "lost", reason: "unicode keys round-trip", rootCause: "unicode-key" }));
    },
    function roundTripEquality() {
      var store = new O.PersistentTaskStore("k", backend());
      var orch = O.createOrchestrator({ registry: registry(), store: store });
      var plan = simplePlan(orch, undefined, "search_current_information");
      return orch.executor.run(plan, {}).then(function (t) {
        var loaded = store.load();
        return fw.check(JSON.stringify(loaded) === JSON.stringify(t),
          { actual: "diverged", reason: "checkpoint equals live task", rootCause: "checkpoint-drift" });
      });
    },
    function resumeClarificationNoop() {
      var store = new O.PersistentTaskStore("k", backend());
      var orch = O.createOrchestrator({ registry: registry(), store: store });
      var intent = O.normalizeIntent({ goal: "hmm", clarification: "Which?", confidence: 0.2, risk: "high", subgoals: [] }, "hmm");
      var plan = orch.planner.plan(intent, {});
      store.save(plan);
      return orch.executor.resume({}).then(function (t) {
        return fw.check(t.status === "needs_clarification", { actual: t.status, reason: "clarification resumes as pause", rootCause: "resume-clarification" });
      });
    }
  ];
  for (var e = 0; e < 600; e++) {
    (function (i) {
      var shape = persistence[i % persistence.length];
      fw.emit(jobs, "edge.persistence-resume", "persistence edge #" + (i % persistence.length), safe(shape));
    })(e);
  }

  return jobs;
}

module.exports = { name: name, build: build };
