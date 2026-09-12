/* Harness tests. No deps, plain node asserts. Run: node agent/tests/run.js */
var path = require("path");
var H = require(path.join(__dirname, "..", "harness.js"));

var passed = 0;
var failed = 0;
var queue = [];

function test(name, fn) { queue.push([name, fn]); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || "eq") + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b));
}
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }
function throws(fn, part, msg) {
  try { fn(); } catch (e) {
    if (part && String(e.message).indexOf(part) === -1) {
      throw new Error((msg || "throws") + ": wrong message: " + e.message);
    }
    return;
  }
  throw new Error((msg || "throws") + ": did not throw");
}

function fakeTool(id) {
  return { id: id, capabilities: ["search"], run: function () { return Promise.resolve({}); } };
}

test("register and resolve", function () {
  var h = H.createHarness();
  h.registerTool(fakeTool("a.tool"));
  eq(h.tools().length, 1, "count");
  eq(h.resolve("search").id, "a.tool", "resolves");
});

test("register rejects bad tools", function () {
  var h = H.createHarness();
  throws(function () { h.registerTool(null); }, "id");
  throws(function () { h.registerTool({ id: "x", capabilities: ["s"] }); }, "run");
  throws(function () { h.registerTool({ id: "x", run: function () {} }); }, "capabilities");
  h.registerTool(fakeTool("dup"));
  throws(function () { h.registerTool(fakeTool("dup")); }, "already registered");
});

test("resolve unknown capability throws", function () {
  throws(function () { H.createHarness().resolve("browse"); }, "No tool");
});

test("default harness ships websearch", function () {
  eq(H.harness.resolve("search").id, "web.search", "default tool");
});

test("simplifyQuery strips framing", function () {
  eq(H.simplifyQuery("What phones?"), "phones", "question");
  eq(H.simplifyQuery("phones under 300k"), "phones under 300k", "plain");
  eq(H.simplifyQuery("???"), "", "empty");
});

test("domainOf reads hosts", function () {
  eq(H.domainOf("https://www.jumia.com.ng/x"), "jumia.com.ng", "host");
  eq(H.domainOf("garbage"), "", "garbage");
});

function searchStub(script) {
  var calls = [];
  return {
    calls: calls,
    fn: function (q, limit) {
      calls.push([q, limit]);
      var next = script[Math.min(calls.length - 1, script.length - 1)];
      return Promise.resolve(next);
    }
  };
}

test("websearch run passes results through", function () {
  var s = searchStub([{ results: [{ title: "A", url: "https://a.io/", snippet: "x" }], provider: "p" }]);
  var emits = [];
  return H.websearchTool.run({ query: "phones" }, { search: s.fn, emit: function (e) { emits.push(e); } }).then(function (out) {
    eq(out.results.length, 1, "count");
    eq(out.retried, false, "no retry");
    eq(emits.length, 1, "one query event");
    eq(emits[0].q, "phones", "query echoed");
  });
});

test("websearch retries empty with simpler query", function () {
  var s = searchStub([{ results: [], provider: "p" }, { results: [{ title: "B", url: "https://b.io/" }], provider: "p" }]);
  return H.websearchTool.run({ query: "What phones?" }, { search: s.fn, emit: function () {} }).then(function (out) {
    eq(s.calls.length, 2, "two calls");
    eq(s.calls[1][0], "phones", "simplified retry");
    eq(out.retried, true, "retried flag");
    eq(out.results.length, 1, "found");
  });
});

test("websearch gives up honestly when retry is empty", function () {
  var s = searchStub([{ results: [] }]);
  return H.websearchTool.run({ query: "phones" }, { search: s.fn, emit: function () {} }).then(function (out) {
    eq(out.results.length, 0, "empty");
  });
});

test("websearch rejects bad input", function () {
  return H.websearchTool.run({ query: "  " }, { search: function () {}, emit: function () {} }).then(function () {
    throw new Error("should have rejected");
  }, function (e) {
    ok(/query/.test(e.message), "message names query");
  });
});

test("runAgent full flow emits the pipeline", function () {
  var s = searchStub([{ results: [
    { title: "A", url: "https://a.io/", snippet: "sa" },
    { title: "B", url: "https://b.io/", snippet: "sb" }
  ], provider: "p" }]);
  var emits = [];
  var deltas = [];
  var completed = null;
  return H.harness.runAgent({
    query: "phones",
    search: s.fn,
    emit: function (e) { emits.push(e.t); },
    onDelta: function (c) { deltas.push(c); },
    complete: function (system, user, onDelta) {
      completed = { system: system, user: user };
      onDelta("hi");
      return Promise.resolve();
    }
  }).then(function (out) {
    eq(emits.join(","), "status,query,source,source,settle", "event order");
    eq(deltas.join(""), "hi", "delta forwarded");
    ok(completed.system.indexOf("cite sources by number like [1]") !== -1, "cites sources");
    ok(completed.system.indexOf("answer from your own knowledge anyway") !== -1, "knowledge fallback");
    ok(completed.user.indexOf("[1] A") !== -1 && completed.user.indexOf("[2] B") !== -1, "numbered evidence");
    eq(out.sources.length, 2, "sources returned");
  });
});

test("runAgent answers from knowledge when results are empty", function () {
  var s = searchStub([{ results: [] }]);
  var completed = null;
  var emits = [];
  return H.harness.runAgent({
    query: "phones",
    search: s.fn,
    emit: function (e) { emits.push(e.t); },
    onDelta: function () {},
    complete: function (system, user) {
      completed = { system: system, user: user };
      return Promise.resolve();
    }
  }).then(function (out) {
    ok(completed, "completes");
    ok(completed.system.indexOf("found nothing") !== -1, "says so");
    eq(completed.user, "phones", "question passed through");
    eq(emits.join(","), "status,query,settle", "pipeline shown");
    eq(out.sources.length, 0, "no sources");
  });
});

test("runAgent with no tool rejects", function () {
  return H.createHarness().runAgent({
    query: "x", search: function () {}, emit: function () {},
    onDelta: function () {}, complete: function () {}
  }).then(function () {
    throw new Error("should have rejected");
  }, function (e) {
    ok(/No tool/.test(e.message), "names the gap");
  });
});

test("runAgent honors abort before completing", function () {
  var s = searchStub([{ results: [{ title: "A", url: "https://a.io/" }] }]);
  return H.harness.runAgent({
    query: "x", search: s.fn, emit: function () {}, onDelta: function () {},
    signal: { aborted: true },
    complete: function () { return Promise.resolve(); }
  }).then(function () {
    throw new Error("should have rejected");
  }, function (e) {
    eq(e.name, "AbortError", "abort propagates");
  });
});

test("runAgent searches the rewritten query", function () {
  var s = searchStub([{ results: [{ title: "A", url: "https://a.io/" }], provider: "p" }]);
  var emits = [];
  var completed = null;
  return H.harness.runAgent({
    query: "Walk me through a Python function line by line",
    rewrite: function (q) {
      eq(q.indexOf("Python") !== -1, true, "rewrite sees the question");
      return Promise.resolve("Python function explained line by line");
    },
    search: s.fn,
    emit: function (e) { emits.push(e.t); },
    onDelta: function () {},
    complete: function (system, user) { completed = user; return Promise.resolve(); }
  }).then(function () {
    eq(s.calls[0][0], "Python function explained line by line", "planned query searched");
    eq(emits.join(","), "status,status,query,source,settle", "planning beat shown");
    ok(completed.indexOf("Walk me through") === 0, "synthesis keeps the original question");
  });
});

test("runAgent falls back to raw words when rewrite fails", function () {
  var s = searchStub([{ results: [{ title: "A", url: "https://a.io/" }] }]);
  return H.harness.runAgent({
    query: "phones under 300k",
    rewrite: function () { return Promise.reject(new Error("nope")); },
    search: s.fn,
    emit: function () {},
    onDelta: function () {},
    complete: function () { return Promise.resolve(); }
  }).then(function () {
    eq(s.calls[0][0], "phones under 300k", "raw query searched");
  });
});

async function main() {
  for (var i = 0; i < queue.length; i++) {
    try {
      await queue[i][1]();
      passed++;
      console.log("PASS: " + queue[i][0]);
    } catch (e) {
      failed++;
      console.log("FAIL: " + queue[i][0] + " :: " + (e && e.message));
    }
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main();
