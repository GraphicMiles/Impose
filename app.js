/* Nova chat client. Bring your own key: providers speak OpenAI style,
   Anthropic, or Gemini request shapes. With no provider set, demo replies. */
(function () {
  "use strict";

  var STORE_KEY = "nova.clone.v1";
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SYS_MSG = "You are Nova, a helpful assistant.";

  /* ---------- canned replies (demo mode, no provider set) ---------- */

  var REPLIES = {
    greeting: "Hello. What would you like to work on?\n\nI can help with writing, code, planning, or working through an idea. Just type below to start.",

    thanks: "You are welcome. Let me know if you want to take it further.",

    email: "Here is a draft you can send as is, plus two subject lines.\n\n**Subject options**\n- Quick follow up on invoice INV-2041\n- Checking in on payment for INV-2041\n\n**Draft**\n> Hi Amaka,\n>\n> I hope you are well. I am writing to follow up on invoice INV-2041 for 450,000 NGN, which was due on 28 August.\n>\n> Please let me know if you need anything from my side to process it. I have attached a copy for ease.\n>\n> Best regards,\n> Adaeze\n\nWant a firmer version for a second reminder, or a shorter one for WhatsApp?",

    code: "Here is what that function does, line by line.\n\n```python\ndef total(prices, tax_rate=0.075):\n    subtotal = sum(prices)\n    tax = subtotal * tax_rate\n    return round(subtotal + tax, 2)\n```\n\n1. **Signature**: takes a list of prices and an optional tax rate that defaults to 7.5%.\n2. **Subtotal**: `sum(prices)` adds every item in the list.\n3. **Tax**: multiplies the subtotal by the rate.\n4. **Return**: adds tax to the subtotal and rounds to 2 decimals.\n\n| Input | Meaning |\n| --- | --- |\n| `prices` | A list of numbers, e.g. `[1200, 3400]` |\n| `tax_rate` | A decimal rate, so `0.075` means 7.5% |\n\nCall it with `total([1200, 3400])` and you get `4945.0`. Paste your own function and I will walk through it the same way.",

    ideas: "Here are 8 options, grouped by tone. My top 3 are marked.\n\n**Playful**\n- Chop Central ★\n- Belle Full Diaries\n- Amala After Hours\n\n**Clean and modern**\n- Lagos Plate ★\n- The Chop List ★\n- Suya and Stories\n\n**Local flavor**\n- Bukka Diaries\n- Owambe Eats\n\nQuick checks before you commit: search the name on Instagram and TikTok, confirm the .com or .com.ng domain is free, and say it out loud to test how it sounds. Want tagline ideas for your favorite?",

    mortgage: "A mortgage is a long term loan used to buy a home. The bank pays most of the price now, and you repay monthly over 15 to 30 years. The house itself is the security, so if you stop paying, the bank can sell it.\n\n**A simple example**\n- House price: 60,000,000 NGN\n- Down payment (20%): 12,000,000 NGN\n- Loan: 48,000,000 NGN at 18% for 20 years\n- Monthly payment: about 740,000 NGN\n\n**Three terms to know**\n- **Down payment**: cash you pay upfront. Larger means smaller monthly bills.\n- **Interest rate**: the bank's fee for lending. Fixed stays the same, variable can move.\n- **Tenure**: how long you repay. Longer means lower monthly cost but more total interest.\n\nWant me to compare two loan offers, or estimate what fits a given salary?",

    travel: "For Lagos to London, here is the practical picture.\n\n**Direct flights (LOS to LHR)**\n- British Airways: daily service, about 6h 40m\n- Virgin Atlantic: daily service, similar timing\n- Air Peace: direct option, often lower fares\n\n**Booking tips**\n- Midweek departures (Tue, Wed) are usually cheaper than weekends.\n- Compare the direct fare against one stop options via Casablanca or Istanbul. The saving can be large.\n- Check the baggage allowance before you book. Some cheaper fares include only 23kg.\n\nTell me your dates and budget and I will sketch a shortlist of options.",

    fallback: "Got it. This is demo mode, so here is a sketch rather than a live answer.\n\n**First pass**\n- Define the outcome in one sentence.\n- List what you already know and what is missing.\n- Start with the step that removes the most doubt.\n\nConnect a provider in Settings to get live answers from a real model."
  };

  function generateReply(text) {
    var t = " " + text.toLowerCase().trim() + " ";
    if (/^(hi|hey|hello|yo|good morning|good afternoon|good evening)[!. ]*$/.test(t.trim())) return REPLIES.greeting;
    if (t.indexOf("thank") > -1) return REPLIES.thanks;
    if (hasAny(t, ["invoice", "follow up", "follow-up", "email", "mail ", "write", "draft", "cover letter", "apolog"])) return REPLIES.email;
    if (hasAny(t, ["python", "function", "code", "debug", "bug ", "error", "javascript", "typescript", "line by line", "walk me through"])) return REPLIES.code;
    if (hasAny(t, ["blog", "name", "brainstorm", "idea", "business name", "brand"])) return REPLIES.ideas;
    if (hasAny(t, ["mortgage", "loan", "interest rate", "house ", "buying a home", "down payment"])) return REPLIES.mortgage;
    if (hasAny(t, ["flight", "lagos to", "to london", "travel", "trip", "itinerary", "visa", "abuja"])) return REPLIES.travel;
    return REPLIES.fallback;
  }

  function hasAny(t, words) {
    for (var i = 0; i < words.length; i++) {
      if (t.indexOf(words[i]) > -1) return true;
    }
    return false;
  }

  /* ---------- provider catalogue (mirrors Luna's presets) ----------
     A preset is a starting point, never a cage: it fills in the request
     shape and the address, and every field stays editable afterwards. */

  var PRESETS = [
    { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", note: "GPT models", icon: "sparkles", keyHint: "sk-…" },
    { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", note: "Claude models", icon: "asterisk", keyHint: "sk-ant-…" },
    { id: "gemini", name: "Google Gemini", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", note: "Gemini models, free tier available", icon: "gem", keyHint: "AIza…" },
    { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", note: "Very fast, free tier available", icon: "zap", keyHint: "gsk_…" },
    { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", note: "One key, most models, some free", icon: "shuffle", keyHint: "sk-or-…" },
    { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", note: "Cheap and strong at code", icon: "droplet" },
    { id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", note: "European, small and fast models", icon: "wind" },
    { id: "together", name: "Together", kind: "openai", baseUrl: "https://api.together.xyz/v1", note: "Open-weight models, hosted", icon: "users" },
    { id: "xai", name: "xAI", kind: "openai", baseUrl: "https://api.x.ai/v1", note: "Grok models", icon: "rocket" },
    { id: "local", name: "LM Studio or llama.cpp", kind: "openai", baseUrl: "http://192.168.1.10:1234/v1", note: "A server on your own network. No key needed", icon: "house" },
    { id: "selfhost", name: "Self hosted", kind: "openai", baseUrl: "", note: "Your own Lightning box. Paste its address after deploy", icon: "server" },
    { id: "custom", name: "Something else", kind: "openai", baseUrl: "", note: "Any endpoint. Pick the shape yourself", icon: "sliders-horizontal" }
  ];

  var KINDS = ["openai", "anthropic", "gemini"];
  var KIND_NAMES = ["OpenAI style", "Anthropic", "Gemini"];
  var AUTH_STYLES = ["bearer", "header", "query", "none"];
  var AUTH_NAMES = ["Bearer", "Header", "In the URL", "No key"];

  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === id) return PRESETS[i];
    }
    return PRESETS[PRESETS.length - 1];
  }

  /* The preset a saved row came from, matched on its address, so a saved
     provider shows what it is rather than "Something else". */
  function presetMatch(kind, baseUrl) {
    var address = String(baseUrl || "").trim().replace(/\/+$/, "");
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].baseUrl && PRESETS[i].baseUrl === address) return PRESETS[i];
    }
    for (var j = 0; j < PRESETS.length; j++) {
      if (PRESETS[j].kind === kind && kind !== "openai") return PRESETS[j];
    }
    return presetById("custom");
  }

  function defaultAuthStyle(kind) {
    if (kind === "anthropic") return "header";
    if (kind === "gemini") return "query";
    return "bearer";
  }

  function defaultAuthName(kind, style) {
    if (style === "query") return "key";
    if (style === "header") return kind === "anthropic" ? "x-api-key" : "Authorization";
    return "Authorization";
  }

  function kindName(kind) {
    var i = KINDS.indexOf(kind);
    return i < 0 ? KIND_NAMES[0] : KIND_NAMES[i];
  }

  function authStyleName(style) {
    var i = AUTH_STYLES.indexOf(style);
    return i < 0 ? AUTH_NAMES[0] : AUTH_NAMES[i];
  }

  /* "Name: value" per line, which is how a person writes a header down. */
  function parseHeaders(text) {
    var out = {};
    String(text || "").split("\n").forEach(function (line) {
      var split = line.indexOf(":");
      if (split <= 0) return;
      var name = line.slice(0, split).trim();
      var value = line.slice(split + 1).trim();
      if (name && value) out[name] = value;
    });
    return out;
  }

  function writeHeaders(headers) {
    var lines = [];
    Object.keys(headers || {}).forEach(function (name) {
      lines.push(name + ": " + headers[name]);
    });
    return lines.join("\n");
  }

  /* ---------- tiny utils ---------- */

  function $(id) { return document.getElementById(id); }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function refreshIcons() {
    if (window.lucide && window.lucide.createIcons) {
      try { window.lucide.createIcons(); } catch (e) { /* icons are decorative */ }
    }
  }

  var store = {
    read: function () {
      try { return window.localStorage.getItem(STORE_KEY); }
      catch (e) { return null; }
    },
    write: function (v) {
      try { window.localStorage.setItem(STORE_KEY, v); }
      catch (e) { /* sandboxed iframe: keep everything in memory */ }
    }
  };

  /* ---------- debug log (edge tab, bottom sheet) ----------
     Every network request is logged automatically (keys in URLs are
     redacted). App events and failures are logged at their call sites.
     Newest first, 500 lines max, like Luna's panel. */

  var debugLog = [];
  var debugErrorsOnly = false;
  var debugCopiedFlash = false;
  var DEBUG_MAX = 500;

  function debugClock(d) {
    function pad(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
    try {
      return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3);
    } catch (e) { return ""; }
  }

  function debugPlain(e) {
    function pad(s, w) { s = String(s); while (s.length < w) s += " "; return s; }
    return debugClock(e.t) + "  " + pad(e.level.toUpperCase(), 5) + " " + pad(e.where, 10) + " " + e.what;
  }

  function dlog(level, where, what) {
    if (level !== "error" && level !== "warn") level = "info";
    debugLog.unshift({ t: new Date(), level: level, where: String(where), what: String(what).replace(/\n/g, " ").trim() });
    if (debugLog.length > DEBUG_MAX) debugLog.length = DEBUG_MAX;
    if (!$("debugPanel").hidden && (!debugErrorsOnly || level === "error")) {
      prependDebugRow(debugLog[0]);
    }
    syncDebugChrome();
  }

  function dnote(where, what) { dlog("info", where, what); }
  function dwarn(where, what) { dlog("warn", where, what); }
  function dfail(where, what) { dlog("error", where, what); }

  function sanitizeUrl(url) {
    return String(url || "").replace(/([?&](key|api_key|token|auth|secret)=)[^&]*/gi, "$1…");
  }

  function debugRow(entry) {
    var row = document.createElement("div");
    row.className = "debug-row" + (entry.level === "error" ? " bad" : entry.level === "warn" ? " warn" : "");
    row.title = "Click to copy this line";
    var meta = document.createElement("div");
    meta.className = "debug-meta";
    var clock = document.createElement("span");
    clock.className = "debug-clock";
    clock.textContent = debugClock(entry.t);
    var where = document.createElement("span");
    where.className = "debug-where";
    where.textContent = entry.where;
    meta.appendChild(clock);
    meta.appendChild(where);
    if (entry.level !== "info") {
      var pill = document.createElement("span");
      pill.className = "debug-pill";
      pill.textContent = entry.level === "error" ? "ERROR" : "WARN";
      meta.appendChild(pill);
    }
    var what = document.createElement("div");
    what.className = "debug-what";
    what.textContent = entry.what;
    row.appendChild(meta);
    row.appendChild(what);
    row.addEventListener("click", function () {
      copyText(debugPlain(entry), "Line copied");
    });
    return row;
  }

  function prependDebugRow(entry) {
    var list = $("debugList");
    var empty = list.querySelector(".debug-empty");
    if (empty) empty.remove();
    list.insertBefore(debugRow(entry), list.firstChild);
    while (list.children.length > DEBUG_MAX) list.lastChild.remove();
  }

  function renderDebugList() {
    var list = $("debugList");
    list.innerHTML = "";
    var shown = 0;
    debugLog.forEach(function (entry) {
      if (debugErrorsOnly && entry.level !== "error") return;
      list.appendChild(debugRow(entry));
      shown++;
    });
    if (!shown) {
      var p = document.createElement("p");
      p.className = "debug-empty";
      p.textContent = debugErrorsOnly ? "Nothing has failed." : "Nothing logged yet.";
      list.appendChild(p);
    }
    list.scrollTop = 0;
  }

  function syncDebugChrome() {
    var errors = 0;
    debugLog.forEach(function (e) { if (e.level === "error") errors++; });
    var tab = $("debugTab");
    tab.classList.toggle("bad", errors > 0);
    var count = $("debugTabCount");
    count.hidden = errors === 0;
    count.textContent = errors > 99 ? "99" : String(errors);
    var shown = debugErrorsOnly ? errors : debugLog.length;
    $("debugCount").textContent = debugCopiedFlash ? "Copied" : shown + (shown === 1 ? " line" : " lines");
  }

  function openDebug() {
    renderDebugList();
    syncDebugChrome();
    var panel = $("debugPanel");
    panel.hidden = false;
    void panel.offsetWidth;
    panel.classList.add("open");
    $("debugTab").hidden = true;
  }

  function closeDebug() {
    var panel = $("debugPanel");
    panel.classList.remove("open");
    $("debugTab").hidden = false;
    setTimeout(function () {
      if (!panel.classList.contains("open")) panel.hidden = true;
    }, 320);
  }

  function copySilent(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {}, function () { copyFallback(text); });
    } else {
      copyFallback(text);
    }
  }

  function copyFallback(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* noop */ }
    ta.remove();
  }

  $("debugTab").addEventListener("click", openDebug);
  $("debugClose").addEventListener("click", closeDebug);
  $("debugTrace").addEventListener("click", function () { closeDebug(); playTraceDemo(); });

  $("debugSeg").addEventListener("click", function (e) {
    var b = e.target.closest("[data-df]");
    if (!b) return;
    debugErrorsOnly = b.dataset.df === "errors";
    $("debugSeg").querySelectorAll("button").forEach(function (x) {
      x.setAttribute("aria-pressed", x === b ? "true" : "false");
    });
    renderDebugList();
    syncDebugChrome();
  });

  $("debugClear").addEventListener("click", function () {
    debugLog.length = 0;
    renderDebugList();
    syncDebugChrome();
  });

  $("debugCopy").addEventListener("click", function () {
    var lines = debugLog.filter(function (e) { return !debugErrorsOnly || e.level === "error"; });
    copySilent(lines.map(debugPlain).join("\n") || "Debug log is empty.");
    debugCopiedFlash = true;
    syncDebugChrome();
    $("debugCopy").innerHTML = '<i data-lucide="check"></i>';
    refreshIcons();
    setTimeout(function () {
      debugCopiedFlash = false;
      syncDebugChrome();
      var btn = $("debugCopy");
      if (btn) { btn.innerHTML = '<i data-lucide="copy"></i>'; refreshIcons(); }
    }, 1400);
  });

  /* Log every network request the app makes. Keys in URLs are redacted. */
  (function wrapFetch() {
    if (!window.fetch || window.fetch.__novaWrapped) return;
    var nativeFetch = window.fetch.bind(window);
    function wrapped(input, opts) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (opts && opts.method) || (input && input.method) || "GET";
      var t0 = (window.performance && performance.now()) || Date.now();
      function ms() {
        var now = (window.performance && performance.now()) || Date.now();
        return Math.round(now - t0);
      }
      return nativeFetch(input, opts).then(function (res) {
        var line = method + " " + sanitizeUrl(url) + " -> " + res.status + " (" + ms() + "ms)";
        if (res.ok) dnote("net", line);
        else dfail("net", line);
        return res;
      }, function (err) {
        if (err && err.name === "AbortError") {
          dwarn("net", method + " " + sanitizeUrl(url) + " aborted (" + ms() + "ms)");
        } else {
          dfail("net", method + " " + sanitizeUrl(url) + " failed (" + ms() + "ms): " + String((err && err.message) || err).slice(0, 140));
        }
        throw err;
      });
    }
    wrapped.__novaWrapped = true;
    window.fetch = wrapped;
  })();

  window.addEventListener("error", function (e) {
    dfail("app", "Uncaught: " + (e.message || "unknown error"));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    dfail("app", "Unhandled rejection: " + (r && r.message ? r.message : String(r)));
  });

  /* ---------- state ---------- */

  var HOUR = 3600 * 1000;
  var now = Date.now();

  function seedChats() {
    return [
      {
        id: uid() + "a",
        title: "Flight options to London",
        model: "Demo",
        providerId: null,
        createdAt: now - 5 * HOUR,
        updatedAt: now - 2 * HOUR,
        messages: [
          { role: "user", content: "What are my options for flights from Lagos to London in October?", ts: now - 2 * HOUR },
          { role: "assistant", content: REPLIES.travel, ts: now - 2 * HOUR + 40000 }
        ]
      },
      {
        id: uid() + "b",
        title: "Follow up email for invoice",
        model: "Demo",
        providerId: null,
        createdAt: now - 8 * HOUR,
        updatedAt: now - 6 * HOUR,
        messages: [
          { role: "user", content: "Draft a follow up email for a late invoice", ts: now - 6 * HOUR },
          { role: "assistant", content: REPLIES.email, ts: now - 6 * HOUR + 30000 }
        ]
      },
      {
        id: uid() + "c",
        title: "Python function walkthrough",
        model: "Demo",
        providerId: null,
        createdAt: now - 30 * HOUR,
        updatedAt: now - 26 * HOUR,
        messages: [
          { role: "user", content: "Walk me through a Python function line by line", ts: now - 26 * HOUR },
          { role: "assistant", content: REPLIES.code, ts: now - 26 * HOUR + 50000 }
        ]
      },
      {
        id: uid() + "d",
        title: "Lagos food blog names",
        model: "Demo",
        providerId: null,
        createdAt: now - 3 * 24 * HOUR,
        updatedAt: now - 3 * 24 * HOUR,
        messages: [
          { role: "user", content: "Brainstorm names for a Lagos food blog", ts: now - 3 * 24 * HOUR },
          { role: "assistant", content: REPLIES.ideas, ts: now - 3 * 24 * HOUR + 25000 }
        ]
      },
      {
        id: uid() + "e",
        title: "How mortgages work",
        model: "Demo",
        providerId: null,
        createdAt: now - 12 * 24 * HOUR,
        updatedAt: now - 12 * 24 * HOUR,
        messages: [
          { role: "user", content: "Teach me how mortgages work in simple terms", ts: now - 12 * 24 * HOUR },
          { role: "assistant", content: REPLIES.mortgage, ts: now - 12 * 24 * HOUR + 60000 }
        ]
      }
    ];
  }

  function defaultSettings() {
    return { theme: "dark", enterToSend: true, showChips: true, activeProviderId: null, relayUrl: "", relayKey: "", searchMode: false, displayName: "You" };
  }

  function loadState() {
    var raw = store.read();
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.chats)) {
          parsed.settings = Object.assign(defaultSettings(), parsed.settings || {});
          parsed.providers = Array.isArray(parsed.providers) ? parsed.providers : [];
          parsed.providers.forEach(function (pr) {
            if (!pr.model && pr.models) pr.model = pr.models[pr.activeSlot || 0] || pr.models[0] || "";
            delete pr.models;
            delete pr.activeSlot;
          });
          if (!Array.isArray(parsed.folders)) parsed.folders = [];
          if (!Array.isArray(parsed.outbox)) parsed.outbox = [];
          parsed.chats.forEach(function (c) {
            if (!Array.isArray(c.excluded)) c.excluded = [];
            (c.messages || []).forEach(function (m) {
              if (m && !m.variants && typeof m.content === "string") {
                m.variants = [m.content];
                m.vi = 0;
              }
            });
          });
          return parsed;
        }
      } catch (e) { /* fall through to seed */ }
    }
    return { chats: seedChats(), providers: [], folders: [], outbox: [], settings: defaultSettings() };
  }

  var state = loadState();
  var activeId = null;
  var lastSendAt = 0;
  var relayDown = false;
  var draining = false;
  var titling = {};
  var stream = null; // canned: { timer, thinkTimer, ... } live: { live, controller, text, ... }

  function save() {
    store.write(JSON.stringify({ chats: state.chats, providers: state.providers, folders: state.folders, outbox: state.outbox, settings: state.settings }));
  }

  function getChat(id) {
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === id) return state.chats[i];
    }
    return null;
  }

  function getProvider(id) {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === id) return state.providers[i];
    }
    return null;
  }

  function activeProvider() {
    return getProvider(state.settings.activeProviderId);
  }

  function activeModelOf(p) {
    if (!p) return "";
    return String(p.model || "").trim();
  }

  function providerDisplay(p) {
    if (!p) return "Demo";
    var m = activeModelOf(p);
    return m ? p.label + " · " + m : p.label;
  }

  /* null means demo mode. missingKey means configured but unusable. */
  function getTarget() {
    var p = activeProvider();
    if (!p) return null;
    var m = activeModelOf(p);
    if (!m) return null;
    if (p.authStyle !== "none" && !String(p.apiKey || "").trim()) {
      return { provider: p, model: m, missingKey: true };
    }
    return { provider: p, model: m };
  }

  function titleFrom(text) {
    var t = text.replace(/\s+/g, " ").trim();
    if (t.length <= 42) return t;
    var cut = t.slice(0, 42);
    var lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + "...";
  }

  /* ---------- request layer: addresses, auth, shapes, failures ---------- */

  function stripSlash(u) {
    return String(u || "").trim().replace(/\/+$/, "");
  }

  function isPrivateHost(h) {
    h = String(h || "").toLowerCase();
    if (h === "localhost" || h.slice(-10) === ".localhost" || h.slice(-6) === ".local") return true;
    if (h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
    var m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    var a = +m[1], b = +m[2];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }

  /* null when fine, otherwise the sentence to show. Plain http is allowed on
     your own network only, because there nothing leaves the building. */
  function checkAddress(raw) {
    var v = String(raw || "").trim();
    if (!v) return "Add a base address.";
    var u = null;
    try { u = new URL(v); } catch (e) { u = null; }
    if (!u) return "That address is not a valid URL.";
    if (u.protocol !== "https:" && u.protocol !== "http:") return "The address must start with https.";
    if (u.protocol === "http:" && !isPrivateHost(u.hostname)) {
      return "Use https, unless the server is on your own network.";
    }
    return null;
  }

  function hasHeader(headers, name) {
    var want = name.toLowerCase();
    return Object.keys(headers).some(function (k) { return k.toLowerCase() === want; });
  }

  /* like: { kind, baseUrl, apiKey, authStyle, authName, headers } */
  function buildRequest(like, path, extraParams) {
    var headers = {};
    Object.keys(like.headers || {}).forEach(function (k) { headers[k] = like.headers[k]; });
    var style = like.authStyle || defaultAuthStyle(like.kind);
    var name = String(like.authName || defaultAuthName(like.kind, style)).trim() || "Authorization";
    var key = String(like.apiKey || "");
    if (key && style === "bearer") headers[name] = "Bearer " + key;
    else if (key && style === "header") headers[name] = key;
    var params = [];
    if (extraParams) {
      Object.keys(extraParams).forEach(function (k) {
        params.push(encodeURIComponent(k) + "=" + encodeURIComponent(extraParams[k]));
      });
    }
    if (key && style === "query") {
      params.push(encodeURIComponent(name) + "=" + encodeURIComponent(key));
    }
    var url = stripSlash(like.baseUrl) + path;
    if (params.length) url += (url.indexOf("?") > -1 ? "&" : "?") + params.join("&");
    if (like.kind === "anthropic") {
      if (!hasHeader(headers, "anthropic-version")) headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
    return { url: url, headers: headers };
  }

  /* The provider's own explanation, dug out of whichever envelope it used. */
  function detailOf(payload) {
    var text = String(payload || "").trim();
    if (!text || text.charAt(0) === "<") return "";
    try {
      var data = JSON.parse(text);
      var err = data && data.error;
      var det = data && typeof data.detail === "string" ? data.detail : "";
      var msg = typeof err === "string" ? err : (err && err.message) || data.message || det || "";
      msg = String(msg).trim().replace(/\s+/g, " ");
      return msg.length > 140 ? msg.slice(0, 140) + "..." : msg;
    } catch (e) {
      return text.length > 140 ? text.slice(0, 140) + "..." : text;
    }
  }

  /* Someone else's HTTP code, turned into a sentence about what to do. */
  function explain(like, code, payload, model) {
    var where = like.kind === "anthropic" ? "Anthropic" : like.kind === "gemini" ? "Google" : "The provider";
    var detail = detailOf(payload);
    var tail = detail ? " " + detail : "";
    if (code === 401) return "That key was rejected by " + where + ". Check it, or paste a new one.";
    if (code === 403) {
      return detail ? where + " refused this request (403)." + tail
        : where + " refused this request (403). The key may lack model access.";
    }
    if (code === 404) {
      return model ? '"' + model + '" is not available on this key. Check the model list and pick another.'
        : "That address does not exist on " + where + ". Check the base address.";
    }
    if (code === 413) return "The conversation is too long for " + where + ". Start a new chat.";
    if (code === 429) return where + " is rate limiting this key. Wait a moment and try again.";
    if (code >= 500) {
      var host = "";
      try { host = new URL(like.baseUrl).hostname; } catch (e) { host = ""; }
      return "The server at " + (host || "the provider") + " is having trouble (" + code + ")." + tail + " Try again shortly.";
    }
    if (code === 400) return where + " rejected the request." + tail;
    return where + " answered " + code + "." + tail;
  }

  function fetchSentence(err) {
    if (err && err.name === "AbortError") return "The provider took too long to answer. Try again.";
    if (err && err.name === "TypeError") return "Could not reach the provider. Check the address and your connection.";
    if (err && err.message) return err.message;
    return "Could not reach the provider. Check the address and your connection.";
  }

  function withTimeout(ms) {
    if (window.AbortSignal && AbortSignal.timeout) return AbortSignal.timeout(ms);
    return undefined;
  }

  function throwIfHttpError(like, model, res) {
    if (res.ok) return Promise.resolve();
    return res.text().then(function (text) {
      throw new Error(explain(like, res.status, text, model));
    }, function () {
      throw new Error(explain(like, res.status, "", model));
    });
  }

  function scoreModel(id) {
    var t = String(id).toLowerCase();
    var s = 0;
    if (/embed|whisper|tts|dall|image|moderation|guard|transcri|realtime|audio|vision/.test(t)) s -= 3;
    if (/gpt|Muse|gemini|llama|mixtral|mistral|grok|deepseek|qwen|sonnet|opus|haiku|chat|instruct|turbo/.test(t)) s += 2;
    return s;
  }

  /* A refused list is not a verdict on the key: some providers hide the
     list even from a key that can chat. Point at the model field instead. */
  function listRefusal(like, code, payload) {
    var t = String(payload || "").trim();
    if ((code === 401 || code === 403 || code === 404) && t.charAt(0) !== "<") {
      var who = like.kind === "anthropic" ? "Anthropic" : like.kind === "gemini" ? "Google" : "The provider";
      return who + " answered " + code + " for the model list. Some providers hide the list even from a key that can chat, so this is not a verdict on the key. Type the model's name and save. The check before saving proves whether it works.";
    }
    return explain(like, code, payload, "");
  }

  function relayCfg() {
    var url = ($("pfRelayUrl").value || "").trim() || (state.settings.relayUrl || "").trim();
    var key = ($("pfRelayKey").value || "").trim() || (state.settings.relayKey || "").trim();
    return { url: url, key: key };
  }

  function relayRefusal(code, payload) {
    var detail = "";
    try {
      var data = JSON.parse(String(payload || ""));
      detail = String((data && data.detail) || "").slice(0, 140);
    } catch (e) { detail = ""; }
    var tail = detail ? " " + detail : "";
    if (code === 400) return "The relay refused this request." + tail;
    if (code === 502) return "The relay could not reach the target." + tail;
    return "The relay refused this request (" + code + ")." + tail;
  }

  /* One request sent server to server through the relay, for providers that
     block browsers. Replies arrive whole: no streaming on this path. */
  function relayFetchReq(req, method, bodyObj, signal) {
    var cfg = relayCfg();
    if (!cfg.url) return Promise.reject(new Error("Set the relay address in the provider editor under Advanced, Relay."));
    if (!cfg.key) return Promise.reject(new Error("Add the relay key in the provider editor under Advanced, Relay."));
    var headers = {};
    Object.keys(req.headers || {}).forEach(function (k) { headers[k] = req.headers[k]; });
    if (method === "POST" && !hasHeader(headers, "Content-Type")) headers["Content-Type"] = "application/json";
    var payload = {
      method: method,
      url: req.url,
      headers: headers,
      body: bodyObj === undefined ? null : JSON.stringify(bodyObj)
    };
    var t0 = (window.performance && performance.now()) || Date.now();
    function ms() {
      var now = (window.performance && performance.now()) || Date.now();
      return Math.round(now - t0);
    }
    var opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key },
      body: JSON.stringify(payload)
    };
    if (signal) opts.signal = signal;
    else opts.signal = withTimeout(90000);
    return fetch(stripSlash(cfg.url) + "/v1/fetch", opts).then(function (res) {
      if (res.status === 401) throw new Error("That relay key was rejected. Check it on the relay dashboard.");
      if (!res.ok) {
        return res.text().then(function (text) {
          throw new Error(relayRefusal(res.status, text));
        }, function () {
          throw new Error(relayRefusal(res.status, ""));
        });
      }
      return res.json().then(function (env) { return env; }, function () {
        throw new Error("The relay returned an unreadable reply.");
      });
    }).then(function (env) {
      var bodyText = String((env && env.body) || "");
      var failTail = "";
      if (!(env.status >= 200 && env.status < 300)) {
        var snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 160);
        if (snippet) failTail = " " + snippet;
      }
      dnote("net", method + " " + sanitizeUrl(req.url) + " via relay -> " + env.status + " (" + ms() + "ms)" + failTail);
      if (bodyText.charAt(0) === "<" && /cloudflare/i.test(bodyText)) {
        throw new Error("A firewall in front of the provider blocked this request (" + env.status + "). The provider may block your region or servers.");
      }
      return {
        ok: env.status >= 200 && env.status < 300,
        status: env.status,
        _body: bodyText,
        text: function () { return Promise.resolve(this._body); },
        json: function () {
          try { return Promise.resolve(JSON.parse(this._body)); }
          catch (e) { return Promise.reject(new Error("The relay returned an unreadable reply.")); }
        }
      };
    }, function (err) {
      if (err && err.name === "AbortError") throw err;
      if (err && err.name === "TypeError") { markRelayDown(); throw new Error("Could not reach the relay. Check the relay address."); }
      throw err;
    });
  }

  function idsFromModelsData(like, data) {
    var ids;
    if (like.kind === "gemini") {
      ids = (data.models || [])
        .filter(function (m) {
          var methods = m && m.supportedGenerationMethods;
          return !methods || methods.indexOf("generateContent") > -1;
        })
        .map(function (m) { return String((m && m.name) || "").replace(/^models\//, ""); })
        .filter(function (id) { return !!id; });
      ids.sort();
      return ids;
    }
    var raw = data.data || data.models || [];
    if (!Array.isArray(raw)) raw = [];
    ids = raw.map(function (m) {
      if (typeof m === "string") return m;
      return String((m && (m.id || m.name)) || "");
    }).filter(function (id) { return !!id; });
    ids.sort(function (a, b) {
      var d = scoreModel(b) - scoreModel(a);
      return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
    });
    return ids;
  }

  /* The relay path never streams: one whole reply per request. */
  function unstreamedChat(provider, model, history, signal, onDelta) {
    var req, body;
    if (provider.kind === "anthropic") {
      req = buildRequest(provider, "/messages");
      body = { model: model, max_tokens: 1024, system: SYS_MSG, messages: history, stream: false };
    } else if (provider.kind === "gemini") {
      req = buildRequest(provider, "/models/" + encodeURIComponent(model) + ":generateContent");
      body = {
        systemInstruction: { parts: [{ text: SYS_MSG }] },
        contents: history.map(function (m) {
          return { role: m.role === "assistant" ? "model" : "user", parts: geminiParts(m.content) };
        })
      };
    } else {
      req = buildRequest(provider, "/chat/completions");
      body = { model: model, messages: [{ role: "system", content: SYS_MSG }].concat(history), stream: false };
    }
    req.headers["Content-Type"] = "application/json";
    return relayFetchReq(req, "POST", body, signal).then(function (res) {
      return throwIfHttpError(provider, model, res).then(function () { return res.json(); });
    }).then(function (d) {
      var text = "";
      var think = "";
      if (provider.kind === "anthropic") {
        (d.content || []).forEach(function (b) {
          if (!b) return;
          if (b.type === "thinking" && b.thinking) think += b.thinking;
          else if (b.text) text += b.text;
        });
      } else if (provider.kind === "gemini") {
        (d.candidates || []).forEach(function (c) {
          ((c.content && c.content.parts) || []).forEach(function (part) {
            if (!part || !part.text) return;
            if (part.thought) think += part.text;
            else text += part.text;
          });
        });
      } else {
        var choice = d.choices && d.choices[0];
        var umsg = choice && choice.message;
        text = (umsg && umsg.content) || "";
        if (umsg && umsg.reasoning_content) think = umsg.reasoning_content;
      }
      if (think) text = "<think>\n" + think + "\n</think>\n\n" + text;
      if (text) onDelta(text);
    });
  }

  /* What the provider says it serves today. Throws the provider's sentence. */
  function listModels(like) {
    if (like && like.useRelay) {
      var rreq = buildRequest(like, "/models");
      return relayFetchReq(rreq, "GET").then(function (res) {
        return throwIfHttpError(like, "", res).then(function () { return res.json(); });
      }).then(function (data) {
        return idsFromModelsData(like, data || {});
      }, function (err) {
        if (err && err.name === "AbortError") throw new Error("The relay took too long to answer. Try again.");
        if (err instanceof Error && err.message) throw err;
        throw new Error("The relay returned an unreadable reply.");
      });
    }
    var req = buildRequest(like, "/models");
    var opts = { headers: req.headers, signal: withTimeout(45000) };
    return fetch(req.url, opts).then(function (res) {
      if (res.ok) return res.json();
      return res.text().then(function (text) {
        throw new Error(listRefusal(like, res.status, text));
      }, function () {
        throw new Error(listRefusal(like, res.status, ""));
      });
    }).then(function (data) {
      return idsFromModelsData(like, data || {});
    }, function (err) {
      if (err && err.name === "AbortError") throw new Error("The provider took too long to answer. Try again.");
      if (err && err.name === "TypeError") throw new Error("Could not reach the provider. Check the address and your connection.");
      if (err instanceof Error && err.message) throw err;
      throw new Error("Could not reach the provider. Check the address and your connection.");
    });
  }

  /* One real request before anything is kept. Empty when the model answered,
     otherwise the provider's own words. */
  function probeModel(like, model) {
    var req, body;
    if (like.kind === "anthropic") {
      req = buildRequest(like, "/messages");
      body = { model: model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] };
    } else if (like.kind === "gemini") {
      req = buildRequest(like, "/models/" + encodeURIComponent(model) + ":generateContent");
      body = { contents: [{ parts: [{ text: "Hi" }] }] };
    } else {
      req = buildRequest(like, "/chat/completions");
      body = { model: model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }], stream: false };
    }
    req.headers["Content-Type"] = "application/json";
    if (like && like.useRelay) {
      return relayFetchReq(req, "POST", body).then(function (res) {
        return throwIfHttpError(like, model, res).then(function () { return ""; });
      }, function (err) {
        if (err && err.name === "AbortError") return "The relay took too long to answer. Try again.";
        if (err instanceof Error && err.message) return err.message;
        return "The relay returned an unreadable reply.";
      });
    }
    return fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(body),
      signal: withTimeout(30000)
    }).then(function (res) {
      return throwIfHttpError(like, model, res).then(function () { return ""; });
    }, function (err) {
      if (err && err.name === "AbortError") return "The provider took too long to answer. Try again.";
      if (err && err.name === "TypeError") return "Could not reach the provider. Check the address and your connection.";
      if (err instanceof Error && err.message) return err.message;
      return "Could not reach the provider. Check the address and your connection.";
    });
  }

  function readSSE(res, onData) {
    if (!res.body || !res.body.getReader) {
      return res.text().then(function (text) {
        text.split("\n").forEach(function (line) {
          line = line.trim();
          if (line.indexOf("data:") === 0) {
            var data = line.slice(5).trim();
            if (data && data !== "[DONE]") {
              try { onData(JSON.parse(data)); } catch (e) { /* partial line */ }
            }
          }
        });
      });
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function (part) {
        if (part.done) return;
        buf += decoder.decode(part.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          var line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.indexOf("data:") === 0) {
            var data = line.slice(5).trim();
            if (data === "[DONE]") return;
            if (data) {
              try { onData(JSON.parse(data)); } catch (e) { /* partial line */ }
            }
          }
        }
        return pump();
      });
    }
    return pump();
  }

  function streamChat(provider, model, history, signal, onDelta, onThink) {
    if (provider && provider.useRelay) return unstreamedChat(provider, model, history, signal, onDelta);
    var req, body;
    if (provider.kind === "anthropic") {
      req = buildRequest(provider, "/messages");
      req.headers["Content-Type"] = "application/json";
      body = { model: model, max_tokens: 1024, system: SYS_MSG, messages: history, stream: true };
      return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: signal })
        .then(function (res) {
          return throwIfHttpError(provider, model, res).then(function () {
            return readSSE(res, function (d) {
              if (d.type === "content_block_delta" && d.delta && d.delta.type === "text_delta" && d.delta.text) {
                onDelta(d.delta.text);
              } else if (onThink && d.type === "content_block_delta" && d.delta && d.delta.type === "thinking_delta" && d.delta.thinking) {
                onThink(d.delta.thinking);
              }
            });
          });
        });
    }
    if (provider.kind === "gemini") {
      req = buildRequest(provider, "/models/" + encodeURIComponent(model) + ":streamGenerateContent", { alt: "sse" });
      req.headers["Content-Type"] = "application/json";
      body = {
        systemInstruction: { parts: [{ text: SYS_MSG }] },
        contents: history.map(function (m) {
          return { role: m.role === "assistant" ? "model" : "user", parts: geminiParts(m.content) };
        })
      };
      return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: signal })
        .then(function (res) {
          return throwIfHttpError(provider, model, res).then(function () {
            return readSSE(res, function (d) {
              (d.candidates || []).forEach(function (c) {
                var parts = (c.content && c.content.parts) || [];
                parts.forEach(function (part) {
                  if (!part || !part.text) return;
                  if (part.thought) { if (onThink) onThink(part.text); }
                  else onDelta(part.text);
                });
              });
            });
          });
        });
    }
    req = buildRequest(provider, "/chat/completions");
    req.headers["Content-Type"] = "application/json";
    body = {
      model: model,
      messages: [{ role: "system", content: SYS_MSG }].concat(history),
      stream: true
    };
    return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: signal })
      .then(function (res) {
        return throwIfHttpError(provider, model, res).then(function () {
          return readSSE(res, function (d) {
            var choice = d.choices && d.choices[0];
            var delta = choice && (choice.delta || choice.message);
            if (delta && delta.content) onDelta(delta.content);
            if (onThink && delta && delta.reasoning_content) onThink(delta.reasoning_content);
          });
        });
      });
  }

  /* One unstreamed completion that resolves with the full text. */
  function completeOnce(provider, model, messages) {
    return new Promise(function (resolve, reject) {
      var out = "";
      streamChat(provider, model, messages, undefined, function (c) { out += c; }).then(function () {
        resolve(out);
      }, reject);
    });
  }

  function cleanTitle(t) {
    var lines = String(t || "").split("\n");
    var line = "";
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { line = lines[i].trim(); break; }
    }
    line = line.replace(/^["']+|["']+$/g, "").replace(/\.+$/, "");
    if (!line || line.length > 70) return "";
    return line;
  }

  /* ---------- markdown renderer (escapes first, then formats) ---------- */

  function inlineMd(s) {
    var t = escapeHtml(s);
    var stash = [];
    function hold(html) { stash.push(html); return "\u0000" + (stash.length - 1) + "\u0000"; }
    t = t.replace(/`([^`\n]+?)`/g, function (m, g) { return hold('<code class="md-code">' + g + "</code>"); });
    t = t.replace(/\[([^\]]+?)\]\((https?:[^)\s]+)\)/g, function (m, g1, g2) {
      return hold('<a href="' + g2 + '" target="_blank" rel="noopener">' + g1 + "</a>");
    });
    t = t.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|\W)\*([^*\n]+?)\*/g, "$1<em>$2</em>");
    t = t.replace(/(^|\W)_([^_\n]+?)_/g, "$1<em>$2</em>");
    t = t.replace(/\u0000(\d+)\u0000/g, function (m, g) { return stash[+g]; });
    return t;
  }

  function isBlockStart(line) {
    return /^```/.test(line) ||
      /^\s{0,3}#{1,4}\s+/.test(line) ||
      /^\s*---+\s*$/.test(line) ||
      /^\s*>/.test(line) ||
      /^\s*\|.*\|\s*$/.test(line) ||
      /^(\s*)([-*•]|\d+[.)])\s+/.test(line);
  }

  function splitRow(line) {
    var t = line.trim().replace(/^\||\|$/g, "");
    return t.split("|").map(function (c) { return c.trim(); });
  }

  function parseList(lines, start) {
    var html = "", i = start;
    var stack = [];
    var itemRe = /^(\s*)([-*•]|\d+[.)])\s+(.*)/;
    function openList(type, indent) {
      html += type === "ol" ? '<ol class="md-list">' : '<ul class="md-list">';
      stack.push({ indent: indent, type: type, liOpen: false });
    }
    function closeItem() {
      if (stack.length && stack[stack.length - 1].liOpen) {
        html += "</li>";
        stack[stack.length - 1].liOpen = false;
      }
    }
    function closeList() {
      var s = stack.pop();
      html += s.type === "ol" ? "</ol>" : "</ul>";
    }
    while (i < lines.length) {
      var m = lines[i].match(itemRe);
      if (!m) break;
      var indent = m[1].replace(/\t/g, "  ").length;
      var type = /^\d/.test(m[2]) ? "ol" : "ul";
      var text = m[3];
      if (!stack.length) {
        openList(type, indent);
      } else {
        var top = stack[stack.length - 1];
        if (indent > top.indent) {
          openList(type, indent);
        } else {
          while (stack.length && indent < stack[stack.length - 1].indent) {
            closeItem();
            closeList();
          }
          if (!stack.length) {
            openList(type, indent);
          } else if (indent === stack[stack.length - 1].indent && type !== stack[stack.length - 1].type) {
            closeItem();
            closeList();
            openList(type, indent);
          } else {
            closeItem();
          }
        }
      }
      html += "<li>" + inlineMd(text);
      stack[stack.length - 1].liOpen = true;
      i++;
    }
    while (stack.length) { closeItem(); closeList(); }
    return { html: html, next: i };
  }

  function thinkHtml(inner) {
    return '<div class="think"><button type="button" class="think-head" data-think><i data-lucide="chevron-down"></i><span>Thought</span></button>' +
      '<div class="think-body" hidden>' + renderMarkdownBody(inner) + "</div></div>";
  }

  function fullText(s) {
    return (s.think ? "<think>\n" + s.think + "\n</think>\n\n" : "") + s.text;
  }

  function renderMarkdown(src) {
    var parts = String(src || "").split(/(<think>[\s\S]*?<\/(?:think|thinking)>|<thinking>[\s\S]*?<\/(?:think|thinking)>)/i);
    if (parts.length === 1) return renderMarkdownBody(src);
    var html = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var inner = parts[i].replace(/^<thinking?>/i, "").replace(/<\/(think|thinking)>$/i, "");
        html += thinkHtml(inner);
      } else {
        html += renderMarkdownBody(parts[i]);
      }
    }
    return html;
  }

  function renderMarkdownBody(src) {
    src = String(src).replace(/\r\n?/g, "\n");
    var fences = (src.match(/^```/gm) || []).length;
    if (fences % 2 === 1) src += "\n```";
    var lines = src.split("\n");
    var html = "", i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var m;
      if (/^```/.test(line)) {
        var lang = line.slice(3).trim() || "code";
        i++;
        var buf = [];
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<div class="codeblock"><div class="code-head"><span>' + escapeHtml(lang) +
          '</span><button class="mini-btn copy-code" type="button"><i data-lucide="copy"></i><span>Copy</span></button></div>' +
          "<pre><code>" + escapeHtml(buf.join("\n")) + "</code></pre></div>";
        continue;
      }
      if (/^\s{0,3}#{1,4}\s+/.test(line)) {
        m = line.match(/^(#{1,4})\s+(.*)/);
        var lvl = Math.min(m[1].length + 1, 5);
        html += "<h" + lvl + ' class="md-h">' + inlineMd(m[2]) + "</h" + lvl + ">";
        i++;
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) { html += '<hr class="md-hr">'; i++; continue; }
      if (/^\s*>/.test(line)) {
        var qb = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          qb.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        html += '<blockquote class="md-quote">' + qb.map(function (l) {
          return "<p>" + (inlineMd(l) || "<br>") + "</p>";
        }).join("") + "</blockquote>";
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|\-]+\|\s*$/.test(lines[i + 1])) {
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
          head.map(function (c) { return "<th>" + inlineMd(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>" +
          rows.map(function (r) {
            return "<tr>" + r.map(function (c) { return "<td>" + inlineMd(c) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div>";
        continue;
      }
      var lm = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)/);
      if (lm) {
        var parsed = parseList(lines, i);
        html += parsed.html;
        i = parsed.next;
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      var pb = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { pb.push(lines[i]); i++; }
      html += '<p class="md-p">' + inlineMd(pb.join(" ")) + "</p>";
    }
    return html;
  }

  /* ---------- toasts ---------- */

  var toastsEl = $("toasts");

  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* noop */ }
  }

  var TOAST_ICON = { info: "info", success: "circle-check", error: "triangle-alert", warn: "circle-alert" };
  var liveToasts = [];

  function toast(msg, actionLabel, onAction, ms, kind) {
    kind = kind || "info";
    while (toastsEl.children.length >= 3) {
      var oldest = toastsEl.children[0];
      if (oldest && oldest._dismiss) oldest._dismiss();
      else if (oldest) oldest.remove();
      else break;
    }
    var el = document.createElement("div");
    el.className = "toast " + kind;
    el.innerHTML = '<i data-lucide="' + TOAST_ICON[kind] + '"></i>';
    var span = document.createElement("span");
    span.className = "toast-msg";
    span.textContent = msg;
    el.appendChild(span);
    var timer = null;
    var remaining = ms || 3200;
    var started = 0;
    var gone = false;
    function dismiss() {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      var i = liveToasts.indexOf(rec);
      if (i !== -1) liveToasts.splice(i, 1);
      el.classList.remove("in");
      setTimeout(function () { el.remove(); }, REDUCED ? 0 : 240);
    }
    function arm() {
      clearTimeout(timer);
      started = Date.now();
      timer = setTimeout(dismiss, remaining);
    }
    var rec = { pause: function () { clearTimeout(timer); remaining = Math.max(0, remaining - (Date.now() - started)); }, resume: arm };
    el._dismiss = dismiss;
    if (actionLabel) {
      var btn = document.createElement("button");
      btn.className = "toast-act";
      btn.type = "button";
      btn.textContent = actionLabel;
      btn.addEventListener("click", function () {
        try { onAction(); } catch (e) { /* noop */ }
        dismiss();
      });
      el.appendChild(btn);
    }
    var sx = 0, sdx = 0, st = 0, pid = null;
    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      pid = e.pointerId;
      sx = e.clientX; sdx = 0; st = Date.now();
      try { el.setPointerCapture(pid); } catch (err) { /* noop */ }
    });
    el.addEventListener("pointermove", function (e) {
      if (e.pointerId !== pid) return;
      sdx = e.clientX - sx;
      el.style.transform = "translateY(0) translateX(" + sdx + "px)";
    });
    el.addEventListener("pointerup", function (e) {
      if (e.pointerId !== pid) return;
      pid = null;
      var dt = Math.max(1, Date.now() - st);
      if (Math.abs(sdx) > el.offsetWidth * 0.4 || Math.abs(sdx) / dt > 0.35) {
        el.style.transform = "translateX(" + (sdx < 0 ? "-" : "") + "120%)";
        el.style.opacity = "0";
        setTimeout(dismiss, 180);
      } else {
        el.style.transform = "";
      }
    });
    el.addEventListener("pointercancel", function () { pid = null; el.style.transform = ""; });
    toastsEl.appendChild(el);
    liveToasts.push(rec);
    refreshIcons();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!gone) el.classList.add("in");
      });
    });
    arm();
    return dismiss;
  }

  toast.success = function (msg, ms) { return toast(msg, null, null, ms, "success"); };
  toast.error = function (msg, ms) { buzz(25); return toast(msg, null, null, ms || 4200, "error"); };
  toast.warn = function (msg, ms) { return toast(msg, null, null, ms || 4200, "warn"); };
  toast.info = function (msg, ms) { return toast(msg, null, null, ms, "info"); };
  toast.promise = function (p, o) {
    o = o || {};
    var dismiss = toast(o.loading || "Working...", null, null, 60000, "info");
    return p.then(function (v) {
      dismiss();
      toast(typeof o.success === "function" ? o.success(v) : (o.success || "Done"), null, null, 3200, "success");
      return v;
    }, function (e) {
      dismiss();
      toast(typeof o.error === "function" ? o.error(e) : (o.error || "Something failed"), null, null, 4200, "error");
      throw e;
    });
  };

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) liveToasts.forEach(function (r) { r.pause(); });
    else liveToasts.forEach(function (r) { r.resume(); });
  });

  function copyText(text, msg) {
    function done() { toast(msg || "Copied to clipboard"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) { /* noop */ }
      ta.remove();
      done();
    }
  }

  /* ---------- popovers (origin aware, scale from trigger) ---------- */

  var openPop = null;
  var openPopTrigger = null;

  function placePop(el, rect, opts) {
    opts = opts || {};
    var side = opts.side || "bottom";
    var align = opts.align || "start";
    var gap = 8;
    el.hidden = false;
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var left, top, origin;
    if (align === "end") {
      left = rect.right - w;
      origin = "right";
    } else if (align === "center") {
      left = rect.left + rect.width / 2 - w / 2;
      origin = "center";
    } else {
      left = rect.left;
      origin = "left";
    }
    if (side === "top") {
      top = rect.top - h - gap;
      origin = "bottom " + origin;
    } else {
      top = rect.bottom + gap;
      origin = "top " + origin;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    if (top < 8) top = 8;
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.setProperty("--origin", origin);
    el.style.visibility = "";
    void el.offsetWidth;
    el.classList.add("open");
  }

  function showPop(el, trigger, opts) {
    if (openPop === el) { hidePop(); return; }
    hidePop(true);
    openPop = el;
    openPopTrigger = trigger || null;
    if (openPopTrigger) openPopTrigger.setAttribute("aria-expanded", "true");
    var rect = (trigger && trigger.getBoundingClientRect) ? trigger.getBoundingClientRect() : { left: 16, right: 250, top: 60, bottom: 100, width: 234 };
    placePop(el, rect, opts);
  }

  function hidePop(instant) {
    if (!openPop) return;
    var el = openPop;
    openPop = null;
    if (openPopTrigger) {
      openPopTrigger.setAttribute("aria-expanded", "false");
      openPopTrigger = null;
    }
    el.classList.remove("open");
    if (instant || REDUCED) {
      el.hidden = true;
    } else {
      setTimeout(function () {
        if (!el.classList.contains("open")) el.hidden = true;
      }, 150);
    }
  }

  document.addEventListener("pointerdown", function (e) {
    if (!openPop) return;
    if (openPop.contains(e.target)) return;
    if (openPopTrigger && openPopTrigger.contains(e.target)) return;
    hidePop();
  });

  /* ---------- modals ---------- */

  function openModal(el) {
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add("open");
  }

  function closeModal(el) {
    el.classList.remove("open");
    var delay = (el.id === "searchModal" || el.id === "palette" || REDUCED) ? 0 : 220;
    setTimeout(function () {
      if (!el.classList.contains("open")) el.hidden = true;
    }, delay);
  }

  /* ---------- chat list ---------- */

  var groupsEl = $("chatGroups");

  function startOfDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupLabel(ts) {
    var dayMs = 24 * HOUR;
    var diff = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / dayMs);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff <= 7) return "Previous 7 days";
    if (diff <= 30) return "Previous 30 days";
    return "Older";
  }

  function folderById(id) {
    if (!id) return null;
    return state.folders.filter(function (f) { return f.id === id; })[0] || null;
  }

  function byUpdated(a, b) { return b.updatedAt - a.updatedAt; }

  function chatRowEl(c) {
    var row = document.createElement("div");
    row.className = "chat-row" + (c.id === activeId ? " active" : "");
    row.setAttribute("role", "listitem");
    row.dataset.id = c.id;

    var openBtn = document.createElement("button");
    openBtn.className = "chat-title";
    openBtn.type = "button";
    openBtn.textContent = c.title;
    openBtn.title = c.title;
    openBtn.addEventListener("click", function () { openChat(c.id); });
    row.appendChild(openBtn);

    var badge = document.createElement("span");
    badge.className = "row-model";
    badge.textContent = String(c.model || "Demo").slice(0, 16);
    row.appendChild(badge);

    var menuBtn = document.createElement("button");
    menuBtn.className = "row-menu";
    menuBtn.type = "button";
    menuBtn.setAttribute("aria-label", "Options for " + c.title);
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.innerHTML = '<i data-lucide="ellipsis"></i>';
    menuBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      itemMenuId = c.id;
      itemMenuBtn = menuBtn;
      $("pinItem").querySelector("span").textContent = c.pinned ? "Unpin" : "Pin";
      showPop($("itemMenu"), menuBtn, { side: "bottom", align: "end" });
    });
    row.appendChild(menuBtn);
    return row;
  }

  function folderEl(f, chats) {
    var wrap = document.createElement("div");
    wrap.className = "folder" + (f.open === false ? " closed" : "");
    wrap.dataset.folder = f.id;
    var head = document.createElement("div");
    head.className = "folder-head";
    var tog = document.createElement("button");
    tog.type = "button";
    tog.className = "folder-toggle";
    tog.setAttribute("aria-expanded", f.open === false ? "false" : "true");
    tog.innerHTML = '<i data-lucide="chevron-down"></i>';
    var nm = document.createElement("span");
    nm.textContent = f.name;
    tog.appendChild(nm);
    var ct = document.createElement("span");
    ct.className = "folder-count";
    ct.textContent = chats.length;
    tog.appendChild(ct);
    tog.addEventListener("click", function () {
      f.open = f.open === false;
      save();
      renderList();
    });
    head.appendChild(tog);
    var rn = document.createElement("button");
    rn.type = "button";
    rn.className = "folder-mini";
    rn.title = "Rename folder";
    rn.setAttribute("aria-label", "Rename " + f.name);
    rn.innerHTML = '<i data-lucide="pencil"></i>';
    rn.addEventListener("click", function () { startFolderRename(f.id); });
    head.appendChild(rn);
    var del = document.createElement("button");
    del.type = "button";
    del.className = "folder-mini danger";
    del.title = "Delete folder (keeps chats)";
    del.setAttribute("aria-label", "Delete " + f.name);
    del.innerHTML = '<i data-lucide="trash-2"></i>';
    del.addEventListener("click", function () { deleteFolder(f.id); });
    head.appendChild(del);
    wrap.appendChild(head);
    var body = document.createElement("div");
    body.className = "folder-body";
    chats.forEach(function (c) { body.appendChild(chatRowEl(c)); });
    wrap.appendChild(body);
    return wrap;
  }

  function deleteFolder(id) {
    state.chats.forEach(function (c) { if (c.folderId === id) c.folderId = null; });
    state.folders = state.folders.filter(function (f) { return f.id !== id; });
    save();
    renderList();
    toast("Folder deleted. Its chats were kept.");
  }

  function startFolderRename(id) {
    var f = folderById(id);
    if (!f) return;
    var span = groupsEl.querySelector('.folder[data-folder="' + id + '"] .folder-toggle span:not(.folder-count)');
    if (!span) return;
    var box = document.createElement("input");
    box.className = "rename-input";
    box.value = f.name;
    box.setAttribute("aria-label", "Rename folder");
    box.addEventListener("click", function (e) { e.stopPropagation(); });
    span.parentElement.replaceChild(box, span);
    box.focus();
    box.select();
    var done = false;
    function commit(saveIt) {
      if (done) return;
      done = true;
      if (saveIt && box.value.trim()) {
        f.name = box.value.trim().slice(0, 40);
        save();
      }
      renderList();
    }
    box.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    box.addEventListener("blur", function () { commit(true); });
  }

  function renderFolderMenu(chatId) {
    var chat = getChat(chatId);
    var current = (chat && chat.folderId) || null;
    var box = $("folderMenuList");
    box.innerHTML = "";
    var opts = [{ id: null, name: "No folder", icon: "message-square" }].concat(state.folders.map(function (f) {
      return { id: f.id, name: f.name, icon: "folder" };
    }));
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.className = "pop-item";
      b.type = "button";
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", current === o.id ? "true" : "false");
      b.innerHTML = '<i data-lucide="' + o.icon + '"></i>';
      var s = document.createElement("span");
      s.textContent = o.name;
      b.appendChild(s);
      if (current === o.id) b.innerHTML += '<i data-lucide="check"></i>';
      b.addEventListener("click", function () {
        if (chat) {
          chat.folderId = o.id;
          chat.updatedAt = Date.now();
          save();
        }
        hidePop(true);
        renderList();
      });
      box.appendChild(b);
    });
    refreshIcons();
  }

  function renderList() {
    var order = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
    var buckets = {};
    order.forEach(function (k) { buckets[k] = []; });
    var pinned = [];
    var byFolder = {};
    state.chats.slice().sort(byUpdated).forEach(function (c) {
      var f = c.folderId && folderById(c.folderId);
      if (f) {
        (byFolder[f.id] = byFolder[f.id] || []).push(c);
      } else if (c.pinned) {
        pinned.push(c);
      } else {
        buckets[groupLabel(c.updatedAt)].push(c);
      }
    });

    groupsEl.innerHTML = "";
    function label(text) {
      var h = document.createElement("p");
      h.className = "group-label";
      h.textContent = text;
      groupsEl.appendChild(h);
    }
    if (pinned.length) {
      label("Pinned");
      pinned.forEach(function (c) { groupsEl.appendChild(chatRowEl(c)); });
    }
    state.folders.forEach(function (f) {
      groupsEl.appendChild(folderEl(f, byFolder[f.id] || []));
    });
    order.forEach(function (text) {
      var list = buckets[text];
      if (!list.length) return;
      label(text);
      list.forEach(function (c) { groupsEl.appendChild(chatRowEl(c)); });
    });
    refreshIcons();
  }

  /* ---------- messages ---------- */

  var messagesEl = $("messages");
  var chatScroll = $("chatScroll");
  var emptyState = $("emptyState");
  var composerDock = $("composerDock");
  var composerBlock = $("composerBlock");
  var emptySlot = $("emptySlot");
  var dockSlot = $("dockSlot");
  var chipsEl = $("chips");
  var input = $("input");
  var sendBtn = $("sendBtn");
  var stopBtn = $("stopBtn");

  function isNearBottom() {
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
  }

  function scrollBottom() {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function rateBtn(act, rating, title, label, icon) {
    var on = rating === act;
    return '<button type="button" data-act="' + act + '" title="' + title + '" aria-label="' + label + '"' +
      (on ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '><i data-lucide="' + icon + '"></i></button>';
  }

  function ensureVariants(msg) {
    if (!msg.variants || !msg.variants.length) {
      msg.variants = [msg.content || ""];
      msg.vi = 0;
    }
    if (msg.vi == null || msg.vi < 0 || msg.vi >= msg.variants.length) msg.vi = msg.variants.length - 1;
    return msg;
  }

  function statsHtml(msg) {
    if (!msg.stats || msg.stats.ms == null) return "";
    var secs = Math.max(1, Math.round(msg.stats.ms / 1000));
    var toks = msg.stats.toks > 0 ? " · ≈" + msg.stats.toks + " tok" : "";
    return '<span class="msg-stats">' + secs + "s" + toks + "</span>";
  }

  function actionsHtml(msg) {
    msg = ensureVariants(msg || { content: "" });
    var pager = "";
    if (msg.variants.length > 1) {
      pager = '<span class="pager">' +
        '<button type="button" data-act="prev" title="Previous version" aria-label="Previous version"><i data-lucide="chevron-left"></i></button>' +
        "<span>" + (msg.vi + 1) + "/" + msg.variants.length + "</span>" +
        '<button type="button" data-act="next" title="Next version" aria-label="Next version"><i data-lucide="chevron-right"></i></button>' +
        "</span>";
    }
    return '<div class="msg-actions">' +
      '<button type="button" data-act="copy" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>' +
      rateBtn("like", msg.rating, "Good response", "Good response", "thumbs-up") +
      rateBtn("dislike", msg.rating, "Bad response", "Bad response", "thumbs-down") +
      '<button type="button" data-act="retry" title="Regenerate" aria-label="Regenerate"><i data-lucide="rotate-ccw"></i></button>' +
      '<button type="button" data-act="speak" title="Read aloud" aria-label="Read aloud"><i data-lucide="volume-2"></i></button>' +
      pager + statsHtml(msg) +
      "</div>";
  }

  function userRowHtml(msg) {
    var text = typeof msg === "string" ? msg : (msg.content || "");
    var imgs = "";
    if (msg && msg.images && msg.images.length) {
      imgs = '<div class="bubble-imgs">' + msg.images.map(function (u) {
        return '<a href="' + u + '" target="_blank" rel="noreferrer noopener"><img src="' + u + '" alt="Attached image"></a>';
      }).join("") + "</div>";
    }
    return imgs + '<div class="bubble">' + escapeHtml(text).replace(/\n/g, "<br>") + "</div>" +
      '<div class="msg-actions user-actions">' +
      '<button type="button" data-act="copy" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>' +
      '<button type="button" data-act="edit" title="Edit and resend" aria-label="Edit and resend"><i data-lucide="pencil"></i></button>' +
      "</div>";
  }

  function errorCardHtml(sentence) {
    return '<div class="msg-error"><i data-lucide="triangle-alert"></i><div class="msg-error-text"><strong>Message failed</strong><p>' +
      escapeHtml(sentence || "Something went wrong.") + '</p><button type="button" class="btn small" data-act="retry"><i data-lucide="rotate-ccw"></i><span>Retry</span></button></div></div>';
  }

  function assistantBodyHtml(msg) {
    if (msg.error && !msg.content) return errorCardHtml(msg.error);
    return linkCites(renderMarkdown(msg.content || ""), msg) + sourcesHtml(msg);
  }

  function assistantRowHtml(msg, withActions) {
    return '<div class="msg-body">' + assistantBodyHtml(msg) + "</div>" + (withActions ? actionsHtml(msg) : "");
  }

  function animateIn(row) {
    if (REDUCED) return;
    row.classList.add("enter");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        row.classList.add("show");
        setTimeout(function () { row.classList.remove("enter", "show"); }, 260);
      });
    });
  }

  function renderMessages() {
    var chat = getChat(activeId);
    messagesEl.innerHTML = "";
    if (!chat) return;
    chat.messages.forEach(function (m, i) {
      var row = document.createElement("div");
      row.className = "msg " + m.role;
      row.dataset.i = i;
      row.innerHTML = m.role === "user" ? userRowHtml(m) : assistantRowHtml(m, true);
      messagesEl.appendChild(row);
    });
    refreshIcons();
  }

  function showEmpty() {
    emptyState.hidden = false;
    messagesEl.hidden = true;
    composerDock.hidden = true;
    emptySlot.appendChild(composerBlock);
    applyChipsVisibility();
  }

  function showDock() {
    emptyState.hidden = true;
    messagesEl.hidden = false;
    composerDock.hidden = false;
    dockSlot.appendChild(composerBlock);
  }

  function applyChipsVisibility() {
    chipsEl.style.display = state.settings.showChips ? "" : "none";
  }

  function openChat(id) {
    stopStream();
    clearFollowups();
    awayBase = -1;
    stopSpeak();
    jumpPill.hidden = true;
    activeId = id;
    renderList();
    renderMessages();
    showDock();
    scrollBottom();
    dnote("chat", "Opened " + getChat(id).title);
    if (window.innerWidth <= 768) document.body.classList.remove("nav-open");
  }

  function newChat() {
    stopStream();
    clearFollowups();
    awayBase = -1;
    stopSpeak();
    jumpPill.hidden = true;
    activeId = null;
    renderList();
    messagesEl.innerHTML = "";
    showEmpty();
    autogrow();
    dnote("chat", "New chat started");
    syncSend();
    if (window.innerWidth <= 768) document.body.classList.remove("nav-open");
    if (window.innerWidth > 768) input.focus();
  }

  /* ---------- streaming: canned demo + live provider ---------- */

  function setStreamingUI(on) {
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
  }

  function stopStream() {
    if (!stream) return;
    var s = stream;
    stream = null;
    setStreamingUI(false);
    if (s.live) {
      s.stopped = true;
      if (s.controller) {
        try { s.controller.abort(); } catch (e) { /* noop */ }
      }
      /* The live driver's finish path runs next and tidies up. */
    } else {
      s.stopped = true;
      clearTimeout(s.thinkTimer);
      clearInterval(s.timer);
      if (s.row && s.row.isConnected && s.chatId === activeId) {
        finalizeStreamRow(s, true);
      }
    }
  }

  function finalizeStreamRow(s) {
    var chat = getChat(s.chatId);
    var content = s.tokens.slice(0, s.pos).join("");
    var msg = chat && chat.messages[s.index];
    if (msg) {
      msg.content = content;
      msg.error = null;
      if (msg.variants) msg.variants[msg.vi] = content;
      chat.updatedAt = Date.now();
      save();
    }
    s.body.innerHTML = msg ? assistantBodyHtml(msg) : renderMarkdown(content);
    if (!s.row.querySelector(".msg-actions")) {
      s.row.insertAdjacentHTML("beforeend", actionsHtml(msg || { content: content }));
    }
    refreshIcons();
    if (!s.stopped && msg) showFollowups(chat, msg);
    if (awayBase !== -1) updateJumpPill();
    renderList();
    drainNext();
  }

  function streamAssistant(chat, reply) {
    var index = chat.messages.length;
    chat.messages.push({ role: "assistant", content: "", ts: Date.now() });

    var row = document.createElement("div");
    row.className = "msg assistant";
    row.dataset.i = index;
    row.innerHTML = '<div class="msg-body"><span class="dots"><span></span><span></span><span></span></span></div>';
    messagesEl.appendChild(row);
    if (isNearBottom()) scrollBottom();

    setStreamingUI(true);

    var tokens = reply.match(/\S+\s+|\S+$/g) || [reply];
    var s = {
      chatId: chat.id,
      index: index,
      tokens: tokens,
      pos: 0,
      row: row,
      body: row.querySelector(".msg-body"),
      timer: null,
      thinkTimer: null
    };
    stream = s;

    function tick() {
      if (stream !== s) return;
      var step = REDUCED ? 14 : (tokens.length > 220 ? 3 : 2);
      s.pos = Math.min(tokens.length, s.pos + step);
      var stick = isNearBottom();
      s.body.innerHTML = renderMarkdown(tokens.slice(0, s.pos).join("")) + '<span class="cursor"></span>';
      if (stick) scrollBottom();
      if (s.pos >= tokens.length) {
        clearInterval(s.timer);
        stream = null;
        setStreamingUI(false);
        finalizeStreamRow(s);
        if (stick) scrollBottom();
      }
    }

    s.thinkTimer = setTimeout(function () {
      if (stream !== s) return;
      tick();
      s.timer = setInterval(tick, REDUCED ? 10 : 26);
    }, REDUCED ? 60 : 520);
  }

  function splitDataUrl(u) {
    var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(String(u || ""));
    if (!m) return null;
    return { mime: m[1] || "image/jpeg", data: m[3] || "" };
  }

  function geminiParts(c) {
    if (typeof c === "string") return [{ text: c }];
    return c.map(function (p) {
      if (!p || typeof p !== "object") return { text: "" };
      if (typeof p.text === "string") return { text: p.text };
      if (p.inline_data) return { inline_data: p.inline_data };
      if (p.image_url && p.image_url.url) {
        var g = splitDataUrl(p.image_url.url);
        return g ? { inline_data: { mime_type: g.mime, data: g.data } } : { text: "" };
      }
      if (p.source && p.source.data) {
        return { inline_data: { mime_type: p.source.media_type || "image/jpeg", data: p.source.data } };
      }
      return { text: "" };
    });
  }

  function historyFor(messages, kind) {
    kind = kind || "openai";
    return messages
      .filter(function (m) { return String(m.content || "").trim() !== "" || (m.images && m.images.length); })
      .slice(-30)
      .map(function (m) {
        if (!m.images || !m.images.length || m.role !== "user") return { role: m.role, content: m.content };
        var parts = [{ type: "text", text: m.content || "" }];
        m.images.forEach(function (u) {
          if (kind === "anthropic") {
            var a = splitDataUrl(u);
            if (a) parts.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.data } });
          } else if (kind === "gemini") {
            var g = splitDataUrl(u);
            if (g) parts.push({ inline_data: { mime_type: g.mime, data: g.data } });
          } else {
            parts.push({ type: "image_url", image_url: { url: u } });
          }
        });
        return { role: m.role, content: parts };
      });
  }

  /* replaceIdx null appends a fresh answer, otherwise regenerates in place. */
  function streamLive(chat, provider, model, history, replaceIdx) {
    var idx, row;
    if (replaceIdx == null) {
      idx = chat.messages.length;
      chat.messages.push({ role: "assistant", content: "", ts: Date.now() });
      row = document.createElement("div");
      row.className = "msg assistant";
      row.dataset.i = idx;
      row.innerHTML = '<div class="msg-body"><span class="dots"><span></span><span></span><span></span></span></div>';
      messagesEl.appendChild(row);
    } else {
      idx = replaceIdx;
      row = messagesEl.querySelector('.msg[data-i="' + idx + '"]');
      if (!row) return;
      var rm = chat.messages[idx];
      if (rm) rm.error = null;
      var oldActions = row.querySelector(".msg-actions");
      if (oldActions) oldActions.remove();
      row.querySelector(".msg-body").innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
    }

    setStreamingUI(true);
    if (isNearBottom()) scrollBottom();

    var s = {
      live: true,
      chatId: chat.id,
      index: idx,
      row: row,
      body: row.querySelector(".msg-body"),
      text: "",
      dirty: false,
      raf: 0,
      controller: ("AbortController" in window) ? new AbortController() : null,
      stopped: false,
      done: false,
      t0: Date.now(),
      provider: provider,
      model: model,
      viaRelay: !!(provider && provider.useRelay)
    };
    stream = s;

    function renderFrame() {
      s.raf = 0;
      if (stream !== s || !s.dirty) return;
      s.dirty = false;
      var stick = isNearBottom();
      if (s.body.isConnected) {
        s.body.innerHTML = renderMarkdown(fullText(s)) + '<span class="cursor"></span>';
        if (s.thinkOpen) {
          var th = s.body.querySelector(".think-body");
          var hd = s.body.querySelector(".think-head");
          if (th) th.hidden = false;
          if (hd) hd.classList.add("open");
        }
      }
      if (stick) scrollBottom();
    }

    streamChat(provider, model, history, s.controller ? s.controller.signal : undefined, function (chunk) {
      if (stream !== s) return;
      s.text += chunk;
      s.dirty = true;
      if (!s.raf) s.raf = requestAnimationFrame(renderFrame);
    }, function (t) {
      if (stream !== s) return;
      s.think = (s.think || "") + t;
      if (!s.thinkTouched) s.thinkOpen = true;
      s.dirty = true;
      if (!s.raf) s.raf = requestAnimationFrame(renderFrame);
    }).then(function () {
      finishLive(s, false, null);
    }, function (err) {
      finishLive(s, true, err);
    });
  }

  function finishLive(s, failed, err) {
    if (s.done) return;
    s.done = true;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (stream === s) {
      stream = null;
      setStreamingUI(false);
    }
    if (failed && err && err.name === "AbortError") {
      failed = false; /* stopped by the user, or timed out mid stream */
      s.stopped = true;
    }
    var chat = getChat(s.chatId);
    var msg = chat && chat.messages[s.index];
    if (!s.text && (s.stopped || !failed)) {
      /* Stopped before a word arrived: leave no empty bubble behind. */
      if (chat) {
        chat.messages.splice(s.index, 1);
        save();
      }
      if (s.row.isConnected) s.row.remove();
      drainNext();
      return;
    }
    s.text = fullText(s);
    var sentence = failed ? fetchSentence(err) : "";
    lastOutcome = failed ? "bad" : "ok";
    syncHealth();
    if (msg) {
      msg.content = s.text;
      msg.error = failed ? sentence : null;
      msg.stats = { ms: Date.now() - (s.t0 || Date.now()), toks: Math.round(s.text.length / 4) };
      if (msg.variants) msg.variants[msg.vi] = s.text;
      chat.updatedAt = Date.now();
      save();
    }
    if (s.row.isConnected) {
      s.body.innerHTML = msg ? assistantBodyHtml(msg) : renderMarkdown(s.text);
      if (!s.row.querySelector(".msg-actions")) {
        s.row.insertAdjacentHTML("beforeend", actionsHtml(msg || { content: s.text }));
      }
      refreshIcons();
      if (isNearBottom()) scrollBottom();
    }
    if (failed) {
      dfail("chat", sentence);
      if (err && err.name === "TypeError" && s.viaRelay) markRelayDown();
    } else if (msg) {
      maybeRetitle(chat, s.provider, s.model);
    }
    if (!failed && !s.stopped && msg) showFollowups(chat, msg);
    if (awayBase !== -1) updateJumpPill();
    renderList();
    drainNext();
  }

  function clearTraceDemo() {
    messagesEl.querySelectorAll(".msg.demo").forEach(function (n) { n.remove(); });
  }

  function playTraceDemo() {
    clearTraceDemo();
    if (!window.NovaTrace || !window.NovaTrace.playDemo) {
      dnote("app", "Trace demo unavailable.");
      return;
    }
    showDock();
    dnote("app", "Playing the agent trace demo.");
    window.NovaTrace.playDemo(messagesEl, {
      refreshIcons: refreshIcons,
      renderMarkdown: renderMarkdown,
      pin: function () { if (isNearBottom()) scrollBottom(); }
    });
  }

  function syncSearchBtn() {
    var on = !!state.settings.searchMode;
    $("searchBtn").setAttribute("aria-pressed", on ? "true" : "false");
    $("searchBtn").title = on ? "Deep search is on" : "Deep search the web";
  }

  function fetchSearchViaRelay(query, limit, signal) {
    var cfg = relayCfg();
    if (!cfg.url) return Promise.reject(new Error("Set the relay address in the provider editor under Advanced, Relay."));
    if (!cfg.key) return Promise.reject(new Error("Add the relay key in the provider editor under Advanced, Relay."));
    var url = stripSlash(cfg.url) + "/v1/search";
    var opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key },
      body: JSON.stringify({ query: query, limit: limit || 8 })
    };
    if (signal) opts.signal = signal;
    return fetch(url, opts).then(function (res) {
      if (res.status === 401) throw new Error("That relay key was rejected. Check it on the relay dashboard.");
      return res.json().then(function (data) { return { status: res.status, data: data }; }, function () {
        throw new Error("The search came back unreadable.");
      });
    }).then(function (env) {
      if (env.status !== 200) throw new Error((env.data && env.data.detail) || ("Search failed (" + env.status + ")."));
      return { results: env.data.results || [], provider: env.data.provider || "" };
    }, function (err) {
      if (err && err.name === "AbortError") throw err;
      if (err && err.name === "TypeError") { markRelayDown(); throw new Error("Could not reach the relay. Check the relay address."); }
      throw err;
    });
  }

  /* First line of a rewrite reply, quotes stripped. Empty means the plan
     failed and the run falls back to the user's own words. */
  function cleanQuery(s) {
    var lines = String(s || "").split("\n");
    var line = "";
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { line = lines[i].trim(); break; }
    }
    line = line.replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "");
    if (!line || line.length > 120) return "";
    return line;
  }

  function streamResearched(chat, provider, model, userText, replaceIdx) {
    var idx, row;
    if (replaceIdx == null) {
      idx = chat.messages.length;
      chat.messages.push({ role: "assistant", content: "", ts: Date.now(), researched: true });
      row = document.createElement("div");
      row.className = "msg assistant";
      row.dataset.i = idx;
      row.innerHTML = '<div class="msg-body"><span class="dots"><span></span><span></span><span></span></span></div>';
      messagesEl.appendChild(row);
    } else {
      idx = replaceIdx;
      row = messagesEl.querySelector('.msg[data-i="' + idx + '"]');
      if (!row) return;
      var rm = chat.messages[idx];
      if (rm) { rm.error = null; rm.researched = true; }
      var oldTrace = row.querySelector(".agent-trace");
      if (oldTrace) oldTrace.remove();
      var oldActions = row.querySelector(".msg-actions");
      if (oldActions) oldActions.remove();
      row.querySelector(".msg-body").innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
    }
    var trace = window.NovaTrace.mountTrace(row, { active: "Thinking" });
    refreshIcons();
    var tickTimer = setInterval(function () { trace.setElapsed(); }, 500);
    setStreamingUI(true);
    if (isNearBottom()) scrollBottom();

    var s = {
      live: true,
      chatId: chat.id,
      index: idx,
      row: row,
      body: row.querySelector(".msg-body"),
      text: "",
      dirty: false,
      raf: 0,
      controller: ("AbortController" in window) ? new AbortController() : null,
      stopped: false,
      done: false,
      t0: Date.now(),
      provider: provider,
      model: model,
      viaRelay: !!(provider && provider.useRelay)
    };
    stream = s;

    function renderFrame() {
      s.raf = 0;
      if (stream !== s || !s.dirty) return;
      s.dirty = false;
      var stick = isNearBottom();
      if (s.body.isConnected) {
        s.body.innerHTML = renderMarkdown(fullText(s)) + '<span class="cursor"></span>';
        if (s.thinkOpen) {
          var th = s.body.querySelector(".think-body");
          var hd = s.body.querySelector(".think-head");
          if (th) th.hidden = false;
          if (hd) hd.classList.add("open");
        }
      }
      if (stick) scrollBottom();
    }

    var shown = 0;
    var siCount = 0;
    function emit(ev) {
      if (!row.isConnected) return;
      if (ev.t === "status") trace.setStatus(ev.text + (ev.provider ? " via " + niceProvider(ev.provider) : ""));
      else if (ev.t === "query") trace.addRow({ kind: "query", primary: ev.q, mono: true });
      else if (ev.t === "source") {
        siCount++;
        if (shown < 5) {
          trace.addRow({ primary: ev.title, secondary: ev.sub, href: ev.href, si: siCount });
          shown++;
        }
      }
      else if (ev.t === "more") trace.setMore(ev.n);
      else if (ev.t === "settle") {
        trace.settle(ev.text);
        if (s.body.isConnected) s.body.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
      }
      refreshIcons();
      if (isNearBottom()) scrollBottom();
    }

    var signal = s.controller ? s.controller.signal : undefined;
    window.NovaHarness.harness.runAgent({
      query: userText,
      signal: signal,
      emit: emit,
      search: function (q, limit) { return fetchSearchViaRelay(q, limit, signal); },
      excluded: chat.excluded,
      rewrite: function (text) {
        return new Promise(function (resolve) {
          var out = "";
          streamChat(provider, model, [{ role: "user", content: "Rewrite this chat request as one short web search query of 3 to 10 words. Reply with only the query and no quotes.\n\nRequest: " + text }], signal, function (c) { out += c; }).then(function () {
            resolve(cleanQuery(out));
          }, function () { resolve(""); });
        });
      },
      onDelta: function (chunk) {
        if (stream !== s) return;
        s.text += chunk;
        s.dirty = true;
        if (!s.raf) s.raf = requestAnimationFrame(renderFrame);
      },
      onThink: function (t) {
        if (stream !== s) return;
        s.think = (s.think || "") + t;
        if (!s.thinkTouched) s.thinkOpen = true;
        s.dirty = true;
        if (!s.raf) s.raf = requestAnimationFrame(renderFrame);
      },
      complete: function (system, user, onDelta, onThink) {
        /* One user message on purpose: the Anthropic shape rejects a system
           role inside messages, and a single user message is valid on all
           three provider shapes. */
        return streamChat(provider, model, [{ role: "user", content: system + "\n\n" + user }], signal, onDelta, onThink);
      }
    }).then(function (out) {
      clearInterval(tickTimer);
      var c = getChat(s.chatId);
      var m = c && c.messages[s.index];
      if (m && out && out.sources) {
        m.sources = out.sources.map(function (r) { return { title: r.title || r.url, url: r.url }; });
        save();
      }
      finishLive(s, false, null);
    }, function (err) {
      clearInterval(tickTimer);
      if (err && err.name !== "AbortError") {
        if (s.body.isConnected) trace.settle("Search failed");
        if (!s.text) s.text = err.message;
      }
      finishLive(s, true, err);
    });
  }

  function send(text) {
    text = (text || "").trim();
    clearTraceDemo();
    stopSpeak();
    if (!text) return;
    if (typeof navigator.onLine === "boolean" && !navigator.onLine) {
      state.outbox.push(text);
      save();
      updateBanners();
      toast("Offline. Your message will send when you reconnect.");
      input.value = "";
      autogrow();
      syncSend();
      return;
    }
    if (stream) stopStream();
    lastSendAt = Date.now();
    buzz(10);

    var chat = getChat(activeId);
    if (!chat) {
      chat = {
        id: uid(),
        title: titleFrom(text),
        model: "Demo",
        providerId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
      };
      state.chats.unshift(chat);
      activeId = chat.id;
    }
    chat.messages.push({ role: "user", content: text, ts: Date.now() });
    if (pendingImages.length) {
      chat.messages[chat.messages.length - 1].images = pendingImages.map(function (p) { return p.url; });
      pendingImages = [];
      renderAttachPreview();
      if (!getTarget()) toast("Demo replies cannot see your images. Only the text was sent.");
    }
    chat.updatedAt = Date.now();
    save();

    showDock();
    renderList();

    var row = document.createElement("div");
    row.className = "msg user";
    row.dataset.i = chat.messages.length - 1;
    row.innerHTML = userRowHtml(chat.messages[chat.messages.length - 1]);
    messagesEl.appendChild(row);
    animateIn(row);
    scrollBottom();

    input.value = "";
    autogrow();
    syncSend();

    routeSend(chat, text, null);
  }

  function abortReplace(chat, replaceIdx) {
    var m = chat.messages[replaceIdx];
    if (!m) { renderMessages(); return; }
    if (m.variants && m.variants.length > 1 && m.variants[m.variants.length - 1] === "" && !m.content) {
      m.variants.pop();
      m.vi = m.variants.length - 1;
      m.content = m.variants[m.vi];
    } else if (!m.content) {
      chat.messages.splice(replaceIdx, 1);
    }
    save();
    renderMessages();
  }

  function routeSend(chat, text, replaceIdx) {
    clearFollowups();
    stopSpeak();
    var t = getTarget();
    if (t && t.missingKey) {
      dwarn("provider", "Missing key for " + t.provider.label + ", chat not sent");
      if (replaceIdx != null) abortReplace(chat, replaceIdx);
      toast("Add a key to " + t.provider.label + " first.");
      openSettings("providers");
      return;
    }
    if (t) {
      chat.model = providerDisplay(t.provider);
      chat.providerId = t.provider.id;
      save();
      if (state.settings.searchMode && window.NovaHarness && window.NovaTrace) {
        dnote("chat", "Research via " + providerDisplay(t.provider));
        streamResearched(chat, t.provider, t.model, text, replaceIdx);
      } else {
        dnote("chat", "Chat via " + providerDisplay(t.provider) + " (" + chat.messages.length + " messages)");
        var hist = replaceIdx == null ? historyFor(chat.messages, t.provider.kind) : historyFor(chat.messages.slice(0, replaceIdx), t.provider.kind);
        streamLive(chat, t.provider, t.model, hist, replaceIdx);
      }
    } else {
      dnote("chat", "Chat via demo replies");
      if (replaceIdx == null) {
        streamAssistant(chat, generateReply(text));
      } else {
        var row = messagesEl.querySelector('.msg[data-i="' + replaceIdx + '"]');
        if (row) cannedRetry(chat, row, replaceIdx, text);
        else abortReplace(chat, replaceIdx);
      }
    }
  }

  function cannedRetry(chat, row, idx, prevUser) {
    var reply = generateReply(prevUser || chat.title);
    var tokens = reply.match(/\S+\s+|\S+$/g) || [reply];
    var body = row.querySelector(".msg-body");
    var oldActions = row.querySelector(".msg-actions");
    if (oldActions) oldActions.remove();
    setStreamingUI(true);
    var s = {
      chatId: chat.id,
      index: idx,
      tokens: tokens,
      pos: 0,
      row: row,
      body: body,
      timer: null,
      thinkTimer: null
    };
    stream = s;
    var timer = setInterval(function () {
      if (stream !== s) { clearInterval(timer); return; }
      s.pos = Math.min(tokens.length, s.pos + 3);
      var stick = isNearBottom();
      s.body.innerHTML = renderMarkdown(tokens.slice(0, s.pos).join("")) + '<span class="cursor"></span>';
      if (stick) scrollBottom();
      if (s.pos >= tokens.length) {
        clearInterval(timer);
        stream = null;
        setStreamingUI(false);
        finalizeStreamRow(s);
      }
    }, REDUCED ? 10 : 22);
    s.timer = timer;
  }

  function startEditUser(chat, row, idx, msg) {
    var bubble = row.querySelector(".bubble");
    if (!bubble || row.querySelector(".edit-box")) return;
    var box = document.createElement("div");
    box.className = "edit-box";
    box.innerHTML = '<textarea aria-label="Edit message"></textarea><div class="edit-row"><button type="button" class="btn small" data-e="cancel">Cancel</button><button type="button" class="btn small primary" data-e="save">Send</button></div>';
    var ta = box.querySelector("textarea");
    ta.value = msg.content;
    row.replaceChild(box, bubble);
    var acts = row.querySelector(".msg-actions");
    if (acts) acts.style.display = "none";
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    function grow() { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 240) + "px"; }
    ta.addEventListener("input", grow);
    grow();
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-e]");
      if (!b) return;
      if (b.dataset.e === "save") applyUserEdit(chat, idx, ta.value);
      else {
        row.innerHTML = userRowHtml(msg);
        refreshIcons();
      }
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && state.settings.enterToSend) {
        e.preventDefault();
        applyUserEdit(chat, idx, ta.value);
      }
      if (e.key === "Escape") {
        row.innerHTML = userRowHtml(msg);
        refreshIcons();
      }
    });
  }

  function applyUserEdit(chat, idx, newText) {
    newText = (newText || "").trim();
    var msg = chat.messages[idx];
    if (!msg || msg.role !== "user") { renderMessages(); return; }
    if (!newText || newText === msg.content) { renderMessages(); return; }
    var t = getTarget();
    if (t && t.missingKey) {
      renderMessages();
      toast("Add a key to " + t.provider.label + " first.");
      openSettings("providers");
      return;
    }
    msg.content = newText;
    var dropped = chat.messages.splice(idx + 1);
    var stash = null;
    if (dropped.length === 1 && dropped[0].role === "assistant" && dropped[0].content && !dropped[0].error) {
      stash = dropped[0].content;
    } else if (dropped.length) {
      var n = dropped.filter(function (m) { return m.role === "assistant" && m.content; }).length;
      if (n) toast(n === 1 ? "1 following reply was replaced." : n + " following replies were replaced.");
    }
    var fresh = { role: "assistant", content: "", ts: Date.now() };
    if (stash != null) { fresh.variants = [stash]; fresh.vi = 1; }
    chat.messages.push(fresh);
    chat.updatedAt = Date.now();
    save();
    renderMessages();
    showDock();
    scrollBottom();
    routeSend(chat, newText, chat.messages.length - 1);
  }

  function updateBanners() {
    var box = $("banners");
    var html = "";
    if (typeof navigator.onLine === "boolean" && !navigator.onLine) {
      html += '<div class="banner warn" role="status"><i data-lucide="wifi-off"></i><span>You are offline.' +
        (state.outbox.length ? " " + state.outbox.length + " queued." : " Messages will send when you reconnect.") + "</span></div>";
    } else if (relayDown) {
      html += '<div class="banner danger" role="alert"><i data-lucide="triangle-alert"></i><span>Relay unreachable.</span><button type="button" class="btn small" id="relayRecheck">Recheck</button></div>';
    }
    box.innerHTML = html;
    box.hidden = !html;
    refreshIcons();
    syncHealth();
    var rb = $("relayRecheck");
    if (rb) rb.addEventListener("click", recheckRelay);
  }

  function markRelayDown() {
    if (relayDown) return;
    relayDown = true;
    updateBanners();
  }

  function recheckRelay() {
    var cfg = relayCfg();
    if (!cfg.url) { toast("Set the relay address first."); openSettings("providers"); return; }
    fetch(stripSlash(cfg.url) + "/health", { headers: { Authorization: "Bearer " + cfg.key } }).then(function (r) {
      if (!r.ok) throw new Error("bad");
      relayDown = false;
      updateBanners();
      toast.success("Relay is reachable again.");
    }, function () { toast.error("Relay is still unreachable."); });
  }

  function drainNext() {
    if (stream || !state.outbox.length) { draining = state.outbox.length > 0 && !!stream; return; }
    if (typeof navigator.onLine === "boolean" && !navigator.onLine) { draining = false; return; }
    draining = true;
    send(state.outbox.shift());
    save();
  }

  function maybeRetitle(chat, provider, model) {
    if (!chat || chat.customTitle || titling[chat.id] || !provider || !model) return;
    if (chat.messages.length !== 2) return;
    var first = chat.messages[0];
    var second = chat.messages[1];
    if (!first || first.role !== "user" || !second || second.role !== "assistant" || second.error) return;
    titling[chat.id] = true;
    completeOnce(provider, model, [{ role: "user", content: "Title this chat in 6 words or fewer. Reply with only the title, no quotes.\n\nQ: " + first.content.slice(0, 300) + "\n\nA: " + second.content.slice(0, 500) }]).then(function (t) {
      titling[chat.id] = false;
      t = cleanTitle(t);
      var c = getChat(chat.id);
      if (t && c && !c.customTitle) {
        c.title = t;
        c.updatedAt = Date.now();
        save();
        renderList();
      }
    }, function () { titling[chat.id] = false; });
  }

  var NICE_PROV = { "bing-html": "Bing", "ddg-html": "DuckDuckGo" };
  function niceProvider(p) {
    if (!p) return "";
    if (NICE_PROV[p]) return NICE_PROV[p];
    if (p.indexOf("searxng:") === 0) return "SearXNG";
    return p;
  }

  function hostOf(url) {
    try { return new URL(String(url)).hostname.replace(/^www\./, ""); }
    catch (e) { return ""; }
  }

  function linkCites(html, msg) {
    if (!msg.sources || !msg.sources.length) return html;
    var parts = String(html).split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/\[(\d{1,2})\]/g, function (m, d) {
        var n = +d;
        if (n < 1 || n > msg.sources.length) return m;
        return '<button type="button" class="cite" data-cite="' + n + '">[' + n + "]</button>";
      });
    }
    return parts.join("");
  }

  function sourcesHtml(msg) {
    if (!msg.sources || !msg.sources.length) return "";
    var items = msg.sources.map(function (s, i) {
      var host = hostOf(s.url);
      return '<li data-si="' + (i + 1) + '"><a href="' + escapeHtml(s.url) + '" target="_blank" rel="noreferrer noopener">' +
        escapeHtml(s.title || s.url) + "</a>" +
        (host ? '<span class="src-host">' + escapeHtml(host) + "</span>" : "") +
        (host ? '<button type="button" class="src-hide" data-exdom="' + escapeHtml(host) + '" title="Hide this site and research again" aria-label="Hide ' + escapeHtml(host) + ' and research again"><i data-lucide="eye-off"></i></button>' : "") +
        "</li>";
    }).join("");
    return '<div class="sources"><button type="button" class="sources-head" data-act="sources"><i data-lucide="chevron-down"></i><span>' +
      msg.sources.length + " sources</span></button>" +
      '<ol class="sources-list" hidden>' + items + "</ol></div>";
  }

  function jumpToSource(row, n) {
    var list = row.querySelector(".sources-list");
    if (list && list.hidden) {
      list.hidden = false;
      var head = row.querySelector(".sources-head");
      if (head) head.classList.add("open");
    }
    var target = row.querySelector('.trace-row[data-si="' + n + '"]') || (list && list.querySelector('li[data-si="' + n + '"]'));
    if (!target) return;
    target.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
    target.classList.add("flash");
    setTimeout(function () { target.classList.remove("flash"); }, 1200);
  }

  function prepRegen(chat, msg) {
    ensureVariants(msg);
    msg.vi = msg.variants.length;
    msg.variants.push("");
    msg.content = "";
    msg.error = null;
    msg.rating = null;
    msg.stats = null;
    msg.sources = null;
    chat.updatedAt = Date.now();
    save();
  }

  function prevUserText(chat, idx) {
    for (var k = idx - 1; k >= 0; k--) {
      if (chat.messages[k].role === "user") return chat.messages[k].content;
    }
    return "";
  }

  function excludeAndRetry(exBtn) {
    if (stream) return;
    var row = exBtn.closest(".msg");
    var chat = getChat(activeId);
    if (!row || !chat) return;
    var idx = +row.dataset.i;
    var msg = chat.messages[idx];
    if (!msg || msg.role !== "assistant") return;
    var dom = exBtn.dataset.exdom;
    if (chat.excluded.indexOf(dom) === -1) {
      chat.excluded.push(dom);
      save();
    }
    toast("Hidden " + dom + ". Researching again.");
    prepRegen(chat, msg);
    routeSend(chat, prevUserText(chat, idx), idx);
  }

  var FU_BANK = [
    { k: ["code", "python", "function", "error", "bug", "javascript", "sql", "regex"], s: ["Show a complete example", "Explain it line by line", "What are the common mistakes?"] },
    { k: ["write", "email", "draft", "essay", "blog", "cover letter"], s: ["Make it shorter", "Make it firmer", "Give me two more versions"] },
    { k: ["recipe", "cook", "food", "diet"], s: ["Give me the full recipe", "What can I substitute?", "How long does it keep?"] },
    { k: [], s: ["Go deeper on this", "Give a concrete example", "Summarize the key points"] }
  ];

  function followupsFor(userText, answerText) {
    var blob = ((userText || "") + " " + (answerText || "").slice(0, 500)).toLowerCase();
    for (var i = 0; i < FU_BANK.length - 1; i++) {
      for (var j = 0; j < FU_BANK[i].k.length; j++) {
        if (blob.indexOf(FU_BANK[i].k[j]) !== -1) return FU_BANK[i].s;
      }
    }
    return FU_BANK[FU_BANK.length - 1].s;
  }

  function clearFollowups() {
    var f = $("followups");
    if (f) f.remove();
  }

  function showFollowups(chat, msg) {
    clearFollowups();
    if (!chat || !msg || msg.role !== "assistant" || msg.error || stream) return;
    if (getChat(activeId) !== chat) return;
    var idx = chat.messages.indexOf(msg);
    if (idx !== chat.messages.length - 1) return;
    var userText = prevUserText(chat, idx);
    var row = messagesEl.querySelector('.msg[data-i="' + idx + '"]');
    if (!row) return;
    var wrap = document.createElement("div");
    wrap.className = "followups";
    wrap.id = "followups";
    followupsFor(userText, msg.content).forEach(function (s) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "followup";
      b.textContent = s;
      b.addEventListener("click", function () { send(s); });
      wrap.appendChild(b);
    });
    row.appendChild(wrap);
  }

  /* ---------- jump to latest ---------- */

  var jumpPill = $("jumpPill");
  var awayBase = -1;

  chatScroll.addEventListener("scroll", function () {
    if (isNearBottom()) {
      awayBase = -1;
      jumpPill.hidden = true;
      return;
    }
    if (awayBase === -1) {
      var chat = getChat(activeId);
      awayBase = chat ? chat.messages.length : 0;
    }
    updateJumpPill();
  });

  function updateJumpPill() {
    if (awayBase === -1) { jumpPill.hidden = true; return; }
    var chat = getChat(activeId);
    var n = chat ? Math.max(0, chat.messages.length - awayBase) : 0;
    jumpPill.querySelector("span").textContent = n > 0 ? n + " new" : "Latest";
    jumpPill.hidden = false;
  }

  jumpPill.addEventListener("click", function () {
    awayBase = -1;
    jumpPill.hidden = true;
    scrollBottom();
  });

  /* ---------- command palette (instant, keyboard driven) ---------- */

  var paletteEl = $("palette");
  var paletteInput = $("paletteInput");
  var paletteResults = $("paletteResults");
  var paletteHot = 0;
  var paletteRows = [];

  function paletteCommands() {
    return [
      { icon: "square-pen", title: "New chat", hint: "Start fresh", run: function () { newChat(); } },
      { icon: "search", title: "Search chats", hint: "Find a conversation", run: function () { openSearch(); } },
      { icon: "globe", title: state.settings.searchMode ? "Turn deep search off" : "Turn deep search on", hint: "Research with citations", run: function () { $("searchBtn").click(); } },
      { icon: "moon", title: "Appearance", hint: "Next theme", run: function () { var n = THEME_ORDER[(THEME_ORDER.indexOf(state.settings.theme) + 1) % THEME_ORDER.length]; applyTheme(n); } },
      { icon: "settings", title: "Settings", hint: "General", run: function () { openSettings("general"); } },
      { icon: "cpu", title: "Providers", hint: "Keys and models", run: function () { openSettings("providers"); } },
      { icon: "download", title: "Export chats", hint: "JSON backup", run: function () { doExportJSON(); } }
    ];
  }

  function paletteModels() {
    var rows = [{ icon: "flask-conical", title: "Demo replies", hint: state.settings.activeProviderId ? "" : "Active", pid: null }];
    state.providers.forEach(function (p) {
      rows.push({ icon: "cpu", title: p.label + " · " + (activeModelOf(p) || "no model"), hint: p.id === state.settings.activeProviderId ? "Active" : "", pid: p.id });
    });
    return rows;
  }

  function paletteRowHtml(r) {
    var i = paletteRows.indexOf(r);
    return '<button type="button" class="palette-row' + (i === paletteHot ? " hot" : "") + '" data-pi="' + i + '">' +
      '<i data-lucide="' + r.icon + '"></i><span>' + escapeHtml(r.title) + "</span>" +
      (r.hint ? '<span class="ph">' + escapeHtml(r.hint) + "</span>" : "") + "</button>";
  }

  function syncPaletteHot() {
    var btns = paletteResults.querySelectorAll("[data-pi]");
    btns.forEach(function (b) { b.classList.toggle("hot", +b.dataset.pi === paletteHot); });
    var hot = paletteResults.querySelector('[data-pi="' + paletteHot + '"]');
    if (hot && hot.scrollIntoView) hot.scrollIntoView({ block: "nearest" });
  }

  function renderPalette() {
    var q = paletteInput.value.trim().toLowerCase();
    var cmds = paletteCommands().filter(function (c) { return !q || c.title.toLowerCase().indexOf(q) !== -1 || (c.hint && c.hint.toLowerCase().indexOf(q) !== -1); });
    var models = paletteModels().filter(function (m) { return !q || m.title.toLowerCase().indexOf(q) !== -1 || "model".indexOf(q) !== -1; });
    paletteRows = cmds.concat(models);
    if (paletteHot >= paletteRows.length) paletteHot = 0;
    var html = "";
    if (cmds.length) {
      html += '<p class="palette-sec">Commands</p>';
      cmds.forEach(function (c) { html += paletteRowHtml(c); });
    }
    if (models.length) {
      html += '<p class="palette-sec">Models</p>';
      models.forEach(function (m) { html += paletteRowHtml(m); });
    }
    if (!paletteRows.length) html = '<p class="search-empty">No matches</p>';
    paletteResults.innerHTML = html;
    syncPaletteHot();
    refreshIcons();
  }

  function runPaletteRow(i) {
    var r = paletteRows[i];
    if (!r) return;
    closePalette();
    if (r.pid !== undefined) {
      state.settings.activeProviderId = r.pid;
      save();
      syncModelLabel();
      renderModelMenu();
      dnote("app", "Model set from palette");
    } else {
      r.run();
    }
  }

  function openPalette() {
    hidePop(true);
    paletteEl.hidden = false;
    paletteEl.classList.add("open");
    paletteInput.value = "";
    paletteHot = 0;
    renderPalette();
    setTimeout(function () { paletteInput.focus(); }, 0);
  }

  function closePalette() {
    paletteEl.classList.remove("open");
    paletteEl.hidden = true;
  }

  paletteInput.addEventListener("input", function () { paletteHot = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      paletteHot = e.key === "ArrowDown"
        ? Math.min(paletteRows.length - 1, paletteHot + 1)
        : Math.max(0, paletteHot - 1);
      syncPaletteHot();
    } else if (e.key === "Enter") {
      runPaletteRow(paletteHot);
    } else if (e.key === "Escape") {
      closePalette();
    }
  });
  paletteResults.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pi]");
    if (b) runPaletteRow(+b.dataset.pi);
  });
  paletteResults.addEventListener("pointermove", function (e) {
    var b = e.target.closest("[data-pi]");
    if (b && +b.dataset.pi !== paletteHot) { paletteHot = +b.dataset.pi; syncPaletteHot(); }
  });
  paletteEl.addEventListener("pointerdown", function (e) {
    if (e.target === paletteEl) closePalette();
  });
  $("paletteBtn").addEventListener("click", openPalette);
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (paletteEl.hidden) openPalette();
      else closePalette();
    }
  });

  /* ---------- read aloud ---------- */

  var speakingRow = null;

  function stripMd(s) {
    return String(s || "")
      .replace(/```[\s\S]*?```/g, " code omitted ")
      .replace(/<think>[\s\S]*?<\/(think|thinking)>/gi, " ")
      .replace(/<thinking>[\s\S]*?<\/(think|thinking)>/gi, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`>#|\-=]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stopSpeak() {
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* noop */ }
    if (speakingRow && speakingRow.isConnected) {
      var b = speakingRow.querySelector('[data-act="speak"]');
      if (b) { b.classList.remove("on"); b.innerHTML = '<i data-lucide="volume-2"></i>'; refreshIcons(); }
    }
    speakingRow = null;
  }

  function speakRow(row, text) {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      toast("Read aloud is not supported in this browser.");
      return;
    }
    if (speakingRow === row) { stopSpeak(); return; }
    stopSpeak();
    var said = stripMd(text).slice(0, 4000);
    if (!said) return;
    var u = new SpeechSynthesisUtterance(said);
    u.onend = function () { if (speakingRow === row) stopSpeak(); };
    var b = row.querySelector('[data-act="speak"]');
    if (b) { b.classList.add("on"); b.innerHTML = '<i data-lucide="square"></i>'; refreshIcons(); }
    speakingRow = row;
    window.speechSynthesis.speak(u);
  }

  /* message action delegation */

  messagesEl.addEventListener("click", function (e) {
    var copyBtn = e.target.closest(".copy-code");
    if (copyBtn) {
      var code = copyBtn.closest(".codeblock").querySelector("code").innerText;
      copyText(code, "Code copied to clipboard");
      copyBtn.innerHTML = '<i data-lucide="check"></i><span>Copied</span>';
      refreshIcons();
      setTimeout(function () {
        if (copyBtn.isConnected) {
          copyBtn.innerHTML = '<i data-lucide="copy"></i><span>Copy</span>';
          refreshIcons();
        }
      }, 1500);
      return;
    }
    var thinkBtn = e.target.closest("[data-think]");
    if (thinkBtn) {
      var tbody = thinkBtn.parentElement.querySelector(".think-body");
      if (tbody) {
        tbody.hidden = !tbody.hidden;
        thinkBtn.classList.toggle("open", !tbody.hidden);
        var trow = thinkBtn.closest(".msg");
        if (trow && stream && stream.row === trow) { stream.thinkOpen = !tbody.hidden; stream.thinkTouched = true; }
      }
      return;
    }
    var cite = e.target.closest("[data-cite]");
    if (cite) {
      var crow = cite.closest(".msg");
      if (crow) jumpToSource(crow, +cite.dataset.cite);
      return;
    }
    var ex = e.target.closest("[data-exdom]");
    if (ex) {
      excludeAndRetry(ex);
      return;
    }
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var row = btn.closest(".msg");
    var chat = getChat(activeId);
    if (!row || !chat) return;
    var idx = +row.dataset.i;
    var msg = chat.messages[idx];
    if (!msg) return;
    var act = btn.dataset.act;

    if (act === "sources") {
      var list = row.querySelector(".sources-list");
      var head = row.querySelector(".sources-head");
      if (list) {
        list.hidden = !list.hidden;
        if (head) head.classList.toggle("open", !list.hidden);
      }
    } else if (act === "speak") {
      speakRow(row, msg.content);
    } else if (act === "copy") {
      copyText(msg.content, "Copied to clipboard");
    } else if (act === "like" || act === "dislike") {
      var other = act === "like" ? "dislike" : "like";
      var otherBtn = row.querySelector('[data-act="' + other + '"]');
      btn.classList.toggle("on");
      if (otherBtn) otherBtn.classList.remove("on");
      btn.setAttribute("aria-pressed", btn.classList.contains("on") ? "true" : "false");
      msg.rating = btn.classList.contains("on") ? act : null;
      chat.updatedAt = Date.now();
      save();
    } else if (act === "prev" || act === "next") {
      if (stream) return;
      if (msg.role !== "assistant") return;
      ensureVariants(msg);
      var ni = msg.vi + (act === "next" ? 1 : -1);
      if (ni < 0 || ni >= msg.variants.length) return;
      msg.vi = ni;
      msg.content = msg.variants[ni];
      msg.error = null;
      chat.updatedAt = Date.now();
      save();
      var body = row.querySelector(".msg-body");
      if (body) body.innerHTML = assistantBodyHtml(msg);
      var acts = row.querySelector(".msg-actions");
      if (acts) acts.outerHTML = actionsHtml(msg);
      refreshIcons();
    } else if (act === "edit") {
      if (stream) return;
      if (msg.role !== "user") return;
      startEditUser(chat, row, idx, msg);
    } else if (act === "retry") {
      if (stream) return;
      prepRegen(chat, msg);
      routeSend(chat, prevUserText(chat, idx), idx);
    }
  });

  /* ---------- composer ---------- */

  function autogrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  function updateTokEst() {
    var el = $("tokEst");
    var chars = input.value.length;
    var imgs = pendingImages.length;
    if (!chars && !imgs) { el.hidden = true; return; }
    var est = Math.round(chars / 4) + imgs * 1000;
    el.hidden = false;
    el.textContent = "\u2248" + (est >= 1000 ? (est / 1000).toFixed(1) + "k" : est);
    el.classList.toggle("large", est > 30000);
    el.title = est > 30000 ? "Large message. Some models may refuse it." : "Estimated tokens";
  }

  function syncSend() {
    sendBtn.disabled = input.value.trim().length === 0;
    updateTokEst();
  }

  input.addEventListener("input", function () { autogrow(); syncSend(); });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      if (state.settings.enterToSend) {
        e.preventDefault();
        send(input.value);
      }
    }
  });

  sendBtn.addEventListener("click", function () { send(input.value); });
  stopBtn.addEventListener("click", function () {
    stopStream();
    if (!input.value && Date.now() - lastSendAt < 5000) {
      var chat = getChat(activeId);
      if (chat) {
        for (var i = chat.messages.length - 1; i >= 0; i--) {
          if (chat.messages[i].role === "user") {
            input.value = chat.messages[i].content;
            autogrow();
            syncSend();
            input.focus();
            break;
          }
        }
      }
    }
  });

  chipsEl.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (!chip) return;
    send(chip.dataset.prompt);
  });

  /* ---------- model menu (demo + every provider) ---------- */

  var modelMenuBody = $("modelMenuBody");

  var lastOutcome = null;

  function syncHealth() {
    var dot = $("healthDot");
    if (!getTarget()) { dot.hidden = true; return; }
    dot.hidden = false;
    var bad = relayDown || lastOutcome === "bad";
    dot.classList.toggle("bad", bad);
    dot.classList.toggle("ok", !bad && lastOutcome === "ok");
    dot.title = bad ? "Last request failed" : (lastOutcome === "ok" ? "Provider reachable" : "Provider ready");
  }

  function syncModelLabel() {
    var p = activeProvider();
    $("modelName").textContent = providerDisplay(p);
    syncHealth();
  }

  function modelRow(icon, title, sub, checked, attrs) {
    var b = document.createElement("button");
    b.className = "pop-model";
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", checked ? "true" : "false");
    Object.keys(attrs || {}).forEach(function (k) { b.setAttribute(k, attrs[k]); });
    b.innerHTML = '<i data-lucide="' + icon + '"></i><span><strong></strong><em></em></span><i data-lucide="check" class="check"></i>';
    b.querySelector("strong").textContent = title;
    b.querySelector("em").textContent = sub;
    return b;
  }

  function renderModelMenu() {
    modelMenuBody.innerHTML = "";
    var label = document.createElement("p");
    label.className = "pop-label";
    label.textContent = "Model";
    modelMenuBody.appendChild(label);

    var demoBtn = modelRow("flask-conical", "Demo replies", "Built in sample answers", !state.settings.activeProviderId, { "data-demo-use": "1" });
    modelMenuBody.appendChild(demoBtn);

    state.providers.forEach(function (p) {
      var preset = presetMatch(p.kind, p.baseUrl);
      var checked = state.settings.activeProviderId === p.id;
      var m = activeModelOf(p);
      var sub = m ? (checked ? m + " · In use" : m) : "No model chosen yet";
      modelMenuBody.appendChild(modelRow(preset.icon, p.label, sub, checked, {
        "data-prov": p.id
      }));
    });

    var sep = document.createElement("div");
    sep.className = "pop-sep";
    modelMenuBody.appendChild(sep);
    var manage = document.createElement("button");
    manage.className = "pop-item";
    manage.type = "button";
    manage.setAttribute("role", "menuitem");
    manage.setAttribute("data-manage", "1");
    manage.innerHTML = '<i data-lucide="settings"></i><span>Manage providers</span>';
    modelMenuBody.appendChild(manage);
    refreshIcons();
  }

  $("modelMenu").addEventListener("click", function (e) {
    if (e.target.closest("[data-manage]")) {
      hidePop(true);
      openSettings("providers");
      return;
    }
    if (e.target.closest("[data-demo-use]")) {
      state.settings.activeProviderId = null;
      save();
      syncModelLabel();
      renderModelMenu();
      dnote("provider", "Switched to demo replies");
      hidePop();
      return;
    }
    var item = e.target.closest("[data-prov]");
    if (!item) return;
    var p = getProvider(item.getAttribute("data-prov"));
    if (!p) return;
    state.settings.activeProviderId = p.id;
    save();
    syncModelLabel();
    renderModelMenu();
    renderProviders();
    dnote("provider", "Now using " + providerDisplay(p));
    hidePop();
  });

  /* ---------- drawer gestures (mobile): swipe to close, edge to open ---------- */

  (function drawerGestures() {
    var sidebar = $("sidebar");
    var backdrop = $("backdrop");
    var pid = null;
    var intent = null;
    var decided = false;
    var startX = 0, startY = 0, startT = 0, dx = 0;
    var suppress = false;

    function width() { return sidebar.offsetWidth || 264; }

    function begin(e, want) {
      suppress = false;
      pid = e.pointerId;
      intent = want;
      decided = false;
      startX = e.clientX; startY = e.clientY; startT = Date.now();
      dx = 0;
    }

    function cancel() {
      pid = null; intent = null; decided = false;
      sidebar.style.transition = "";
      sidebar.style.transform = "";
      sidebar.style.visibility = "";
      backdrop.style.opacity = "";
    }

    sidebar.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" || window.innerWidth > 768) return;
      if (!document.body.classList.contains("nav-open")) return;
      begin(e, "close");
    });
    document.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" || window.innerWidth > 768) return;
      if (pid !== null) return;
      if (document.body.classList.contains("nav-open")) return;
      if (e.clientX > 20) return;
      begin(e, "open");
    });
    document.addEventListener("pointermove", function (e) {
      if (e.pointerId !== pid || !intent) return;
      var nx = e.clientX - startX;
      var ny = e.clientY - startY;
      if (!decided) {
        if (Math.abs(nx) < 10 && Math.abs(ny) < 10) return;
        if (Math.abs(nx) <= Math.abs(ny) * 1.2) { pid = null; intent = null; return; }
        decided = true;
        suppress = true;
        sidebar.style.transition = "none";
        sidebar.style.visibility = "visible";
      }
      dx = nx;
      var W = width();
      if (intent === "close") {
        var off = nx > 0 ? nx * 0.25 : Math.max(nx, -W);
        sidebar.style.transform = "translateX(" + off + "px)";
        backdrop.style.opacity = String(Math.max(0, 0.45 * (1 + off / W)));
      } else {
        var p = nx < 0 ? 0 : (nx <= W ? nx : W + (nx - W) * 0.25);
        sidebar.style.transform = "translateX(" + (-W + p) + "px)";
        backdrop.style.opacity = String(0.45 * Math.min(1, p / W));
      }
    });

    function end(e, cancelled) {
      if (e.pointerId !== pid || !intent) return;
      var wasDecided = decided;
      var v = dx / Math.max(1, Date.now() - startT);
      var shut = intent === "close" && (dx < -70 || v < -0.15);
      var open = intent === "open" && !cancelled && (dx > 70 || v > 0.15);
      cancel();
      if (!wasDecided) return;
      if (shut) document.body.classList.remove("nav-open");
      if (open) document.body.classList.add("nav-open");
    }
    document.addEventListener("pointerup", function (e) { end(e, false); });
    document.addEventListener("pointercancel", function (e) { end(e, true); });
    document.addEventListener("click", function (e) {
      if (!suppress) return;
      suppress = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  })();

  /* ---------- sidebar + topbar wiring ---------- */

  $("newChatBtn").addEventListener("click", newChat);
  $("collapseBtn").addEventListener("click", function () { document.body.classList.remove("nav-open"); });
  $("openSidebarBtn").addEventListener("click", function () { document.body.classList.add("nav-open"); });
  $("backdrop").addEventListener("click", function () { document.body.classList.remove("nav-open"); });

  var recog = null;
  var recogOn = false;
  function setMicUI(on) {
    recogOn = on;
    $("micBtn").setAttribute("aria-pressed", on ? "true" : "false");
    $("micBtn").classList.toggle("recording", on);
    $("micBtn").title = on ? "Stop dictation" : "Voice input";
  }
  $("micBtn").addEventListener("click", function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Voice input is not supported in this browser."); return; }
    if (recogOn) { try { recog.stop(); } catch (e) { /* noop */ } return; }
    try { recog = new SR(); }
    catch (e) { toast.error("Could not start voice input."); return; }
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true;
    recog.maxAlternatives = 1;
    var base = input.value;
    if (base && !/\s$/.test(base)) base += " ";
    recog.onresult = function (e) {
      var text = "";
      for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      input.value = base + text;
      autogrow();
      syncSend();
    };
    recog.onerror = function (e) {
      var kind = e && e.error;
      if (kind === "not-allowed" || kind === "service-not-allowed") toast.error("Microphone blocked. Allow it to dictate.");
      else if (kind === "no-speech") toast("Heard nothing. Try again.");
      else if (kind !== "aborted") toast("Voice input stopped.");
    };
    recog.onend = function () { setMicUI(false); recog = null; };
    try { recog.start(); setMicUI(true); dnote("app", "Dictation started"); }
    catch (e) { toast.error("Could not start voice input."); }
  });

  $("modelBtn").addEventListener("click", function () {
    renderModelMenu();
    showPop($("modelMenu"), $("modelBtn"), { side: "bottom", align: "start" });
  });

  function displayName() {
    var n = String((state.settings && state.settings.displayName) || "").trim();
    return n || "You";
  }

  function syncAvatars() {
    var name = displayName();
    var initial = (name.charAt(0) || "Y").toUpperCase();
    $("avatarBtn").textContent = initial;
    $("profileAvatar").textContent = initial;
    $("profileName").textContent = name;
    $("acctAvatar").textContent = initial;
    if (document.activeElement !== $("acctName")) $("acctName").value = name;
  }

  var THEME_ORDER = ["dark", "light", "warm"];
  var THEME_ICON = { dark: "moon", light: "sun", warm: "sunset" };
  var THEME_LABEL = { dark: "Dark", light: "Light", warm: "Warm" };

  function syncAccountMenu() {
    syncAvatars();
    var next = THEME_ORDER[(THEME_ORDER.indexOf(state.settings.theme) + 1) % THEME_ORDER.length];
    var btn = $("acctTheme");
    btn.innerHTML = '<i data-lucide="' + THEME_ICON[next] + '"></i><span>Appearance: ' + THEME_LABEL[next] + "</span>";
    disarmWipe();
    refreshIcons();
  }

  function openAccount(trigger, side, align) {
    syncAccountMenu();
    showPop($("accountMenu"), trigger, { side: side, align: align });
  }

  function wipeAll() {
    state.chats = [];
    activeId = null;
    stopStream();
    messagesEl.innerHTML = "";
    save();
    renderList();
    showEmpty();
    toast("All chats deleted");
  }

  $("profileBtn").addEventListener("click", function () { openAccount($("profileBtn"), "top", "start"); });

  $("avatarBtn").addEventListener("click", function () { openAccount($("avatarBtn"), "bottom", "end"); });

  $("acctName").addEventListener("change", function () {
    var v = $("acctName").value.trim().slice(0, 24);
    state.settings.displayName = v || "You";
    save();
    syncAvatars();
    dnote("app", "Display name set");
  });
  $("acctName").addEventListener("keydown", function (e) {
    if (e.key === "Enter") $("acctName").blur();
    if (e.key === "Escape") { $("acctName").blur(); hidePop(); }
  });
  $("acctTheme").addEventListener("click", function () {
    var next = THEME_ORDER[(THEME_ORDER.indexOf(state.settings.theme) + 1) % THEME_ORDER.length];
    applyTheme(next);
    syncAccountMenu();
  });
  $("acctSettings").addEventListener("click", function () {
    hidePop(true);
    openSettings("general");
  });
  $("acctExport").addEventListener("click", function () {
    hidePop(true);
    doExportJSON();
  });

  var wipeArmed = false;
  var wipeTimer = null;
  function disarmWipe() {
    wipeArmed = false;
    if (wipeTimer) { clearTimeout(wipeTimer); wipeTimer = null; }
    var b = $("acctWipe");
    b.classList.remove("armed");
    var s = b.querySelector("span");
    if (s) s.textContent = "Delete all chats";
  }
  $("acctWipe").addEventListener("click", function () {
    if (!wipeArmed) {
      wipeArmed = true;
      var b = $("acctWipe");
      b.classList.add("armed");
      b.querySelector("span").textContent = "Tap again to delete everything";
      wipeTimer = setTimeout(disarmWipe, 3000);
      return;
    }
    disarmWipe();
    hidePop(true);
    wipeAll();
  });

  var filePicker = $("filePicker");
  var pendingImages = [];

  function downscaleImage(f) {
    return new Promise(function (resolve) {
      if (f.size > 8 * 1024 * 1024) { resolve({ name: f.name, error: "over 8MB" }); return; }
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, 1024 / Math.max(img.width || 1, img.height || 1));
          var cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(img.width * scale));
          cv.height = Math.max(1, Math.round(img.height * scale));
          cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
          URL.revokeObjectURL(url);
          resolve({ name: f.name, image: cv.toDataURL("image/jpeg", 0.85) });
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve({ name: f.name, error: "unreadable" });
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ name: f.name, error: "unreadable" }); };
      img.src = url;
    });
  }

  function renderAttachPreview() {
    var box = $("attachPreview");
    box.innerHTML = "";
    box.hidden = pendingImages.length === 0;
    pendingImages.forEach(function (p, i) {
      var chip = document.createElement("span");
      chip.className = "att-chip";
      var img = document.createElement("img");
      img.src = p.url;
      img.alt = p.name;
      chip.appendChild(img);
      var x = document.createElement("button");
      x.type = "button";
      x.className = "att-x";
      x.setAttribute("aria-label", "Remove " + p.name);
      x.innerHTML = '<i data-lucide="x"></i>';
      x.addEventListener("click", function () {
        pendingImages.splice(i, 1);
        renderAttachPreview();
        updateTokEst();
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
    refreshIcons();
  }

  function attachFiles(list) {
    var files = Array.prototype.slice.call(list || []).slice(0, 5);
    if (!files.length) return;
    var reads = files.map(function (f) {
      if (/^image\//.test(f.type || "")) return downscaleImage(f);
      return new Promise(function (resolve) {
        if (f.size > 100 * 1024) { resolve({ name: f.name, error: "over 100KB" }); return; }
        var r = new FileReader();
        r.onload = function () {
          var text = String(r.result || "");
          if (/\u0000/.test(text)) resolve({ name: f.name, error: "not a text file" });
          else resolve({ name: f.name, text: text.slice(0, 100 * 1024) });
        };
        r.onerror = function () { resolve({ name: f.name, error: "unreadable" }); };
        r.readAsText(f);
      });
    });
    Promise.all(reads).then(function (out) {
      var ok = out.filter(function (o) { return !o.error && o.text; });
      var imgs = out.filter(function (o) { return !o.error && o.image; });
      var bad = out.filter(function (o) { return o.error; });
      var gotImgs = 0;
      imgs.forEach(function (o) {
        if (pendingImages.length >= 3) bad.push({ name: o.name, error: "only 3 images per message" });
        else { pendingImages.push({ name: o.name, url: o.image }); gotImgs++; }
      });
      renderAttachPreview();
      if (ok.length) {
        var block = ok.map(function (o) {
          return "File: " + o.name + "\n```\n" + o.text.trim() + "\n```";
        }).join("\n\n");
        input.value = (input.value ? input.value.replace(/\s+$/, "") + "\n\n" : "") + block;
        autogrow();
        syncSend();
        input.focus();
        dnote("app", "Attached " + ok.length + " file" + (ok.length > 1 ? "s" : ""));
      }
      updateTokEst();
      var added = ok.length + gotImgs;
      if (bad.length) toast.error(bad.map(function (o) { return o.name + " (" + o.error + ")"; }).join("; "));
      else if (added) {
        if (input.value.length > 60000) toast.warn("Large attachment. About " + (Math.round(input.value.length / 4000) / 10) + "k tokens; some models may refuse it.");
        else toast(added === 1 ? "File added to your message." : added + " files added to your message.");
      }
    });
  }

  $("attachBtn").addEventListener("click", function () { filePicker.click(); });
  filePicker.addEventListener("change", function () {
    var files = filePicker.files;
    filePicker.value = "";
    attachFiles(files);
  });
  (function attachDropPaste() {
    var composerEl = $("composer");
    composerEl.addEventListener("dragover", function (e) { e.preventDefault(); composerEl.classList.add("dragover"); });
    composerEl.addEventListener("dragleave", function () { composerEl.classList.remove("dragover"); });
    composerEl.addEventListener("drop", function (e) {
      e.preventDefault();
      composerEl.classList.remove("dragover");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) attachFiles(e.dataTransfer.files);
    });
    input.addEventListener("paste", function (e) {
      var files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) {
        e.preventDefault();
        attachFiles(files);
      }
    });
  })();


  $("shareBtn").addEventListener("click", function () {
    var chat = getChat(activeId);
    if (!chat || !chat.messages.length) { toast("Nothing to share yet."); return; }
    var text = chat.title + "\n\n" + chat.messages.map(function (m) {
      return (m.role === "user" ? "You: " : "Nova: ") + m.content;
    }).join("\n\n");
    if (navigator.share) {
      navigator.share({ title: chat.title, text: text }).then(function () {
        dnote("app", "Chat shared");
      }, function () { /* dismissed */ });
    } else {
      copyText(text, "Chat copied to clipboard");
    }
  });

  /* ---------- chat item menu: rename + delete ---------- */

  var itemMenuId = null;
  var itemMenuBtn = null;

  $("renameItem").addEventListener("click", function () {
    var id = itemMenuId;
    hidePop(true);
    if (!id) return;
    var chat = getChat(id);
    if (!chat) return;
    var row = groupsEl.querySelector('.chat-row[data-id="' + id + '"] .chat-title');
    if (!row) return;
    var parent = row.parentElement;
    var box = document.createElement("input");
    box.className = "rename-input";
    box.value = chat.title;
    box.setAttribute("aria-label", "Rename chat");
    parent.replaceChild(box, row);
    box.focus();
    box.select();
    var done = false;
    function commit(saveIt) {
      if (done) return;
      done = true;
      if (saveIt && box.value.trim()) {
        chat.title = box.value.trim().slice(0, 80);
        chat.customTitle = true;
        chat.updatedAt = Date.now();
        save();
      }
      renderList();
    }
    box.addEventListener("keydown", function (e) {
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    box.addEventListener("blur", function () { commit(true); });
  });

  $("pinItem").addEventListener("click", function () {
    var chat = itemMenuId && getChat(itemMenuId);
    hidePop(true);
    if (!chat) return;
    chat.pinned = !chat.pinned;
    chat.updatedAt = Date.now();
    save();
    renderList();
  });

  $("moveItem").addEventListener("click", function () {
    var id = itemMenuId;
    hidePop(true);
    if (!id || !getChat(id)) return;
    renderFolderMenu(id);
    showPop($("folderMenu"), itemMenuBtn || groupsEl, { side: "bottom", align: "end" });
  });

  $("folderNew").addEventListener("click", function () {
    hidePop(true);
    var f = { id: uid(), name: "Folder " + (state.folders.length + 1), open: true };
    state.folders.push(f);
    save();
    renderList();
    startFolderRename(f.id);
  });

  $("deleteItem").addEventListener("click", function () {
    var id = itemMenuId;
    hidePop(true);
    if (!id) return;
    deleteChat(id);
  });

  $("exportMdItem").addEventListener("click", function () {
    var id = itemMenuId;
    hidePop(true);
    var chat = id && getChat(id);
    if (!chat) return;
    var lines = ["# " + chat.title, ""];
    chat.messages.forEach(function (m) {
      lines.push(m.role === "user" ? "You:" : "Nova:");
      lines.push(m.content || "");
      lines.push("");
    });
    var base = chat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "chat";
    var blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = base + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast.success("Chat exported as Markdown");
  });

  function deleteChat(id) {
    var idx = -1;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return;
    var removed = state.chats.splice(idx, 1)[0];
    if (activeId === id) {
      activeId = null;
      stopStream();
      messagesEl.innerHTML = "";
      showEmpty();
    }
    save();
    renderList();
    dnote("chat", "Deleted " + removed.title);
    toast("Chat deleted", "Undo", function () {
      state.chats.splice(Math.min(idx, state.chats.length), 0, removed);
      save();
      renderList();
    }, 5000);
  }

  /* ---------- search (opens instantly, no animation) ---------- */

  var searchModal = $("searchModal");
  var searchInput = $("searchInput");
  var searchResults = $("searchResults");
  var searchHot = 0;
  var searchMatches = [];

  function openSearch() {
    hidePop(true);
    openModal(searchModal);
    searchInput.value = "";
    searchHot = 0;
    runSearch("");
    setTimeout(function () { searchInput.focus(); }, 0);
  }

  function snippetFor(chat) {
    for (var i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") return chat.messages[i].content;
    }
    return "";
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    var sorted = state.chats.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    searchMatches = sorted.filter(function (c) {
      if (!q) return true;
      return c.title.toLowerCase().indexOf(q) > -1 || snippetFor(c).toLowerCase().indexOf(q) > -1;
    }).slice(0, 12);
    searchHot = 0;
    renderSearchResults();
  }

  function renderSearchResults() {
    searchResults.innerHTML = "";
    if (!searchMatches.length) {
      var p = document.createElement("p");
      p.className = "search-empty";
      p.textContent = "No chats match your search.";
      searchResults.appendChild(p);
      return;
    }
    searchMatches.forEach(function (c, i) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "search-row" + (i === searchHot ? " hot" : "");
      row.setAttribute("role", "option");
      var icon = document.createElement("i");
      icon.setAttribute("data-lucide", "message-square");
      row.appendChild(icon);
      var wrap = document.createElement("span");
      wrap.className = "search-row-text";
      var t = document.createElement("strong");
      t.textContent = c.title;
      var s = document.createElement("em");
      s.textContent = snippetFor(c).replace(/\s+/g, " ").slice(0, 90);
      wrap.appendChild(t);
      wrap.appendChild(s);
      row.appendChild(wrap);
      row.addEventListener("click", function () {
        closeModal(searchModal);
        openChat(c.id);
      });
      row.addEventListener("mousemove", function () {
        if (searchHot !== i) {
          searchHot = i;
          var rows = searchResults.querySelectorAll(".search-row");
          rows.forEach(function (r, k) { r.classList.toggle("hot", k === searchHot); });
        }
      });
      searchResults.appendChild(row);
    });
    refreshIcons();
  }

  $("searchChatsBtn").addEventListener("click", openSearch);

  searchInput.addEventListener("input", function () { runSearch(searchInput.value); });

  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!searchMatches.length) return;
      searchHot = e.key === "ArrowDown"
        ? (searchHot + 1) % searchMatches.length
        : (searchHot - 1 + searchMatches.length) % searchMatches.length;
      renderSearchResults();
      var hot = searchResults.querySelectorAll(".search-row")[searchHot];
      if (hot && hot.scrollIntoView) hot.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      var c = searchMatches[searchHot];
      if (c) {
        closeModal(searchModal);
        openChat(c.id);
      }
    }
  });

  searchModal.addEventListener("pointerdown", function (e) {
    if (e.target === searchModal) closeModal(searchModal);
  });

  /* ---------- settings ---------- */

  var settingsModal = $("settingsModal");

  function syncSettingsUI() {
    var segBtns = $("themeSeg").querySelectorAll("button");
    segBtns.forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.themeOpt === state.settings.theme ? "true" : "false");
    });
    $("tglEnter").setAttribute("aria-checked", state.settings.enterToSend ? "true" : "false");
    $("tglChips").setAttribute("aria-checked", state.settings.showChips ? "true" : "false");
  }

  function switchTab(name) {
    var tabs = settingsModal.querySelectorAll("[data-stab]");
    tabs.forEach(function (b) {
      b.setAttribute("aria-selected", b.dataset.stab === name ? "true" : "false");
    });
    var panes = settingsModal.querySelectorAll("[data-pane]");
    panes.forEach(function (p) {
      p.hidden = p.dataset.pane !== name;
    });
  }

  function openSettings(tab) {
    syncSettingsUI();
    renderProviders();
    switchTab(tab || "general");
    openModal(settingsModal);
  }

  document.querySelector(".settings-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-stab]");
    if (b) switchTab(b.dataset.stab);
  });

  function applyTheme(theme) {
    state.settings.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    save();
    syncSettingsUI();
    dnote("app", "Theme: " + theme);
  }

  $("themeSeg").addEventListener("click", function (e) {
    var b = e.target.closest("[data-theme-opt]");
    if (!b) return;
    applyTheme(b.dataset.themeOpt);
  });

  function wireToggle(id, key, onChange) {
    $(id).addEventListener("click", function () {
      state.settings[key] = !state.settings[key];
      save();
      syncSettingsUI();
      if (onChange) onChange();
    });
  }

  wireToggle("tglEnter", "enterToSend");
  wireToggle("tglChips", "showChips", applyChipsVisibility);

  $("searchBtn").addEventListener("click", function () {
    state.settings.searchMode = !state.settings.searchMode;
    save();
    syncSearchBtn();
    toast(state.settings.searchMode ? "Deep search on. Answers will cite the web." : "Deep search off.");
  });

  $("settingsClose").addEventListener("click", function () { closeModal(settingsModal); });
  settingsModal.addEventListener("pointerdown", function (e) {
    if (e.target === settingsModal) closeModal(settingsModal);
  });

  function doExportJSON() {
    var blob = new Blob([JSON.stringify({ chats: state.chats, folders: state.folders }, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "nova-chats.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    dnote("app", "Chats exported");
    toast.success("Chats exported");
  }

  $("exportBtn").addEventListener("click", doExportJSON);

  $("importBtn").addEventListener("click", function () { $("importPicker").click(); });
  $("importPicker").addEventListener("change", function () {
    var f = $("importPicker").files && $("importPicker").files[0];
    $("importPicker").value = "";
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var data = JSON.parse(String(r.result || ""));
        if (!data || !Array.isArray(data.chats)) throw new Error("bad file");
        var have = {};
        state.chats.forEach(function (c) { have[c.id] = true; });
        var added = 0;
        data.chats.forEach(function (c) {
          if (!c || !c.id || have[c.id] || !Array.isArray(c.messages)) return;
          have[c.id] = true;
          if (!Array.isArray(c.excluded)) c.excluded = [];
          c.messages.forEach(function (m) {
            if (m && !m.variants && typeof m.content === "string") { m.variants = [m.content]; m.vi = 0; }
          });
          state.chats.push(c);
          added++;
        });
        if (Array.isArray(data.folders)) {
          var fh = {};
          state.folders.forEach(function (g) { fh[g.id] = true; });
          data.folders.forEach(function (g) {
            if (g && g.id && !fh[g.id]) {
              fh[g.id] = true;
              state.folders.push({ id: g.id, name: String(g.name || "Folder"), open: g.open !== false });
            }
          });
        }
        state.chats.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        save();
        renderList();
        toast.success(added === 1 ? "Imported 1 chat." : "Imported " + added + " chats.");
        dnote("app", "Imported " + added + " chats");
      } catch (e) {
        toast.error("That file is not a Nova backup.");
      }
    };
    r.readAsText(f);
  });

  /* hold to delete: press and hold 1.4s to confirm */

  var holdBtn = $("holdDelete");
  var holdTimer = null;

  function holdStart(e) {
    if (e && e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    if (e && e.type === "keydown") e.preventDefault();
    if (holdTimer) return;
    holdBtn.classList.add("armed");
    holdTimer = setTimeout(function () {
      holdTimer = null;
      holdBtn.classList.remove("armed");
      wipeAll();
      closeModal(settingsModal);
    }, 1450);
  }

  function holdCancel() {
    if (!holdTimer) return;
    clearTimeout(holdTimer);
    holdTimer = null;
    holdBtn.classList.remove("armed");
  }

  holdBtn.addEventListener("pointerdown", holdStart);
  holdBtn.addEventListener("pointerup", holdCancel);
  holdBtn.addEventListener("pointerleave", holdCancel);
  holdBtn.addEventListener("keydown", holdStart);
  holdBtn.addEventListener("keyup", holdCancel);

  /* ---------- providers UI ---------- */

  var providerModal = $("providerModal");
  var edEditing = null;   /* provider object when editing, else null */
  var edPreset = null;    /* preset the form started from */
  var edKind = "openai";
  var edAuth = "bearer";
  var edBusy = false;
  var edRelay = false;

  function renderProviders() {
    var list = $("providerList");
    list.innerHTML = "";
    state.providers.forEach(function (p) {
      var preset = presetMatch(p.kind, p.baseUrl);
      var isActive = state.settings.activeProviderId === p.id;
      var row = document.createElement("div");
      row.className = "provider-row" + (isActive ? " is-active" : "");
      var model = activeModelOf(p);
      row.innerHTML = '<span class="icon-box"><i data-lucide="' + preset.icon + '"></i></span>' +
        '<span class="provider-text"><strong></strong><em></em></span>';
      row.querySelector("strong").textContent = p.label;
      row.querySelector("em").textContent = model || "No model chosen yet";
      if (isActive) {
        var tag = document.createElement("span");
        tag.className = "active-tag";
        tag.textContent = "Active";
        row.appendChild(tag);
      } else {
        var use = document.createElement("button");
        use.className = "pill-btn";
        use.type = "button";
        use.textContent = "Use";
        use.addEventListener("click", function () {
          state.settings.activeProviderId = p.id;
          save();
          renderProviders();
          renderModelMenu();
          syncModelLabel();
          dnote("provider", "Now using " + p.label);
          toast("Now using " + p.label);
        });
        row.appendChild(use);
      }
      var recheck = document.createElement("button");
      recheck.className = "icon-btn sm";
      recheck.type = "button";
      recheck.title = "Check models";
      recheck.setAttribute("aria-label", "Check what " + p.label + " serves today");
      recheck.innerHTML = '<i data-lucide="rotate-ccw"></i>';
      recheck.addEventListener("click", function () {
        openEditor(p);
        $("pfCheck").click();
      });
      row.appendChild(recheck);
      var edit = document.createElement("button");
      edit.className = "icon-btn sm";
      edit.type = "button";
      edit.title = "Edit " + p.label;
      edit.setAttribute("aria-label", "Edit " + p.label);
      edit.innerHTML = '<i data-lucide="pencil"></i>';
      edit.addEventListener("click", function () { openEditor(p); });
      row.appendChild(edit);
      list.appendChild(row);
    });
    var note = $("providerNote");
    if (!state.providers.length) {
      note.textContent = "No providers yet. Connect OpenAI, Anthropic, Groq, or any endpoint you name yourself. Until then, chats use demo replies.";
    } else {
      note.textContent = "Keys stay in this browser. Prompts go to the provider you use.";
    }
    refreshIcons();
  }

  $("addProviderBtn").addEventListener("click", function () {
    openProviderModal();
  });

  function openProviderModal() {
    edEditing = null;
    edPreset = null;
    $("providerTitle").textContent = "Add a provider";
    $("presetStep").hidden = false;
    $("providerForm").hidden = true;
    renderPresets();
    openModal(providerModal);
  }

  function renderPresets() {
    var wrap = $("presetList");
    wrap.innerHTML = "";
    PRESETS.forEach(function (preset) {
      var b = document.createElement("button");
      b.className = "preset-row";
      b.type = "button";
      b.innerHTML = '<span class="icon-box"><i data-lucide="' + preset.icon + '"></i></span>' +
        "<span><strong></strong><em></em></span>";
      b.querySelector("strong").textContent = preset.name;
      b.querySelector("em").textContent = preset.note;
      b.addEventListener("click", function () { startForm(preset, null); });
      wrap.appendChild(b);
    });
    refreshIcons();
  }

  function openEditor(p) {
    startForm(presetMatch(p.kind, p.baseUrl), p);
    if (providerModal.hidden) openModal(providerModal);
  }

  function startForm(preset, existing) {
    edEditing = existing || null;
    edPreset = preset;
    edKind = existing ? (existing.kind || "openai") : preset.kind;
    edAuth = existing ? (existing.authStyle || defaultAuthStyle(edKind)) : defaultAuthStyle(preset.kind);

    $("providerTitle").textContent = existing ? "Edit " + existing.label : "Connect to " + preset.name;
    $("presetStep").hidden = true;
    $("providerForm").hidden = false;

    $("pfName").value = existing ? existing.label : preset.name;
    $("pfBase").value = existing ? existing.baseUrl : preset.baseUrl;
    $("pfKey").value = "";
    $("pfKey").type = "password";
    $("pfKeyToggle").innerHTML = '<i data-lucide="eye"></i>';
    $("pfKey").placeholder = existing ? "Saved. Type to replace it." : (preset.keyHint || "Paste your key");
    $("pfModel").value = existing ? (existing.model || "") : "";
    renderPickList([]);
    edRelay = !!(existing && existing.useRelay);
    $("pfRelayToggle").setAttribute("aria-checked", edRelay ? "true" : "false");
    $("pfRelayFields").hidden = !edRelay;
    $("pfRelayUrl").value = state.settings.relayUrl || "";
    $("pfRelayKey").value = state.settings.relayKey || "";
    $("pfAuthName").value = existing ? (existing.authName || defaultAuthName(edKind, edAuth)) : defaultAuthName(edKind, edAuth);
    $("pfHeaders").value = existing ? writeHeaders(existing.headers) : "";
    $("pfAdvanced").hidden = true;
    $("pfAdvancedToggle").setAttribute("aria-expanded", "false");
    setStatus($("pfModelStatus"), "");
    setStatus($("pfStatus"), "");
    $("pfRemove").hidden = !existing;
    syncEditorKind();
    syncEditorAuth();
    refreshIcons();
    if (providerModal.hidden) openModal(providerModal);
  }

  function syncEditorKind() {
    var btns = $("pfKindSeg").querySelectorAll("button");
    btns.forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.kind === edKind ? "true" : "false");
    });
    var help = $("pfKindHelp");
    if (edKind === "gemini") {
      help.textContent = "Gemini speaks its own shape. Nova handles that for you.";
      help.hidden = false;
    } else if (edKind === "anthropic") {
      help.textContent = "Anthropic speaks its own shape. Nova handles that for you.";
      help.hidden = false;
    } else {
      help.hidden = true;
    }
    syncAdvancedSummary();
  }

  function syncEditorAuth() {
    var btns = $("pfAuthSeg").querySelectorAll("button");
    btns.forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.auth === edAuth ? "true" : "false");
    });
    $("pfKeyRow").style.display = edAuth === "none" ? "none" : "";
    var nameRow = $("pfAuthNameRow");
    if (edAuth === "none") {
      nameRow.style.display = "none";
    } else {
      nameRow.style.display = "";
      $("pfAuthNameLabel").textContent = edAuth === "query" ? "Query parameter" : "Header name";
    }
    syncAdvancedSummary();
  }

  function syncAdvancedSummary() {
    var extra = Object.keys(parseHeaders($("pfHeaders").value)).length > 0;
    $("pfAdvancedSummary").textContent = kindName(edKind) + ", " + authStyleName(edAuth) + (extra ? ", custom headers" : "") + (edRelay ? ", via relay" : "");
  }

  $("pfKindSeg").addEventListener("click", function (e) {
    var b = e.target.closest("[data-kind]");
    if (!b || edBusy) return;
    edKind = b.dataset.kind;
    edAuth = defaultAuthStyle(edKind);
    $("pfAuthName").value = defaultAuthName(edKind, edAuth);
    if (!edEditing && !$("pfBase").value.trim()) {
      var suggested = presetMatch(edKind, "");
      if (suggested.baseUrl) $("pfBase").value = suggested.baseUrl;
    }
    syncEditorKind();
    syncEditorAuth();
  });

  $("pfAuthSeg").addEventListener("click", function (e) {
    var b = e.target.closest("[data-auth]");
    if (!b || edBusy) return;
    edAuth = b.dataset.auth;
    $("pfAuthName").value = defaultAuthName(edKind, edAuth);
    syncEditorAuth();
  });

  $("pfAdvancedToggle").addEventListener("click", function () {
    var open = $("pfAdvanced").hidden;
    $("pfAdvanced").hidden = !open;
    $("pfAdvancedToggle").setAttribute("aria-expanded", open ? "true" : "false");
  });

  $("pfRelayToggle").addEventListener("click", function () {
    if (edBusy) return;
    edRelay = !edRelay;
    $("pfRelayToggle").setAttribute("aria-checked", edRelay ? "true" : "false");
    $("pfRelayFields").hidden = !edRelay;
    syncAdvancedSummary();
  });

  $("pfHeaders").addEventListener("input", syncAdvancedSummary);

  $("pfKeyToggle").addEventListener("click", function () {
    var field = $("pfKey");
    var show = field.type === "password";
    field.type = show ? "text" : "password";
    $("pfKeyToggle").innerHTML = show ? '<i data-lucide="eye-off"></i>' : '<i data-lucide="eye"></i>';
    $("pfKeyToggle").setAttribute("aria-label", show ? "Hide key" : "Show key");
    refreshIcons();
  });

  function setStatus(el, msg, opts) {
    opts = opts || {};
    el.classList.toggle("error", !!opts.error);
    el.innerHTML = "";
    if (opts.spin) {
      var spin = document.createElement("span");
      spin.className = "spin";
      spin.innerHTML = '<i data-lucide="loader-circle"></i>';
      el.appendChild(spin);
      refreshIcons();
    }
    if (msg) el.appendChild(document.createTextNode(msg));
  }

  /* The connection as the form describes it right now. */
  function formLike() {
    var key = $("pfKey").value.trim();
    if (!key && edEditing) key = edEditing.apiKey || "";
    return {
      kind: edKind,
      baseUrl: $("pfBase").value.trim(),
      apiKey: key,
      authStyle: edAuth,
      authName: $("pfAuthName").value.trim() || defaultAuthName(edKind, edAuth),
      headers: parseHeaders($("pfHeaders").value),
      useRelay: edRelay
    };
  }

  function formModel() {
    return $("pfModel").value.trim();
  }

  /* The provider's own list, not one baked into the app. Tapping a row
     probes it at once; only a model that answers fills the field. */
  function renderPickList(names) {
    var box = $("pickList");
    box.innerHTML = "";
    (names || []).slice(0, 300).forEach(function (name) {
      var b = document.createElement("button");
      b.className = "pick-row";
      b.type = "button";
      b.innerHTML = '<i data-lucide="cpu"></i><span><strong></strong><em></em></span>';
      b.querySelector("strong").textContent = name;
      var em = b.querySelector("em");
      if (name === $("pfModel").value.trim()) em.textContent = "In use";
      b.addEventListener("click", function () {
        if (edBusy) return;
        var like = formLike();
        edBusy = true;
        em.textContent = "Checking it works…";
        dnote("provider", "Checking " + name + "...");
        probeModel(like, name).then(function (problem) {
          edBusy = false;
          if (problem) {
            em.textContent = "";
            toast(problem);
            dfail("provider", name + " failed: " + problem);
            return;
          }
          $("pfModel").value = name;
          renderPickList([]);
          setStatus($("pfModelStatus"), "Using " + name + ".");
          dnote("provider", "Picked " + name);
        });
      });
      box.appendChild(b);
    });
    refreshIcons();
  }

  $("pfCheck").addEventListener("click", function () {
    if (edBusy) return;
    var like = formLike();
    var bad = checkAddress(like.baseUrl);
    if (bad) {
      setStatus($("pfModelStatus"), bad, { error: true });
      return;
    }
    if (like.authStyle !== "none" && !like.apiKey) {
      setStatus($("pfModelStatus"), "Add a key first.", { error: true });
      return;
    }
    if (like.useRelay) {
      var rcfg = relayCfg();
      var rbad = checkAddress(rcfg.url);
      if (rbad) {
        setStatus($("pfModelStatus"), rbad, { error: true });
        return;
      }
      if (!rcfg.key) {
        setStatus($("pfModelStatus"), "Add the relay key.", { error: true });
        return;
      }
    }
    edBusy = true;
    $("pfCheck").disabled = true;
    $("pfSave").disabled = true;
    setStatus($("pfModelStatus"), "Asking the provider what it serves...", { spin: true });
    listModels(like).then(function (found) {
      edBusy = false;
      $("pfCheck").disabled = false;
      $("pfSave").disabled = false;
      if (!found.length) {
        setStatus($("pfModelStatus"), "That key can see no models.", { error: true });
        return;
      }
      renderPickList(found);
      setStatus($("pfModelStatus"), "It serves " + found.length + ". Tap one to check it.");
      dnote("provider", "Check models: " + found.length + " served");
    }, function (err) {
      edBusy = false;
      $("pfCheck").disabled = false;
      $("pfSave").disabled = false;
      setStatus($("pfModelStatus"), fetchSentence(err), { error: true });
      dfail("provider", "Check models failed: " + fetchSentence(err));
    });
  });

  $("pfSave").addEventListener("click", function () {
    if (edBusy) return;
    var like = formLike();
    var bad = checkAddress(like.baseUrl);
    if (bad) {
      setStatus($("pfStatus"), bad, { error: true });
      return;
    }
    if (like.authStyle !== "none" && !like.apiKey) {
      setStatus($("pfStatus"), "This provider needs a key.", { error: true });
      return;
    }
    if (like.useRelay) {
      var rcfg = relayCfg();
      var rbad = checkAddress(rcfg.url);
      if (rbad) {
        setStatus($("pfStatus"), rbad, { error: true });
        return;
      }
      if (!rcfg.key) {
        setStatus($("pfStatus"), "Add the relay key.", { error: true });
        return;
      }
    }
    var model = formModel();
    if (!model) {
      setStatus($("pfStatus"), "Pick a model. Tap Check models.", { error: true });
      return;
    }
    edBusy = true;
    $("pfCheck").disabled = true;
    $("pfSave").disabled = true;
    setStatus($("pfStatus"), "Checking " + model + "...", { spin: true });
    probeModel(like, model).then(function (problem) {
      edBusy = false;
      $("pfCheck").disabled = false;
      $("pfSave").disabled = false;
      if (problem) {
        setStatus($("pfStatus"), problem, { error: true });
        dfail("provider", "Save check failed: " + problem);
        return;
      }
      persist();
    });

    function persist() {
      var label = $("pfName").value.trim() || (edPreset ? edPreset.name : "Provider");
      if (edEditing) {
        edEditing.label = label;
        edEditing.kind = edKind;
        edEditing.baseUrl = like.baseUrl;
        if ($("pfKey").value.trim()) edEditing.apiKey = $("pfKey").value.trim();
        if (like.authStyle === "none") edEditing.apiKey = "";
        edEditing.authStyle = like.authStyle;
        edEditing.authName = like.authName;
        edEditing.headers = like.headers;
        edEditing.model = model;
        edEditing.useRelay = like.useRelay;
      } else {
        var p = {
          id: uid(),
          label: label,
          kind: edKind,
          baseUrl: like.baseUrl,
          apiKey: like.authStyle === "none" ? "" : like.apiKey,
          authStyle: like.authStyle,
          authName: like.authName,
          headers: like.headers,
          model: model,
          useRelay: like.useRelay
        };
        state.providers.push(p);
        if (!state.settings.activeProviderId) state.settings.activeProviderId = p.id;
      }
      state.settings.relayUrl = $("pfRelayUrl").value.trim();
      state.settings.relayKey = $("pfRelayKey").value.trim();
      save();
      edBusy = false;
      $("pfCheck").disabled = false;
      $("pfSave").disabled = false;
      renderProviders();
      renderModelMenu();
      syncModelLabel();
      dnote("provider", "Saved " + label + " (" + model + ")");
      closeModal(providerModal);
      toast.success("Provider saved");
    }
  });

  /* hold to remove a provider */

  var pfRemoveBtn = $("pfRemove");
  var pfRemoveTimer = null;

  function pfRemoveStart(e) {
    if (e && e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    if (e && e.type === "keydown") e.preventDefault();
    if (pfRemoveTimer || !edEditing) return;
    pfRemoveBtn.classList.add("armed");
    pfRemoveTimer = setTimeout(function () {
      pfRemoveTimer = null;
      pfRemoveBtn.classList.remove("armed");
      var id = edEditing.id;
      state.providers = state.providers.filter(function (p) { return p.id !== id; });
      if (state.settings.activeProviderId === id) state.settings.activeProviderId = null;
      save();
      renderProviders();
      renderModelMenu();
      syncModelLabel();
      dnote("provider", "Removed " + edEditing.label);
      closeModal(providerModal);
      toast("Provider removed");
    }, 1450);
  }

  function pfRemoveCancel() {
    if (!pfRemoveTimer) return;
    clearTimeout(pfRemoveTimer);
    pfRemoveTimer = null;
    pfRemoveBtn.classList.remove("armed");
  }

  pfRemoveBtn.addEventListener("pointerdown", pfRemoveStart);
  pfRemoveBtn.addEventListener("pointerup", pfRemoveCancel);
  pfRemoveBtn.addEventListener("pointerleave", pfRemoveCancel);
  pfRemoveBtn.addEventListener("keydown", pfRemoveStart);
  pfRemoveBtn.addEventListener("keyup", pfRemoveCancel);

  $("providerBack").addEventListener("click", function () {
    if (edBusy) return;
    if (!$("providerForm").hidden && !edEditing) {
      $("providerForm").hidden = true;
      $("presetStep").hidden = false;
      $("providerTitle").textContent = "Add a provider";
      return;
    }
    closeModal(providerModal);
  });

  $("providerClose").addEventListener("click", function () {
    if (!edBusy) closeModal(providerModal);
  });

  providerModal.addEventListener("pointerdown", function (e) {
    if (e.target === providerModal && !edBusy) closeModal(providerModal);
  });

  /* ---------- global keys ---------- */

  document.addEventListener("keydown", function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (searchModal.hidden) openSearch();
      else closeModal(searchModal);
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      newChat();
      return;
    }
    if (e.key === "Escape") {
      if (!providerModal.hidden) { if (!edBusy) closeModal(providerModal); return; }
      if (openPop) { hidePop(); return; }
      if (!searchModal.hidden) { closeModal(searchModal); return; }
      if (!settingsModal.hidden) { closeModal(settingsModal); return; }
    }
  });

  window.addEventListener("resize", function () {
    if (openPop) hidePop(true);
  });

  /* ---------- init ---------- */

  var deferredInstall = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstall = e;
    var b = $("acctInstall");
    if (b) b.hidden = false;
  });
  window.addEventListener("appinstalled", function () {
    deferredInstall = null;
    var b = $("acctInstall");
    if (b) b.hidden = true;
  });
  $("acctInstall").addEventListener("click", function () {
    hidePop(true);
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function () { deferredInstall = null; });
  });

  function init() {
    if (REDUCED) document.documentElement.classList.add("reduce-motion");
    document.documentElement.setAttribute("data-theme", state.settings.theme);
    if (window.innerWidth <= 768) document.body.classList.remove("nav-open");
    else document.body.classList.add("nav-open");
    if (state.settings.activeProviderId && !getProvider(state.settings.activeProviderId)) {
      state.settings.activeProviderId = null;
    }
    syncModelLabel();
    renderModelMenu();
    renderList();
    showEmpty();
    autogrow();
    syncSend();
    refreshIcons();
    dnote("app", "Ready. " + state.providers.length + " providers, " + state.chats.length + " chats, " + state.settings.theme + " theme.");
    syncSearchBtn();
    syncAvatars();
    updateBanners();
    window.addEventListener("online", function () { updateBanners(); drainNext(); });
    window.addEventListener("offline", function () { updateBanners(); });
    drainNext();
    if (/[?&]demo=trace\b/.test(window.location.search)) playTraceDemo();
    if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").then(function () {
          dnote("app", "Offline cache ready");
        }, function () { /* offline cache unavailable */ });
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
