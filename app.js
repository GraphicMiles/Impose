/* Impose chat client. Bring your own key: providers speak OpenAI style,
   Anthropic, or Gemini request shapes. With no provider set, demo replies. */
(function () {
  "use strict";

  var STORE_KEY = "impose.clone.v1";
  var LEGACY_STORE_KEY = "nova.clone.v1";
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* anime.js (vendored) drives JS motion; CSS owns hovers and reveals. */
  function motionOK() {
    return !REDUCED && typeof window.anime !== "undefined" && !!window.anime.animate;
  }
  function EZ(name) {
    try { return window.anime.eases[name]; }
    catch (e) { return "linear"; }
  }
  function play(params) {
    if (!motionOK()) return null;
    try { return window.anime.animate(params); }
    catch (e) { return null; }
  }
  function noTrans(els) {
    for (var i = 0; i < els.length; i++) els[i].style.transition = "none";
  }
  function yesTrans(els) {
    for (var i = 0; i < els.length; i++) els[i].style.transition = "";
  }
  var SYS_MSG = "You are Impose, a helpful assistant running inside a web chat app with rich rendering: markdown, highlighted code blocks, image galleries, and clickable links. Never describe yourself as a CLI, terminal, or text-only system, and never claim you cannot display rich content. Be direct and concrete; skip filler, self-introductions, and restating the question.";

  /* Base persona + per chat instructions + memory, assembled once per send. */
  function getSystemMsg(chat) {
    var mem = state.memories || [];
    if (window.ImposeFeatures) return window.ImposeFeatures.buildSystem(SYS_MSG, chat && chat.params && chat.params.system, mem);
    return SYS_MSG;
  }

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
      try { return window.localStorage.getItem(STORE_KEY) || window.localStorage.getItem(LEGACY_STORE_KEY); }
      catch (e) { return null; }
    },
    write: function (v) {
      try {
        window.localStorage.setItem(STORE_KEY, v);
        window.localStorage.removeItem(LEGACY_STORE_KEY);
      }
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
    if (!window.fetch || window.fetch.__imposeWrapped) return;
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
    wrapped.__imposeWrapped = true;
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
    /* The public relay ships as the default: visitors get keyless search
       and images out of the box, rate limited per person. Owners add their
       control key for the wake, the proxy, and the reader. */
    return { theme: "dark", enterToSend: true, showChips: true, activeProviderId: null, relayUrl: "https://impose-relay.onrender.com", relayKey: "", searchMode: false, displayName: "You",
      redactPII: false, followupsSmart: true, imageTools: true, autoName: true, retentionDays: 0, failover: true };
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
          if (!Array.isArray(parsed.library)) parsed.library = [];
          if (!Array.isArray(parsed.memories)) parsed.memories = [];
          parsed.chats.forEach(function (c) {
            if (c.params) {
              c.params = { system: String(c.params.system || ""), temperature: c.params.temperature, topP: c.params.topP, maxTokens: c.params.maxTokens };
              if (!c.params.system && c.params.temperature == null && c.params.topP == null && c.params.maxTokens == null) delete c.params;
            }
          });
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
    return { chats: seedChats(), providers: [], folders: [], outbox: [], library: [], memories: [], settings: defaultSettings() };
  }

  var state = loadState();
  var activeId = null;
  var lastSendAt = 0;
  var relayDown = false;
  var draining = false;
  var titling = {};
  var stream = null; // canned: { timer, thinkTimer, ... } live: { live, controller, text, ... }

  var quotaTrimming = false;

  function payloadJson() {
    return JSON.stringify({ chats: state.chats, providers: state.providers, folders: state.folders, outbox: state.outbox, library: state.library || [], memories: state.memories || [], settings: state.settings });
  }

  /* Quota rescue: photos are the only heavy part of the store, so drop them
     oldest first until the payload fits again, then tell the user exactly
     what happened. Never silently: a silent failed save is how people lose
     a whole history. */
  function trimOldestImages() {
    var LIMIT = 3 * 1024 * 1024;
    var order = state.chats.slice().sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); });
    var removed = 0;
    for (var i = 0; i < order.length; i++) {
      var ms = order[i].messages || [];
      for (var j = 0; j < ms.length; j++) {
        if (ms[j] && ms[j].images && ms[j].images.length) {
          removed += ms[j].images.length;
          delete ms[j].images;
          if (payloadJson().length < LIMIT) return removed;
        }
      }
    }
    return removed;
  }

  function save() {
    try {
      store.write(payloadJson());
      return;
    }
    catch (e) {
      var quota = e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014);
      if (!quota) return; /* sandboxed iframe: keep everything in memory */
      if (quotaTrimming) return;
      quotaTrimming = true;
      try {
        var removed = trimOldestImages();
        store.write(payloadJson());
        toast(removed
          ? "Browser storage was full. " + removed + " older image" + (removed === 1 ? " was" : "s were") + " removed to make space."
          : "Browser storage is full. Export your chats, then delete a few old ones.");
        dnote("storage", "Quota hit; removed " + removed + " images to fit");
      }
      catch (e2) {
        toast("Browser storage is full. Export your chats, then delete a few old ones.");
        dfail("storage", "Save failed even after trimming: " + String((e2 && e2.message) || e2));
      }
      quotaTrimming = false;
    }
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
    h = String(h || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    if (h === "localhost" || h.slice(-10) === ".localhost" || h.slice(-6) === ".local") return true;
    if (h.indexOf("::ffff:") === 0) h = h.slice(7); /* IPv4-mapped IPv6 */
    if (h === "::1" || h === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; /* IPv6 unique local fc00::/7 */
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; /* IPv6 link local fe80::/10 */
    var m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    var a = +m[1], b = +m[2];
    /* loopback, this host, RFC1918, carrier NAT range aside: these are all
       "inside the building", which is the only place plain http is allowed */
    return a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
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
    /* Older browsers: build the same thing by hand instead of returning
       undefined, which meant "no timeout at all" and an editor stuck busy. */
    if (window.AbortController) {
      var c = new AbortController();
      setTimeout(function () { try { c.abort(); } catch (e) { /* noop */ } }, ms);
      return c.signal;
    }
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
    if (/gpt|gemini|llama|mixtral|mistral|grok|deepseek|qwen|sonnet|opus|haiku|chat|instruct|turbo/.test(t)) s += 2;
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

  /* Is the relay's GPU gateway answering? /health is open by design, so no
     key is needed to poll it. */
  function relayGatewayUp(cfg, signal) {
    var opts = { cache: "no-store" };
    if (signal) opts.signal = signal;
    else opts.signal = withTimeout(8000);
    return fetch(stripSlash(cfg.url) + "/health", opts).then(function (r) {
      if (!r.ok) return false;
      return r.json().then(function (d) { return !!(d && d.gateway_up === true); }, function () { return false; });
    }, function () { return false; });
  }

  /* A 503 "waking up" answer means the relay already started the box. Poll
     until the gateway answers (about 5 minutes max) instead of leaving the
     person to hammer the retry button themselves. */
  function waitRelayWake(cfg, signal) {
    var STEPS = 30, STEP_MS = 10000;
    function step(i) {
      if (signal && signal.aborted) {
        var err = new Error("stopped");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      return relayGatewayUp(cfg, signal).then(function (up) {
        if (up) return true;
        if (i >= STEPS) return false;
        return new Promise(function (res) { setTimeout(res, STEP_MS); }).then(function () {
          return step(i + 1);
        });
      });
    }
    return step(0);
  }

  /* One request sent server to server through the relay, for providers that
     block browsers. Replies arrive whole: no streaming on this path. */
  function relayFetchReq(req, method, bodyObj, signal, depth, hooks) {
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
        throw new Error("The provider's firewall (" + env.status + ") is blocking the relay too. " +
          "Use a provider the relay can reach, or wake the relay's own model from Settings, Providers.");
      }
      /* The box was asleep and is starting. Wait for it, then send this same
         request once more. depth keeps a wake loop from ever going infinite. */
      if (env.status === 503 && /waking/i.test(bodyText) && !depth) {
        dnote("relay", "Model is waking; waiting for the gateway");
        if (hooks && hooks.onWaking) { try { hooks.onWaking(); } catch (e) { /* ui only */ } }
        return waitRelayWake(cfg, signal).then(function (up) {
          if (!up) throw new Error("The model is still waking up. It usually takes 1 to 3 minutes. Try again in a moment.");
          dnote("relay", "Gateway is up; sending again");
          return relayFetchReq(req, method, bodyObj, signal, 1, hooks);
        });
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
  function unstreamedChat(provider, model, history, signal, onDelta, opts) {
    opts = opts || {};
    var F = window.ImposeFeatures;
    var sys = opts.system || SYS_MSG;
    var req, body;
    if (provider.kind === "anthropic") {
      req = buildRequest(provider, "/messages");
      body = { model: model, max_tokens: 1024, system: sys, messages: history, stream: false };
      if (F) F.applyGenParams(body, "anthropic", opts.genParams);
    } else if (provider.kind === "gemini") {
      req = buildRequest(provider, "/models/" + encodeURIComponent(model) + ":generateContent");
      body = {
        systemInstruction: { parts: [{ text: sys }] },
        contents: history.map(function (m) {
          return { role: m.role === "assistant" ? "model" : "user", parts: geminiParts(m.content) };
        })
      };
      if (F) F.applyGenParams(body, "gemini", opts.genParams);
    } else {
      req = buildRequest(provider, "/chat/completions");
      body = { model: model, messages: [{ role: "system", content: sys }].concat(history), stream: false };
      if (F) F.applyGenParams(body, "openai", opts.genParams);
    }
    req.headers["Content-Type"] = "application/json";
    var hooks = (opts && opts.onStage) ? { onWaking: function () { try { opts.onStage("waking"); } catch (e) { /* ui only */ } } } : null;
    return relayFetchReq(req, "POST", body, signal, 0, hooks).then(function (res) {
      return throwIfHttpError(provider, model, res).then(function () { return res.json(); });
    }).then(function (d) {
      if (opts.usage) { /* usage capture stays ahead of the reveal */
        if (provider.kind === "anthropic" && d.usage) { opts.usage.toksIn = d.usage.input_tokens; opts.usage.toksOut = d.usage.output_tokens; }
        else if (provider.kind === "openai" && d.usage) { opts.usage.toksIn = d.usage.prompt_tokens; opts.usage.toksOut = d.usage.completion_tokens; }
        else if (provider.kind === "gemini" && d.usageMetadata) { opts.usage.toksIn = d.usageMetadata.promptTokenCount; opts.usage.toksOut = d.usageMetadata.candidatesTokenCount; }
      }
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
      if (text) return phantomStream(text, signal, onDelta);
    });
  }

  /* The relay path answers whole, but a wall of text under the loading dots
     reads as broken. Reveal it at reading pace with the same cursor the
     live stream uses. ~1.6s for a short reply, capped at ~4s for long ones. */
  function phantomStream(text, signal, onDelta) {
    if (signal && signal.aborted) {
      var err = new Error("stopped");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    if (REDUCED || !window.requestAnimationFrame) {
      onDelta(text);
      return Promise.resolve();
    }
    var parts = text.match(/\S+\s+|\S+$/g) || [text];
    /* Pace by length: short lines snap in, long answers unfold for about
       two seconds -- enough to read as a stream, never as a wall. */
    var total = Math.min(2400, Math.max(550, text.length * 2.4));
    /* one rAF step per frame at ~60fps */
    var frames = Math.max(12, Math.round(total / 17));
    var perFrame = Math.ceil(parts.length / frames);
    return new Promise(function (resolve, reject) {
      var i = 0;
      function step() {
        if (signal && signal.aborted) {
          var err = new Error("stopped");
          err.name = "AbortError";
          reject(err);
          return;
        }
        var end = Math.min(parts.length, i + perFrame);
        var chunk = "";
        while (i < end) chunk += parts[i++];
        if (chunk) onDelta(chunk);
        if (i < parts.length) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
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
      /* No max_tokens here: o-series and gpt-5-class models reject it in
         favor of max_completion_tokens, and the probe only asks "does this
         model answer". Chat never sends the field either. */
      req = buildRequest(like, "/chat/completions");
      body = { model: model, messages: [{ role: "user", content: "Hi" }], stream: false };
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
    function handleLine(line) {
      line = line.trim();
      if (line.indexOf("data:") !== 0) return false;
      var data = line.slice(5).trim();
      if (data === "[DONE]") return true;
      if (!data) return false;
      var parsed = null;
      try { parsed = JSON.parse(data); }
      catch (e) { return false; /* partial line */ }
      onData(parsed); /* an error thrown here fails the stream on purpose */
      return false;
    }
    if (!res.body || !res.body.getReader) {
      return res.text().then(function (text) {
        text.split("\n").forEach(function (line) {
          handleLine(line);
        });
      });
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    function pump() {
      return reader.read().then(function (part) {
        if (part.done) {
          /* Some providers close right after the last chunk with no trailing
             newline. Flush what is left instead of dropping it. */
          if (buf.trim()) handleLine(buf);
          return;
        }
        buf += decoder.decode(part.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          var line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (handleLine(line)) return; /* [DONE] */
        }
        return pump();
      });
    }
    return pump();
  }

  /* opts: { genParams, system, usage } where usage is filled in place
     {toksIn, toksOut} when the provider reports real counts. */
  /* Every chat goes through here: normal replies, the research rewrite,
     and the research completion. A provider whose firewall blocks browsers
     gets exactly one silent retry through the relay, as long as nothing
     streamed yet. This is the whole trick that keeps blocked gateways
     usable without anyone flipping a setting. */
  function streamChat(provider, model, history, signal, onDelta, onThink, opts) {
    opts = opts || {};
    var cfg = (!provider || provider.useRelay) ? null : relayCfg();
    if (!cfg || !cfg.url || !cfg.key) return streamChatAttempt(provider, model, history, signal, onDelta, onThink, opts);
    var streamed = false;
    var watched = onDelta ? function (c) { streamed = true; onDelta(c); } : null;
    function stage(name) {
      if (opts.onStage) { try { opts.onStage(name); } catch (e) { /* ui only */ } }
    }
    return streamChatAttempt(provider, model, history, signal, watched, onThink, opts).catch(function (err) {
      var blocked = err && err.name !== "AbortError" &&
        (err.name === "TypeError" || /firewall|blocked the browser|\(403\)/i.test(String(err.message || "")));
      if (!blocked || streamed || (signal && signal.aborted)) throw err;
      dnote("chat", "Direct call to " + (provider.label || provider.baseUrl) + " was blocked. Retrying through the relay.");
      stage("relay");
      var viaRelay = Object.assign({}, provider, { useRelay: true });
      var streamed2 = false;
      var watched2 = onDelta ? function (c) { streamed2 = true; onDelta(c); } : null;
      return streamChatAttempt(viaRelay, model, history, signal, watched2, onThink, opts).catch(function (err2) {
        /* The provider firewall blocks the relay too. Last resort: the
           relay's own model, labeled honestly in the reply footer. */
        var walled = err2 && /provider's firewall/i.test(String(err2.message || ""));
        if (!walled || streamed2 || streamed || (signal && signal.aborted)) throw err2;
        dnote("chat", "The relay is blocked as well. Trying the relay's own model.");
        stage("gateway");
        var gw = {
          id: "__relaygw", label: "Relay gateway", kind: "openai",
          baseUrl: stripSlash(cfg.url) + "/v1", apiKey: cfg.key,
          authStyle: "bearer", authName: "Authorization", headers: {},
          model: model, useRelay: true
        };
        return streamChatAttempt(gw, model, history, signal, onDelta, onThink, opts).catch(function (err3) {
          if (err3 && /\(503\)/.test(String(err3.message || ""))) {
            throw new Error("The relay's own model is offline. Wake it from Settings, Providers, then try again.");
          }
          throw err3;
        });
      });
    });
  }

  function streamChatAttempt(provider, model, history, signal, onDelta, onThink, opts) {
    opts = opts || {};
    var F = window.ImposeFeatures;
    if (provider && provider.useRelay) return unstreamedChat(provider, model, history, signal, onDelta, opts);
    var sys = opts.system || SYS_MSG;
    var req, body;
    if (provider.kind === "anthropic") {
      req = buildRequest(provider, "/messages");
      req.headers["Content-Type"] = "application/json";
      body = { model: model, max_tokens: 1024, system: sys, messages: history, stream: true };
      if (F) F.applyGenParams(body, "anthropic", opts.genParams);
      return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: signal })
        .then(function (res) {
          return throwIfHttpError(provider, model, res).then(function () {
            return readSSE(res, function (d) {
              if (opts.usage && d.type === "message_start" && d.message && d.message.usage) {
                opts.usage.toksIn = d.message.usage.input_tokens;
              } else if (opts.usage && d.type === "message_delta" && d.usage) {
                opts.usage.toksOut = d.usage.output_tokens;
              }
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
        systemInstruction: { parts: [{ text: sys }] },
        contents: history.map(function (m) {
          return { role: m.role === "assistant" ? "model" : "user", parts: geminiParts(m.content) };
        })
      };
      if (F) F.applyGenParams(body, "gemini", opts.genParams);
      return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: signal })
        .then(function (res) {
          return throwIfHttpError(provider, model, res).then(function () {
            return readSSE(res, function (d) {
              if (opts.usage && d.usageMetadata) {
                opts.usage.toksIn = d.usageMetadata.promptTokenCount;
                opts.usage.toksOut = d.usageMetadata.candidatesTokenCount;
              }
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
            /* The relay appends this event when the upstream died
               mid-generation, so a cut-off answer is never mistaken for a
               complete one. */
            if (d && d.error && d.error.type === "impose_truncated_stream") {
              throw new Error("The reply stream ended early, so part of the answer may be missing.");
            }
            if (opts.usage && d.usage && d.usage.completion_tokens != null) {
              opts.usage.toksIn = d.usage.prompt_tokens;
              opts.usage.toksOut = d.usage.completion_tokens;
            }
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

  /* --- syntax highlighting for fenced code ------------------------------- */
  var HL_SETS = {
    python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda None nonlocal not or pass raise return True False try while with yield match case self",
    js: "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined",
    clike: "abstract as base bool break byte case catch char class const constexpr continue debugger default delete do double dynamic else enum event explicit extern final finally float for foreach func function go goto if implements import in inline int interface internal is lock long namespace new null nullptr object operator out override package params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw try typeof uint ulong unsafe ushort using var virtual void volatile while true false nil defer select range map chan go type struct",
    sql: "add all alter and any as asc auto_increment between by case check column constraint create cross database default delete desc distinct drop else end exists foreign from full group having in index inner insert into is join key left like limit not null offset on or order outer primary procedure references replace right select set table then top truncate union unique update values view when where with",
    css: "important media supports keyframes import from to and not"
  };
  var HL_ALIAS = {
    py: "python", python: "python",
    js: "js", jsx: "js", javascript: "js", mjs: "js", node: "js", ts: "js", tsx: "js", typescript: "js", json: "js",
    java: "clike", c: "clike", cpp: "clike", "c++": "clike", cs: "clike", "c#": "clike", go: "clike", golang: "clike",
    rust: "clike", rs: "clike", swift: "clike", kotlin: "clike", kt: "clike", php: "clike", dart: "clike", scala: "clike",
    sql: "sql", mysql: "sql", postgres: "sql", sqlite: "sql",
    css: "css", scss: "css", less: "css",
    sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh",
    html: "html", xml: "html", svg: "html", vue: "html", yaml: "sh", yml: "sh", toml: "sh", ini: "sh"
  };
  var HL_RE = {
    python: /(#[^\n]*|"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\')|("(?:\\.|[^"\\\n])*"|\'(?:\\.|[^'\\\n])*\')|(\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_][\w]*)/g,
    js: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|\'(?:\\.|[^'\\\n])*\'|`(?:\\.|[^`\\])*`)|(\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g,
    clike: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|\'(?:\\.|[^'\\\n])*\')|(\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*\b)|([A-Za-z_][\w]*)/g,
    sql: /(--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|\'(?:[^'\\\n])*\')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/gi,
    css: /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|\'(?:[^'\\\n])*\')|(#[0-9a-fA-F]{3,8}\b|\b-?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|dvh|s|ms|%)?\b)|([@#.]?[A-Za-z-][\w-]*)/g,
    sh: /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|\'(?:[^'\\\n])*\')|(\b\d+\b)|([A-Za-z_][\w-]*)/g,
    html: /(<!--[\s\S]*?-->)|("(?:[^"\\\n])*"|\'(?:[^'\\\n])*\')|(<\/?[a-zA-Z][\w-]*|\/?>)|([a-zA-Z-]+(?==))/g
  };

  function hlEscape(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlightCode(code, lang) {
    var family = HL_ALIAS[String(lang || "").toLowerCase()] || "";
    if (!family || !HL_RE[family]) return hlEscape(code);
    var words = {};
    (HL_SETS[family === "js" ? "js" : family] || "").split(" ").forEach(function (w) { if (w) words[w] = 1; });
    var isJson = /^(json|ts|tsx)$/i.test(String(lang || "")) && /^[\s\[{]/.test(code);
    var out = "", last = 0, m;
    HL_RE[family].lastIndex = 0;
    while ((m = HL_RE[family].exec(code))) {
      if (m.index > last) out += hlEscape(code.slice(last, m.index));
      last = m.index + m[0].length;
      var cls = "";
      if (m[1]) cls = "tok-com";
      else if (m[2]) {
        cls = "tok-str";
        if (family === "js" && isJson && /^"/.test(m[2]) && code.slice(last).match(/^\s*:/)) cls = "tok-fn";
      }
      else if (m[3]) cls = "tok-num";
      else if (m[4]) {
        var w = m[4];
        if (words[w]) cls = "tok-kw";
        else if (code.slice(last).match(/^\s*\(/)) cls = "tok-fn";
        else if (family === "css" && /^[.@]/.test(w)) cls = "tok-kw";
        else if (family === "css" && code.slice(m.index - 1, m.index) === ".") cls = "tok-fn";
      }
      if (family === "html" && m[3]) cls = "tok-kw";
      out += cls ? '<span class="' + cls + '">' + hlEscape(m[0]) + "</span>" : hlEscape(m[0]);
      if (m[0].length === 0) HL_RE[family].lastIndex++;
    }
    out += hlEscape(code.slice(last));
    return out;
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
          "<pre><code>" + highlightCode(buf.join("\n"), lang) + "</code></pre></div>";
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
      if (!oldest) break;
      if (oldest._dismiss) oldest._dismiss();
      oldest.remove();
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

  document.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("fav")) {
      if (t.parentElement && t.parentElement.classList.contains("trace-fav")) t.parentElement.classList.add("bare");
      t.remove();
    }
  }, true);

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

  /* Modals keep focus inside themselves while open and hand it back to
     whatever opened them on close. A stack, because the provider editor
     opens on top of settings. */
  var modalStack = [];

  function focusablesIn(el) {
    return Array.prototype.filter.call(
      el.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      function (n) { return !n.disabled && (n.offsetWidth || n.offsetHeight || n === document.activeElement); });
  }

  function trapTab(e, el) {
    if (e.key !== "Tab") return;
    var f = focusablesIn(el);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openModal(el) {
    if (!el.getAttribute("role")) el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add("open");
    if (!el.__imposeTrap) {
      el.__imposeTrap = function (e) { trapTab(e, el); };
      el.addEventListener("keydown", el.__imposeTrap);
    }
    modalStack.push({ el: el, prev: document.activeElement });
    var f = focusablesIn(el);
    if (f.length) f[0].focus();
  }

  function closeModal(el) {
    el.classList.remove("open");
    for (var i = modalStack.length - 1; i >= 0; i--) {
      if (modalStack[i].el === el) {
        var prev = modalStack[i].prev;
        modalStack.splice(i, 1);
        if (prev && prev.focus && document.body.contains(prev)) {
          try { prev.focus(); } catch (e) { /* element went away */ }
        }
        break;
      }
    }
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

  function renderList(animateGlide) {
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
    placeGlide(!!animateGlide);
  }

  /* ---------- sidebar glide indicator ---------- */

  var glideEl = null;

  function glideRow() {
    if (!activeId) return null;
    return groupsEl.querySelector('.chat-row[data-id="' + activeId + '"]');
  }

  function placeGlide(animate) {
    var row = null;
    try { row = glideRow(); } catch (e) { row = null; }
    if (!row) {
      if (glideEl) glideEl.style.display = "none";
      return;
    }
    try {
      if (!glideEl) {
        glideEl = document.createElement("div");
        glideEl.className = "row-glide";
        glideEl.setAttribute("aria-hidden", "true");
      }
      if (glideEl.parentNode !== groupsEl) groupsEl.appendChild(glideEl);
      var g = groupsEl.getBoundingClientRect();
      var r = row.getBoundingClientRect();
      var top = r.top - g.top + groupsEl.scrollTop + Math.max(0, (r.height - 24) / 2);
      if (window.anime && window.anime.remove) {
        try { window.anime.remove(glideEl); } catch (e) { /* noop */ }
      }
      glideEl.style.display = "";
      if (animate && motionOK()) {
        play({ targets: glideEl, top: top, duration: 340, ease: EZ("outExpo") });
      } else {
        glideEl.style.top = top + "px";
      }
    } catch (e) { /* decorative */ }
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

  function statsHtml(msg, chatModel) {
    if (!msg.stats || msg.stats.ms == null) return "";
    var secs = Math.max(1, Math.round(msg.stats.ms / 1000));
    var bits = [secs + "s"];
    if (msg.stats.toks > 0) bits.push("≈" + msg.stats.toks + " tok");
    if (msg.stats.cost > 0) bits.push("$" + (msg.stats.cost >= 1 ? msg.stats.cost.toFixed(2) : msg.stats.cost.toFixed(4)));
    /* "via" only when the reply came from somewhere other than the provider
       the header already names. */
    if (msg.via && msg.via !== chatModel) bits.push("via " + msg.via);
    return '<span class="msg-stats">' + bits.join(" · ") + "</span>";
  }

  function actionsHtml(msg, fresh, chatModel) {
    msg = ensureVariants(msg || { content: "" });
    var pager = "";
    if (msg.variants.length > 1) {
      var meta = Array.isArray(msg.variantsMeta) ? msg.variantsMeta[msg.vi] : null;
      var mm = meta && meta.model ? ' title="' + escapeHtml(meta.model) + '"' : "";
      pager = '<span class="pager"' + mm + ">" +
        '<button type="button" data-act="prev" title="Previous version" aria-label="Previous version"><i data-lucide="chevron-left"></i></button>' +
        "<span>" + (msg.vi + 1) + "/" + msg.variants.length + "</span>" +
        '<button type="button" data-act="next" title="Next version" aria-label="Next version"><i data-lucide="chevron-right"></i></button>' +
        "</span>";
    }
    var retryAs = state.providers.length > 1
      ? '<button type="button" data-act="retryas" title="Regenerate with another model" aria-label="Regenerate with another model"><i data-lucide="shuffle"></i></button>'
      : "";
    return '<div class="msg-actions' + (fresh ? " fresh" : "") + '">' +
      '<button type="button" data-act="copy" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button>' +
      rateBtn("like", msg.rating, "Good response", "Good response", "thumbs-up") +
      rateBtn("dislike", msg.rating, "Bad response", "Bad response", "thumbs-down") +
      '<button type="button" data-act="retry" title="Regenerate" aria-label="Regenerate"><i data-lucide="rotate-ccw"></i></button>' +
      retryAs +
      '<button type="button" data-act="editasst" title="Edit reply" aria-label="Edit reply"><i data-lucide="pencil"></i></button>' +
      '<button type="button" data-act="speak" title="Read aloud" aria-label="Read aloud"><i data-lucide="volume-2"></i></button>' +
      sourcesToggleHtml(msg) + pager + statsHtml(msg, chatModel) +
      "</div>";
  }

  /* Only real, self contained image data URLs make it into the DOM or the
     storage. Anything else (a crafted href, a script URL from an imported
     backup) is dropped before it can become markup. */
  var IMAGE_URL_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

  function safeImageUrls(list) {
    if (!list || !list.length) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var u = String(list[i] || "");
      if (u.length <= 14 * 1024 * 1024 && IMAGE_URL_RE.test(u)) out.push(u);
    }
    return out;
  }

  function userRowHtml(msg) {
    var text = typeof msg === "string" ? msg : (msg.content || "");
    var imgs = "";
    var pics = msg && msg.images ? safeImageUrls(msg.images) : [];
    if (pics.length) {
      imgs = '<div class="bubble-imgs">' + pics.map(function (u) {
        return '<a href="' + escapeHtml(u) + '" target="_blank" rel="noreferrer noopener"><img src="' + escapeHtml(u) + '" alt="Attached image"></a>';
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
    return linkCites(renderMarkdown(msg.content || ""), msg);
  }

  /* The image gallery a researched answer carries when the request asked
     for pictures. Tiles keep a square box so loading never shifts layout;
     the photo fades in over the box once it decodes. */
  function imagesHtml(msg) {
    var imgs = msg && msg.images;
    if (!imgs || !imgs.length) return "";
    var tiles = "";
    for (var i = 0; i < imgs.length && i < 8; i++) {
      var im = imgs[i];
      var cap = escapeHtml(im.title || "image").replace(/\s+/g, " ").trim().slice(0, 90);
      tiles += '<button type="button" class="img-tile" data-full="' + escapeHtml(im.image) + '"' +
        ' data-title="' + cap + '"' +
        (im.page ? ' data-page="' + escapeHtml(im.page) + '"' : "") +
        ' style="animation-delay:' + Math.min(i * 45, 360) + 'ms" aria-label="Open image: ' + cap + '">' +
        '<img src="' + escapeHtml(im.thumb || im.image) + '" alt="' + cap + '"' +
        ' loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>';
    }
    return '<div class="img-grid">' + tiles + "</div>";
  }

  function assistantRowHtml(msg, withActions, chatModel) {
    return '<div class="msg-body">' + assistantBodyHtml(msg) + "</div>" + imagesHtml(msg) +
      (withActions ? actionsHtml(msg, false, chatModel) : "") + sourcesPanelHtml(msg, !withActions);
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

  function staggerActions(row) {
    if (!motionOK()) return;
    var box = row.querySelector(".msg-actions");
    if (!box || !box.children.length) return;
    var kids = Array.prototype.slice.call(box.children);
    try {
      noTrans(kids);
      play({
        targets: kids,
        opacity: [0, 1],
        translateY: [7, 0],
        duration: 260,
        ease: EZ("outCubic"),
        delay: window.anime.stagger(38),
        onComplete: function () { yesTrans(kids); }
      });
    } catch (e) { yesTrans(kids); }
  }

  function settleBodyIn(body) {
    if (!body || !body.isConnected) return;
    play({ targets: body, opacity: [0.4, 1], translateY: [6, 0], duration: 340, ease: EZ("outCubic") });
    /* The blur bridges the reveal into the settle so it reads as one
       continuous focus pull. WAAPI keeps it off the main thread. */
    if (!REDUCED && body.animate) {
      try {
        body.animate([{ filter: "blur(5px)" }, { filter: "blur(0px)" }],
          { duration: 320, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      } catch (e) { /* older engines just get the fade */ }
    }
  }

  function countUpStats(row, msg) {
    if (!motionOK() || !msg || !msg.stats || msg.stats.ms == null) return;
    var slot = row.querySelector(".msg-stats");
    if (!slot) return;
    var secs = Math.max(1, Math.round(msg.stats.ms / 1000));
    var toks = msg.stats.toks > 0 ? Math.round(msg.stats.toks) : 0;
    try {
      var o = { s: 0, t: 0 };
      play({
        targets: o,
        s: secs,
        t: toks,
        duration: 650,
        ease: EZ("outCubic"),
        onUpdate: function () {
          if (!slot.isConnected) return;
          slot.textContent = Math.max(1, Math.round(o.s)) + "s" + (toks > 0 ? " · ≈" + Math.round(o.t) + " tok" : "");
        }
      });
    } catch (e) { /* static text stays */ }
  }

  function flashCopied(btn) {
    if (!btn || !btn.isConnected) return;
    btn.innerHTML = '<i data-lucide="check"></i>';
    btn.classList.add("on");
    btn.title = "Copied";
    refreshIcons();
    if (motionOK()) {
      try {
        btn.style.transition = "none";
        play({
          targets: btn,
          scale: [0.65, 1],
          duration: 260,
          ease: EZ("outExpo"),
          onComplete: function () { btn.style.transition = ""; }
        });
      } catch (e) { btn.style.transition = ""; }
    }
    setTimeout(function () {
      if (!btn.isConnected) return;
      btn.innerHTML = '<i data-lucide="copy"></i>';
      btn.classList.remove("on");
      btn.title = "Copy";
      refreshIcons();
    }, 1300);
  }

  var regenBusy = false;
  function fadeRegen(row, next) {
    if (REDUCED || !row) { next(); return; }
    regenBusy = true;
    row.classList.add("regen-out");
    setTimeout(function () {
      row.classList.remove("regen-out");
      regenBusy = false;
      next();
    }, 180);
  }

  function restoreTrace(row, msg) {
    if (!window.ImposeTrace || !msg) return;
    if (row.querySelector(".agent-trace")) return;
    var hasSources = msg.sources && msg.sources.length;
    if (!hasSources && !msg.trace) return;
    var rows = hasSources ? msg.sources.map(function (s, i) {
      return { primary: s.title || s.url, secondary: hostOf(s.url), href: s.url, si: i + 1 };
    }) : [];
    var snap = msg.trace
      ? { status: msg.trace.status, secs: msg.trace.secs, query: msg.trace.query, rows: rows }
      : {
        status: "Searched the web",
        secs: msg.stats && msg.stats.ms ? Math.max(1, Math.round(msg.stats.ms / 1000)) : 1,
        query: null,
        rows: rows
      };
    window.ImposeTrace.mountSettled(row, snap);
    refreshIcons();
  }

  function renderMessages() {
    var chat = getChat(activeId);
    messagesEl.innerHTML = "";
    if (!chat) return;
    chat.messages.forEach(function (m, i) {
      var row = document.createElement("div");
      row.className = "msg " + m.role;
      row.dataset.i = i;
      row.innerHTML = m.role === "user" ? userRowHtml(m) : assistantRowHtml(m, true, chat.model);
      messagesEl.appendChild(row);
      if (m.role !== "user") {
        (function (r, msg) {
          requestAnimationFrame(function () {
            if (r.isConnected) restoreTrace(r, msg);
          });
        })(row, m);
      }
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
    hideJump(true);
    activeId = id;
    renderList(true);
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
    hideJump(true);
    activeId = null;
    renderList();
    if (motionOK() && messagesEl.children.length && !messagesEl.hidden) {
      try {
        play({
          targets: messagesEl,
          opacity: [1, 0],
          translateY: [0, 10],
          duration: 170,
          ease: EZ("inCubic"),
          onComplete: function () {
            messagesEl.innerHTML = "";
            showEmpty();
            messagesEl.style.opacity = "";
            messagesEl.style.transform = "";
          }
        });
      } catch (e) {
        messagesEl.innerHTML = "";
        showEmpty();
      }
    } else {
      messagesEl.innerHTML = "";
      showEmpty();
    }
    autogrow();
    dnote("chat", "New chat started");
    syncSend();
    if (window.innerWidth <= 768) document.body.classList.remove("nav-open");
    if (window.innerWidth > 768) input.focus();
  }

  /* ---------- streaming: canned demo + live provider ---------- */

  function setStreamingUI(on) {
    if (!motionOK()) {
      sendBtn.hidden = on;
      stopBtn.hidden = !on;
      return;
    }
    var outEl = on ? sendBtn : stopBtn;
    var inEl = on ? stopBtn : sendBtn;
    if (outEl.hidden && !inEl.hidden) return;
    try {
      if (window.anime.remove) { window.anime.remove(outEl); window.anime.remove(inEl); }
      outEl.style.transition = "none";
      inEl.style.transition = "none";
      play({
        targets: outEl,
        scale: [1, 0.5],
        opacity: [1, 0],
        duration: 130,
        ease: EZ("inCubic"),
        onComplete: function () {
          outEl.hidden = true;
          outEl.style.transition = "";
          outEl.style.opacity = "";
          outEl.style.transform = "";
          inEl.hidden = false;
          play({
            targets: inEl,
            scale: [0.5, 1],
            opacity: [0, 1],
            duration: 200,
            ease: EZ("outExpo"),
            onComplete: function () {
              inEl.style.transition = "";
              inEl.style.opacity = "";
              inEl.style.transform = "";
            }
          });
        }
      });
    } catch (e) {
      outEl.style.transition = "";
      inEl.style.transition = "";
      sendBtn.hidden = on;
      stopBtn.hidden = !on;
    }
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
        finalizeStreamRow(s);
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
      s.row.insertAdjacentHTML("beforeend", imagesHtml(msg) + actionsHtml(msg || { content: content }, true, chat.model) + sourcesPanelHtml(msg || { content: content }));
    }
    refreshIcons();
    settleBodyIn(s.body);
    staggerActions(s.row);
    countUpStats(s.row, msg);
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
    row.innerHTML = '<div class="msg-body"><span class="dots"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span></div>';
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

  function historyFor(messages, kind, model) {
    kind = kind || "openai";
    var F = window.ImposeFeatures;
    var msgs = messages;
    if (F) {
      /* Token aware trim against the model window, instead of a blind last 30. */
      msgs = F.trimHistory(messages, kind, Math.floor(F.modelContext(model) * 0.5));
    } else {
      msgs = messages.filter(function (m) { return String(m.content || "").trim() !== "" || (m.images && m.images.length); }).slice(-30);
    }
    return msgs
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

  /* replaceIdx null appends a fresh answer, otherwise regenerates in place.
     retried marks a failover attempt so a bad provider cannot loop forever. */
  var dotsHtml = '<span class="dots"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>';

  function streamLive(chat, provider, model, history, replaceIdx, retried) {
    var idx, row;
    if (replaceIdx == null) {
      idx = chat.messages.length;
      chat.messages.push({ role: "assistant", content: "", ts: Date.now() });
      row = document.createElement("div");
      row.className = "msg assistant";
      row.dataset.i = idx;
      row.innerHTML = '<div class="msg-body"></div>';
      messagesEl.appendChild(row);
    } else {
      idx = replaceIdx;
      row = messagesEl.querySelector('.msg[data-i="' + idx + '"]');
      if (!row) return;
      var rm = chat.messages[idx];
      if (rm) rm.error = null;
      var oldActions = row.querySelector(".msg-actions");
      if (oldActions) oldActions.remove();
      var oldPanel = row.querySelector(".sources");
      if (oldPanel) oldPanel.remove();
      var oldTrace = row.querySelector(".agent-trace");
      if (oldTrace) oldTrace.remove();
      row.querySelector(".msg-body").innerHTML = "";
    }

    setStreamingUI(true);
    if (isNearBottom()) scrollBottom();

    /* Every chat gets the thinking trace, not just deep search: the pipeline
       can legitimately take a while (blocked provider, relay hop, waking the
       gateway model) and a bare pixel grid hides all of it. */
    var trace = window.ImposeTrace ? window.ImposeTrace.mountTrace(row, { active: "Thinking" }) : null;
    if (!trace) {
      var fb = row.querySelector(".msg-body");
      if (fb && !fb.firstChild) fb.innerHTML = dotsHtml;
    }
    refreshIcons();
    var tickTimer = trace ? setInterval(function () { trace.setElapsed(); }, 100) : 0;
    var slowTimer = setTimeout(function () {
      if (stream === s && row.isConnected && trace) trace.setStatus("Still working. The provider may be waking.");
    }, 14000);

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
      viaRelay: !!(provider && provider.useRelay),
      retried: !!retried,
      usage: {},
      trace: trace,
      tickTimer: tickTimer,
      slowTimer: slowTimer
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

    var liveOpts = {
      genParams: chat && chat.params,
      system: getSystemMsg(chat),
      usage: s.usage,
      onStage: function (stage) {
        if (!trace || stream !== s) return;
        if (stage === "relay") {
          s.stageLabel = "relay";
          trace.addRow({ primary: "Provider blocked the app", secondary: "retrying via the relay" });
        } else if (stage === "gateway") {
          s.stageLabel = "Relay gateway";
          trace.addRow({ primary: "Provider unreachable", secondary: "using the relay model" });
        } else if (stage === "waking") {
          trace.setStatus("Waking the relay model");
          trace.addRow({ primary: "Model offline", secondary: "waking takes 1 to 3 minutes" });
        }
      }
    };
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
    }, liveOpts).then(function () {
      settleLiveTrace(s, false, null);
      finishLive(s, false, null);
    }, function (err) {
      settleLiveTrace(s, true, err);
      /* Failover: one automatic retry on the next usable provider. */
      var backup = (!err || err.name !== "AbortError") && !s.retried && state.settings.failover
        ? pickBackup(provider && provider.id) : null;
      if (backup) {
        dnote("chat", "Failover to " + backup.label + " after " + (provider ? provider.label : "failure"));
        toast("Provider failed. Retrying with " + backup.label + ".");
        var idxKeep = s.index;
        var rowKeep = s.row;
        if (stream === s) stream = null;
        setStreamingUI(true);
        rowKeep.querySelector(".msg-body").innerHTML = dotsHtml;
        chat.model = backup.label; /* header label mirrors who actually answers */
        var hist2 = historyFor(chat.messages.slice(0, idxKeep), backup.kind, backup.model);
        streamLive(chat, backup.provider, backup.model, hist2, idxKeep, true);
        return;
      }
      finishLive(s, true, err);
    });
  }

  /* The next provider in the list that has a model and can actually run. */
  function pickBackup(excludeId) {
    var candidates = state.providers.filter(function (p) {
      return p.id !== excludeId && activeModelOf(p) &&
        (p.authStyle === "none" || String(p.apiKey || "").trim());
    });
    return candidates.length ? { provider: candidates[0], model: activeModelOf(candidates[0]), label: providerDisplay(candidates[0]) } : null;
  }

  function settleLiveTrace(s, failed, err) {
    if (s.tickTimer) clearInterval(s.tickTimer);
    if (s.slowTimer) clearTimeout(s.slowTimer);
    if (!s.trace) return;
    var chat = getChat(s.chatId);
    var msg = chat && chat.messages[s.index];
    if (failed && err && err.name !== "AbortError") {
      s.trace.settle("Failed");
    } else if (failed) {
      s.trace.settle("Stopped");
    } else if (s.stageLabel) {
      s.trace.settle("Answered via " + s.stageLabel);
      if (msg && !(msg.trace && msg.trace.status)) {
        msg.trace = { status: "Answered via " + s.stageLabel,
          secs: Math.max(1, Math.round((Date.now() - (s.t0 || Date.now())) / 1000)), query: null };
      }
    } else {
      s.trace.settle("Thought for");
    }
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
    /* The gallery is a work product of the search, not of the answer: keep
       it even when the completion failed. */
    if (s.galleryImages && msg && !(msg.images && msg.images.length)) {
      msg.images = s.galleryImages.slice(0, 8);
    }
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
      var stats = { ms: Date.now() - (s.t0 || Date.now()), toks: Math.round(s.text.length / 4) };
      var u = s.usage || {};
      if (u.toksOut > 0 || u.toksIn > 0) {
        stats.toks = (u.toksIn || 0) + (u.toksOut || 0);
        stats.toksIn = u.toksIn || 0;
        stats.toksOut = u.toksOut || 0;
        var pr = s.provider || {};
        var pin = isFinite(+pr.priceIn) ? +pr.priceIn : null;
        var pout = isFinite(+pr.priceOut) ? +pr.priceOut : null;
        if (pin != null || pout != null) {
          stats.cost = (pin != null ? (u.toksIn || 0) / 1e6 * pin : 0) + (pout != null ? (u.toksOut || 0) / 1e6 * pout : 0);
        }
      }
      msg.stats = stats;
      /* The header already shows who is answering; keep "via" only when the
         reply actually came from somewhere else (failover, regenerate). */
      var disp = s.provider ? providerDisplay(s.provider) : null;
      msg.via = disp && disp !== chat.model ? disp : null;
      if (s.stopped && !failed && s.text) msg.stopped = true; else msg.stopped = null;
      if (msg.variants) msg.variants[msg.vi] = s.text;
      chat.updatedAt = Date.now();
      save();
    }
    if (s.row.isConnected) {
      s.body.innerHTML = msg ? assistantBodyHtml(msg) : renderMarkdown(s.text);
      if (!s.row.querySelector(".msg-actions")) {
        s.row.insertAdjacentHTML("beforeend", imagesHtml(msg) + actionsHtml(msg || { content: s.text }, true, chat.model) + sourcesPanelHtml(msg || { content: s.text }));
      }
      refreshIcons();
      settleBodyIn(s.body);
      staggerActions(s.row);
      countUpStats(s.row, msg);
      if (isNearBottom()) scrollBottom();
    }
    if (failed) {
      dfail("chat", sentence);
      if (err && err.name === "TypeError" && s.viaRelay) markRelayDown();
    } else if (msg) {
      maybeRetitle(chat, s.provider, s.model);
    }
    if (!failed && !s.stopped && msg) showFollowups(chat, msg);
    if (!failed && !s.stopped && msg) maybeSmartFollowups(chat, msg);
    if (awayBase !== -1) updateJumpPill();
    renderList();
    drainNext();
  }

  /* Model generated follow ups, cached on the message. Falls back to the
     canned bank silently when the model is out of ideas or money. */
  function maybeSmartFollowups(chat, msg) {
    if (!state.settings.followupsSmart) return;
    if (!msg || msg.suggested || msg.suggesting) return;
    var t = getTarget();
    if (!t || String(msg.content || "").length < 40) return;
    msg.suggesting = true;
    completeOnce(t.provider, t.model, [{ role: "user", content:
      window.ImposeFeatures.followUpPrompt(prevUserText(chat, chat.messages.indexOf(msg)), String(msg.content).slice(0, 600)) }])
      .then(function (out) {
        msg.suggesting = false;
        var lines = window.ImposeFeatures.parseFollowUps(out);
        if (!lines.length) return;
        msg.suggested = lines;
        save();
        if (getChat(activeId) === chat && !stream &&
            chat.messages[chat.messages.length - 1] === msg) {
          showFollowups(chat, msg);
        }
      }, function () { msg.suggesting = false; });
  }

  function clearTraceDemo() {
    messagesEl.querySelectorAll(".msg.demo").forEach(function (n) { n.remove(); });
  }

  function playTraceDemo() {
    clearTraceDemo();
    if (!window.ImposeTrace || !window.ImposeTrace.playDemo) {
      dnote("app", "Trace demo unavailable.");
      return;
    }
    showDock();
    dnote("app", "Playing the agent trace demo.");
    window.ImposeTrace.playDemo(messagesEl, {
      refreshIcons: refreshIcons,
      renderMarkdown: renderMarkdown,
      pin: function () { if (isNearBottom()) scrollBottom(); }
    });
  }

  function syncSearchBtn() {
    /* The tools button wears one face: plus. The menu carries the state. */
    var btn = $("searchBtn");
    if (btn.getAttribute("data-face") === "plus") return;
    btn.setAttribute("data-face", "plus");
    btn.innerHTML = '<i data-lucide="plus"></i>';
    btn.title = "Assistant tools";
    btn.setAttribute("aria-label", "Assistant tools");
    btn.setAttribute("aria-haspopup", "menu");
    btn.removeAttribute("aria-pressed");
    refreshIcons();
  }

  function fetchSearchViaRelay(query, limit, signal) {
    var cfg = relayCfg();
    if (!cfg.url) return Promise.reject(new Error("Set the relay address in the provider editor under Advanced, Relay."));
    var url = stripSlash(cfg.url) + "/v1/search";
    var headers = { "Content-Type": "application/json" };
    if (cfg.key) headers.Authorization = "Bearer " + cfg.key;
    var opts = {
      method: "POST",
      headers: headers,
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
  /* Last few turns as plain lines, so the agent can resolve follow-ups
     ("is he married" after talking about MrBeast). Skips empties, which
     covers the placeholder being regenerated. */
  function agentContext(chat, current) {
    var lines = [];
    var msgs = (chat && chat.messages) || [];
    for (var i = msgs.length - 1; i >= 0 && lines.length < 7; i--) {
      var m = msgs[i];
      var text = m && typeof m.content === "string" ? m.content.trim().replace(/\s+/g, " ") : "";
      if (!text) continue;
      if (text.length > 300) text = text.slice(0, 300) + "\u2026";
      lines.unshift((m.role === "assistant" ? "assistant" : "user") + ": " + text);
    }
    var want = String(current || "").trim().replace(/\s+/g, " ");
    if (want && lines.length) {
      var tail = lines[lines.length - 1];
      var tailText = tail.indexOf("user: ") === 0 ? tail.slice(6) : null;
      /* The tail was cut at 300 chars with an ellipsis, so compare on the
         prefix, or the message just sent shows up twice in the context. */
      if (tailText != null &&
          (tailText === want ||
           (tailText.charAt(tailText.length - 1) === "\u2026" && want.indexOf(tailText.slice(0, -1)) === 0))) {
        lines.pop();
      }
    }
    return lines.slice(-6).join("\n");
  }

  function fetchImagesViaRelay(query, limit, signal) {
    var cfg = relayCfg();
    if (!cfg.url) return Promise.reject(new Error("Set the relay address to search images."));
    var headers = { "Content-Type": "application/json" };
    if (cfg.key) headers.Authorization = "Bearer " + cfg.key;
    var opts = {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ query: query, limit: limit || 6 })
    };
    if (signal) opts.signal = signal;
    return fetch(stripSlash(cfg.url) + "/v1/images", opts).then(function (res) {
      if (res.status === 401) throw new Error("That relay key was rejected.");
      return res.json().then(function (data) { return { status: res.status, data: data }; }, function () {
        throw new Error("The image search came back unreadable.");
      });
    }).then(function (env) {
      if (env.status !== 200) throw new Error((env.data && env.data.detail) || ("Image search failed (" + env.status + ")."));
      return { results: env.data.results || [], provider: env.data.provider || "" };
    });
  }

  /* Fire-and-forget wake for a sleeping relay. Render free spins down on
     idle and the first request pays the wake, so this moves the wake ahead
     of the first real request. Silent by design: no log, no toast. */
  var warmedAt = 0;
  function warmRelay() {
    try {
      if (Date.now() - warmedAt < 60000) return;
      warmedAt = Date.now();
      var cfg = relayCfg();
      if (!cfg.url) return;
      fetch(stripSlash(cfg.url) + "/health", { method: "GET", mode: "cors", cache: "no-store" }).then(function () {}, function () {});
    } catch (e) { /* waking is best effort */ }
  }

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
      row.innerHTML = '<div class="msg-body"></div>';
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
      var oldPanel = row.querySelector(".sources");
      if (oldPanel) oldPanel.remove();
      row.querySelector(".msg-body").innerHTML = "";
    }
    var trace = window.ImposeTrace.mountTrace(row, { active: "Thinking" });
    refreshIcons();
    trace.setElapsed();
    var tickTimer = setInterval(function () { trace.setElapsed(); }, 100);
    var slowTimer = setTimeout(function () {
      if (stream === s && row.isConnected) trace.setStatus("Still working, the relay is waking up");
    }, 12000);
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
      else if (ev.t === "query") {
        s.query = ev.q;
        trace.addRow({ kind: "query", primary: ev.q, mono: true });
      }
      else if (ev.t === "source") {
        siCount++;
        if (shown < 5) {
          trace.addRow({ primary: ev.title, secondary: ev.sub, href: ev.href, si: siCount });
          shown++;
        }
      }
      else if (ev.t === "images") {
        s.galleryImages = ev.images || null;
        trace.addRow({ primary: ev.n + " images", secondary: ev.provider || "" });
      }
      else if (ev.t === "imagesfail") trace.addRow({ primary: "Image search failed", secondary: "answered without photos" });
      else if (ev.t === "more") trace.setMore(ev.n);
      else if (ev.t === "settle") {
        clearTimeout(slowTimer);
        trace.settle(ev.text);
        if (s.body.isConnected) s.body.innerHTML = "";
      }
      refreshIcons();
      if (isNearBottom()) scrollBottom();
    }

    var signal = s.controller ? s.controller.signal : undefined;
    window.ImposeHarness.harness.runAgent({
      query: userText,
      context: agentContext(chat, userText),
      signal: signal,
      emit: emit,
      search: function (q, limit) { return fetchSearchViaRelay(q, limit, signal); },
      images: state.settings.imageTools === false ? undefined : function (q, limit) { return fetchImagesViaRelay(q, limit, signal); },
      excluded: chat.excluded,
      rewrite: function (text, context) {
        return new Promise(function (resolve) {
          var out = "";
          var prompt = "Rewrite this chat request as one short web search query of 3 to 10 words. " +
            "Use the conversation to resolve names and pronouns like he, she, it, or they, so the query names its subject. " +
            "Reply with only the query and no quotes.\n\n" +
            (context ? "Conversation:\n" + context + "\n\n" : "") + "Request: " + text;
          streamChat(provider, model, [{ role: "user", content: prompt }], signal, function (c) { out += c; }).then(function () {
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
      clearTimeout(slowTimer);
      var c = getChat(s.chatId);
      var m = c && c.messages[s.index];
      if (m && out && out.images && out.images.length) m.images = out.images.slice(0, 8);
      if (m && out && out.sources) {
        m.sources = out.sources.map(function (r) { return { title: r.title || r.url, url: r.url }; });
        m.trace = {
          status: "Searched the web",
          secs: Math.max(1, Math.round((Date.now() - (s.t0 || Date.now())) / 1000)),
          query: s.query || null
        };
        save();
      }
      finishLive(s, false, null);
    }, function (err) {
      clearInterval(tickTimer);
      clearTimeout(slowTimer);
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
    /* "remember that ..." stores a fact for future chats before anything
       else happens. The message still goes to the model. */
    if (/^remember /i.test(text) && window.ImposeFeatures) {
      var fact = window.ImposeFeatures.memoryFromText(text);
      if (fact) {
        state.memories = window.ImposeFeatures.dedupeMemory(state.memories, fact);
        save();
        renderMemory();
        toast("Remembered. Manage memories in Settings.");
      }
    }
    /* Optional redaction before anything leaves the device. */
    if (state.settings.redactPII && window.ImposeFeatures) {
      var red = window.ImposeFeatures.redactPII(text);
      if (red.text !== text) {
        text = red.text;
        toast.warn("Redacted before send: " + red.found.join(", "));
      }
    }
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
      var vt = getTarget();
      if (!vt) toast("Demo replies cannot see your images. Only the text was sent.");
      else if (window.ImposeFeatures && !window.ImposeFeatures.visionCapable(vt.model)) {
        toast.warn(vt.model + " may not see images. A vision model would.");
      }
      pendingImages = [];
      renderAttachPreview();
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

  function routeSend(chat, text, replaceIdx, override) {
    clearFollowups();
    stopSpeak();
    var t = override ? { provider: override, model: activeModelOf(override) } : getTarget();
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
      if (state.settings.searchMode && window.ImposeHarness && window.ImposeTrace) {
        dnote("chat", "Research via " + providerDisplay(t.provider));
        streamResearched(chat, t.provider, t.model, text, replaceIdx);
      } else {
        dnote("chat", "Chat via " + providerDisplay(t.provider) + " (" + chat.messages.length + " messages)");
        var hist = replaceIdx == null ? historyFor(chat.messages, t.provider.kind, t.model) : historyFor(chat.messages.slice(0, replaceIdx), t.provider.kind, t.model);
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
    if (!state.settings.autoName) return;
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
      /* Standalone [n] only: preceded by start, space, or an open bracket,
         and not glued to a word or a call like arr[1] or footnote defs
         like "[1]:". Everything else stays plain text. */
      parts[i] = parts[i].replace(/(^|[\s(>\n])\[(\d{1,2})\](?![\w(:])/g, function (m, pre, d) {
        var n = +d;
        if (n < 1 || n > msg.sources.length) return m;
        var src = msg.sources[n - 1] || {};
        var host = hostOf(src.url || "");
        if (!host) return m;
        return pre + '<button type="button" class="cite-chip" data-cite="' + n + '" title="' + escapeHtml(host) + '">' +
          '<img class="fav cite-fav" src="https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64" alt="" loading="lazy">' +
          escapeHtml(host) + "</button>";
      });
    }
    return parts.join("");
  }

  function sourcesToggleHtml(msg) {
    if (!msg.sources || !msg.sources.length) return "";
    var stack = msg.sources.slice(0, 3).map(function (s) {
      var host = hostOf(s.url);
      if (!host) return "";
      return '<img class="fav src-stack-img" src="https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64" alt="" loading="lazy">';
    }).join("");
    return '<button type="button" class="sources-head" data-act="sources" aria-expanded="false">' +
      '<span class="src-stack">' + stack + "</span>" +
      "<span>" + msg.sources.length + " sources</span>" +
      '<i data-lucide="chevron-down"></i></button>';
  }

  function sourcesPanelHtml(msg, open) {
    if (!msg.sources || !msg.sources.length) return "";
    var items = msg.sources.map(function (s, i) {
      var host = hostOf(s.url);
      return '<li data-si="' + (i + 1) + '"><a href="' + escapeHtml(s.url) + '" target="_blank" rel="noreferrer noopener">' +
        (host ? '<img class="fav src-fav" src="https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64" alt="" loading="lazy">' : "") +
        '<span class="src-title">' + escapeHtml(s.title || s.url) + "</span></a>" +
        (host ? '<span class="src-host">' + escapeHtml(host) + "</span>" : "") +
        (host ? '<button type="button" class="src-hide" data-exdom="' + escapeHtml(host) + '" title="Hide this site and research again" aria-label="Hide ' + escapeHtml(host) + ' and research again"><i data-lucide="eye-off"></i></button>' : "") +
        "</li>";
    }).join("");
    return '<div class="sources"><div class="sources-grid' + (open ? "" : " closed") + '"><div class="sources-clip">' +
      '<ol class="sources-list">' + items + "</ol></div></div></div>";
  }

  function jumpToSource(row, n) {
    var grid = row.querySelector(".sources-grid");
    if (grid && grid.classList.contains("closed")) {
      grid.classList.remove("closed");
      var head = row.querySelector(".sources-head");
      if (head) {
        head.classList.add("open");
        head.setAttribute("aria-expanded", "true");
      }
    }
    var list = row.querySelector(".sources-list");
    var target = row.querySelector('.trace-row[data-si="' + n + '"]') || (list && list.querySelector('li[data-si="' + n + '"]'));
    if (!target) return;
    if (target.scrollIntoView) target.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
    target.classList.add("flash");
    setTimeout(function () { target.classList.remove("flash"); }, 1200);
  }

  /* ---------- image lightbox ---------- */

  var imgbox = null;
  var imgboxTimer = 0;

  function closeImgbox() {
    if (!imgbox || !imgbox.classList.contains("open")) return;
    imgbox.classList.remove("open");
    clearTimeout(imgboxTimer);
    imgboxTimer = setTimeout(function () { if (imgbox) imgbox.hidden = true; }, 160);
    document.removeEventListener("keydown", imgboxKeys);
  }

  function imgboxKeys(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeImgbox(); }
  }

  function openImgbox(tile) {
    if (!imgbox) {
      imgbox = document.createElement("div");
      imgbox.className = "imgbox";
      imgbox.hidden = true;
      imgbox.setAttribute("role", "dialog");
      imgbox.setAttribute("aria-modal", "true");
      imgbox.setAttribute("aria-label", "Image preview");
      document.body.appendChild(imgbox);
      imgbox.addEventListener("click", function (e) {
        /* Taps land on the icon inside the button, so match the button
           through the tree, and treat any tap outside the figure as close. */
        if (e.target === imgbox || e.target.closest(".imgbox-x") ||
            !e.target.closest(".imgbox-fig")) closeImgbox();
      });
    }
    var full = tile.getAttribute("data-full") || "";
    var page = tile.getAttribute("data-page") || "";
    var title = tile.getAttribute("data-title") || "image";
    imgbox.innerHTML =
      '<button type="button" class="imgbox-x icon-btn" aria-label="Close"><i data-lucide="x"></i></button>' +
      '<figure class="imgbox-fig">' +
      '<a href="' + escapeHtml(full) + '" target="_blank" rel="noopener noreferrer">' +
      '<img src="' + escapeHtml(full) + '" alt="' + escapeHtml(title) + '" referrerpolicy="no-referrer"></a>' +
      '<figcaption class="imgbox-cap"><span>' + escapeHtml(title) + "</span>" +
      (page ? '<a href="' + escapeHtml(page) + '" target="_blank" rel="noopener noreferrer">Source</a>' : "") +
      "</figcaption></figure>";
    imgbox.hidden = false;
    /* next frame so the entry transition runs */
    requestAnimationFrame(function () { imgbox.classList.add("open"); });
    refreshIcons();
    document.addEventListener("keydown", imgboxKeys);
  }

  messagesEl.addEventListener("click", function (e) {
    var tile = e.target.closest ? e.target.closest(".img-tile") : null;
    if (tile) { openImgbox(tile); return; }
    if (e.target.closest && e.target.closest(".imgbox")) closeImgbox();
  });
  /* load does not bubble: fade the photo in over its box from here */
  messagesEl.addEventListener("load", function (e) {
    if (e.target && e.target.classList && e.target.classList.contains("loaded")) return;
    if (e.target && e.target.tagName === "IMG" && e.target.parentElement && e.target.parentElement.classList.contains("img-tile")) {
      e.target.classList.add("loaded");
    }
  }, true);
  messagesEl.addEventListener("error", function (e) {
    if (e.target && e.target.tagName === "IMG" && e.target.parentElement && e.target.parentElement.classList.contains("img-tile")) {
      e.target.parentElement.classList.add("broken");
    }
  }, true);

  /* ---------- citation hover cards ---------- */

  var citeCard = null;
  var citeHideTimer = 0;

  function hideCiteCard() {
    clearTimeout(citeHideTimer);
    if (citeCard) {
      citeCard._chip = null;
      citeCard.classList.remove("show");
      citeCard.style.opacity = "0";
      citeCard.style.visibility = "hidden";
    }
  }

  function showCiteCard(chip) {
    var row = chip.closest(".msg");
    var chat = getChat(activeId);
    if (!row || !chat) return;
    var msg = chat.messages[+row.dataset.i];
    var src = msg && msg.sources && msg.sources[(+chip.dataset.cite) - 1];
    if (!src || (!src.title && !src.url)) return;
    if (!citeCard) {
      citeCard = document.createElement("div");
      citeCard.className = "cite-card";
      citeCard.setAttribute("aria-hidden", "true");
      document.body.appendChild(citeCard);
    }
    if (citeCard._chip === chip && citeCard.classList.contains("show")) return;
    citeCard._chip = chip;
    clearTimeout(citeHideTimer);
    citeCard.innerHTML = "";
    var t = document.createElement("strong");
    t.textContent = src.title || hostOf(src.url || "");
    var h = document.createElement("span");
    h.textContent = hostOf(src.url || "");
    var hint = document.createElement("em");
    hint.textContent = "Select to jump to the source";
    citeCard.appendChild(t);
    citeCard.appendChild(h);
    citeCard.appendChild(hint);
    var r = chip.getBoundingClientRect();
    var cw = Math.min(260, window.innerWidth - 16);
    citeCard.style.maxWidth = cw + "px";
    citeCard.style.visibility = "visible";
    var left = Math.max(8, Math.min(window.innerWidth - cw - 8, r.left + r.width / 2 - cw / 2));
    citeCard.style.left = left + "px";
    var ch = citeCard.offsetHeight || 64;
    var top = r.top - ch - 8;
    if (top < 8) top = r.bottom + 8;
    citeCard.style.top = Math.max(8, top) + "px";
    citeCard.classList.add("show");
    play({ targets: citeCard, opacity: [0, 1], translateY: [4, 0], duration: 160, ease: EZ("outCubic") });
    if (!motionOK()) citeCard.style.opacity = "1";
  }

  messagesEl.addEventListener("mouseover", function (e) {
    var chip = e.target.closest ? e.target.closest("[data-cite]") : null;
    if (chip) showCiteCard(chip);
  });
  messagesEl.addEventListener("mouseout", function (e) {
    if (e.target.closest && e.target.closest("[data-cite]")) {
      clearTimeout(citeHideTimer);
      citeHideTimer = setTimeout(hideCiteCard, 120);
    }
  });
  messagesEl.addEventListener("focusin", function (e) {
    var chip = e.target.closest ? e.target.closest("[data-cite]") : null;
    if (chip) showCiteCard(chip);
  });
  messagesEl.addEventListener("focusout", function (e) {
    if (e.target.closest && e.target.closest("[data-cite]")) hideCiteCard();
  });
  chatScroll.addEventListener("scroll", hideCiteCard, { passive: true });

  function prepRegen(chat, msg, nextModel) {
    ensureVariants(msg);
    if (!Array.isArray(msg.variantsMeta)) {
      msg.variantsMeta = msg.variants.map(function () { return null; });
    }
    while (msg.variantsMeta.length < msg.variants.length) msg.variantsMeta.push(null);
    msg.vi = msg.variants.length;
    msg.variants.push("");
    msg.variantsMeta.push({ model: nextModel || chat.model || "" });
    msg.content = "";
    msg.error = null;
    msg.rating = null;
    msg.stats = null;
    msg.sources = null;
    msg.stopped = null;
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
    if (stream || regenBusy) return;
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
    fadeRegen(row, function () {
      prepRegen(chat, msg);
      routeSend(chat, prevUserText(chat, idx), idx);
    });
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
    var h = document.createElement("p");
    h.className = "followups-head";
    h.textContent = "Follow-ups";
    wrap.appendChild(h);
    var picks = Array.isArray(msg.suggested) && msg.suggested.length
      ? msg.suggested.slice(0, 3)
      : followupsFor(userText, msg.content);
    if (msg.stopped) {
      picks = ["Continue where you stopped"].concat(picks.slice(0, 2));
    }
    picks.forEach(function (s, i) {
      var prompt = s === "Continue where you stopped"
        ? "Continue exactly where you stopped. Do not repeat what you already wrote."
        : s;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "followup";
      b.innerHTML = '<i data-lucide="' + (s === "Continue where you stopped" ? "play" : "corner-up-left") + '"></i>';
      var sp = document.createElement("span");
      sp.textContent = s;
      b.appendChild(sp);
      b.style.setProperty("--d", (i * 90) + "ms");
      b.addEventListener("click", function () { send(prompt); });
      wrap.appendChild(b);
    });
    row.appendChild(wrap);
    refreshIcons();
  }

  /* ---------- jump to latest ---------- */

  var jumpPill = $("jumpPill");
  var awayBase = -1;

  var jumpTimer = 0;

  function showJump() {
    if (!jumpPill.hidden && jumpPill.classList.contains("show")) return;
    clearTimeout(jumpTimer);
    jumpPill.hidden = false;
    if (REDUCED) { jumpPill.classList.add("show"); return; }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { jumpPill.classList.add("show"); });
    });
  }

  function hideJump(instant) {
    if (jumpPill.hidden && !jumpPill.classList.contains("show")) return;
    clearTimeout(jumpTimer);
    jumpPill.classList.remove("show");
    if (instant || REDUCED) { jumpPill.hidden = true; return; }
    jumpTimer = setTimeout(function () {
      if (!jumpPill.classList.contains("show")) jumpPill.hidden = true;
    }, 200);
  }

  chatScroll.addEventListener("scroll", function () {
    if (isNearBottom()) {
      awayBase = -1;
      hideJump();
      return;
    }
    if (awayBase === -1) {
      var chat = getChat(activeId);
      awayBase = chat ? chat.messages.length : 0;
    }
    updateJumpPill();
  });

  function updateJumpPill() {
    if (awayBase === -1) { hideJump(); return; }
    var chat = getChat(activeId);
    var n = chat ? Math.max(0, chat.messages.length - awayBase) : 0;
    jumpPill.querySelector("span").textContent = n > 0 ? n + " new" : "Latest";
    showJump();
  }

  jumpPill.addEventListener("click", function () {
    awayBase = -1;
    hideJump();
    if (REDUCED || !chatScroll.scrollTo) { scrollBottom(); return; }
    try { chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: "smooth" }); }
    catch (e) { scrollBottom(); }
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
      { icon: "download", title: "Export chats", hint: "JSON backup", run: function () { doExportJSON(); } },
      { icon: "book-marked", title: "Prompt library", hint: "Save and reuse prompts", run: function () { openSettings("prompts"); } },
      { icon: "bar-chart-3", title: "Usage", hint: "Replies, tokens, cost", run: function () { openSettings("usage"); } },
      { icon: "sliders-horizontal", title: "Chat settings", hint: "System prompt and sampling", run: function () { $("chatParamsBtn").click(); } },
      { icon: "keyboard", title: "Keyboard shortcuts", hint: "The full list", run: function () { openShortcuts(); } }
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
    /* Palette is Ctrl/Cmd + Shift + P. Ctrl/Cmd + K belongs to chat search
       (one handler further down); two launchers on one key was a fight. */
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "p" || e.key === "P")) {
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
      if (motionOK()) {
        try {
          copyBtn.style.transition = "none";
          play({
            targets: copyBtn,
            scale: [0.85, 1],
            duration: 230,
            ease: EZ("outExpo"),
            onComplete: function () { copyBtn.style.transition = ""; }
          });
        } catch (e) { copyBtn.style.transition = ""; }
      }
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
      var grid = row.querySelector(".sources-grid");
      var head = row.querySelector(".sources-head");
      if (grid) {
        grid.classList.toggle("closed");
        var isOpen = !grid.classList.contains("closed");
        if (head) {
          head.classList.toggle("open", isOpen);
          head.setAttribute("aria-expanded", isOpen ? "true" : "false");
        }
      }
    } else if (act === "speak") {
      speakRow(row, msg.content);
    } else if (act === "copy") {
      copyText(msg.content, "Copied to clipboard");
      flashCopied(btn);
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
      if (acts) acts.outerHTML = actionsHtml(msg, false, chat.model);
      refreshIcons();
    } else if (act === "edit") {
      if (stream) return;
      if (msg.role !== "user") return;
      startEditUser(chat, row, idx, msg);
    } else if (act === "retry") {
      if (stream || regenBusy) return;
      fadeRegen(row, function () {
        prepRegen(chat, msg);
        routeSend(chat, prevUserText(chat, idx), idx);
      });
    } else if (act === "retryas") {
      if (stream || regenBusy) return;
      renderRetryMenu(chat, msg, idx, row, btn);
    } else if (act === "editasst") {
      if (stream) return;
      startEditAssistant(chat, row, idx, msg);
    }
  });

  /* Regenerate with a different model: a small menu of the other providers. */
  function renderRetryMenu(chat, msg, idx, row, trigger) {
    var list = $("retryMenuList");
    if (!list) return;
    list.innerHTML = "";
    var current = msg.variantsMeta && msg.variantsMeta[msg.variantsMeta.length - 1];
    state.providers.forEach(function (p) {
      if (!activeModelOf(p)) return;
      if (current && current.model === providerDisplay(p)) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pop-item";
      b.setAttribute("role", "menuitem");
      b.innerHTML = '<i data-lucide="cpu"></i><span></span><em></em>';
      b.querySelector("span").textContent = p.label;
      b.querySelector("em").textContent = activeModelOf(p);
      b.addEventListener("click", function () {
        hidePop(true);
        if (stream || regenBusy) return;
        var model = activeModelOf(p);
        fadeRegen(row, function () {
          prepRegen(chat, msg, providerDisplay(p));
          routeSend(chat, prevUserText(chat, idx), idx, p);
        });
      });
      list.appendChild(b);
    });
    if (!list.children.length) {
      var p0 = document.createElement("p");
      p0.className = "search-empty";
      p0.textContent = "No other providers are ready.";
      list.appendChild(p0);
    }
    refreshIcons();
    showPop($("retryMenu"), trigger, { side: "top", align: "start" });
  }

  /* Fix or adjust an assistant reply in place. Saved as the active variant. */
  function startEditAssistant(chat, row, idx, msg) {
    var body = row.querySelector(".msg-body");
    if (!body || row.querySelector(".edit-box")) return;
    var box = document.createElement("div");
    box.className = "edit-box";
    box.innerHTML = '<textarea aria-label="Edit reply"></textarea><div class="edit-row"><button type="button" class="btn small" data-e="cancel">Cancel</button><button type="button" class="btn small primary" data-e="save">Save</button></div>';
    var ta = box.querySelector("textarea");
    ta.value = msg.content || "";
    body.replaceWith(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    function grow() { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 300) + "px"; }
    ta.addEventListener("input", grow);
    grow();
    function commit() {
      var v = ta.value.trim();
      if (v && v !== msg.content) {
        ensureVariants(msg);
        msg.variants[msg.vi] = v;
        msg.content = v;
        chat.updatedAt = Date.now();
        save();
      }
      renderMessages();
    }
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-e]");
      if (!b) return;
      if (b.dataset.e === "save") commit();
      else renderMessages();
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      if (e.key === "Escape") renderMessages();
    });
  }

  /* ---------- composer ---------- */

  function autogrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  function updateTokEst() {
    var el = $("tokEst");
    var chars = input.value.length;
    var imgs = pendingImages.length;
    if (!chars && !imgs) { el.hidden = true; } else {
      var est = Math.round(chars / 4) + imgs * 1000;
      el.hidden = false;
      el.textContent = "\u2248" + (est >= 1000 ? (est / 1000).toFixed(1) + "k" : est);
      el.classList.toggle("large", est > 30000);
      el.title = est > 30000 ? "Large message. Some models may refuse it." : "Estimated tokens";
    }
    updateCtxMeter();
  }

  /* Context meter as a thin ring around the send button: how much of the
     model window the next request would take, history included. */
  var RING_C = 2 * Math.PI * 20; /* r=20 in the 44x44 viewBox */
  function updateCtxMeter() {
    var ring = $("sendRing");
    if (!ring) return;
    var F = window.ImposeFeatures;
    var t = getTarget();
    var chat = getChat(activeId);
    if (!F || !t || !chat || (!chat.messages.length && !input.value)) { ring.setAttribute("hidden", ""); return; }
    var hist = historyFor(chat.messages, t.provider.kind || "openai", t.model);
    var used = 600; /* system prompt, roughly */
    hist.forEach(function (m) {
      used += F.estimateTokens(typeof m.content === "string" ? m.content : "", m.images);
    });
    used += F.estimateTokens(input.value, pendingImages);
    var ctx = F.modelContext(t.model);
    var pct = Math.min(100, Math.round(used / ctx * 100));
    /* NB: #sendRing is an <svg>; SVGElement has no hidden IDL attribute, so
       ring.hidden = false would only set an expando and the [hidden] CSS rule
       would keep it display:none forever. Toggle the content attribute. */
    if (pct < 4) ring.setAttribute("hidden", ""); else ring.removeAttribute("hidden");
    var fill = $("sendRingFill");
    if (fill) {
      fill.style.strokeDasharray = RING_C.toFixed(1);
      fill.style.strokeDashoffset = (RING_C * (1 - pct / 100)).toFixed(1);
      ring.classList.toggle("warn", pct >= 60 && pct < 85);
      ring.classList.toggle("danger", pct >= 85);
    }
    $("sendBtn").title = "Send message. About " +
      (used >= 1000 ? (used / 1000).toFixed(1) + "k" : used) + " of " +
      (ctx >= 1000 ? (ctx / 1000) + "k" : ctx) + " tokens (" + pct + "%)";
  }

  var sendWasDisabled = true;
  function syncSend() {
    var dis = input.value.trim().length === 0;
    sendBtn.disabled = dis;
    if (sendWasDisabled && !dis && motionOK() && !sendBtn.hidden) {
      try {
        sendBtn.style.transition = "none";
        play({
          targets: sendBtn,
          scale: [0.8, 1],
          duration: 230,
          ease: EZ("outExpo"),
          onComplete: function () { sendBtn.style.transition = ""; }
        });
      } catch (e) { sendBtn.style.transition = ""; }
    }
    sendWasDisabled = dis;
    updateTokEst();
  }

  input.addEventListener("input", function () { autogrow(); syncSend(); updateSlashPop(); });

  input.addEventListener("keydown", function (e) {
    if (slashActive()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        slashHot = e.key === "ArrowDown"
          ? (slashHot + 1) % slashItems.length
          : (slashHot - 1 + slashItems.length) % slashItems.length;
        var rows = $("slashList").querySelectorAll(".slash-row");
        rows.forEach(function (r, k) { r.classList.toggle("hot", k === slashHot); });
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); pickSlash(slashHot); return; }
      if (e.key === "Escape") { hideSlash(); return; }
    }
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
    warmRelay();
  }

  function pulseModelLabel() {
    var lab = $("modelName");
    if (!lab) return;
    play({ targets: lab, opacity: [0, 1], translateY: [5, 0], duration: 240, ease: EZ("outCubic") });
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
      toast.success("Switched to demo replies");
      pulseModelLabel();
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
    toast.success("Switched to " + providerDisplay(p));
    pulseModelLabel();
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
        if (f.size > 200 * 1024) { resolve({ name: f.name, error: "over 200KB" }); return; }
        var r = new FileReader();
        r.onload = function () {
          var text = String(r.result || "");
          if (/\u0000/.test(text)) resolve({ name: f.name, error: "not a text file" });
          else resolve({ name: f.name, text: text.slice(0, 200 * 1024), truncated: text.length >= 200 * 1024 && f.size > text.length });
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
          var head = "File: " + o.name + (o.truncated ? " (first 200KB)" : "");
          return head + "\n```\n" + o.text.trim() + "\n```";
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
      return (m.role === "user" ? "You: " : "Impose: ") + m.content;
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
      lines.push(m.role === "user" ? "You:" : "Impose:");
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

  /* Search every message, newest first, not just the title and the last
     thing the user said. Returns the chat plus where the hit lives, so the
     result can show real context and the app can jump to the message. */
  function chatMatch(c, q) {
    var msgs = c.messages || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      var text = typeof (msgs[i] && msgs[i].content) === "string" ? msgs[i].content : "";
      if (!text) continue;
      var at = text.toLowerCase().indexOf(q);
      if (at === -1) continue;
      var start = Math.max(0, at - 40);
      var end = Math.min(text.length, at + q.length + 60);
      var snip = text.slice(start, end).replace(/\s+/g, " ").trim();
      return { c: c, mi: i, snippet: (start > 0 ? "\u2026" : "") + snip + (end < text.length ? "\u2026" : "") };
    }
    if (c.title.toLowerCase().indexOf(q) > -1) return { c: c, mi: -1, snippet: snippetFor(c) };
    return null;
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    var sorted = state.chats.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    if (!q) {
      searchMatches = sorted.slice(0, 12).map(function (c) { return { c: c, mi: -1, snippet: snippetFor(c) }; });
    } else {
      searchMatches = [];
      for (var i = 0; i < sorted.length && searchMatches.length < 12; i++) {
        var m = chatMatch(sorted[i], q);
        if (m) searchMatches.push(m);
      }
    }
    searchHot = 0;
    renderSearchResults();
  }

  function openSearchMatch(match) {
    closeModal(searchModal);
    openChat(match.c.id);
    if (match.mi == null || match.mi < 0) return;
    setTimeout(function () {
      var row = messagesEl.querySelector('.msg[data-i="' + match.mi + '"]');
      if (!row) return;
      if (row.scrollIntoView) row.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
      row.classList.add("flash");
      setTimeout(function () { row.classList.remove("flash"); }, 1400);
    }, 80);
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
    searchMatches.forEach(function (m, i) {
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
      t.textContent = m.c.title;
      var s = document.createElement("em");
      s.textContent = (m.snippet || "").replace(/\s+/g, " ").slice(0, 90);
      wrap.appendChild(t);
      wrap.appendChild(s);
      row.appendChild(wrap);
      row.addEventListener("click", function () {
        openSearchMatch(m);
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
      var m = searchMatches[searchHot];
      if (m) openSearchMatch(m);
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
    $("tglRedact").setAttribute("aria-checked", state.settings.redactPII ? "true" : "false");
    $("tglFollow").setAttribute("aria-checked", state.settings.followupsSmart ? "true" : "false");
    $("tglAutoName").setAttribute("aria-checked", state.settings.autoName ? "true" : "false");
    $("retentionSel").value = String(state.settings.retentionDays || 0);
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
    if (name === "usage") renderUsage();
    if (name === "prompts") renderLibrary();
    if (name === "providers") renderRelayCard();
  }

  /* First-run onboarding: once, and only for people with nothing set up. */
  function maybeOnboard() {
    var KEY = "impose.onboarded.v1";
    var seen = false;
    try { seen = localStorage.getItem(KEY) === "1"; } catch (e) { /* private mode */ }
    if (seen || state.providers.length) return;
    var m = $("onboardModal");
    if (!m) return;
    function remember() { try { localStorage.setItem(KEY, "1"); } catch (e) { /* private mode */ } }
    $("onboardAdd").addEventListener("click", function () {
      remember();
      closeModal(m);
      openSettings("providers");
    });
    $("onboardSkip").addEventListener("click", function () {
      remember();
      closeModal(m);
    });
    m.addEventListener("pointerdown", function (e) {
      if (e.target === m) { remember(); closeModal(m); }
    });
    setTimeout(function () {
      openModal(m);
      refreshIcons();
    }, 350);
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
  wireToggle("tglRedact", "redactPII");
  wireToggle("tglFollow", "followupsSmart");
  wireToggle("tglAutoName", "autoName");

  $("retentionSel").addEventListener("change", function () {
    var days = +$("retentionSel").value || 0;
    state.settings.retentionDays = days;
    save();
    if (days > 0) applyRetention(true);
    dnote("app", "Retention set to " + (days || "off"));
  });

  /* Delete chats older than the retention window. Pinned chats survive. */
  function applyRetention(manual) {
    var days = +state.settings.retentionDays || 0;
    if (!days) return;
    var out = window.ImposeFeatures.pruneChats(state.chats, days);
    if (out.removed.length) {
      state.chats = out.kept;
      if (activeId && !getChat(activeId)) { activeId = null; showEmpty(); }
      save();
      renderList();
      toast(out.removed.length + " chat" + (out.removed.length === 1 ? "" : "s") + " removed by the " + days + " day retention rule.");
      dnote("app", "Retention removed " + out.removed.length + " chats");
    } else if (manual) {
      toast("Nothing older than " + days + " days to remove.");
    }
  }

  $("searchBtn").addEventListener("click", function () {
    showPop($("toolMenu"), $("searchBtn"), { side: "top", align: "end" });
  });

  function syncToolMenu() {
    var web = !!state.settings.searchMode;
    $("toolWeb").setAttribute("aria-checked", web ? "true" : "false");
  }

  function toggleTool(setting, btn) {
    state.settings[setting] = !state.settings[setting];
    save();
    syncToolMenu();
    if (setting === "searchMode" && state.settings.searchMode) warmRelay();
    dnote("chat", (btn || setting) + " " + (state.settings[setting] ? "on" : "off"));
  }
  $("toolWeb").addEventListener("click", function () { toggleTool("searchMode", "web-search"); });
  $("toolAttach").addEventListener("click", function () {
    hidePop(true);
    filePicker.click();
  });
  [["toolImgGen", "Image generation"], ["toolVidGen", "Video generation"], ["toolGit", "Code x Git"]].forEach(function (pair) {
    $(pair[0]).addEventListener("click", function () {
      toast(pair[1] + " is coming soon.");
    });
  });

  $("settingsClose").addEventListener("click", function () { closeModal(settingsModal); });
  settingsModal.addEventListener("pointerdown", function (e) {
    if (e.target === settingsModal) closeModal(settingsModal);
  });

  /* ---------- feedback (opens the maker's email) ---------- */

  var FEEDBACK_TO = "rfarouq69@gmail.com";
  var feedbackModal = $("feedbackModal");
  var fbType = "Bug report";

  $("feedbackType").addEventListener("click", function (e) {
    var b = e.target.closest("[data-fb]");
    if (!b) return;
    fbType = b.getAttribute("data-fb");
    var btns = $("feedbackType").querySelectorAll("[data-fb]");
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute("aria-pressed", btns[i] === b ? "true" : "false");
  });

  function fbContextLine() {
    return "Impose 1.2 · " + (state.settings.theme || "dark") + " theme · " + (activeProvider() ? "provider mode" : "demo mode");
  }

  function fbDraft() {
    var summary = $("fbSummary").value.trim() || "(no summary)";
    var details = $("fbDetails").value.trim() || "(no details)";
    return { subject: "[" + fbType + "] " + summary, body: details + "\n\n---\n" + fbContextLine() };
  }

  function openFeedback() {
    $("fbContext").textContent = "Sends to " + FEEDBACK_TO + " · " + fbContextLine();
    openModal(feedbackModal);
    setTimeout(function () { $("fbSummary").focus(); }, 250);
  }

  $("feedbackBtn").addEventListener("click", openFeedback);
  $("feedbackClose").addEventListener("click", function () { closeModal(feedbackModal); });
  feedbackModal.addEventListener("pointerdown", function (e) {
    if (e.target === feedbackModal) closeModal(feedbackModal);
  });
  $("fbSend").addEventListener("click", function () {
    var d = fbDraft();
    window.location.href = "mailto:" + FEEDBACK_TO + "?subject=" + encodeURIComponent(d.subject) + "&body=" + encodeURIComponent(d.body);
    closeModal(feedbackModal);
    toast("Opening your email app with the report addressed.");
  });
  $("fbCopy").addEventListener("click", function () {
    var d = fbDraft();
    copyText(d.subject + "\n\n" + d.body, "Feedback copied to clipboard");
  });

  /* ---------- agent actions via the companion extension ---------- */

  var EXT_TIMEOUT = 25000;
  var extSeq = 0;
  var extPending = {};
  var ext = { connected: false, version: "", tabs: [], tabId: 0, threadUrl: "", snapshot: "", log: [] };

  try {
    var savedActions = JSON.parse(localStorage.getItem("impose.actions.v1") || localStorage.getItem("nova.actions.v1") || "[]");
    if (Array.isArray(savedActions)) ext.log = savedActions.slice(-30);
  } catch (e) { ext.log = []; }

  function extSaveLog() {
    try { localStorage.setItem("impose.actions.v1", JSON.stringify(ext.log.slice(-30))); localStorage.removeItem("nova.actions.v1"); } catch (e) { /* noop */ }
  }

  function renderExtLog() {
    var box = $("extLog");
    if (!box) return;
    box.innerHTML = "";
    if (!ext.log.length) { box.textContent = "No actions yet."; return; }
    ext.log.slice(-8).reverse().forEach(function (e) {
      var d = document.createElement("div");
      d.className = "al";
      var t = new Date(e.ts || Date.now());
      var s = document.createElement("strong");
      s.textContent = (e.ok === false ? "\u2717 " : "\u2713 ") + e.action + " \u00b7 " +
        ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2) + " ";
      var sp = document.createElement("span");
      sp.textContent = e.detail || "";
      d.appendChild(s);
      d.appendChild(sp);
      box.appendChild(d);
    });
  }

  function extLog(action, detail, ok) {
    ext.log.push({ ts: Date.now(), action: action, detail: String(detail || "").slice(0, 200), ok: ok !== false });
    ext.log = ext.log.slice(-30);
    extSaveLog();
    renderExtLog();
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin) return;
    var m = e.data;
    if (!m || m.src !== "impose-ext" || !m.id || !extPending[m.id]) return;
    var p = extPending[m.id];
    delete extPending[m.id];
    clearTimeout(p.timer);
    if (m.ok) p.resolve(("result" in m) ? m.result : m);
    else p.reject(new Error(m.error || "Extension error."));
  });

  function extSend(method, params) {
    return new Promise(function (resolve, reject) {
      var id = "x" + (++extSeq);
      var timer = setTimeout(function () {
        delete extPending[id];
        reject(new Error("Extension did not answer. Is it installed and enabled?"));
      }, EXT_TIMEOUT);
      if (timer.unref) { try { timer.unref(); } catch (e) { /* browsers lack unref */ } }
      extPending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.postMessage({ src: "impose-page", id: id, method: method, params: params || {} }, location.origin);
    });
  }

  function setExtStatus(connected, title, sub) {
    ext.connected = connected;
    $("extDot").hidden = !connected;
    $("extDotLg").classList.toggle("off", !connected);
    $("extStatusTitle").textContent = title;
    $("extStatusSub").textContent = sub;
    $("extMain").hidden = !connected;
    $("extSetup").hidden = connected;
  }

  function extPing(silent) {
    return extSend("ping").then(function (r) {
      ext.version = (r && r.version) || "";
      setExtStatus(true, "Extension connected", "Bridge v" + ext.version + " \u00b7 protocol 1");
      return true;
    }, function (err) {
      setExtStatus(false, "Extension not connected",
        silent ? "Install the Impose bridge to act in your tabs." : String((err && err.message) || err));
      return false;
    });
  }

  function setExtBusy(busy) {
    ["extTabsBtn", "extReadBtn", "extThreadsBtn", "extProbeBtn", "extDraftBtn", "extSendBtn", "extPasteDraft"].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = busy;
    });
  }

  function refreshExtTabs() {
    setExtBusy(true);
    extSend("tabs.list").then(function (r) {
      setExtBusy(false);
      ext.tabs = (r && r.tabs) || [];
      var sel = $("extTabs");
      sel.innerHTML = "";
      if (!ext.tabs.length) {
        sel.appendChild(new Option("No X tabs open", ""));
        ext.tabId = 0;
        toast("Open x.com in a tab first, then press Tabs.");
        return;
      }
      ext.tabs.forEach(function (t) {
        sel.appendChild(new Option(String(t.title || t.url || "X tab").slice(0, 60), String(t.tabId)));
      });
      if (!ext.tabs.some(function (t) { return t.tabId === ext.tabId; })) ext.tabId = ext.tabs[0].tabId;
      sel.value = String(ext.tabId);
    }, function (err) {
      setExtBusy(false);
      toast.error("Tab list failed: " + err.message);
    });
  }

  function needTab() {
    if (ext.tabId) return true;
    toast("Pick an X tab first.");
    return false;
  }

  function extRead() {
    if (!needTab()) return;
    setExtBusy(true);
    extSend("snapshot", { tabId: ext.tabId }).then(function (r) {
      setExtBusy(false);
      ext.snapshot = (r && r.text) || "";
      $("extSnap").textContent = ext.snapshot || "(the page returned no text)";
      $("extSnapWrap").open = true;
      extLog("read", (r && r.url) || "tab", true);
      dnote("ext", "Snapshot read from tab " + ext.tabId);
    }, function (err) {
      setExtBusy(false);
      toast.error("Read failed: " + err.message);
      extLog("read", err.message, false);
    });
  }

  function extThreads() {
    if (!needTab()) return;
    setExtBusy(true);
    extSend("dm.list", { tabId: ext.tabId }).then(function (r) {
      setExtBusy(false);
      var box = $("extThreads");
      box.innerHTML = "";
      var list = (r && r.threads) || [];
      if (!list.length) {
        box.textContent = "No threads found. Open x.com/messages in that tab first.";
        return;
      }
      list.forEach(function (th) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "thread-row" + (th.url === ext.threadUrl ? " chosen" : "");
        var s = document.createElement("strong");
        s.textContent = th.name || "(no name)";
        var sp = document.createElement("span");
        sp.textContent = th.snippet || "";
        b.appendChild(s);
        b.appendChild(sp);
        b.addEventListener("click", function () {
          ext.threadUrl = th.url;
          $("extTarget").textContent = "Target thread: " + th.url;
          var rows = box.querySelectorAll(".thread-row");
          for (var i = 0; i < rows.length; i++) rows[i].classList.toggle("chosen", rows[i] === b);
        });
        box.appendChild(b);
      });
      extLog("threads", list.length + " found", true);
    }, function (err) {
      setExtBusy(false);
      toast.error("Threads failed: " + err.message);
      extLog("threads", err.message, false);
    });
  }

  function extProbe() {
    if (!needTab()) return;
    setExtBusy(true);
    extSend("probe", { tabId: ext.tabId }).then(function (r) {
      setExtBusy(false);
      r = r || {};
      if (r.loggedOut) {
        toast("That tab is logged out. Log in to X there first.");
        extLog("probe", "logged out", false);
        return;
      }
      var bits = "composer " + (r.composer ? "seen" : "missing") + ", send " +
        (r.send ? "seen" : "missing") + ", " + (r.threads || 0) + " threads";
      toast("Page check: " + bits + ".");
      dnote("ext", "Probe tab " + ext.tabId + ": " + bits);
      extLog("probe", bits, !!(r.composer && r.send));
    }, function (err) {
      setExtBusy(false);
      toast.error("Check failed: " + err.message);
      extLog("probe", err.message, false);
    });
  }

  function draftReply(convo, instr) {
    var t = getTarget();
    if (!t) { toast("Add a provider first: drafting needs a model."); return null; }
    return completeOnce(t.provider, t.model, [{ role: "user", content:
      "You are helping reply to a DM conversation on X. Read the conversation, follow the instruction, " +
      "and output ONLY the reply text: no quotes, no commentary, no placeholders.\n\nConversation:\n" +
      String(convo).slice(0, 3500) + "\n\nInstruction: " + (instr || "Reply helpfully and briefly.") }]);
  }

  function extDraft() {
    if (!ext.snapshot) { toast("Read the page first so Impose can see the conversation."); return; }
    var instr = $("extInstr").value.trim();
    var p = draftReply(ext.snapshot, instr);
    if (!p) return;
    setExtBusy(true);
    extLog("draft", instr || "Reply helpfully and briefly.", true);
    p.then(function (text) {
      setExtBusy(false);
      $("extReply").value = String(text || "").trim();
      if (!$("extReply").value) toast.error("The draft came back empty. Try again.");
    }, function (err) {
      setExtBusy(false);
      toast.error("Draft failed: " + String((err && err.message) || err));
    });
  }

  function pasteDraft() {
    var convo = $("extPaste").value.trim();
    if (!convo) { toast("Paste the conversation first."); return; }
    var p = draftReply(convo, $("extPasteInstr").value.trim());
    if (!p) return;
    setExtBusy(true);
    p.then(function (text) {
      setExtBusy(false);
      $("extPasteOut").value = String(text || "").trim();
      if (!$("extPasteOut").value) toast.error("The draft came back empty. Try again.");
    }, function (err) {
      setExtBusy(false);
      toast.error("Draft failed: " + String((err && err.message) || err));
    });
  }

  var sendArmed = false;
  var sendArmTimer = 0;
  function disarmSend() {
    sendArmed = false;
    clearTimeout(sendArmTimer);
    var btn = $("extSendBtn");
    btn.classList.remove("armed");
    btn.querySelector("span").textContent = "Send via extension";
  }

  function extSendReply() {
    var text = $("extReply").value.trim();
    if (!text) { toast("Write the reply first."); return; }
    if (!needTab()) return;
    if (!sendArmed) {
      sendArmed = true;
      var btn = $("extSendBtn");
      btn.classList.add("armed");
      btn.querySelector("span").textContent = "Tap again to send";
      clearTimeout(sendArmTimer);
      sendArmTimer = setTimeout(disarmSend, 6000);
      toast("Review the exact text above, then tap again to send.");
      return;
    }
    disarmSend();
    setExtBusy(true);
    extLog("send", (ext.threadUrl || "current thread") + " \u00b7 " + text.slice(0, 80), true);
    extSend("dm.send", { tabId: ext.tabId, threadUrl: ext.threadUrl || undefined, text: text }).then(function (r) {
      setExtBusy(false);
      if (r && r.sent) {
        toast.success("Sent via the extension.");
        dnote("ext", "dm.send ok");
        $("extReply").value = "";
      } else {
        var why = (r && r.error) || "unknown reason";
        toast.error("Not sent: " + why);
        extLog("send", "failed: " + why, false);
      }
    }, function (err) {
      setExtBusy(false);
      toast.error("Send failed: " + err.message);
      extLog("send", err.message, false);
    });
  }

  var actionsModal = $("actionsModal");
  function openActions() {
    renderExtLog();
    openModal(actionsModal);
    extPing(true).then(function (ok) { if (ok) refreshExtTabs(); });
  }
  $("actionsBtn").addEventListener("click", openActions);
  $("actionsClose").addEventListener("click", function () { closeModal(actionsModal); });
  actionsModal.addEventListener("pointerdown", function (e) {
    if (e.target === actionsModal) closeModal(actionsModal);
  });
  $("extPingBtn").addEventListener("click", function () {
    extPing(false).then(function (ok) { if (ok) refreshExtTabs(); });
  });
  $("extTabsBtn").addEventListener("click", refreshExtTabs);
  $("extTabs").addEventListener("change", function () { ext.tabId = +$("extTabs").value || 0; });
  $("extReadBtn").addEventListener("click", extRead);
  $("extThreadsBtn").addEventListener("click", extThreads);
  $("extProbeBtn").addEventListener("click", extProbe);
  $("extDraftBtn").addEventListener("click", extDraft);
  $("extPasteDraft").addEventListener("click", pasteDraft);
  $("extPasteCopy").addEventListener("click", function () {
    var v = $("extPasteOut").value.trim();
    if (!v) { toast("Nothing to copy yet."); return; }
    copyText(v, "Draft copied. Paste it into your X app.");
  });
  $("extSendBtn").addEventListener("click", extSendReply);
  renderExtLog();
  extPing(true);

  function doExportJSON() {
    var blob = new Blob([JSON.stringify({ chats: state.chats, folders: state.folders }, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "impose-chats.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    dnote("app", "Chats exported");
    toast.success("Chats exported");
  }

  $("exportBtn").addEventListener("click", doExportJSON);

  $("importBtn").addEventListener("click", function () { $("importPicker").click(); });
  var pendingEnc = null;

  function applyImportData(data) {
    if (!data || !Array.isArray(data.chats)) throw new Error("bad file");
        var have = {};
        state.chats.forEach(function (c) { have[c.id] = true; });
        var added = 0;
        var droppedImages = 0;
        data.chats.forEach(function (c) {
          if (!c || !c.id || have[c.id] || !Array.isArray(c.messages)) return;
          have[c.id] = true;
          if (!Array.isArray(c.excluded)) c.excluded = [];
          c.excluded = c.excluded.map(function (d) { return String(d || "").slice(0, 120); });
          c.title = String(c.title || "Imported chat").slice(0, 80);
          c.messages.forEach(function (m) {
            if (!m) return;
            if (typeof m.content !== "string") m.content = "";
            if (m.images && m.images.length) {
              var before = m.images.length;
              m.images = safeImageUrls(m.images);
              droppedImages += before - m.images.length;
              if (!m.images.length) delete m.images;
            }
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
    if (droppedImages) toast.warn(droppedImages + " attached image" + (droppedImages === 1 ? "" : "s") + " skipped: not valid image data.");
    dnote("app", "Imported " + added + " chats, skipped " + droppedImages + " bad images");
    return added;
  }

  $("importPicker").addEventListener("change", function () {
    var f = $("importPicker").files && $("importPicker").files[0];
    $("importPicker").value = "";
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      var data;
      try { data = JSON.parse(String(r.result || "")); }
      catch (e) { toast.error("That file is not a Impose backup."); return; }
      if (data && data.format === "impose-encrypted-v1") {
        pendingEnc = data;
        openEncModal("decrypt");
        return;
      }
      try { applyImportData(data); }
      catch (e) { toast.error("That file is not a Impose backup."); }
    };
    r.readAsText(f);
  });

  /* ---------- encrypted backup ---------- */

  function openEncModal(mode) {
    $("encTitle").textContent = mode === "decrypt" ? "Unlock encrypted backup" : "Create encrypted backup";
    $("encPass").value = "";
    $("encPass2").value = "";
    $("encPass2Row").hidden = mode === "decrypt";
    $("encGo").textContent = mode === "decrypt" ? "Import" : "Export";
    $("encStatus").textContent = "";
    $("encModal").__mode = mode;
    openModal($("encModal"));
    setTimeout(function () { $("encPass").focus(); }, 200);
  }

  $("encExportBtn").addEventListener("click", function () { openEncModal("encrypt"); });
  $("encCancel").addEventListener("click", function () { closeModal($("encModal")); });
  $("encGo").addEventListener("click", function () {
    var mode = $("encModal").__mode;
    var pass = $("encPass").value;
    var st = $("encStatus");
    if (mode === "encrypt" && $("encPass2").value !== pass) {
      st.textContent = "The two passphrases do not match.";
      return;
    }
    if (mode === "encrypt" && pass.length < 8) {
      st.textContent = "Use a passphrase of at least 8 characters. There is no recovery without it.";
      return;
    }
    st.textContent = "Working...";
    var promise;
    if (mode === "encrypt") {
      promise = window.ImposeFeatures.encryptExport(
        { chats: state.chats, folders: state.folders, library: state.library || [], memories: state.memories || [] }, pass
      ).then(function (blob) {
        downloadBlob(new Blob([JSON.stringify(blob, null, 2)], { type: "application/json" }), "impose-chats-encrypted.json");
        closeModal($("encModal"));
        toast.success("Encrypted backup downloaded. The passphrase is not stored anywhere.");
      });
    } else {
      promise = window.ImposeFeatures.decryptExport(pendingEnc, pass).then(function (data) {
        closeModal($("encModal"));
        pendingEnc = null;
        return applyImportData(data);
      });
    }
    promise.then(null, function (err) {
      st.textContent = String((err && err.message) || err).indexOf("decrypt") > -1 || /bad|Malformed|not an encrypted/i.test(String(err))
        ? "Wrong passphrase or damaged file."
        : String((err && err.message) || err);
      dfail("crypto", String((err && err.message) || err));
    });
  });

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

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
    $("pfPriceIn").value = existing && existing.priceIn !== "" && existing.priceIn != null ? existing.priceIn : "";
    $("pfPriceOut").value = existing && existing.priceOut !== "" && existing.priceOut != null ? existing.priceOut : "";
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
      help.textContent = "Gemini speaks its own shape. Impose handles that for you.";
      help.hidden = false;
    } else if (edKind === "anthropic") {
      help.textContent = "Anthropic speaks its own shape. Impose handles that for you.";
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
        edEditing.priceIn = parseFloat($("pfPriceIn").value) || "";
        edEditing.priceOut = parseFloat($("pfPriceOut").value) || "";
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
          useRelay: like.useRelay,
          priceIn: parseFloat($("pfPriceIn").value) || "",
          priceOut: parseFloat($("pfPriceOut").value) || ""
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
      if (!feedbackModal.hidden) { closeModal(feedbackModal); return; }
      if (!actionsModal.hidden) { closeModal(actionsModal); return; }
    }
  });

  window.addEventListener("resize", function () {
    if (openPop) hidePop(true);
  });

  /* ---------- conversation memory ---------- */

  function renderMemory() {
    var box = $("memoryList");
    if (!box) return;
    box.innerHTML = "";
    var mems = state.memories || [];
    if (!mems.length) {
      var p = document.createElement("p");
      p.className = "pane-note";
      p.textContent = 'Nothing yet. Type "remember that ..." in a chat to store a fact.';
      box.appendChild(p);
      return;
    }
    mems.slice().reverse().forEach(function (m) {
      var row = document.createElement("div");
      row.className = "mem-row";
      var t = document.createElement("span");
      t.textContent = m.text;
      var x = document.createElement("button");
      x.type = "button";
      x.className = "icon-btn sm";
      x.setAttribute("aria-label", "Forget this");
      x.title = "Forget";
      x.innerHTML = '<i data-lucide="x"></i>';
      x.addEventListener("click", function () {
        state.memories = state.memories.filter(function (g) { return g.id !== m.id; });
        save();
        renderMemory();
      });
      row.appendChild(t);
      row.appendChild(x);
      box.appendChild(row);
    });
    refreshIcons();
  }

  function addMemoryFromInput() {
    var v = $("memoryInput").value.trim();
    if (!v) return;
    var fact = window.ImposeFeatures.memoryFromText(v) || v.slice(0, 160);
    state.memories = window.ImposeFeatures.dedupeMemory(state.memories, fact);
    save();
    $("memoryInput").value = "";
    renderMemory();
    toast("Remembered.");
  }
  $("memoryAddBtn").addEventListener("click", addMemoryFromInput);
  $("memoryInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); addMemoryFromInput(); }
  });

  /* ---------- prompt library + slash insert ---------- */

  function renderLibrary() {
    var box = $("libList");
    if (!box) return;
    box.innerHTML = "";
    if (!(state.library || []).length) {
      var p = document.createElement("p");
      p.className = "pane-note";
      p.textContent = "Save prompts you reuse. {{name}} becomes a fill in slot. Type / in the composer to insert.";
      box.appendChild(p);
    }
    (state.library || []).forEach(function (item) {
      var row = document.createElement("div");
      row.className = "lib-row";
      var txt = document.createElement("div");
      txt.className = "lib-text";
      var st = document.createElement("strong");
      st.textContent = item.title;
      var em = document.createElement("em");
      em.textContent = item.body.replace(/\s+/g, " ").slice(0, 90);
      txt.appendChild(st);
      txt.appendChild(em);
      var ins = document.createElement("button");
      ins.type = "button";
      ins.className = "pill-btn";
      ins.textContent = "Insert";
      ins.addEventListener("click", function () { insertPrompt(item.body); });
      var del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn sm";
      del.title = "Delete prompt";
      del.setAttribute("aria-label", "Delete " + item.title);
      del.innerHTML = '<i data-lucide="trash-2"></i>';
      del.addEventListener("click", function () {
        state.library = state.library.filter(function (g) { return g.id !== item.id; });
        save();
        renderLibrary();
        toast("Prompt deleted");
      });
      row.appendChild(txt);
      row.appendChild(ins);
      row.appendChild(del);
      box.appendChild(row);
    });
    refreshIcons();
  }

  function insertPrompt(body) {
    closeModal(settingsModal);
    input.value = window.ImposeFeatures.applyTemplate(body);
    autogrow();
    syncSend();
    input.focus();
    var vars = window.ImposeFeatures.extractVars(body);
    if (vars.length) toast("Fill the " + vars.map(function (v) { return "{{" + v + "}}"; }).join(" ") + " slots before sending.");
  }

  $("libSaveBtn").addEventListener("click", function () {
    var title = $("libTitle").value.trim().slice(0, 60);
    var body = $("libBody").value.trim();
    if (!title || !body) { toast.warn("Give the prompt a title and a body."); return; }
    state.library = state.library || [];
    state.library.push({ id: uid(), title: title, body: body });
    save();
    $("libTitle").value = "";
    $("libBody").value = "";
    renderLibrary();
    toast.success("Prompt saved. Type / to use it.");
  });

  /* Slash popup: type / at the start of the composer to pick a prompt. */
  var slashItems = [];
  var slashHot = 0;

  function slashActive() { return slashItems.length > 0; }

  function updateSlashPop() {
    var m = /^\/([a-z0-9_-]*)$/i.exec(input.value);
    var pop = $("slashPop");
    if (!m || !(state.library || []).length) { hideSlash(); return; }
    var q = m[1].toLowerCase();
    slashItems = state.library.filter(function (it) {
      return !q || it.title.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 6);
    if (!slashItems.length) { hideSlash(); return; }
    slashHot = 0;
    var box = $("slashList");
    box.innerHTML = "";
    slashItems.forEach(function (it, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "slash-row" + (i === slashHot ? " hot" : "");
      var st = document.createElement("strong");
      st.textContent = "/" + it.title;
      var em = document.createElement("em");
      em.textContent = it.body.replace(/\s+/g, " ").slice(0, 60);
      b.appendChild(st);
      b.appendChild(em);
      b.addEventListener("click", function () { pickSlash(i); });
      box.appendChild(b);
    });
    pop.hidden = false;
  }

  function hideSlash() {
    slashItems = [];
    var pop = $("slashPop");
    if (pop) pop.hidden = true;
  }

  function pickSlash(i) {
    var it = slashItems[i];
    hideSlash();
    if (!it) return;
    input.value = window.ImposeFeatures.applyTemplate(it.body);
    autogrow();
    syncSend();
    input.focus();
    var vars = window.ImposeFeatures.extractVars(it.body);
    if (vars.length) toast("Fill the " + vars.map(function (v) { return "{{" + v + "}}"; }).join(" ") + " slots before sending.");
  }

  /* ---------- usage dashboard ---------- */

  function renderUsage() {
    var box = $("usageTable");
    if (!box) return;
    var rows = window.ImposeFeatures.aggregateUsage(state.chats, state.providers);
    box.innerHTML = "";
    if (!rows.length) {
      var p = document.createElement("p");
      p.className = "pane-note";
      p.textContent = "No replies yet. Usage shows up here once you chat with a provider.";
      box.appendChild(p);
      return;
    }
    var totalMsgs = 0, totalToks = 0, totalCost = 0;
    var html = '<table class="usage"><thead><tr><th>Provider</th><th>Replies</th><th>≈tok</th><th>Est. cost</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      totalMsgs += r.msgs;
      totalToks += r.toks;
      totalCost += r.cost;
      html += "<tr><td>" + escapeHtml(r.label) + "</td><td>" + r.msgs + "</td><td>" +
        (r.toks >= 1000 ? (r.toks / 1000).toFixed(1) + "k" : r.toks) + "</td><td>" +
        (r.priced ? "$" + (r.cost >= 1 ? r.cost.toFixed(2) : r.cost.toFixed(4)) : "set prices") + "</td></tr>";
    });
    html += '</tbody><tfoot><tr><td>All</td><td>' + totalMsgs + "</td><td>" +
      (totalToks >= 1000 ? (totalToks / 1000).toFixed(1) + "k" : totalToks) + "</td><td>" +
      "$" + (totalCost >= 1 ? totalCost.toFixed(2) : totalCost.toFixed(4)) + "</td></tr></tfoot></table>" +
      '<p class="pane-note">Costs estimate from the per million prices you set on a provider. Providers without prices show the token count only.</p>';
    box.innerHTML = html;
  }

  /* ---------- relay status card ---------- */

  var relayCardBusy = false;

  function renderRelayCard() {
    var card = $("relayCard");
    if (!card || relayCardBusy) return;
    var cfg = relayCfg();
    var dot = card.querySelector(".relay-dot");
    var title = card.querySelector(".relay-title");
    var sub = card.querySelector(".relay-sub");
    var wake = $("relayWakeBtn");
    if (!cfg.url) {
      dot.className = "relay-dot off";
      title.textContent = "No relay connected";
      sub.textContent = "Set one under Advanced in any provider to unlock keyless search and server side requests.";
      wake.hidden = true;
      return;
    }
    wake.hidden = !cfg.key; /* waking the model is an owner move */
    dot.className = "relay-dot busy";
    title.textContent = "Checking the relay...";
    sub.textContent = stripSlash(cfg.url);
    if (!cfg.key) {
      /* Visitors: the open /health endpoint says enough. */
      fetch(stripSlash(cfg.url) + "/health", { signal: withTimeout(9000) }).then(function (r) {
        if (!r.ok) throw new Error("bad");
        return r.json();
      }).then(function (d) {
        dot.className = "relay-dot ok";
        title.textContent = d && d.gateway_up ? "Public search ready" : "Public search ready";
        sub.textContent = stripSlash(cfg.url);
      }, function () {
        dot.className = "relay-dot bad";
        title.textContent = "Relay unreachable";
        sub.textContent = stripSlash(cfg.url);
      });
      return;
    }
    var opts = { headers: { "Authorization": "Bearer " + cfg.key }, signal: withTimeout(9000) };
    fetch(stripSlash(cfg.url) + "/admin/status", opts).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(function (d) {
      var out = window.ImposeFeatures.formatRelayStatus(d);
      dot.className = "relay-dot " + (out.up ? "ok" : "bad");
      title.textContent = out.text;
      sub.textContent = stripSlash(cfg.url);
    }, function () {
      dot.className = "relay-dot bad";
      title.textContent = "Relay unreachable";
      sub.textContent = stripSlash(cfg.url);
    });
  }

  $("relayRefreshBtn").addEventListener("click", renderRelayCard);
  $("relayWakeBtn").addEventListener("click", function () {
    var cfg = relayCfg();
    if (!cfg.url) { toast("Set a relay first."); return; }
    fetch(stripSlash(cfg.url) + "/admin/wake-llm?background=1", {
      method: "POST",
      headers: { "Authorization": "Bearer " + cfg.key },
      signal: withTimeout(9000)
    }).then(function (r) {
      return r.json();
    }).then(function (d) {
      if (d && d.llm_up) toast.success("The model is already up.");
      else toast("Wake request sent. First reply lands in 1 to 3 minutes.", null, null, 4200);
      renderRelayCard();
    }, function () { toast.error("Could not reach the relay."); });
  });

  /* ---------- per chat generation settings ---------- */

  $("chatParamsBtn").addEventListener("click", function () {
    var chat = getChat(activeId);
    if (!chat) { toast("Send a message first. Chat settings live with a chat."); return; }
    var pr = chat.params || {};
    $("cpSystem").value = pr.system || "";
    $("cpTemp").value = pr.temperature == null ? "" : pr.temperature;
    $("cpTopP").value = pr.topP == null ? "" : pr.topP;
    $("cpMaxTok").value = pr.maxTokens == null ? "" : pr.maxTokens;
    openModal($("chatParamsModal"));
    setTimeout(function () { $("cpSystem").focus(); }, 200);
  });
  $("cpCancel").addEventListener("click", function () { closeModal($("chatParamsModal")); });
  $("chatParamsModal").addEventListener("pointerdown", function (e) {
    if (e.target === $("chatParamsModal")) closeModal($("chatParamsModal"));
  });
  $("cpReset").addEventListener("click", function () {
    var chat = getChat(activeId);
    if (chat) { delete chat.params; save(); }
    $("cpSystem").value = "";
    $("cpTemp").value = "";
    $("cpTopP").value = "";
    $("cpMaxTok").value = "";
    toast("Chat settings reset to defaults.");
  });
  $("cpSave").addEventListener("click", function () {
    var chat = getChat(activeId);
    if (!chat) { closeModal($("chatParamsModal")); return; }
    var F = window.ImposeFeatures;
    var params = {
      system: $("cpSystem").value.trim().slice(0, 2000),
      temperature: F.clampParam($("cpTemp").value, 0, 2),
      topP: F.clampParam($("cpTopP").value, 0, 1),
      maxTokens: $("cpMaxTok").value ? Math.max(1, Math.floor(+$("cpMaxTok").value) || 0) || null : null
    };
    if (!params.system && params.temperature == null && params.topP == null && params.maxTokens == null) {
      delete chat.params;
    } else {
      chat.params = params;
    }
    save();
    closeModal($("chatParamsModal"));
    toast.success("Chat settings saved for this chat only.");
  });

  /* ---------- keyboard shortcuts overlay ---------- */

  function openShortcuts() { openModal($("shortcutsModal")); }
  $("shortcutsClose").addEventListener("click", function () { closeModal($("shortcutsModal")); });
  $("shortcutsModal").addEventListener("pointerdown", function (e) {
    if (e.target === $("shortcutsModal")) closeModal($("shortcutsModal"));
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
    var el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    e.preventDefault();
    openShortcuts();
  });

  /* ---------- share as web page + duplicate chat ---------- */

  $("shareHtmlItem").addEventListener("click", function () {
    var id = itemMenuId;
    hidePop(true);
    var chat = id && getChat(id);
    if (!chat) return;
    var html = window.ImposeFeatures.shareChatHtml(chat);
    var base = chat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "chat";
    downloadBlob(new Blob([html], { type: "text/html" }), base + ".html");
    toast.success("Shared as a read only web page.");
  });

  $("dupItem").addEventListener("click", function () {
    var id = itemMenuId;
    hidePop(true);
    var chat = id && getChat(id);
    if (!chat) return;
    var copy = window.ImposeFeatures.duplicateChat(chat, uid());
    state.chats.unshift(copy);
    save();
    renderList();
    toast.success("Chat duplicated. Branch away.");
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
    renderMemory();
    applyRetention(false);
    maybeOnboard();
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
