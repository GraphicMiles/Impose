/* Impose audit runner. Executes scenario batches, writes a machine-readable
   ledger (JSON + CSV) and a grouped failure report.
   Usage: node audit/run.js [--only=agent,core] [--out=DIR] [--seed=N] */
"use strict";
var fs = require("fs");
var path = require("path");
var L = require("./lib.js");

var argv = {};
process.argv.slice(2).forEach(function (a) {
  var m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) argv[m[1]] = m[2] === undefined ? true : m[2];
});
var OUT = argv.out || path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

var only = argv.only ? String(argv.only).split(",") : null;
var available = fs.readdirSync(__dirname).filter(function (f) {
  return /^[a-z]+\.js$/.test(f) && ["lib.js", "run.js", "report.js"].indexOf(f) === -1;
}).sort();
var modules = available.filter(function (f) {
  var n = f.replace(/\.js$/, "");
  return !only || only.indexOf(n) !== -1;
}).map(function (f) { return f.replace(/\.js$/, ""); });

var fw = new L.Framework({ seed: Number(argv.seed || 20260915) });

function runBatch(label, jobs) {
  process.stdout.write(label + ": " + jobs.length + " scenarios\n");
  var i = 0;
  return jobs.reduce(function (chain, job) {
    return chain.then(function () {
      i += 1;
      return Promise.resolve().then(job).then(null, function (e) {
        return fw.scenario(label + ".unevaluated-" + i, { title: "scenario could not be driven to a verdict" }, function () {
          return { blocked: true, actual: String(e && e.message || e).slice(0, 200),
            reason: "the harness could not exercise this path; recorded as blocked, never as a pass" };
        });
      }).then(function () {
        if (i % 250 === 0) process.stdout.write("  ... " + i + "/" + jobs.length + "\n");
      });
    });
  }, Promise.resolve()).then(function () {
    process.stdout.write(label + ": complete (" + i + " executed)\n");
  });
}

function quote(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""').replace(/\n/g, " ") + '"'; }

var chain = Promise.resolve();
modules.forEach(function (name) {
  chain = chain.then(function () {
    var mod = require("./" + name + ".js");
    return runBatch(mod.name, mod.build(fw));
  });
});

chain.then(function () {
  var s = fw.summary();
  fs.writeFileSync(path.join(OUT, "ledger.json"), JSON.stringify(fw.ledger, null, 1));
  fs.writeFileSync(path.join(OUT, "ledger.csv"),
    "scenario_id,category,title,preconditions,action,expected,actual,result,error,severity,root_cause,fix,regression_test\n" +
    fw.ledger.map(function (r) {
      return [r.id, r.category, quote(r.title), quote(r.preconditions), quote(r.action), quote(r.expected),
        quote(r.actual), r.status, quote(r.error), r.severity, quote(r.rootCause), quote(r.fix), quote(r.regressionTest)].join(",");
    }).join("\n"));

  var byRoot = {};
  fw.ledger.filter(function (r) { return r.status === "fail"; }).forEach(function (r) {
    var k = r.rootCause || "unclassified";
    var row = byRoot[k] = byRoot[k] || { count: 0, severity: r.severity, sample: r, categories: {} };
    row.count += 1;
    row.categories[r.category] = (row.categories[r.category] || 0) + 1;
  });

  console.log("\n==== SUMMARY ====");
  console.log("total scenarios: " + s.total + " | passed: " + s.pass + " | failed: " + s.fail + " | blocked: " + (s.blocked || 0));
  Object.keys(s.byCategory).sort().forEach(function (k) { console.log("   " + k + ": " + s.byCategory[k]); });
  console.log("\n==== DISTINCT ROOT CAUSES (failures grouped) ====");
  Object.keys(byRoot).sort(function (a, b) { return byRoot[b].count - byRoot[a].count; }).forEach(function (k) {
    console.log("[" + byRoot[k].severity + "] " + k + "  x" + byRoot[k].count);
    console.log("     sample: " + String(byRoot[k].sample.error).slice(0, 150));
    console.log("     actual: " + String(byRoot[k].sample.actual).slice(0, 150));
  });
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({
    total: s.total, pass: s.pass, fail: s.fail, blocked: s.blocked || 0,
    byCategory: s.byCategory, bySeverity: s.bySeverity,
    rootCauses: Object.keys(byRoot).map(function (k) {
      return { rootCause: k, count: byRoot[k].count, severity: byRoot[k].severity, categories: byRoot[k].categories };
    })
  }, null, 1));
}).catch(function (e) { console.error("RUNNER ERROR", e && e.stack || e); process.exit(2); });
