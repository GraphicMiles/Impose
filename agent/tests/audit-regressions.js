/* Regressions from the 2026-09-15 autonomous reliability audit.
   Each test here corresponds to a reproduced failure, not a hypothetical.
   Run: node agent/tests/audit-regressions.js */
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var O = require("../orchestrator.js");

var root = path.join(__dirname, "..", "..");
var appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");

var passed = 0, failed = 0;
var queue = [];
function test(name, fn) { queue.push([name, fn]); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

/* Lifts the shipped function out of app.js so the test executes real code. */
function liftAppFunction(name) {
  var lines = appSource.split("\n");
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim().indexOf("function " + name + "(") === 0) { start = i; break; }
  }
  if (start === -1) throw new Error("could not locate " + name + " in app.js");
  var end = -1;
  for (var j = start; j < lines.length; j++) { if (lines[j] === "  }") { end = j; break; } }
  if (end === -1) throw new Error("could not find the end of " + name);
  var ctx = { String: String, Math: Math, JSON: JSON, RegExp: RegExp };
  vm.createContext(ctx);
  vm.runInContext(lines.slice(start, end + 1).join("\n") + "\n;__out = " + name + ";", ctx, { filename: "app.js" });
  return ctx.__out;
}

function tool(id, caps) {
  return { id: id, name: id, description: id, capabilities: caps, primaryCapability: caps[0],
    inputs: {}, outputs: {}, prerequisites: [], permissions: [], sideEffects: "none",
    requiresApproval: false, cost: { latency: "low", monetary: "none" }, reliability: 0.8,
    environments: ["browser"], composable: true, mutability: "read-only", failureModes: [],
    run: function () { return { ok: true }; } };
}

/* ---- Finding 1: the intent primitive substituted a policy verdict for the goal ---- */
test("a refusal verdict with nothing to retrieve is rejected as a malformed decomposition", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("files.discover", ["discover_files"]));
  var seen = 0;
  var payload = JSON.stringify({ goal: "Refuse to provide or locate the Mini Militia APK as it is likely copyrighted material.",
    confidence: 0.9, risk: "low", subgoals: [{ id: "g1", goal: "Refuse the request", requirements: [] }] });
  var error = null;
  await orch.interpret({ request: "get me the mini militia apk", environment: "browser",
    interpreter: function () { seen += 1; return payload; } }).catch(function (e) { error = e; });
  ok(error, "interpret must reject a verdict-shaped decomposition");
  ok(/policy verdict/i.test(error.message), "rejection names the real cause: " + error.message);
  ok(seen === 2, "the one bounded repair is attempted exactly once, got " + seen);
});

test("the refusal guard does not invent tools for a genuine conversational goal", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("files.discover", ["discover_files"]));
  var decision = await orch.interpret({ request: "thanks, that helped", environment: "browser",
    interpreter: function () { return JSON.stringify({ goal: "Acknowledge the thanks", confidence: 0.95,
      risk: "low", subgoals: [{ id: "g1", goal: "Acknowledge the thanks", requirements: [] }] }); } });
  ok((decision.plan.steps || []).length === 0, "no retrieval step for a reply");
});

test("a decline wording inside a real decomposition still executes the capability", async function () {
  var orch = O.createOrchestrator();
  orch.registry.register(tool("files.discover", ["discover_files"]));
  var decision = await orch.interpret({ request: "find the package", environment: "browser",
    interpreter: function () { return JSON.stringify({ goal: "Locate an attributed source for the requested package",
      confidence: 0.9, risk: "low",
      subgoals: [{ id: "g1", goal: "Find it", requirements: [{ capability: "discover_files", required: true }] }] }); } });
  ok(decision.plan.steps.length === 1 && decision.plan.steps[0].toolId === "files.discover",
    "capability routing is unaffected by the guard");
});

test("the interpreter is told explicitly that policy is not its job", function () {
  var prompt = O.interpretationPrompt("x", "", null, [], null);
  ok(prompt.indexOf("Never substitute your own verdict") !== -1, "prompt states the boundary");
  ok(prompt.indexOf("Return JSON only with: goal,") !== -1, "the schema contract survives the prompt edit");
  ok(prompt.indexOf("Available capability providers:") !== -1, "catalog still supplied");
  ok(prompt.indexOf("Active task:") !== -1, "active task still supplied");
});

/* ---- Finding 2: provider credentials survived the copyable debug log ---- */
test("every credential-shaped query parameter is redacted in log lines", function () {
  var sanitizeUrl = liftAppFunction("sanitizeUrl");
  var cases = ["apikey", "api_key", "api-key", "x-api-key", "access_token", "my_key", "Key",
    "client_secret", "password", "credential", "bearer", "signature", "sig", "auth", "code", "otp"];
  cases.forEach(function (name) {
    var leaked = /LEAK/i.test(sanitizeUrl("https://api.example/v1/models?" + name + "=LEAK"));
    ok(!leaked, name + " must not reach the log");
  });
  var url = sanitizeUrl("https://user:hunter2@api.example/v1?query=fish&limit=3");
  ok(url.indexOf("hunter2") === -1, "URL userinfo is redacted: " + url);
  ok(url.indexOf("query=fish") !== -1 && url.indexOf("limit=3") !== -1, "benign parameters stay readable");
  var benign = sanitizeUrl("https://api.example/v1?design=dark&assign=auto&query=fish");
  ok(benign.indexOf("design=dark") !== -1 && benign.indexOf("assign=auto") !== -1,
    "over-redaction would make the log useless: " + benign);
});

test("escaping is safe in any attribute context, not just the one in use today", function () {
  var escapeHtml = liftAppFunction("escapeHtml");
  ["<script>alert(1)</script>", "<a href='javascript:alert(1)'>x</a>", "&", 'a\'b"c<d>e', "' onmouseover=alert(1) '"].forEach(function (input) {
    var out = String(escapeHtml(input));
    ok(!/[<>"']/.test(out), "no live delimiter survives: " + out);
    ok(!/&(?!(amp|lt|gt|quot|#39|#\d+);)/.test(out), "no bare ampersand: " + out);
  });
});

test("short exact-name credential parameters are redacted without eating benign ones", function () {
  var sanitizeUrl = liftAppFunction("sanitizeUrl");
  ["sig", "auth", "code", "otp", "token"].forEach(function (name) {
    var out = sanitizeUrl("https://x.example/v1?" + name + "=SECRETVALUE");
    ok(out.indexOf("SECRETVALUE") === -1, name + " leaked: " + out);
    ok(out.indexOf("$2") === -1, "the redactor produced garbage instead of a mask: " + out);
  });
  var benign = sanitizeUrl("https://x.example/v1?signature=keep-me-friendly&design=dark");
  ok(benign.indexOf("design=dark") !== -1, "benign parameters stay readable: " + benign);
});

/* Finding 3 (extension side-effect approval) no longer applies: the
   companion extension bridge was removed, so its router has no client. */

function run() {
  var row = queue.shift();
  if (!row) {
    console.log(passed + " passed, " + failed + " failed");
    if (failed) process.exitCode = 1;
    return;
  }
  Promise.resolve().then(row[1]).then(function () { passed += 1; console.log("PASS: " + row[0]); },
    function (e) { failed += 1; console.log("FAIL: " + row[0] + "\n  " + e.message); }).then(run);
}
run();
