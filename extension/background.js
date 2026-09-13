/* Impose Agent Bridge service worker: routes Impose page commands to X tabs.
   No page is touched until the user approves the action in Impose. */
"use strict";

var X_URLS = ["https://x.com/*", "https://twitter.com/*"];

function send(tabId, msg) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: "Empty reply from the tab." });
    });
  });
}

function xTabs() {
  return chrome.tabs.query({ url: X_URLS }).catch(function () { return []; });
}

function pickTab(tabId) {
  return xTabs().then(function (tabs) {
    if (!tabs.length) throw new Error("Open x.com in a tab first, and log in there.");
    if (tabId) {
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].id === tabId) return tabs[i];
      }
      throw new Error("That X tab is gone. Refresh the tab list.");
    }
    return tabs[0];
  });
}

/* Navigation happens here, not in the page, because navigating kills the
   content script context that would have to continue the work. */
function validThreadUrl(raw) {
  try {
    var u = new URL(String(raw || ""));
    return u.protocol === "https:" && (u.hostname === "x.com" || u.hostname === "twitter.com") &&
      /^\/messages(?:\/|$)/.test(u.pathname) ? u.href : "";
  } catch (e) { return ""; }
}

function gotoThread(tab, url) {
  if (!url) return Promise.resolve(tab);
  var target = validThreadUrl(url);
  if (!target) return Promise.reject(new Error("Refused a thread URL outside X messages."));
  var cur = (tab.url || "").split("?")[0];
  if (cur === target.split("?")[0]) return Promise.resolve(tab);
  /* Register before update: a cached navigation can complete before the
     update promise settles, which previously left the listener waiting for
     an event that had already happened. */
  return new Promise(function (resolve, reject) {
    var done = false;
    var to = setTimeout(function () { finish(new Error("Timed out opening the thread.")); }, 20000);
    function clean() {
      clearTimeout(to);
      chrome.tabs.onUpdated.removeListener(onU);
      chrome.tabs.onRemoved.removeListener(onR);
    }
    function finish(err, value) {
      if (done) return;
      done = true;
      clean();
      if (err) reject(err); else resolve(value);
    }
    function onR(id) { if (id === tab.id) finish(new Error("The X tab was closed.")); }
    function onU(id, info) {
      if (id !== tab.id || info.status !== "complete") return;
      setTimeout(function () {
        chrome.tabs.get(tab.id).then(function (fresh) {
          if ((fresh.url || "").split("?")[0] !== target.split("?")[0]) return;
          finish(null, fresh);
        }, function () { finish(new Error("The X tab is no longer available.")); });
      }, 800);
    }
    chrome.tabs.onUpdated.addListener(onU);
    chrome.tabs.onRemoved.addListener(onR);
    chrome.tabs.update(tab.id, { url: target }).catch(function (err) {
      finish(new Error(String((err && err.message) || err || "Could not open the thread.")));
    });
  });
}

function touch(status) {
  try {
    var s = status || {};
    s.at = Date.now();
    chrome.storage.local.set({ imposeStatus: s });
  } catch (e) { /* status is a nicety */ }
}

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  (function () {
    if (!msg || typeof msg.method !== "string") return Promise.resolve({ ok: false, error: "Bad message." });
    var p = msg.params || {};
    if (msg.method === "tabs.list") {
      return xTabs().then(function (tabs) {
        var list = tabs.map(function (t) { return { tabId: t.id, title: t.title || "", url: t.url || "" }; });
        touch({ tabs: list.length });
        return { ok: true, result: { tabs: list } };
      });
    }
    if (msg.method === "probe" || msg.method === "snapshot" || msg.method === "dm.list" || msg.method === "dm.send") {
      return pickTab(p.tabId).then(function (tab) {
        return gotoThread(tab, p.threadUrl).then(function (t2) {
          return send(t2.id, { method: msg.method, params: p }).then(function (r) {
            touch({ last: msg.method, ok: !!r.ok });
            return r;
          });
        });
      });
    }
    return Promise.resolve({ ok: false, error: "Unknown method: " + msg.method });
  })().then(function (r) { reply(r); }, function (err) {
    reply({ ok: false, error: String((err && err.message) || err) });
  });
  return true;
});
