/* Global debug bus.

   The debug panel already existed, but only app.js could write to it and
   only when someone remembered to call dnote(). That meant 39 hand-placed
   lines in Workspace, nothing at all from Community, and no record of the
   things you actually need when something breaks: the request that 500ed,
   the promise nobody caught, the Supabase row that was refused by a
   policy.

   This module is the collection layer. It installs itself before anything
   else runs, records into a ring buffer, and lets app.js attach the panel
   later. Two consequences of that ordering matter:

     - a failure during startup is captured even though no UI exists yet,
       which is exactly when the old panel was blindest;

     - nothing here depends on the panel existing, so Community, access.js
       and the auth pages all log through the same bus without importing
       any of Workspace.

   Everything is redacted on the way in, not on the way out. The buffer is
   copied into bug reports and pasted into chats, so a credential that
   reaches it has already leaked. Redacting at the boundary means there is
   no path that stores the raw value.
*/
(function () {
  "use strict";

  if (window.BotoDebug) return;

  var MAX = 800;
  var entries = [];
  var listeners = [];
  var seq = 0;

  /* ---------- redaction ----------
     Deliberately aggressive. A log that occasionally hides something
     harmless is a nuisance; a log that occasionally reveals a token is an
     incident. When in doubt these rules drop the value. */

  function redactUrl(url) {
    var out = String(url == null ? "" : url);
    /* user:pass@host */
    out = out.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^\/@:?#]+(:[^\/@?#]*)?@/gi, "$1redacted@");
    /* any query parameter whose NAME looks credential shaped */
    out = out.replace(
      /[?&][^=&#]*(?:key|token|secret|password|passwd|credential|authorization|bearer|signature|api[-_]?key)[^=&#]*=[^&#]*/gi,
      function (pair) { return pair.slice(0, pair.indexOf("=") + 1) + "\u2026"; }
    );
    /* short exact names, matched exactly so design= and assign= survive */
    out = out.replace(/([?&])(sig|auth|code|otp|token|jwt)=[^&#]*/gi,
      function (pair, mark, name) { return mark + name + "\u2026"; });
    return out;
  }

  function redactText(value) {
    return String(value == null ? "" : value)
      /* known key shapes, including the ones this project actually uses */
      .replace(/\b(?:sk[-_]|gsk_|ghp_|github_pat_|sbp_|sb_secret_)[a-z0-9_-]{8,}\b/gi, "[redacted credential]")
      .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]+/gi, "[redacted jwt]")
      .replace(/\bBearer\s+[a-z0-9._~+\/-]{8,}=*/gi, "Bearer [redacted]")
      .replace(/\borg_[a-z0-9]+\b/gi, "org_\u2026")
      /* a bare 8 digit run next to code/otp wording is a live one-time code */
      .replace(/\b(code|otp)\b([^0-9]{0,12})\d{6,8}\b/gi, "$1$2\u2026");
  }

  /* Bodies are the most useful and most dangerous thing in a log. Capped
     hard, and passwords are removed by key name before the cap so a long
     body cannot push one past the truncation point. */
  function redactBody(body, cap) {
    var text;
    if (body == null) return "";
    if (typeof body === "string") text = body;
    else if (typeof FormData !== "undefined" && body instanceof FormData) return "[form data]";
    else if (typeof Blob !== "undefined" && body instanceof Blob) return "[blob " + body.size + "b]";
    else {
      try { text = JSON.stringify(body); } catch (e) { return "[unserialisable body]"; }
    }
    text = text.replace(/("(?:password|passwd|pass|secret|token|api[-_]?key|code)"\s*:\s*)"[^"]*"/gi, '$1"\u2026"');
    text = redactText(text);
    var limit = cap || 600;
    return text.length > limit ? text.slice(0, limit) + "\u2026 [" + text.length + " chars]" : text;
  }

  /* ---------- the bus ---------- */

  function push(level, where, what, detail) {
    if (level !== "error" && level !== "warn") level = "info";
    var entry = {
      id: ++seq,
      t: new Date(),
      level: level,
      where: String(where || "app").slice(0, 16),
      what: redactText(what).replace(/\s+/g, " ").trim().slice(0, 500),
      detail: detail ? redactText(detail).slice(0, 2000) : ""
    };
    entries.push(entry);
    /* Drop from the front: the oldest line is the least useful one when a
       buffer this size overflows, because whatever you are debugging just
       happened. */
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](entry); } catch (e) {}
    }
    return entry;
  }

  /* ---------- automatic capture ----------
     The point of the rewrite. None of the below needs a call site, which
     is why it catches the things hand-placed logging always misses. */

  function installErrorCapture() {
    window.addEventListener("error", function (e) {
      /* Resource errors (a dead <img>) arrive here too and carry no
         message; they are worth a line but not an error-level one. */
      if (e && e.target && e.target !== window && e.target.tagName) {
        push("warn", "asset", e.target.tagName.toLowerCase() + " failed to load",
          redactUrl(e.target.src || e.target.href || ""));
        return;
      }
      push("error", "js", (e && e.message) || "Unknown error",
        e && e.filename ? e.filename + ":" + e.lineno + ":" + e.colno +
          (e.error && e.error.stack ? "\n" + e.error.stack : "") : "");
    }, true);

    window.addEventListener("unhandledrejection", function (e) {
      var reason = e && e.reason;
      var message = reason && reason.message ? reason.message : String(reason);
      push("error", "promise", "Unhandled rejection: " + message,
        reason && reason.stack ? reason.stack : "");
    });
  }

  function installConsoleCapture() {
    /* console.error and console.warn only. Mirroring console.log would
       bury the signal: this codebase logs freely at info level. */
    ["error", "warn"].forEach(function (name) {
      var original = console[name];
      if (typeof original !== "function") return;
      console[name] = function () {
        try {
          var parts = Array.prototype.map.call(arguments, function (a) {
            if (a instanceof Error) return a.message + (a.stack ? "\n" + a.stack : "");
            if (typeof a === "object") { try { return JSON.stringify(a); } catch (e) { return String(a); } }
            return String(a);
          });
          push(name === "error" ? "error" : "warn", "console", parts.join(" ").slice(0, 400));
        } catch (e) {}
        return original.apply(console, arguments);
      };
    });
  }

  function classify(url) {
    var u = String(url || "");
    if (/supabase\.co/i.test(u)) return /\/auth\/v1\//.test(u) ? "auth" : "supabase";
    if (/\/v1\/auth\/otp\//.test(u)) return "otp";
    if (/\/v1\/(chat|models|images|videos|search|read|fetch|file)/.test(u)) return "relay";
    return "net";
  }

  /* Third-party beacons fail constantly: ad blockers eat them, they are
     blocked offline, and none of it is our bug. They stay in the log
     because "why is this page slow" is sometimes answered by them, but at
     warn level so they never light up the error badge and send someone
     hunting a fault that is not theirs. */
  function isThirdPartyBeacon(url) {
    return /cloudflareinsights\.com|\/cdn-cgi\/rum|google-analytics\.com|googletagmanager\.com|sentry\.io|doubleclick\.net/i.test(String(url || ""));
  }

  function installFetchCapture() {
    if (!window.fetch) return;
    var original = window.fetch;
    window.fetch = function (input, init) {
      var started = Date.now();
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      var where = classify(url);
      var safeUrl = redactUrl(url);
      var reqBody = init && init.body ? redactBody(init.body, 400) : "";

      return original.apply(this, arguments).then(function (res) {
        var ms = Date.now() - started;
        var line = method.toUpperCase() + " " + res.status + " " + safeUrl + " (" + ms + "ms)";
        if (res.ok) {
          push("info", where, line, reqBody ? "request: " + reqBody : "");
          return res;
        }
        /* A failed response body is the single most useful thing in this
           whole module: Supabase puts the policy violation there, the
           relay puts the reason there. Read it from a clone so the caller
           still gets an unconsumed stream. */
        var level = isThirdPartyBeacon(url) ? "warn" : "error";
        var detail = reqBody ? "request: " + reqBody + "\n" : "";
        try {
          res.clone().text().then(function (text) {
            push(level, where, line, detail + (text ? "response: " + redactBody(text, 900) : ""));
          }, function () { push(level, where, line, detail); });
        } catch (e) {
          push(level, where, line, detail);
        }
        return res;
      }, function (err) {
        var ms = Date.now() - started;
        /* No status at all: DNS, CORS, offline, or a blocked request. The
           browser deliberately hides which, so say so rather than guess. */
        push(isThirdPartyBeacon(url) ? "warn" : "error", where,
          method.toUpperCase() + " failed " + safeUrl + " (" + ms + "ms)",
          (err && err.message ? err.message : String(err)) +
          "\nNo response reached the page. Usually offline, CORS, or a blocked request.");
        throw err;
      });
    };
  }

  function installXhrCapture() {
    if (!window.XMLHttpRequest) return;
    var Open = XMLHttpRequest.prototype.open;
    var Send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__dbg = { method: method, url: url, started: 0 };
      return Open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var info = this.__dbg;
      if (info) {
        info.started = Date.now();
        var self = this;
        this.addEventListener("loadend", function () {
          var ms = Date.now() - info.started;
          var where = classify(info.url);
          var line = String(info.method).toUpperCase() + " " + (self.status || "failed") +
            " " + redactUrl(info.url) + " (" + ms + "ms)";
          if (!self.status || self.status >= 400) {
            var body = "";
            try { body = self.responseType === "" || self.responseType === "text" ? self.responseText : ""; } catch (e) {}
            push(isThirdPartyBeacon(info.url) ? "warn" : "error", where, line,
              body ? "response: " + redactBody(body, 900) : "");
          } else {
            push("info", where, line);
          }
        });
      }
      return Send.apply(this, arguments);
    };
  }

  /* Interactions. Delegated at the document so it costs one listener and
     survives every re-render, which matters in Community where the feed
     rebuilds constantly. Only meaningful controls are recorded: logging
     every click on every div produces noise nobody reads. */
  function installInteractionCapture() {
    document.addEventListener("click", function (e) {
      var el = e.target && e.target.closest
        ? e.target.closest("button, a, [role=button], [data-act], [data-reply], [data-expand]")
        : null;
      if (!el) return;
      var label =
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        (el.textContent || "").trim().slice(0, 40) ||
        el.getAttribute("data-act") ||
        el.tagName.toLowerCase();
      var id = el.id ? "#" + el.id : "";
      var act = el.getAttribute("data-act");
      push("info", "ui", "click " + label + (id || (act ? " [" + act + "]" : "")));
    }, true);

    window.addEventListener("hashchange", function () {
      push("info", "route", "-> " + location.hash);
    });

    window.addEventListener("online", function () { push("warn", "net", "Back online"); });
    window.addEventListener("offline", function () { push("warn", "net", "Went offline"); });
  }

  /* ---------- formatting for copy ---------- */

  function pad(value, width) {
    value = String(value);
    while (value.length < width) value += " ";
    return value;
  }

  function clock(d) {
    function two(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
    try {
      return two(d.getHours(), 2) + ":" + two(d.getMinutes(), 2) + ":" +
             two(d.getSeconds(), 2) + "." + two(d.getMilliseconds(), 3);
    } catch (e) { return ""; }
  }

  function formatEntry(entry) {
    var head = clock(entry.t) + "  " + pad(entry.level.toUpperCase(), 5) + " " +
               pad(entry.where, 9) + " " + entry.what;
    /* Detail is indented rather than joined, so a pasted log stays
       readable as a column of events with their evidence underneath. */
    if (!entry.detail) return head;
    return head + "\n" + entry.detail.split("\n").map(function (l) {
      return "        " + l;
    }).join("\n");
  }

  /* A copied log is read by someone who was not there, so it leads with
     what they would otherwise have to ask for. */
  function asText(filtered) {
    var list = filtered || entries;
    var errors = 0;
    entries.forEach(function (e) { if (e.level === "error") errors++; });
    var header = [
      "Impose debug log",
      "when     " + new Date().toISOString(),
      "where    " + location.href.split("#")[0] + (location.hash || ""),
      "browser  " + navigator.userAgent,
      "online   " + navigator.onLine,
      "lines    " + list.length + " of " + entries.length + " (" + errors + " errors)",
      ""
    ].join("\n");
    return header + list.map(formatEntry).join("\n");
  }

  window.BotoDebug = {
    log: function (where, what, detail) { return push("info", where, what, detail); },
    warn: function (where, what, detail) { return push("warn", where, what, detail); },
    error: function (where, what, detail) { return push("error", where, what, detail); },
    entries: function () { return entries.slice(); },
    errorCount: function () {
      var n = 0;
      entries.forEach(function (e) { if (e.level === "error") n++; });
      return n;
    },
    clear: function () {
      entries.length = 0;
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](null); } catch (e) {}
      }
    },
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        var at = listeners.indexOf(fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    asText: asText,
    formatEntry: formatEntry,
    redactUrl: redactUrl,
    redactText: redactText,
    MAX: MAX
  };

  /* ---------- the portable panel ----------

     index.html has a rich panel wired by app.js. Every other page in the
     product had none, so the bus was recording faithfully on the auth
     pages, the marketing pages and the 404 and nobody could read it: the
     log existed and the door did not.

     This is that door, built here so it travels with the bus rather than
     with the app. It stands down on any page that already has the full
     panel, so index.html keeps the richer one and there is never a second
     bug button.

     It is deliberately self-contained: its own markup, its own styles, no
     dependency on styles.css, because the marketing pages do not load it. */

  var LAYER = 2147483000;

  function hostAlreadyHasPanel() {
    return !!document.getElementById("debugPanel");
  }

  function mountPortablePanel() {
    if (hostAlreadyHasPanel()) return;
    if (document.getElementById("botoDebugPortable")) return;

    var wrap = document.createElement("div");
    wrap.id = "botoDebugPortable";
    wrap.innerHTML =
      '<button type="button" class="bdp-tab" aria-label="Open the debug log">' +
        '<span class="bdp-glyph">bug</span><span class="bdp-count" hidden></span>' +
      "</button>" +
      '<section class="bdp-panel" hidden aria-label="Debug log">' +
        '<header class="bdp-head">' +
          "<strong>Debug log</strong><span class=\"bdp-meta\"></span>" +
          '<span class="bdp-acts">' +
            '<button type="button" data-bdp="copy">Copy</button>' +
            '<button type="button" data-bdp="clear">Clear</button>' +
            '<button type="button" data-bdp="close">Close</button>' +
          "</span>" +
        "</header>" +
        '<div class="bdp-list"></div>' +
      "</section>";

    var css = document.createElement("style");
    /* Every rule is scoped under the wrapper id so it cannot leak into a
       page it was dropped onto. */
    css.textContent =
      "#botoDebugPortable .bdp-tab{position:fixed;right:0;top:64px;z-index:" + LAYER + ";" +
        "width:34px;height:34px;display:flex;align-items:center;justify-content:center;" +
        "border:1px solid rgba(255,255,255,.14);border-right:0;border-radius:8px 0 0 8px;" +
        "background:#1b1c1f;color:#9aa0a6;font:600 9px/1 ui-monospace,Menlo,monospace;" +
        "text-transform:uppercase;cursor:pointer;padding:0}" +
      "#botoDebugPortable .bdp-tab.bad{color:#ff6b6b;border-color:#ff6b6b}" +
      "#botoDebugPortable .bdp-count{position:absolute;top:-6px;left:-8px;min-width:15px;height:15px;" +
        "border-radius:99px;background:#ff5252;color:#fff;font:600 9px/15px sans-serif;text-align:center}" +
      "#botoDebugPortable .bdp-panel{position:fixed;left:0;right:0;bottom:0;z-index:" + LAYER + ";" +
        "height:min(52dvh,560px);background:#141517;border-top:1px solid rgba(255,255,255,.14);" +
        "display:flex;flex-direction:column;color:#e8eaed;" +
        "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}" +
      "#botoDebugPortable .bdp-head{display:flex;align-items:center;gap:10px;padding:10px 14px;" +
        "border-bottom:1px solid rgba(255,255,255,.1);font-family:system-ui,sans-serif;font-size:13px}" +
      "#botoDebugPortable .bdp-meta{color:#9aa0a6;font-size:12px}" +
      "#botoDebugPortable .bdp-acts{margin-left:auto;display:flex;gap:6px}" +
      "#botoDebugPortable .bdp-acts button{background:#232427;color:#e8eaed;border:1px solid rgba(255,255,255,.14);" +
        "border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer;min-height:30px}" +
      "#botoDebugPortable .bdp-list{flex:1;overflow:auto;padding:8px 10px 20px}" +
      "#botoDebugPortable .bdp-row{padding:6px 8px;border-radius:7px;margin-bottom:3px;" +
        "overflow-wrap:anywhere;white-space:pre-wrap}" +
      "#botoDebugPortable .bdp-row.error{background:rgba(255,82,82,.12);color:#ffb4b4}" +
      "#botoDebugPortable .bdp-row.warn{background:rgba(255,193,7,.1);color:#ffd97a}" +
      "#botoDebugPortable .bdp-when{color:#7a8085;margin-right:8px}";

    document.documentElement.appendChild(css);
    document.body.appendChild(wrap);

    var tab = wrap.querySelector(".bdp-tab");
    var panelEl = wrap.querySelector(".bdp-panel");
    var list = wrap.querySelector(".bdp-list");
    var meta = wrap.querySelector(".bdp-meta");
    var countEl = wrap.querySelector(".bdp-count");

    function row(e) {
      var d = document.createElement("div");
      d.className = "bdp-row " + e.level;
      /* Clamp the detail. An HTML error page is a legitimate response body
         and it ran to twenty lines, pushing every other event off screen:
         the one entry you can see is rarely the one you need. The full
         text is still in the buffer and in Copy. */
      var detail = e.detail || "";
      if (detail.length > 220) detail = detail.slice(0, 220) + "\u2026 [" + detail.length + " chars, full text in Copy]";
      d.textContent = e.where + "  " + e.what + (detail ? "\n" + detail : "");
      var when = document.createElement("span");
      when.className = "bdp-when";
      when.textContent = clock(e.t);
      d.insertBefore(when, d.firstChild);
      return d;
    }

    function paint() {
      list.innerHTML = "";
      entries.slice().reverse().forEach(function (e) { list.appendChild(row(e)); });
      var n = window.BotoDebug.errorCount();
      meta.textContent = entries.length + " lines" + (n ? ", " + n + " errors" : "");
      countEl.hidden = n === 0;
      countEl.textContent = n > 99 ? "99" : String(n);
      tab.classList.toggle("bad", n > 0);
    }

    tab.addEventListener("click", function () {
      panelEl.hidden = false;
      tab.hidden = true;
      paint();
    });

    wrap.addEventListener("click", function (ev) {
      var act = ev.target.getAttribute && ev.target.getAttribute("data-bdp");
      if (!act) return;
      if (act === "close") { panelEl.hidden = true; tab.hidden = false; return; }
      if (act === "clear") { window.BotoDebug.clear(); paint(); return; }
      if (act === "copy") {
        var text = window.BotoDebug.asText();
        var done = function () { ev.target.textContent = "Copied"; setTimeout(function () { ev.target.textContent = "Copy"; }, 1200); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, done);
        } else {
          var ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch (e) {}
          ta.remove(); done();
        }
      }
    });

    listeners.push(function () { if (!panelEl.hidden) paint(); else {
      var n = window.BotoDebug.errorCount();
      countEl.hidden = n === 0;
      countEl.textContent = n > 99 ? "99" : String(n);
      tab.classList.toggle("bad", n > 0);
    } });

    /* Same shortcut as the full panel, so the habit transfers. */
    document.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      if (String(e.key).toLowerCase() !== "d") return;
      e.preventDefault();
      if (panelEl.hidden) { panelEl.hidden = false; tab.hidden = true; paint(); }
      else { panelEl.hidden = true; tab.hidden = false; }
    });

    paint();
  }

  installErrorCapture();
  installConsoleCapture();
  installFetchCapture();
  installXhrCapture();

  function onReady() {
    installInteractionCapture();
    /* Deferred a frame so a host page that builds its own panel late still
       wins the check. */
    setTimeout(mountPortablePanel, 0);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }

  push("info", "app", "Debug bus ready");
})();
