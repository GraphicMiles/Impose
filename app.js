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
    return { theme: "dark", enterToSend: true, showChips: true, activeProviderId: null, relayUrl: "", relayKey: "" };
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
          return parsed;
        }
      } catch (e) { /* fall through to seed */ }
    }
    return { chats: seedChats(), providers: [], settings: defaultSettings() };
  }

  var state = loadState();
  var activeId = null;
  var stream = null; // canned: { timer, thinkTimer, ... } live: { live, controller, text, ... }

  function save() {
    store.write(JSON.stringify({ chats: state.chats, providers: state.providers, settings: state.settings }));
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
    return { url: $("pfRelayUrl").value.trim(), key: $("pfRelayKey").value.trim() };
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
      if (err && err.name === "TypeError") throw new Error("Could not reach the relay. Check the relay address.");
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
          return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
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
      if (provider.kind === "anthropic") {
        (d.content || []).forEach(function (b) { if (b && b.text) text += b.text; });
      } else if (provider.kind === "gemini") {
        (d.candidates || []).forEach(function (c) {
          ((c.content && c.content.parts) || []).forEach(function (part) { if (part.text) text += part.text; });
        });
      } else {
        var choice = d.choices && d.choices[0];
        text = (choice && choice.message && choice.message.content) || "";
      }
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

  function streamChat(provider, model, history, signal, onDelta) {
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
          return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
        })
      };
      return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: signal })
        .then(function (res) {
          return throwIfHttpError(provider, model, res).then(function () {
            return readSSE(res, function (d) {
              (d.candidates || []).forEach(function (c) {
                var parts = (c.content && c.content.parts) || [];
                parts.forEach(function (part) { if (part.text) onDelta(part.text); });
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
          });
        });
      });
  }

  /* ---------- markdown renderer (escapes first, then formats) ---------- */

  function inlineMd(s) {
    var t = escapeHtml(s);
    var stash = [];
    function hold(html) { stash.push(html); return "" + (stash.length - 1) + ""; }
    t = t.replace(/`([^`\n]+?)`/g, function (m, g) { return hold('<code class="md-code">' + g + "</code>"); });
    t = t.replace(/\[([^\]]+?)\]\((https?:[^)\s]+)\)/g, function (m, g1, g2) {
      return hold('<a href="' + g2 + '" target="_blank" rel="noopener">' + g1 + "</a>");
    });
    t = t.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|\W)\*([^*\n]+?)\*/g, "$1<em>$2</em>");
    t = t.replace(/(^|\W)_([^_\n]+?)_/g, "$1<em>$2</em>");
    t = t.replace(/(\d+)/g, function (m, g) { return stash[+g]; });
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

  function renderMarkdown(src) {
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

  function toast(msg, actionLabel, onAction, ms) {
    var el = document.createElement("div");
    el.className = "toast";
    var span = document.createElement("span");
    span.className = "toast-msg";
    span.textContent = msg;
    el.appendChild(span);
    var timer = null;
    function dismiss() {
      el.classList.remove("in");
      setTimeout(function () { el.remove(); }, 240);
    }
    if (actionLabel) {
      var btn = document.createElement("button");
      btn.className = "toast-act";
      btn.type = "button";
      btn.textContent = actionLabel;
      btn.addEventListener("click", function () {
        clearTimeout(timer);
        try { onAction(); } catch (e) { /* noop */ }
        dismiss();
      });
      el.appendChild(btn);
    }
    toastsEl.appendChild(el);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add("in"); });
    });
    timer = setTimeout(dismiss, ms || 3200);
    return dismiss;
  }

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
    if (instant) {
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
    var delay = el.id === "searchModal" ? 0 : 220;
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

  function renderList() {
    var order = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
    var buckets = {};
    order.forEach(function (k) { buckets[k] = []; });
    var sorted = state.chats.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    sorted.forEach(function (c) { buckets[groupLabel(c.updatedAt)].push(c); });

    groupsEl.innerHTML = "";
    order.forEach(function (label) {
      var list = buckets[label];
      if (!list.length) return;
      var h = document.createElement("p");
      h.className = "group-label";
      h.textContent = label;
      groupsEl.appendChild(h);
      list.forEach(function (c) {
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

        var menuBtn = document.createElement("button");
        menuBtn.className = "row-menu";
        menuBtn.type = "button";
        menuBtn.setAttribute("aria-label", "Options for " + c.title);
        menuBtn.setAttribute("aria-haspopup", "menu");
        menuBtn.innerHTML = '<i data-lucide="ellipsis"></i>';
        menuBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          itemMenuId = c.id;
          showPop($("itemMenu"), menuBtn, { side: "bottom", align: "end" });
        });
        row.appendChild(menuBtn);
        groupsEl.appendChild(row);
      });
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

  function actionsHtml() {
    return '<div class="msg-actions">' +
      '<button type="button" data-act="copy" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>' +
      '<button type="button" data-act="like" title="Good response" aria-label="Good response"><i data-lucide="thumbs-up"></i></button>' +
      '<button type="button" data-act="dislike" title="Bad response" aria-label="Bad response"><i data-lucide="thumbs-down"></i></button>' +
      '<button type="button" data-act="retry" title="Regenerate" aria-label="Regenerate"><i data-lucide="rotate-ccw"></i></button>' +
      "</div>";
  }

  function userRowHtml(content) {
    return '<div class="bubble">' + escapeHtml(content).replace(/\n/g, "<br>") + "</div>";
  }

  function assistantRowHtml(content, withActions) {
    return '<div class="msg-body">' + renderMarkdown(content) + "</div>" + (withActions ? actionsHtml() : "");
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
      row.innerHTML = m.role === "user" ? userRowHtml(m.content) : assistantRowHtml(m.content, true);
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
    if (chat && chat.messages[s.index]) {
      chat.messages[s.index].content = content;
      chat.updatedAt = Date.now();
      save();
    }
    s.body.innerHTML = renderMarkdown(content);
    if (!s.row.querySelector(".msg-actions")) {
      s.row.insertAdjacentHTML("beforeend", actionsHtml());
    }
    refreshIcons();
    renderList();
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

  function historyFor(messages) {
    return messages
      .filter(function (m) { return String(m.content || "").trim() !== ""; })
      .slice(-30)
      .map(function (m) { return { role: m.role, content: m.content }; });
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
      done: false
    };
    stream = s;

    function renderFrame() {
      s.raf = 0;
      if (stream !== s || !s.dirty) return;
      s.dirty = false;
      var stick = isNearBottom();
      if (s.body.isConnected) {
        s.body.innerHTML = renderMarkdown(s.text) + '<span class="cursor"></span>';
      }
      if (stick) scrollBottom();
    }

    streamChat(provider, model, history, s.controller ? s.controller.signal : undefined, function (chunk) {
      if (stream !== s) return;
      s.text += chunk;
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
    if (!s.text && (s.stopped || !failed)) {
      /* Stopped before a word arrived: leave no empty bubble behind. */
      if (chat) {
        chat.messages.splice(s.index, 1);
        save();
      }
      if (s.row.isConnected) s.row.remove();
      return;
    }
    var sentence = failed ? fetchSentence(err) : "";
    if (failed && !s.text) s.text = sentence;
    if (chat && chat.messages[s.index]) {
      chat.messages[s.index].content = s.text;
      chat.updatedAt = Date.now();
      save();
    }
    if (s.row.isConnected) {
      s.body.innerHTML = renderMarkdown(s.text);
      if (!s.row.querySelector(".msg-actions")) {
        s.row.insertAdjacentHTML("beforeend", actionsHtml());
      }
      refreshIcons();
      if (isNearBottom()) scrollBottom();
    }
    if (failed) dfail("chat", sentence);
    if (failed && s.text !== sentence) toast(sentence);
    renderList();
  }

  function send(text) {
    text = (text || "").trim();
    if (!text) return;
    if (stream) stopStream();

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
    chat.updatedAt = Date.now();
    save();

    showDock();
    renderList();

    var row = document.createElement("div");
    row.className = "msg user";
    row.dataset.i = chat.messages.length - 1;
    row.innerHTML = userRowHtml(text);
    messagesEl.appendChild(row);
    animateIn(row);
    scrollBottom();

    input.value = "";
    autogrow();
    syncSend();

    var t = getTarget();
    if (t && t.missingKey) {
      dwarn("provider", "Missing key for " + t.provider.label + ", chat not sent");
      toast("Add a key to " + t.provider.label + " first.");
      openSettings("providers");
      return;
    }
    if (t) {
      chat.model = providerDisplay(t.provider);
      chat.providerId = t.provider.id;
      save();
      dnote("chat", "Chat via " + providerDisplay(t.provider) + " (" + chat.messages.length + " messages)");
      streamLive(chat, t.provider, t.model, historyFor(chat.messages), null);
    } else {
      dnote("chat", "Chat via demo replies");
      streamAssistant(chat, generateReply(text));
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
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var row = btn.closest(".msg");
    var chat = getChat(activeId);
    if (!row || !chat) return;
    var idx = +row.dataset.i;
    var msg = chat.messages[idx];
    if (!msg) return;
    var act = btn.dataset.act;

    if (act === "copy") {
      copyText(msg.content, "Copied to clipboard");
    } else if (act === "like" || act === "dislike") {
      var other = act === "like" ? "dislike" : "like";
      var otherBtn = row.querySelector('[data-act="' + other + '"]');
      btn.classList.toggle("on");
      if (otherBtn) otherBtn.classList.remove("on");
      btn.setAttribute("aria-pressed", btn.classList.contains("on") ? "true" : "false");
    } else if (act === "retry") {
      if (stream) return;
      var t = getTarget();
      if (t && t.missingKey) {
        dwarn("provider", "Missing key for " + t.provider.label + ", chat not sent");
      toast("Add a key to " + t.provider.label + " first.");
        openSettings("providers");
        return;
      }
      if (t) {
        streamLive(chat, t.provider, t.model, historyFor(chat.messages.slice(0, idx)), idx);
        return;
      }
      var prevUser = null;
      for (var k = idx - 1; k >= 0; k--) {
        if (chat.messages[k].role === "user") { prevUser = chat.messages[k].content; break; }
      }
      cannedRetry(chat, row, idx, prevUser);
    }
  });

  /* ---------- composer ---------- */

  function autogrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  function syncSend() {
    sendBtn.disabled = input.value.trim().length === 0;
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
  stopBtn.addEventListener("click", function () { stopStream(); });

  chipsEl.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (!chip) return;
    send(chip.dataset.prompt);
  });

  /* ---------- model menu (demo + every provider) ---------- */

  var modelMenuBody = $("modelMenuBody");

  function syncModelLabel() {
    var p = activeProvider();
    $("modelName").textContent = providerDisplay(p);
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

  /* ---------- sidebar + topbar wiring ---------- */

  $("newChatBtn").addEventListener("click", newChat);
  $("collapseBtn").addEventListener("click", function () { document.body.classList.remove("nav-open"); });
  $("openSidebarBtn").addEventListener("click", function () { document.body.classList.add("nav-open"); });
  $("backdrop").addEventListener("click", function () { document.body.classList.remove("nav-open"); });

  $("libraryBtn").addEventListener("click", function () { toast("Library is not part of this demo"); });
  $("exploreBtn").addEventListener("click", function () { toast("Explore is not part of this demo"); });
  $("upgradeBtn").addEventListener("click", function () { toast("Plans are not part of this demo"); });
  $("micBtn").addEventListener("click", function () { toast("Voice input is not part of this demo"); });

  $("modelBtn").addEventListener("click", function () {
    renderModelMenu();
    showPop($("modelMenu"), $("modelBtn"), { side: "bottom", align: "start" });
  });

  $("profileBtn").addEventListener("click", function () {
    hidePop(true);
    showPop($("profileMenu"), $("profileBtn"), { side: "top", align: "start" });
  });

  $("avatarBtn").addEventListener("click", function () {
    hidePop(true);
    showPop($("profileMenu"), $("avatarBtn"), { side: "bottom", align: "end" });
  });

  $("attachBtn").addEventListener("click", function () {
    showPop($("attachMenu"), $("attachBtn"), { side: "top", align: "start" });
  });

  $("attachMenu").addEventListener("click", function (e) {
    var item = e.target.closest("[data-demo]");
    if (!item) return;
    hidePop();
    toast(item.dataset.demo);
  });

  $("settingsItem").addEventListener("click", function () {
    hidePop(true);
    openSettings("general");
  });
  $("helpItem").addEventListener("click", function () {
    hidePop();
    toast("No help center in this demo");
  });
  $("logoutItem").addEventListener("click", function () {
    hidePop();
    toast("Log out is disabled in this demo");
  });

  $("shareBtn").addEventListener("click", function () {
    var id = activeId || "new";
    copyText("https://nova.chat/share/" + id, "Share link copied to clipboard");
  });

  /* ---------- chat item menu: rename + delete ---------- */

  var itemMenuId = null;

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

  $("deleteItem").addEventListener("click", function () {
    var id = itemMenuId;
    hidePop(true);
    if (!id) return;
    deleteChat(id);
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

  $("settingsClose").addEventListener("click", function () { closeModal(settingsModal); });
  settingsModal.addEventListener("pointerdown", function (e) {
    if (e.target === settingsModal) closeModal(settingsModal);
  });

  $("exportBtn").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify({ chats: state.chats }, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "nova-chats.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    dnote("app", "Chats exported");
    toast("Chats exported");
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
      state.chats = [];
      activeId = null;
      stopStream();
      messagesEl.innerHTML = "";
      save();
      renderList();
      showEmpty();
      closeModal(settingsModal);
      toast("All chats deleted");
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
      toast("Provider saved");
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
