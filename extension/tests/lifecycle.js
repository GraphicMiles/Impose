/* Companion-extension lifecycle/security checks. Run with Node. */
"use strict";
var fs = require("fs");
var path = require("path");
var bg = require("../background.js");
var generic = require("../content/generic-actions.js");
var root = path.join(__dirname, "..");
var page = fs.readFileSync(path.join(root, "..", "app.js"), "utf8");
var xActions = fs.readFileSync(path.join(root, "content", "x-actions.js"), "utf8");
var genericSource = fs.readFileSync(path.join(root, "content", "generic-actions.js"), "utf8");
var bridge = fs.readFileSync(path.join(root, "content", "impose-bridge.js"), "utf8");
var manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

var passed = 0;
function ok(value, name) {
  if (!value) throw new Error(name);
  passed += 1;
  console.log("PASS: " + name);
}

async function run() {
  ok(/^https:\/\/x\.com\/messages\//.test(bg.validThreadUrl("https://x.com/messages/123")), "X DM thread accepted");
  ok(/^https:\/\/twitter\.com\/messages\//.test(bg.validThreadUrl("https://twitter.com/messages/123")), "Twitter DM thread accepted");
  ok(bg.validThreadUrl("https://evil.example/messages/123") === "", "foreign DM navigation rejected");
  ok(bg.validPostUrl("https://x.com/user/status/123") !== "", "valid X post accepted");
  ok(bg.validPostUrl("https://x.com/messages/123") === "", "non-post X target rejected");
  ok(bg.validWebUrl("javascript:alert(1)") === "", "script navigation rejected");
  ok(bg.validWebUrl("https://user:secret@example.com/") === "", "credential-bearing URL rejected");
  ok(bg.validNavigationUrl("https://example.com/unsubscribe") === "" && bg.validNavigationUrl("https://example.com/search?q=docs") !== "", "unsafe GET side effects are rejected without blocking normal navigation");

  var nested = bg.attachTabId({ ok: true, result: { results: [] } }, 77);
  var direct = bg.attachTabId({ ok: true, sent: true }, 78);
  ok(nested.result.tabId === 77 && direct.tabId === 78, "X results retain their execution tab identity");

  ok(manifest.host_permissions.indexOf("<all_urls>") !== -1, "manifest requests selected all-site access");
  ok(manifest.content_scripts.some(function (entry) {
    return entry.js.indexOf("content/generic-actions.js") !== -1 && entry.matches.indexOf("http://*/*") !== -1 && entry.matches.indexOf("https://*/*") !== -1;
  }), "generic semantic driver is injected on HTTP and HTTPS pages");
  ok(generic.riskOf("Delete account") === "destructive" && generic.riskOf("Publish post") === "side-effect", "generic controls are classified by risk");
  ok(generic.elementRisk({ value: "", type: "submit", tagName: "BUTTON", form: { method: "post" }, getAttribute: function () { return ""; } }, "Continue") === "side-effect", "generic POST form submissions are classified as external effects");
  ok(generic.sensitiveField({ type: "password", autocomplete: "", name: "", id: "", getAttribute: function () { return ""; } }), "generic driver detects password fields");
  ok(generic.sensitiveField({ type: "text", autocomplete: "one-time-code", name: "", id: "", getAttribute: function () { return ""; } }), "generic driver detects one-time-code fields");
  ok(genericSource.indexOf('risk === "side-effect" && params.public !== true') !== -1, "generic side-effect controls require an approved-plan marker");
  ok(genericSource.indexOf("the page did not show a confirming state change") !== -1, "generic external clicks fail uncertain without rendered confirmation");
  ok(genericSource.indexOf("The page moved outside the approved site origins") !== -1, "generic actions recheck approved origin bounds at execution time");

  var updateListeners = [];
  var removedListeners = [];
  global.chrome = {
    tabs: {
      query: function () { return Promise.resolve([]); },
      create: function () { return Promise.resolve({ id: 91, url: "about:blank", active: true }); },
      update: function (id, update) {
        setTimeout(function () {
          updateListeners.slice().forEach(function (listener) { listener(id, { status: "complete" }); });
        }, 0);
        return Promise.resolve({ id: id, url: update.url });
      },
      get: function (id) { return Promise.resolve({ id: id, url: "https://example.com/", title: "Example", active: true }); },
      onUpdated: {
        addListener: function (listener) { updateListeners.push(listener); },
        removeListener: function (listener) { updateListeners = updateListeners.filter(function (item) { return item !== listener; }); }
      },
      onRemoved: {
        addListener: function (listener) { removedListeners.push(listener); },
        removeListener: function (listener) { removedListeners = removedListeners.filter(function (item) { return item !== listener; }); }
      }
    },
    storage: { local: { set: function () {} } }
  };
  var navigation = await bg.route({ method: "page.navigate", params: {
    url: "https://example.com/", allowedOrigins: ["https://example.com"]
  } }, { tab: { id: 5 } });
  ok(navigation.ok && navigation.result.tabId === 91, "navigation creates a usable tab when no web tab exists");

  global.chrome.tabs.query = function () {
    return Promise.resolve([
      { id: 5, url: "https://custom-impose.example/", title: "Impose", active: true },
      { id: 6, url: "https://example.org/", title: "Target", active: false }
    ]);
  };
  var tabs = await bg.route({ method: "browser.tabs", params: {} }, { tab: { id: 5 } });
  ok(tabs.result.tabs.length === 1 && tabs.result.tabs[0].tabId === 6, "browser tab discovery excludes the Impose control tab");

  var sendTimeout = /var EXT_SEND_TIMEOUT = (\d+);/.exec(page);
  ok(sendTimeout && +sendTimeout[1] >= 55000, "frontend timeout covers navigation and confirmation");
  ok(xActions.indexOf("confirmed: true") !== -1 && xActions.indexOf("uncertain: true") !== -1, "X side effects distinguish confirmation from uncertainty");
  ok(bridge.indexOf("uncertain: !!(resp && resp.uncertain)") !== -1, "uncertain extension outcomes reach the app boundary");
  ok(page.indexOf("savePendingBrowserPlan(null)") !== -1 && page.indexOf("/approve") !== -1, "approval state is consumed before bounded execution");
  ok(page.indexOf("impose.browser-run.v1") !== -1 && page.indexOf("recoverInterruptedBrowserRun") !== -1, "interrupted browser execution has persistent recovery state");
  ok(page.indexOf('navigator.locks.request("impose-browser-execution"') !== -1, "cross-tab execution uses a single-task browser lock");
  ok(page.indexOf("settleUntil") !== -1 && page.indexOf("browserRecoveryHoldUntil") !== -1, "interrupted in-flight actions retain a bounded settling window");

  console.log(passed + " passed, 0 failed");
}

run().catch(function (error) {
  console.error("FAIL: " + error.message);
  process.exitCode = 1;
});
