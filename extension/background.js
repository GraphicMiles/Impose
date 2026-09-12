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
function gotoThread(tab, url) {
  if (!url) return Promise.resolve(tab);
  var cur = (tab.url || "").split("?")[0];
  if (cur === String(url).split("?")[0]) return Promise.resolve(tab);
  return chrome.tabs.update(tab.id, { url: url }).then(function () {
    return new Promise(function (resolve, reject) {
      var to = setTimeout(function () {
        chrome.tabs.onUpdated.removeListener(onU);
        reject(new Error("Timed out opening the thread."));
      }, 20000);
      function onU(id, info) {
        if (id === tab.id && info.status === "complete") {
          clearTimeout(to);
          chrome.tabs.onUpdated.removeListener(onU);
          setTimeout(function () {
            chrome.tabs.get(tab.id).then(resolve, function () { resolve(tab); });
          }, 800);
        }
      }
      chrome.tabs.onUpdated.addListener(onU);
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
