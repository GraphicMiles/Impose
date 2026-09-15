/* Impose audit harness: shared scenario framework.
   Deterministic, seeded, no network. Run via audit/run.js. */
"use strict";
var path = require("path");
var ROOT = path.join(__dirname, "..");

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  var r = mulberry32(seed);
  var api = {
    next: r,
    int: function (lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); },
    pick: function (arr) { return arr[Math.floor(r() * arr.length)]; },
    bool: function (p) { return r() < (p == null ? 0.5 : p); },
    shuffle: function (arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    },
    string: function (n, alphabet) {
      var chars = alphabet || "abcdefghijklmnopqrstuvwxyz0123456789 -_.:/<>\"'&;#%\\|";
      var out = "";
      for (var i = 0; i < n; i++) out += chars[Math.floor(r() * chars.length)];
      return out;
    }
  };
  return api;
}

function Framework(opts) {
  opts = opts || {};
  this.ledger = [];
  this.seq = 0;
  this.seed = opts.seed || 20260915;
  this.currentCategory = "uncategorized";
  this.fixes = opts.fixes || {};
}

Framework.prototype.scenario = function (id, meta, fn) {
  var self = this;
  this.seq += 1;
  var row = {
    seq: this.seq, id: id || (this.currentCategory + "-" + this.seq), category: meta.category || this.currentCategory,
    title: meta.title || "", preconditions: meta.pre || "", action: meta.action || "",
    expected: meta.expect || "", status: "planned", actual: "", error: "",
    severity: meta.severity || "P3", rootCause: "", fix: "", regressionTest: ""
  };
  var done = false;
  var timer = null;
  var work = Promise.resolve().then(function () { return fn(self); });
  work.catch(function () { /* handled below */ });
  var guard = new Promise(function (resolve) {
    timer = setTimeout(function () { if (!done) { done = true; resolve({ __timeout: true }); } }, meta.timeoutMs || 5000);
  });
  return Promise.race([work, guard]).then(function settle(result) {
    if (result && result.__timeout) {
      row.status = "fail"; row.actual = "(no settlement within " + (meta.timeoutMs || 5000) + "ms)";
      row.error = "operation never completes; matches the forbidden 'loading forever' failure class";
      row.severity = "P1"; row.rootCause = "operation-never-settles";
      self.ledger.push(row); return row;
    }
    clearTimeout(timer);
    return Promise.resolve(result).then(function (value) {
      done = true;
      if (value && typeof value === "object" && value.blocked) {
        row.status = "blocked";
        row.actual = String(value.actual || "").slice(0, 300);
        row.error = String(value.reason || "not evaluable").slice(0, 300);
        self.ledger.push(row); return row;
      }
      if (value && typeof value === "object" && value.invariant === false) {
        row.status = "fail";
        row.actual = String(value.actual || "").slice(0, 300);
        row.error = String(value.reason || "invariant violated").slice(0, 300);
        row.rootCause = String(value.rootCause || "").slice(0, 400);
        row.severity = value.severity || row.severity;
      } else {
        row.status = "pass";
        row.actual = String(value == null ? "" : (typeof value === "object" ? JSON.stringify(value).slice(0, 200) : value)).slice(0, 300);
      }
      self.ledger.push(row);
      return row;
    }, function (error) {
      done = true;
      row.status = "fail"; row.actual = "(threw)";
      row.error = String((error && error.message) || error).slice(0, 300);
      row.rootCause = "uncaught-exception-in-scenario";
      self.ledger.push(row);
      return row;
    });
  });
};

/* Turns a bare invariant-returning closure into a recorded scenario. */
Framework.prototype.emit = function (list, category, title, fn) {
  var self = this;
  list.push(function () {
    return self.scenario(category + "." + (self.seq + 1), { title: title, category: category }, fn);
  });
};

/* Marks a scenario as blocked (harness/environment cannot prove it) instead
   of pretending it passed or failed. */
Framework.BLOCKED = { __blocked: true };

/* A scenario asserts via invariant objects; this helper keeps call sites short. */
Framework.prototype.check = function (condition, detail) {
  if (condition) return { invariant: true };
  return Object.assign({ invariant: false }, detail || {});
};

Framework.prototype.blocked = function (reason) {
  return { __blocked: reason };
};

Framework.prototype.summary = function () {
  var out = { total: this.ledger.length, pass: 0, fail: 0, byCategory: {}, bySeverity: {}, failures: [] };
  var self = this;
  this.ledger.forEach(function (row) {
    if (row.status === "fail") { out.fail += 1; out.failures.push(row); } else { out.pass += 1; }
    out.byCategory[row.category] = (out.byCategory[row.category] || 0) + 1;
    if (row.status === "fail") out.bySeverity[row.severity] = (out.bySeverity[row.severity] || 0) + 1;
  });
  out.fixesApplied = Object.keys(this.fixes).map(function (k) { return { defect: k, commit: self.fixes[k] }; });
  return out;
};

/* Loads a browser-targeted Impose script into a sandbox with a minimal DOM. */
var vm = require("vm");
function loadScript(relPath, sandboxExtra) {
  var fs = require("fs");
  var src = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  var store = {};
  var sandbox = Object.assign({
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
    TextEncoder: TextEncoder, TextDecoder: TextDecoder, URL: URL,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    module: undefined, exports: undefined,
    globalThis: undefined
  }, sandboxExtra || {});
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: relPath });
  return { sandbox: sandbox, store: store };
}

module.exports = { makeRng: makeRng, Framework: Framework, loadScript: loadScript, ROOT: ROOT, path: path };
