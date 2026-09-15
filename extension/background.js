/* Impose Agent Bridge service worker. It routes approved plans to semantic
   page actions and keeps platform-specific behavior behind explicit methods. */
"use strict";

var X_URLS = ["https://x.com/*", "https://twitter.com/*"];
var WEB_URLS = ["http://*/*", "https://*/*"];
var PAGE_METHODS = ["page.snapshot", "page.click", "page.type", "page.select", "page.scroll", "page.wait"];
var X_METHODS = ["probe", "snapshot", "dm.list", "dm.send", "x.post", "x.reply", "x.results"];
/* Methods that change something outside this browser. Each one must present the
   single-use token the client mints when it consumes the user approval, so a replay,
   a duplicate tab event, or a client bug cannot publish twice on the user's behalf. */
var SIDE_EFFECT_METHODS = ["x.post", "x.reply", "dm.send"];

function messageTab(tabId, message) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, message, function (response) {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "Empty reply from the tab." });
    });
  });
}

function xTabs() {
  return chrome.tabs.query({ url: X_URLS }).catch(function () { return []; });
}

function webTabs(excludeTabId) {
  return chrome.tabs.query({ url: WEB_URLS }).then(function (tabs) {
    return tabs.filter(function (tab) {
      if (excludeTabId && tab.id === excludeTabId) return false;
      try { return new URL(tab.url).hostname !== "impose-web.onrender.com"; }
      catch (error) { return false; }
    });
  }).catch(function () { return []; });
}

function findTab(tabs, tabId, missingMessage) {
  if (!tabs.length) throw new Error(missingMessage);
  if (!tabId) return tabs[0];
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].id === tabId) return tabs[i];
  }
  throw new Error("That tab is gone. Refresh the tab list.");
}

function pickXTab(tabId) {
  return xTabs().then(function (tabs) {
    return findTab(tabs, tabId, "Open x.com in a tab first, and log in there.");
  });
}

function pickWebTab(tabId, excludeTabId) {
  return webTabs(excludeTabId).then(function (tabs) {
    return findTab(tabs, tabId, "Open the website you want Impose to use in a tab first.");
  });
}

function createWebTab() {
  return chrome.tabs.create({ url: "about:blank", active: true });
}

function pickOrCreateWebTab(tabId, excludeTabId) {
  if (tabId) return pickWebTab(tabId, excludeTabId);
  return webTabs(excludeTabId).then(function (tabs) { return tabs[0] || createWebTab(); });
}

function createXTab() {
  return chrome.tabs.create({ url: "about:blank", active: true });
}

function pickOrCreateXTab(tabId) {
  return xTabs().then(function (tabs) {
    if (tabId) {
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].id === tabId) return tabs[i];
      }
    }
    return tabs[0] || createXTab();
  });
}

function validWebUrl(raw) {
  try {
    var url = new URL(String(raw || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch (error) {
    return "";
  }
}

function validNavigationUrl(raw) {
  var value = validWebUrl(raw);
  if (!value) return "";
  var url = new URL(value);
  if (/\/(?:logout|signout|unsubscribe|delete-account|close-account|checkout|place-order|confirm-purchase|transfer)(?:\/|$)/i.test(url.pathname)) return "";
  var intent = String(url.searchParams.get("action") || url.searchParams.get("intent") || "").toLowerCase();
  if (["delete", "remove", "unsubscribe", "purchase", "transfer", "logout"].indexOf(intent) !== -1) return "";
  return value;
}

var spentApprovals = Object.create(null);
var approvalChain = Promise.resolve();

function approvalTokenShape(token) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,120}$/.test(String(token || ""));
}

function claimApproval(method, token) {
  if (SIDE_EFFECT_METHODS.indexOf(method) === -1) return Promise.resolve("");
  var value = String(token || "");
  if (!approvalTokenShape(value)) {
    return Promise.resolve("A side effect needs the single-use token from the approval the user just confirmed.");
  }
  /* Serialized so two requests arriving together cannot both read "unspent". */
  approvalChain = approvalChain.then(function () {
    if (spentApprovals[value]) return "That approval was already spent. Nothing was sent a second time.";
    spentApprovals[value] = true;
    return "";
  });
  return approvalChain;
}

function hasApprovedOrigin(params, origin) {
  return !!params && Array.isArray(params.allowedOrigins) && params.allowedOrigins.indexOf(origin) !== -1;
}

function isXUrl(raw) {
  try {
    var url = new URL(String(raw || ""));
    return url.protocol === "https:" && (url.hostname === "x.com" || url.hostname === "twitter.com");
  } catch (error) {
    return false;
  }
}

function validThreadUrl(raw) {
  var url = validWebUrl(raw);
  if (!url || !isXUrl(url)) return "";
  return /^\/messages(?:\/|$)/.test(new URL(url).pathname) ? url : "";
}

function validPostUrl(raw) {
  var url = validWebUrl(raw);
  if (!url || !isXUrl(url)) return "";
  return /^\/[^/]+\/status\/\d+(?:\/|$)/.test(new URL(url).pathname) ? url : "";
}

/* Register listeners before navigation because cached pages can finish before
   chrome.tabs.update resolves. The validator catches login redirects for
   platform-specific actions while generic browsing may follow normal redirects. */
function navigateTab(tab, rawUrl, validator) {
  var target = validWebUrl(rawUrl);
  if (!target) return Promise.reject(new Error("Only normal HTTP and HTTPS destinations are allowed."));
  return new Promise(function (resolve, reject) {
    var finished = false;
    var timer = setTimeout(function () {
      finish(new Error("Timed out opening the page."));
    }, 25000);

    function clean() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clean();
      if (error) reject(error);
      else resolve(value);
    }

    function onRemoved(id) {
      if (id === tab.id) finish(new Error("The target tab was closed."));
    }

    function onUpdated(id, info) {
      if (id !== tab.id || info.status !== "complete") return;
      setTimeout(function () {
        chrome.tabs.get(tab.id).then(function (fresh) {
          if (validator && !validator(fresh.url || "")) {
            finish(new Error("The site redirected away from the required page. Check that you are logged in."));
            return;
          }
          finish(null, fresh);
        }, function () {
          finish(new Error("The target tab is no longer available."));
        });
      }, 500);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.update(tab.id, { url: target }).catch(function (error) {
      finish(new Error(String((error && error.message) || error || "Could not open the page.")));
    });
  });
}

function gotoThread(tab, url) {
  if (!url) return Promise.resolve(tab);
  var target = validThreadUrl(url);
  if (!target) return Promise.reject(new Error("Refused a thread URL outside X messages."));
  if ((tab.url || "").split("?")[0] === target.split("?")[0]) return Promise.resolve(tab);
  return navigateTab(tab, target, function (finalUrl) {
    return validThreadUrl(finalUrl).split("?")[0] === target.split("?")[0];
  });
}

function tabSummary(tab) {
  return {
    tabId: tab.id,
    title: String(tab.title || "").slice(0, 200),
    url: String(tab.url || "").slice(0, 2000),
    active: !!tab.active
  };
}

function attachTabId(response, tabId) {
  var value = response || { ok: false, error: "Empty reply from the tab." };
  if (value.ok && value.result && typeof value.result === "object") value.result.tabId = tabId;
  else if (value.ok) value.tabId = tabId;
  return value;
}

function touch(status) {
  try {
    var value = status || {};
    value.at = Date.now();
    chrome.storage.local.set({ imposeStatus: value });
  } catch (error) { /* Status display is best effort only. */ }
}

function route(message, sender) {
  if (!message || typeof message.method !== "string") {
    return Promise.resolve({ ok: false, error: "Bad message." });
  }
  var method = message.method;
  var params = message.params || {};
  var sourceTabId = sender && sender.tab ? sender.tab.id : 0;

  return claimApproval(method, params.approvalToken).then(function (denied) {
    if (denied) return { ok: false, error: denied, denied: "approval" };
    return dispatch(method, params, sourceTabId, sender);
  });
}

function dispatch(method, params, sourceTabId, sender) {

  if (method === "tabs.list") {
    return xTabs().then(function (tabs) {
      var list = tabs.slice(0, 50).map(tabSummary);
      touch({ tabs: list.length });
      return { ok: true, result: { tabs: list } };
    });
  }

  if (method === "browser.tabs") {
    return webTabs(sourceTabId).then(function (tabs) {
      var list = tabs.slice(0, 50).map(tabSummary);
      touch({ tabs: list.length });
      return { ok: true, result: { tabs: list } };
    });
  }

  if (method === "page.navigate") {
    var destination = validNavigationUrl(params.url);
    if (!destination) return Promise.resolve({ ok: false, error: "That destination could trigger an unsafe external action." });
    if (!Array.isArray(params.allowedOrigins) || params.allowedOrigins.indexOf(new URL(destination).origin) === -1) {
      return Promise.resolve({ ok: false, error: "That destination is outside the approved site origins." });
    }
    return pickOrCreateWebTab(params.tabId, sourceTabId).then(function (tab) {
      return navigateTab(tab, destination).then(function (fresh) {
        return { ok: true, result: tabSummary(fresh) };
      });
    });
  }

  if (PAGE_METHODS.indexOf(method) !== -1) {
    return pickWebTab(params.tabId, sourceTabId).then(function (tab) {
      return messageTab(tab.id, { method: method, params: params });
    });
  }

  if (method === "x.search") {
    if (!hasApprovedOrigin(params, "https://x.com")) {
      return Promise.resolve({ ok: false, error: "X is outside the approved site origins." });
    }
    var query = String(params.query || "").trim().slice(0, 500);
    if (!query) return Promise.resolve({ ok: false, error: "X search needs a query." });
    var mode = params.mode === "latest" ? "live" : "top";
    var searchUrl = "https://x.com/search?q=" + encodeURIComponent(query) + "&src=typed_query&f=" + mode;
    return pickOrCreateXTab(params.tabId).then(function (tab) {
      return navigateTab(tab, searchUrl, isXUrl).then(function (fresh) {
        return messageTab(fresh.id, { method: "x.results", params: params }).then(function (response) {
          return attachTabId(response, fresh.id);
        });
      });
    });
  }

  if (method === "x.post") {
    if (!hasApprovedOrigin(params, "https://x.com")) {
      return Promise.resolve({ ok: false, error: "X is outside the approved site origins." });
    }
    return pickOrCreateXTab(params.tabId).then(function (tab) {
      return navigateTab(tab, "https://x.com/compose/post", isXUrl).then(function (fresh) {
        return messageTab(fresh.id, { method: "x.post", params: params }).then(function (response) {
          return attachTabId(response, fresh.id);
        });
      });
    });
  }

  if (method === "x.reply") {
    var postUrl = validPostUrl(params.url || "");
    if (!postUrl) return Promise.resolve({ ok: false, error: "A valid X post URL is required for a reply." });
    if (!hasApprovedOrigin(params, new URL(postUrl).origin)) {
      return Promise.resolve({ ok: false, error: "The reply target is outside the approved site origins." });
    }
    return pickOrCreateXTab(params.tabId).then(function (tab) {
      return navigateTab(tab, postUrl, function (finalUrl) {
        return validPostUrl(finalUrl).split("?")[0] === postUrl.split("?")[0];
      }).then(function (fresh) {
        return messageTab(fresh.id, { method: "x.reply", params: params }).then(function (response) {
          return attachTabId(response, fresh.id);
        });
      });
    });
  }

  if (X_METHODS.indexOf(method) !== -1) {
    return pickXTab(params.tabId).then(function (tab) {
      return gotoThread(tab, params.threadUrl).then(function (ready) {
        return messageTab(ready.id, { method: method, params: params }).then(function (response) {
          return attachTabId(response, ready.id);
        });
      });
    });
  }

  return Promise.resolve({ ok: false, error: "Unknown method: " + method });
}

function registerWorker() {
  chrome.runtime.onMessage.addListener(function (message, sender, reply) {
    route(message, sender).then(function (result) {
      touch({ last: message && message.method, ok: !!(result && result.ok) });
      reply(result);
    }, function (error) {
      touch({ last: message && message.method, ok: false });
      reply({ ok: false, error: String((error && error.message) || error) });
    });
    return true;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    validWebUrl: validWebUrl,
    validNavigationUrl: validNavigationUrl,
    validThreadUrl: validThreadUrl,
    validPostUrl: validPostUrl,
    isXUrl: isXUrl,
    attachTabId: attachTabId,
    route: route
  };
} else {
  registerWorker();
}
