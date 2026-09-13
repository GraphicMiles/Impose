/* Tests for the feature kit (agent/features.js) plus the harness read step.
   Run: node agent/tests/features.js */
"use strict";

var F = require("../features.js");
var H = require("../harness.js");

var pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("PASS: " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

/* ---------- tokens and context ---------- */
ok(F.estimateTokens("1234567890") === 3, "estimateTokens rounds up chars/4");
ok(F.estimateTokens("", [1, 2]) === 2000, "estimateTokens counts 1000 per image");
ok(F.modelContext("gpt-5.6-terra") === 128000, "modelContext gpt-5 family");
ok(F.modelContext("claude-sonnet-4") === 200000, "modelContext claude");
ok(F.modelContext("gemini-2.5-pro") === 1000000, "modelContext gemini new");
ok(F.modelContext("mystery-model") === 16384, "modelContext default");

var long = [];
for (var i = 0; i < 50; i++) long.push({ role: i % 2 ? "assistant" : "user", content: "word ".repeat(400) });
var trimmed = F.trimHistory(long, "openai", 2000);
ok(trimmed.length < 50 && trimmed.length >= 2, "trimHistory keeps the recent tail within budget");
ok(trimmed[trimmed.length - 1] === long[long.length - 1], "trimHistory keeps the newest message");
ok(F.trimHistory([], "openai", 1000).length === 0, "trimHistory on empty");

/* ---------- gen params ---------- */
var b = {};
F.applyGenParams(b, "openai", { temperature: 3, topP: 0.5, maxTokens: 256 });
ok(b.temperature === 2 && b.top_p === 0.5 && b.max_tokens === 256, "openai params applied and clamped");
b = {}; F.applyGenParams(b, "anthropic", { maxTokens: 77 });
ok(b.max_tokens === 77, "anthropic max_tokens override");
b = {}; F.applyGenParams(b, "gemini", { temperature: 0.3 });
ok(b.generationConfig && b.generationConfig.temperature === 0.3, "gemini generationConfig");
b = {}; F.applyGenParams(b, "openai", { temperature: null });
ok(!("temperature" in b), "unset params leave the body alone");
b = {}; F.applyGenParams(b, "openai", { temperature: -5 });
ok(b.temperature === 0, "temperature clamps at 0");

/* ---------- system assembly and memory ---------- */
var sys = F.buildSystem("BASE", "Be terse", [{ text: "Likes short answers" }]);
ok(sys.indexOf("BASE") === 0 && sys.indexOf("Be terse") > -1 && sys.indexOf("Likes short answers") > -1,
  "buildSystem stacks persona, chat instructions, memory");
ok(F.buildSystem("BASE", "", []).indexOf("remember") === -1, "no memory block when empty");
ok(F.memoryFromText("remember that Ada lives in Yaba") === "Ada lives in Yaba", "memoryFromText strips the command");
ok(F.memoryFromText("what time is it") === null, "memoryFromText ignores normal text");
var mems = F.dedupeMemory([{ id: "1", text: "Ada lives in Yaba" }], "ada lives in yaba");
ok(mems.length === 1 && mems[0].id !== "1", "dedupeMemory replaces case variants");

/* ---------- vision ---------- */
ok(F.visionCapable("gpt-5.6-terra") && F.visionCapable("claude-sonnet-4") && F.visionCapable("gemini-2.5-pro"), "vision: big three capable");
ok(!F.visionCapable("text-embed-3") && !F.visionCapable("qwen3-coder"), "vision: text models flagged");

/* ---------- PII redaction ---------- */
var r = F.redactPII("mail me at ada@example.com or +234 801 234 5678");
ok(r.text.indexOf("ada@example.com") === -1 && r.found.indexOf("email") > -1, "redact email");
ok(r.text.indexOf("234 801") === -1 && r.found.indexOf("phone") > -1, "redact NG phone international");
r = F.redactPII("my number is 0801 234 5678, account 0123456789");
ok(r.text.indexOf("0801 234 5678") === -1, "redact NG local phone");
ok(r.text.indexOf("0123456789") !== -1, "bare 11 digit run without keyword stays (conservative)");
r = F.redactPII("bvn 12345678901 on file");
ok(r.text.indexOf("12345678901") === -1 && r.found.indexOf("bvn") > -1, "redact BVN with keyword");
r = F.redactPII("NIN: 12345678901");
ok(r.text.indexOf("12345678901") === -1 && r.found.indexOf("nin") > -1, "redact NIN with keyword");
r = F.redactPII("card 4111 1111 1111 1111 please");
ok(r.text.indexOf("4111") === -1 && r.found.indexOf("card") > -1, "redact Luhn valid card");
r = F.redactPII("order 4111 1111 1111 1112 shipped");
ok(r.text.indexOf("4111 1111 1111 1112") !== -1, "Luhn invalid number untouched");
r = F.redactPII("total is 450000 NGN and inv-2041 is late");
ok(r.found.length === 0 && r.text.indexOf("450000") !== -1, "ordinary numbers survive");

/* ---------- library templates ---------- */
ok(JSON.stringify(F.extractVars("Hello {{name}}, meet {{other}} and {{name}}")) === JSON.stringify(["name", "other"]),
  "extractVars unique in order");
ok(F.applyTemplate("Hi {{name}}", { name: "Ada" }) === "Hi Ada", "applyTemplate fills");
ok(F.applyTemplate("Hi {{name}}", {}) === "Hi {{name}}", "applyTemplate keeps unfilled slots");

/* ---------- follow ups ---------- */
var fp = F.followUpPrompt("who is mrbeast", "MrBeast is a YouTuber");
ok(fp.indexOf("3 short follow up") > -1 && fp.indexOf("mrbeast") > -1, "followUpPrompt carries context");
ok(JSON.stringify(F.parseFollowUps("1. Give an example\n- explain deeper\nLong line over sixty characters that should be dropped because it is far too long for a chip\n\nOK")) === JSON.stringify(["Give an example", "explain deeper", "OK"]),
  "parseFollowUps cleans numbering and drops longs");

/* ---------- usage ---------- */
var chats = [
  { providerId: "p1", messages: [
    { role: "assistant", content: "x", stats: { toks: 100, toksIn: 25, toksOut: 75 } },
    { role: "user", content: "y" }
  ] },
  { providerId: "p1", messages: [{ role: "assistant", content: "z", stats: { toks: 50, toksIn: 10, toksOut: 40 } }] },
  { providerId: "p2", messages: [{ role: "assistant", content: "w", stats: { toks: 10 } }] }
];
var rows = F.aggregateUsage(chats, [
  { id: "p1", label: "Work", priceIn: 2, priceOut: 8 },
  { id: "p2", label: "Free" }
]);
ok(rows.length === 2, "aggregateUsage one row per provider");
var w = rows.filter(function (r) { return r.label === "Work"; })[0];
ok(w.msgs === 2 && w.toks === 150, "aggregateUsage sums");
ok(Math.abs(w.cost - (25 / 1e6 * 2 + 75 / 1e6 * 8 + 10 / 1e6 * 2 + 40 / 1e6 * 8)) < 1e-9, "aggregateUsage cost math");
ok(rows.filter(function (r) { return r.label === "Free"; })[0].priced === false, "unpriced provider flagged");

/* ---------- retention ---------- */
var now = Date.now();
var pc = F.pruneChats([
  { id: "new", updatedAt: now - 86400000 },
  { id: "old", updatedAt: now - 40 * 86400000 },
  { id: "oldpin", updatedAt: now - 40 * 86400000, pinned: true }
], 30, now);
ok(pc.kept.length === 2 && pc.removed.length === 1 && pc.removed[0].id === "old", "pruneChats honors days and pinned");
ok(F.pruneChats(chats, 0).kept.length === 3, "pruneChats off when days 0");

/* ---------- crypto roundtrip ---------- */
(async function () {
  try {
    var payload = { chats: [{ id: "c1", title: "t" }], folders: [] };
    var enc = await F.encryptExport(payload, "correct horse battery");
    ok(enc.format === "impose-encrypted-v1" && enc.data && enc.salt && enc.iv, "encryptExport shape");
    var back = await F.decryptExport(enc, "correct horse battery");
    ok(back.chats[0].id === "c1", "decryptExport roundtrip");
    var wrong = false;
    try { await F.decryptExport(enc, "wrong passphrase!"); } catch (e) { wrong = true; }
    ok(wrong, "decryptExport rejects a wrong passphrase");
    var short = false;
    try { await F.encryptExport(payload, "short"); } catch (e) { short = true; }
    ok(short, "encryptExport needs 8+ chars");
    var badfile = false;
    try { await F.decryptExport({ format: "nope" }, "x"); } catch (e) { badfile = true; }
    ok(badfile, "decryptExport rejects foreign files");
  } catch (e) {
    ok(false, "crypto roundtrip threw: " + e.message);
  }

  /* ---------- share HTML ---------- */
  var html = F.shareChatHtml({ title: "Chat <1>", messages: [
    { role: "user", content: "<script>alert(1)<\/script>" },
    { role: "assistant", content: "Line1\nLine2" }
  ] });
  ok(html.indexOf("<script>alert") === -1 && html.indexOf("&lt;script&gt;") > -1, "shareChatHtml escapes content");
  ok(html.indexOf("Chat &lt;1&gt;") > -1 && html.indexOf("Line1<br>Line2") > -1, "shareChatHtml title and newlines");

  /* ---------- relay status ---------- */
  ok(F.formatRelayStatus({ gateway_up: true, idle_minutes: 2.4 }).text.indexOf("Gateway up") === 0, "formatRelayStatus up");
  ok(F.formatRelayStatus({ gateway_up: true, llm_up: false }).text.indexOf("model down") > -1, "formatRelayStatus distinguishes model down");
  ok(F.formatRelayStatus({ gateway_up: false, gateway_configured: false }).text === "Gateway not configured", "formatRelayStatus missing gateway");
  ok(F.formatRelayStatus({ gateway_up: false, gateway_configured: true, wake_studio: false }).text.indexOf("disabled") > -1, "formatRelayStatus wake disabled");
  ok(F.formatRelayStatus({ gateway_up: false, gateway_configured: true, wake_studio: true, wake_configured: false }).text.indexOf("incomplete") > -1, "formatRelayStatus missing wake credentials");
  ok(F.formatRelayStatus({ gateway_up: false, gateway_configured: true, wake_studio: true, wake_configured: true, wake_on_chat: false }).text.indexOf("off") > -1, "formatRelayStatus wake-on-chat off");
  ok(F.formatRelayStatus({ gateway_up: false, gateway_configured: true, waking: true }).waking === true, "formatRelayStatus waking");
  ok(F.formatRelayStatus(null).ok === false, "formatRelayStatus guards garbage");

  /* ---------- duplicate ---------- */
  var dc = F.duplicateChat({ id: "a", title: "Orig", pinned: true, messages: [{ role: "user", content: "hi" }] }, "b");
  ok(dc.id === "b" && dc.title === "Orig (copy)" && dc.pinned === false && dc.messages.length === 1, "duplicateChat deep copy");

  /* ---------- harness read step ---------- */
  var events = [];
  var searches = 0;
  H.harness.registerTool({
    id: "web.read.test", version: "1", capabilities: ["read"],
    run: function (args) { return Promise.resolve({ text: "PAGE CONTENT FOR " + args.url }); }
  });
  var deps = {
    query: "what is on the page",
    emit: function (e) { events.push(e); },
    search: function () { searches++; return Promise.resolve({ results: [
      { title: "A", url: "https://a.example/x", snippet: "sa" },
      { title: "B", url: "https://b.example/y", snippet: "sb" }
    ], provider: "test" }); },
    read: function (url) { return Promise.resolve({ title: "T", text: "PAGE CONTENT FOR " + url }); },
    complete: function (system, user, onDelta) {
      deps._user = user;
      onDelta("done");
      return Promise.resolve();
    },
    onDelta: function () {}
  };
  H.harness.runAgent(deps).then(function (out) {
    ok(searches === 1, "harness read: one search");
    ok(deps._user.indexOf("PAGE CONTENT FOR https://a.example/x") > -1, "harness read: page text lands in evidence");
    ok(deps._user.indexOf("Page contents:") > -1, "harness read: contents section present");
    ok(out.read === 2, "harness read: read count returned");
    ok(events.some(function (e) { return e.t === "reading"; }), "harness read: reading event emitted");

    /* read failure tolerated */
    var deps2 = {
      query: "q", emit: function () {},
      search: function () { return Promise.resolve({ results: [{ title: "A", url: "https://a.example/x", snippet: "s" }], provider: "t" }); },
      read: function () { return Promise.reject(new Error("down")); },
      complete: function (s, u, onDelta) { deps2._user = u; onDelta("x"); return Promise.resolve(); },
      onDelta: function () {}
    };
    H.harness.runAgent(deps2).then(function (out2) {
      ok(deps2._user.indexOf("Page contents:") === -1 && out2.read === 0, "harness read: failure tolerated, snippet evidence only");
      console.log("\n" + pass + " passed, " + fail + " failed");
      process.exit(fail ? 1 : 0);
    });
  }).catch(function (e) { ok(false, "harness read threw: " + e.message); console.log(pass + " passed, " + fail + " failed"); process.exit(1); });
})();
