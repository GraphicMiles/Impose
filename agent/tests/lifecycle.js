/* Focused hostile-lifecycle tests for browser transport contracts.
   Run: node agent/tests/lifecycle.js */
"use strict";

var fs = require("fs");
var path = require("path");
var src = fs.readFileSync(path.join(__dirname, "..", "..", "app.js"), "utf8");

function extractFunction(name, nextMarker) {
  var start = src.indexOf("  function " + name + "(");
  var end = src.indexOf(nextMarker, start);
  if (start < 0 || end < 0) throw new Error("Could not extract " + name);
  return (0, eval)("(" + src.slice(start + 2, end).trim() + ")");
}

var readSSE = extractFunction("readSSE", "\n\n  /* opts:");
var safeImportedId = extractFunction("safeImportedId", "\n\n  function safeHttpUrl");
var safeHttpUrl = extractFunction("safeHttpUrl", "\n\n  function normalizeImportedMessage");
var sanitizeLogDetail = extractFunction("sanitizeLogDetail", "\n\n  function debugRow");
var detailOf = extractFunction("detailOf", "\n\n  /* Someone else's HTTP code");
var stripUnverifiedMediaMarkup = extractFunction("stripUnverifiedMediaMarkup", "\n\n  function withTimeout");
var looksLikeCasualChat = extractFunction("looksLikeCasualChat", "\n\n  function routeSend");
global.detailOf = detailOf;
var explain = extractFunction("explain", "\n\n  /* Technical detail stays");
var tests = [];
function test(name, fn) { tests.push([name, fn]); }
function ok(value, message) { if (!value) throw new Error(message || "expected truthy"); }
function response(text) { return { body: null, text: function () { return Promise.resolve(text); } }; }
function streamedResponse(chunks) {
  var i = 0;
  return { body: { getReader: function () { return {
    read: function () {
      if (i >= chunks.length) return Promise.resolve({ done: true });
      return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[i++]) });
    },
    cancel: function () { i = chunks.length; return Promise.resolve(); }
  }; } } };
}

var openAITerminal = function (d) {
  return !!(d && (d.choices || []).some(function (c) { return c && c.finish_reason != null; }));
};

test("import IDs cannot break attribute selectors", async function () {
  ok(safeImportedId("chat_123-A") === "chat_123-A", "safe id kept");
  ok(safeImportedId('x\"] .danger') === "", "selector payload rejected");
  ok(safeImportedId("a".repeat(101)) === "", "oversized id rejected");
});

test("import URLs allow only HTTP and HTTPS", async function () {
  ok(/^https:\/\//.test(safeHttpUrl("https://example.com/a")), "https kept");
  ok(safeHttpUrl("javascript:alert(1)") === "", "javascript rejected");
  ok(safeHttpUrl("data:text/html,boom") === "", "data rejected");
});

test("provider logs redact account IDs and credentials", async function () {
  var fakeCredential = "gsk_" + "x".repeat(24);
  var clean = sanitizeLogDetail("organization org_01abc token " + fakeCredential);
  ok(clean.indexOf("org_01abc") === -1, "organization id redacted");
  ok(clean.indexOf(fakeCredential) === -1, "credential redacted");
});

test("casual reactions bypass broad research without hiding real requests", async function () {
  ok(looksLikeCasualChat("I like the song"), "song reaction is ordinary chat");
  ok(looksLikeCasualChat("Thanks!"), "thanks is ordinary chat");
  ok(!looksLikeCasualChat("I like the iPhone; compare it with Samsung"), "comparison still researches");
  ok(!looksLikeCasualChat("Help me pick the best iPhone under 500k"), "shopping request still researches");
});

test("research output cannot fabricate embedded media", async function () {
  var dirty = "Ready.\n<iframe src=\"https://www.youtube.com/embed/fake\"></iframe>\n" +
    "<video><source src=\"https://evil.example/fake.mp4\"></video>\n" +
    "<https://www.youtube.com/channel/fake>\nSafe explanation.";
  var clean = stripUnverifiedMediaMarkup(dirty);
  ok(clean.indexOf("iframe") === -1, "iframe removed");
  ok(clean.indexOf("video") === -1 && clean.indexOf("source") === -1, "HTML media removed");
  ok(clean.indexOf("youtube.com") === -1, "angle-bracketed media URL removed");
  ok(clean.indexOf("Safe explanation.") > -1, "ordinary text kept");
});

test("Groq token 413 is not mislabeled as chat length", async function () {
  var payload = JSON.stringify({ error: { message: "Request too large on tokens per minute (TPM): Limit 6000, Requested 9000" } });
  var sentence = explain({ kind: "openai", label: "Groq", baseUrl: "https://api.groq.com" }, 413, payload, "m");
  ok(sentence.indexOf("Groq rejected") === 0, "provider named");
  ok(sentence.indexOf("token allowance") > -1, "token cause explained");
  ok(sentence.indexOf("Start a new chat") === -1, "misleading old remedy removed");
});

test("accepts explicit DONE", async function () {
  var chunks = [];
  await readSSE(response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n'), function (d) {
    chunks.push(d.choices[0].delta.content);
  }, openAITerminal);
  ok(chunks.join("") === "hi", "delta preserved");
});

test("reassembles SSE lines split across network chunks", async function () {
  var out = "";
  await readSSE(streamedResponse([
    'data: {"choices":[{"delta":{"con',
    'tent":"split"}}]}\n\n',
    'data: [DO',
    'NE]\n\n'
  ]), function (d) { out += d.choices[0].delta.content; }, openAITerminal);
  ok(out === "split", "split delta preserved");
});

test("accepts provider-specific terminal event", async function () {
  var seen = 0;
  await readSSE(response('data: {"type":"content_block_delta"}\n\ndata: {"type":"message_stop"}\n'), function () { seen++; }, function (d) {
    return d.type === "message_stop";
  });
  ok(seen === 2, "both events parsed");
});

test("accepts OpenAI finish_reason without DONE", async function () {
  await readSSE(response('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}'), function () {}, openAITerminal);
});

test("rejects ordinary EOF without terminal proof", async function () {
  var failed = false;
  try {
    await readSSE(response('data: {"choices":[{"delta":{"content":"partial"}}]}\n'), function () {}, openAITerminal);
  } catch (e) {
    failed = e && e.name === "TruncatedStreamError";
  }
  ok(failed, "truncated stream rejected");
});

test("rejects malformed data event", async function () {
  var failed = false;
  try { await readSSE(response("data: {bad json}\n"), function () {}, openAITerminal); }
  catch (e) { failed = e && e.name === "MalformedStreamError"; }
  ok(failed, "malformed stream rejected");
});

test("rejects streamed provider error", async function () {
  var failed = false;
  try { await readSSE(response('data: {"error":{"message":"upstream died"}}\n'), function () {}, openAITerminal); }
  catch (e) { failed = /upstream died/.test(e.message); }
  ok(failed, "provider error propagated");
});

(async function () {
  var passed = 0;
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i][1](); passed++; console.log("PASS: " + tests[i][0]); }
    catch (e) { console.error("FAIL: " + tests[i][0] + " :: " + e.message); process.exitCode = 1; }
  }
  console.log(passed + " passed, " + (tests.length - passed) + " failed");
})();
