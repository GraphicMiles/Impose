/* Browser-agent planner/executor boundary and lifecycle checks. */
"use strict";
var agent = require("../browser-agent.js");

var passed = 0;
function ok(value, name) {
  if (!value) throw new Error(name);
  passed += 1;
  console.log("PASS: " + name);
}

function rejects(work, pattern, name) {
  return Promise.resolve().then(work).then(function () {
    throw new Error(name + " (expected rejection)");
  }, function (error) {
    ok(pattern.test(String(error && error.message)), name);
  });
}

async function run() {
  ok(agent.validUrl("https://example.com/a") === "https://example.com/a", "normal HTTPS URL accepted");
  ok(agent.validUrl("javascript:alert(1)") === "", "script URL rejected");
  ok(agent.validUrl("https://user:secret@example.com/") === "", "credential-bearing URL rejected");
  ok(agent.safeNavigationUrl("https://example.com/logout") === "" &&
    agent.safeNavigationUrl("https://example.com/?action=%64elete") === "" &&
    agent.safeNavigationUrl("https://example.com/docs") !== "", "action-oriented GET navigation is rejected without blocking normal pages");

  var compact = agent.compactSnapshot({
    text: "x".repeat(12000),
    elements: Array.from({ length: 140 }, function (_, index) { return { ref: "e" + index, name: "n".repeat(300) }; })
  });
  ok(compact.text.length === 10000 && compact.elements.length === 120 && compact.elements[0].name.length === 180, "page observations are bounded");

  var normalized = agent.normalizePlan({
    summary: "Plan",
    tabId: 7,
    allowedOrigins: ["https://example.com/path", "javascript:alert(1)"],
    steps: ["Open page"],
    sideEffects: [
      { kind: "post", target: "@account", text: "Hello" },
      { kind: "reply", target: "", text: "Dropped" },
      { kind: "purchase", target: "shop", text: "Blocked" }
    ]
  }, []);
  ok(normalized.tabId === 7 && normalized.allowedOrigins[0] === "https://example.com" && normalized.sideEffects.length === 1, "approved plan retains tab identity and filters malformed bounds");
  await rejects(function () {
    return agent.validateAction({ action: "navigate", url: "https://other.example/" }, normalized, {}, []);
  }, /outside the approved origin/, "navigation outside approved origins is rejected");
  await rejects(function () {
    return agent.validateAction({ action: "click", ref: "e9" }, normalized, {
      url: "https://example.com/", elements: [{ ref: "e9", href: "https://other.example/", disabled: false, risk: "none" }]
    }, []);
  }, /leaves the approved origin/, "links are rechecked against approved origins");

  var destructivePage = { elements: [{ ref: "e1", disabled: false, risk: "destructive" }] };
  await rejects(function () {
    return agent.validateAction({ action: "click", ref: "e1" }, { sideEffects: [] }, destructivePage, []);
  }, /Destructive/, "destructive generic click rejected");

  var publicPage = { url: "https://example.com/form", elements: [{ ref: "e2", disabled: false, risk: "side-effect" }] };
  var submitPlan = { allowedOrigins: ["https://example.com"], sideEffects: [{ kind: "submit", target: "https://example.com/form", text: "Approved application" }] };
  await rejects(function () {
    return agent.validateAction({ action: "click", ref: "e2" }, submitPlan, publicPage, []);
  }, /does not exactly match/, "unbound generic side effect rejected");

  await rejects(function () {
    return agent.validateAction({
      action: "click", ref: "e2", effectKind: "submit", effectTarget: "https://example.com/form", effectText: "Approved application"
    }, submitPlan, publicPage, []);
  }, /has not been entered/, "generic side effect requires exact approved content to be entered first");

  var boundClick = agent.validateAction({
    action: "click", ref: "e2", effectKind: "submit", effectTarget: "https://example.com/form", effectText: "Approved application"
  }, submitPlan, publicPage, [{ url: "https://example.com/form", action: { action: "type", text: "Approved application" } }]);
  ok(boundClick.public === true && boundClick.effectTarget === "https://example.com/form", "generic side effect is bound to exact approved target and content");

  var postPlan = { allowedOrigins: ["https://x.com"], sideEffects: [{ kind: "post", target: "@impose", text: "Exact post" }] };
  ok(agent.validateAction({ action: "x.post", target: "@impose", text: "Exact post" }, postPlan, {}, []).text === "Exact post", "X post matches exact approved target and text");
  await rejects(function () {
    return agent.validateAction({ action: "x.post", target: "@other", text: "Exact post" }, postPlan, {}, []);
  }, /not present/, "X post target mismatch rejected");

  var replyPlan = { allowedOrigins: ["https://x.com"], sideEffects: [{ kind: "reply", target: "https://x.com/u/status/123", text: "Exact reply" }] };
  ok(agent.validateAction({ action: "x.reply", url: "https://x.com/u/status/123", text: "Exact reply" }, replyPlan, {}, []).url === "https://x.com/u/status/123", "X reply matches exact approved URL and text");

  var planningCalls = [];
  var planner = agent.createBrowserAgent({
    complete: function () {
      return Promise.resolve(JSON.stringify({ summary: "Read the page", tabId: 4, allowedOrigins: ["https://example.com"], steps: ["Inspect the current page"], sideEffects: [] }));
    },
    act: function (method, params) {
      planningCalls.push({ method: method, params: params });
      if (method === "browser.tabs") return Promise.resolve({ tabs: [{ tabId: 4, active: true, url: "https://example.com/" }] });
      return Promise.resolve({ url: "https://example.com/", text: "Example" });
    }
  });
  var plan = await planner.plan("Read example");
  ok(plan.tabId === 4 && plan.allowedOrigins[0] === "https://example.com" &&
    planningCalls.map(function (call) { return call.method; }).join(",") === "browser.tabs,page.snapshot", "planner observes bounded tab state and produces origin bounds");

  var actionAnswers = [
    JSON.stringify({ action: "navigate", url: "https://example.com/", reason: "Open target" }),
    JSON.stringify({ action: "done", result: "Read the target page." })
  ];
  var executionCalls = [];
  var events = [];
  var executor = agent.createBrowserAgent({
    complete: function () { return Promise.resolve(actionAnswers.shift()); },
    act: function (method, params) {
      executionCalls.push({ method: method, params: params });
      if (method === "page.navigate") return Promise.resolve({ tabId: 55, url: params.url });
      if (method === "page.snapshot") return Promise.resolve({ url: "https://example.com/", text: "Example" });
      throw new Error("Unexpected action " + method);
    },
    onStep: function (event) { events.push(event); }
  });
  var outcome = await executor.run("Read example", { summary: "Read", tabId: 0, allowedOrigins: ["https://example.com"], steps: ["Open target", "Read it"], sideEffects: [] });
  ok(outcome.tabId === 55 && executionCalls.some(function (call) { return call.method === "page.snapshot" && call.params.tabId === 55; }), "navigation creates and retains a usable execution tab");
  ok(events.filter(function (event) { return event.type === "result"; }).length === 1, "completed actions emit a final lifecycle event");

  var repeats = agent.createBrowserAgent({
    complete: function () { return Promise.resolve(JSON.stringify({ action: "wait", ms: 100, reason: String(Math.random()) })); },
    act: function () { return Promise.resolve({ waited: 100 }); }
  });
  await rejects(function () {
    return repeats.run("Wait forever", { summary: "Wait", allowedOrigins: ["https://example.com"], steps: ["Wait"], sideEffects: [] });
  }, /repeated the same action/, "repeat detection ignores changing model rationale");

  var limitStep = 0;
  var limitAgent = agent.createBrowserAgent({
    complete: function () {
      limitStep += 1;
      return Promise.resolve(JSON.stringify({ action: "wait", ms: 100 + limitStep, reason: "bounded" }));
    },
    act: function () { return Promise.resolve({ waited: true }); }
  });
  await rejects(function () {
    return limitAgent.run("Keep waiting", { summary: "Bounded", allowedOrigins: ["https://example.com"], steps: ["Wait within limits"], sideEffects: [] });
  }, /20-step safety limit/, "execution cannot exceed the 20-step bound");

  var repaired = 0;
  var repairAgent = agent.createBrowserAgent({
    complete: function () {
      repaired += 1;
      if (repaired === 1) return Promise.resolve(JSON.stringify({ action: "click", ref: "missing" }));
      return Promise.resolve(JSON.stringify({ action: "done", result: "Stopped safely." }));
    },
    act: function () { throw new Error("No browser action should execute"); }
  });
  var repairedResult = await repairAgent.run("Finish", { summary: "Finish", allowedOrigins: ["https://example.com"], steps: ["Finish"], sideEffects: [] });
  ok(repaired === 2 && repairedResult.result === "Stopped safely.", "one invalid model instruction receives one bounded repair attempt");

  var controller = new AbortController();
  controller.abort();
  var stoppedAgent = agent.createBrowserAgent({
    signal: controller.signal,
    complete: function () { throw new Error("not reached"); },
    act: function () { throw new Error("not reached"); }
  });
  await rejects(function () {
    return stoppedAgent.run("Do nothing", { summary: "Stop", allowedOrigins: ["https://example.com"], steps: ["Stop"], sideEffects: [] });
  }, /stopped/, "abandoned execution stops before another browser action");

  console.log(passed + " passed, 0 failed");
}

run().catch(function (error) {
  console.error("FAIL: " + error.message);
  process.exitCode = 1;
});
