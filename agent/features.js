/* Impose feature kit: the pure logic behind the smarter-chat features.
   No DOM here. The app injects storage, providers, and fetch; tests run
   this file directly under node. Same UMD shape as harness.js. */
(function () {
  "use strict";

  /* ---------- tokens and context ---------- */

  /* ~4 chars per token is the classic estimate; close enough for meters. */
  function estimateTokens(text, images) {
    var n = Math.ceil(String(text || "").length / 4);
    var imgs = images && images.length ? images.length : 0;
    return n + imgs * 1000;
  }

  /* Context windows by model family. Conservative defaults; the point is
     trimming before a 400, not squeezing the last page in. */
  function modelContext(model) {
    var m = String(model || "").toLowerCase();
    if (/gpt-5|gpt-4\.1|gpt-4o|o1|o3|o4/.test(m)) return 128000;
    if (/claude|sonnet|opus|haiku/.test(m)) return 200000;
    if (/gemini/.test(m)) return /1\.5|2\.0|2\.5/.test(m) ? 1000000 : 32000;
    if (/grok/.test(m)) return 131072;
    if (/deepseek/.test(m)) return 64000;
    if (/qwen|llama|mixtral|mistral/.test(m)) return 32000;
    return 16384;
  }

  /* Keep the newest turns that fit a token budget. Always keeps at least
     the last two messages, and never counts a lone image as skippable. */
  function trimHistory(messages, kind, budgetTokens) {
    var msgs = (messages || []).filter(function (m) {
      return m && (String(m.content || "").trim() !== "" || (m.images && m.images.length));
    });
    var budget = Math.max(1000, budgetTokens | 0);
    var out = [];
    var used = 0;
    for (var i = msgs.length - 1; i >= 0; i--) {
      var t = estimateTokens(typeof msgs[i].content === "string" ? msgs[i].content : "", msgs[i].images);
      if (used + t > budget && out.length >= 2) break;
      used += t;
      out.unshift(msgs[i]);
    }
    return out.slice(-60);
  }

  /* ---------- generation params ---------- */

  function clampParam(v, lo, hi) {
    var n = Number(v);
    if (!isFinite(n)) return null;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  /* Apply the per chat overrides to a request body, per request shape.
     Only fields the user actually set are touched. */
  function applyGenParams(body, kind, params) {
    if (!params) return body;
    var temp = params.temperature == null ? null : clampParam(params.temperature, 0, 2);
    var topP = params.topP == null ? null : clampParam(params.topP, 0, 1);
    var maxTok = params.maxTokens == null ? null : Math.max(1, Math.floor(Number(params.maxTokens) || 0)) || null;
    if (kind === "openai") {
      if (temp != null) body.temperature = temp;
      if (topP != null) body.top_p = topP;
      if (maxTok != null) body.max_tokens = maxTok;
    } else if (kind === "anthropic") {
      if (temp != null) body.temperature = temp;
      if (topP != null) body.top_p = topP;
      if (maxTok != null) body.max_tokens = maxTok; /* required field: 1024 when unset */
    } else if (kind === "gemini") {
      var cfg = {};
      if (temp != null) cfg.temperature = temp;
      if (topP != null) cfg.topP = topP;
      if (maxTok != null) cfg.maxOutputTokens = maxTok;
      if (Object.keys(cfg).length) body.generationConfig = cfg;
    }
    return body;
  }

  /* ---------- system prompt assembly ---------- */

  function memoryBlock(memories, cap) {
    var list = (memories || []).slice(-8);
    if (!list.length) return "";
    var lines = [];
    var used = 0;
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i].text || "").trim().slice(0, 160);
      if (!t) continue;
      if (used + t.length > (cap || 1000)) break;
      used += t.length;
      lines.push("- " + t);
    }
    return lines.length ? "\n\nThings to remember about the user:\n" + lines.join("\n") : "";
  }

  function buildSystem(base, chatSystem, memories) {
    var out = String(base || "");
    var extra = String(chatSystem || "").trim();
    if (extra) out += "\n\nThe user set these standing instructions for this chat: " + extra;
    out += memoryBlock(memories);
    return out;
  }

  /* ---------- vision ---------- */

  function visionCapable(model) {
    var m = String(model || "").toLowerCase();
    return /gpt-4|gpt-5|o3|o4|chatgpt|claude|gemini|pixtral|vision|vl|llava|multimodal|omni/.test(m);
  }

  /* ---------- PII redaction ---------- */

  function luhn_ok(digits) {
    var s = String(digits);
    if (!/^\d+$/.test(s)) return false;
    var sum = 0;
    var alt = false;
    for (var i = s.length - 1; i >= 0; i--) {
      var d = +s[i];
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /* Masks personal identifiers before a message leaves the device.
     Conservative on purpose: it is worse to mangle a legitimate number
     than to miss one. Each pattern gets its own replacer so capture group
     positions never blur. Returns the new text and what it changed. */
  function redactPII(text) {
    var t = String(text || "");
    var found = [];
    /* emails */
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, function (m) {
      found.push("email");
      return "[email]";
    });
    /* cards: 13 to 19 digits with spaces or dashes, Luhn checked */
    t = t.replace(/\b(?:\d[ -]?){13,19}\b/g, function (m) {
      if (!luhn_ok(m.replace(/[ -]/g, ""))) return m;
      found.push("card");
      return "[card]";
    });
    /* BVN and NIN: the keyword names the 11 digit run, so only the digits go */
    t = t.replace(/\b(?:bvn|bank verification number)[ \t.:]{0,3}\d{11}\b/gi, function (m) {
      found.push("bvn");
      return m.replace(/\d{11}/, "[bvn]");
    });
    t = t.replace(/\b(?:nin|national identification number)[ \t.:]{0,3}\d{11}\b/gi, function (m) {
      found.push("nin");
      return m.replace(/\d{11}/, "[nin]");
    });
    /* phones: Nigerian local (0801 234 5678) or international (+234...).
       The prefix character is kept so spacing around the mask survives. */
    t = t.replace(/(^|[^\w.])(\+?234[ -]?\d{3}[ -]?\d{3}[ -]?\d{3,4}|0[7-9][01]\d[ -]?\d{3}[ -]?\d{3,4})\b/g, function (m, pre) {
      found.push("phone");
      return pre + "[phone]";
    });
    return { text: t, found: found };
  }

  /* ---------- prompt library ---------- */

  function extractVars(tpl) {
    var out = [];
    String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_ ]{1,30})\s*\}\}/g, function (m, name) {
      var k = name.trim();
      if (out.indexOf(k) === -1) out.push(k);
      return m;
    });
    return out;
  }

  function applyTemplate(tpl, values) {
    return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_ ]{1,30})\s*\}\}/g, function (m, name) {
      var k = name.trim();
      return values && values[k] != null && String(values[k]).length ? String(values[k]) : m;
    });
  }

  /* ---------- memory capture ---------- */

  /* "remember that Ada lives in Yaba" stores the fact, not the command. */
  function memoryFromText(text) {
    var m = /^\s*(?:please\s+)?remember\s+(?:that\s+)?(.+)$/i.exec(String(text || ""));
    if (!m) return null;
    var fact = m[1].replace(/\s+/g, " ").trim().slice(0, 160);
    if (fact.length < 3) return null;
    return fact;
  }

  function dedupeMemory(memories, fact) {
    var list = (memories || []).filter(function (m) {
      return String(m.text || "").toLowerCase() !== fact.toLowerCase();
    });
    list.push({ id: "mem" + Date.now().toString(36), text: fact, ts: Date.now() });
    return list.slice(-50);
  }

  /* ---------- follow ups ---------- */

  function followUpPrompt(userText, answerText) {
    return "Suggest exactly 3 short follow up messages the user of a chat app might send next. " +
      "Each is one line, at most 6 words, no numbering, no quotes, no explanations. " +
      "Reply with the 3 lines and nothing else.\n\n" +
      "User asked: " + String(userText || "").slice(0, 300) + "\n" +
      "Answer began: " + String(answerText || "").slice(0, 400);
  }

  function parseFollowUps(text) {
    return String(text || "").split("\n")
      .map(function (l) { return l.replace(/^[\s\d.):\-*]+/, "").trim(); })
      .filter(function (l) { return l && l.length <= 60; })
      .slice(0, 3);
  }

  /* ---------- usage and cost ---------- */

  /* One row per provider that appears in chats, with message counts and
     token sums from message stats. Cost only when the provider has prices
     set (per million tokens, in and out). */
  function aggregateUsage(chats, providers) {
    var byId = {};
    (providers || []).forEach(function (p) { byId[p.id] = p; });
    var rows = {};
    (chats || []).forEach(function (c) {
      var p = byId[c.providerId];
      var label = p ? p.label : (c.model || "Demo");
      var priceIn = p && isFinite(+p.priceIn) ? +p.priceIn : null;
      var priceOut = p && isFinite(+p.priceOut) ? +p.priceOut : null;
      var row = rows[c.providerId || "demo"] ||
        (rows[c.providerId || "demo"] = { label: label, msgs: 0, toks: 0, cost: 0, priced: priceIn != null || priceOut != null });
      (c.messages || []).forEach(function (m) {
        if (!m || m.role !== "assistant" || m.error) return;
        if (!String(m.content || "").length) return;
        row.msgs++;
        var toks = m.stats && m.stats.toks > 0 ? m.stats.toks : 0;
        row.toks += toks;
        if (row.priced && m.stats) {
          var tin = m.stats.toksIn != null ? m.stats.toksIn : Math.round(toks * 0.25);
          var tout = m.stats.toksOut != null ? m.stats.toksOut : Math.round(toks * 0.75);
          if (priceIn != null) row.cost += tin / 1e6 * priceIn;
          if (priceOut != null) row.cost += tout / 1e6 * priceOut;
        }
      });
    });
    return Object.keys(rows).map(function (k) { return rows[k]; })
      .sort(function (a, b) { return b.cost - a.cost || b.toks - a.toks; });
  }

  /* ---------- retention ---------- */

  /* Deletes chats older than N days. Pinned chats and folders survive. */
  function pruneChats(chats, days, now) {
    if (!days || !(days > 0)) return { kept: chats || [], removed: [] };
    var cutoff = (now || Date.now()) - days * 86400000;
    var kept = [], removed = [];
    (chats || []).forEach(function (c) {
      var ts = c.updatedAt || c.createdAt || 0;
      if (c.pinned || ts >= cutoff) kept.push(c);
      else removed.push(c);
    });
    return { kept: kept, removed: removed };
  }

  /* ---------- encrypted backup (WebCrypto) ---------- */

  var cryptoObj = (typeof globalThis !== "undefined" && globalThis.crypto) ? globalThis.crypto : null;

  function b64(bytes) {
    var s = "";
    var u = new Uint8Array(bytes);
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function unb64(s) {
    var raw = atob(String(s || ""));
    var u = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u;
  }

  async function deriveKey(passphrase, salt) {
    var keyMat = await cryptoObj.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return cryptoObj.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 200000, hash: "SHA-256" },
      keyMat,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]);
  }

  /* File shape: {format:"impose-encrypted-v1", salt, iv, data} all base64.
     The payload is the plain Impose export JSON. */
  async function encryptExport(plainObj, passphrase) {
    if (!cryptoObj || !cryptoObj.subtle) return Promise.reject(new Error("WebCrypto is not available in this browser."));
    if (String(passphrase || "").length < 8) return Promise.reject(new Error("Use a passphrase of at least 8 characters."));
    var salt = cryptoObj.getRandomValues(new Uint8Array(16));
    var iv = cryptoObj.getRandomValues(new Uint8Array(12));
    var key = await deriveKey(passphrase, salt);
    var data = new TextEncoder().encode(JSON.stringify(plainObj));
    var enc = await cryptoObj.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, data);
    return { format: "impose-encrypted-v1", salt: b64(salt), iv: b64(iv), data: b64(enc) };
  }

  async function decryptExport(fileObj, passphrase) {
    if (!cryptoObj || !cryptoObj.subtle) return Promise.reject(new Error("WebCrypto is not available in this browser."));
    if (!fileObj || fileObj.format !== "impose-encrypted-v1") return Promise.reject(new Error("That file is not an encrypted Impose backup."));
    var key = await deriveKey(passphrase, unb64(fileObj.salt));
    var plain = await cryptoObj.subtle.decrypt({ name: "AES-GCM", iv: unb64(fileObj.iv) }, key, unb64(fileObj.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /* ---------- share as HTML ---------- */

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* A self contained read only snapshot. No scripts, inline styles only. */
  function shareChatHtml(chat) {
    var title = String((chat && chat.title) || "Impose chat");
    var rows = "";
    ((chat && chat.messages) || []).forEach(function (m) {
      if (!m) return;
      var mine = m.role === "user";
      rows += '<div class="m ' + (mine ? "u" : "a") + '"><span class="who">' + escHtml(mine ? "You" : "Impose") +
        '</span><div class="b">' + escHtml(m.content || "").replace(/\n/g, "<br>") + "</div></div>";
    });
    return "<!DOCTYPE html>\n<html><head><meta charset=\"UTF-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>" + escHtml(title) + "</title><style>" +
      "body{margin:0;background:#212121;color:#ececec;font:15px/1.6 system-ui,sans-serif}" +
      ".wrap{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:19px}" +
      ".m{margin:18px 0}.who{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8f8f8f;margin-bottom:6px}" +
      ".u .b{background:#323232;border-radius:12px;padding:12px 16px;display:inline-block}" +
      ".a .b{border-left:2px solid rgba(255,255,255,.2);padding:2px 0 2px 16px}" +
      "</style></head><body><div class=\"wrap\"><h1>" + escHtml(title) + "</h1>" + rows +
      "<p style=\"color:#8f8f8f;font-size:12px\">Shared from Impose. Read only snapshot.</p></div></body></html>";
  }

  /* ---------- relay status ---------- */

  function formatRelayStatus(data) {
    if (!data || typeof data !== "object") return { ok: false, text: "The relay did not answer." };
    if (data.gateway_up === true) {
      var idle = data.idle_minutes != null ? Math.round(data.idle_minutes) : null;
      return { ok: true, up: true, text: "Gateway up" + (idle != null ? " · idle " + idle + "m" : "") };
    }
    if (data.wake_studio === false && data.note) return { ok: true, up: false, text: "Gateway down · wake disabled" };
    return { ok: true, up: false, text: "Gateway down · set to wake on chat" };
  }

  /* ---------- misc helpers ---------- */

  function duplicateChat(chat, newId) {
    var copy = JSON.parse(JSON.stringify(chat));
    copy.id = newId;
    copy.title = String(chat.title || "Chat") + " (copy)";
    copy.pinned = false;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    return copy;
  }

  var api = {
    estimateTokens: estimateTokens,
    modelContext: modelContext,
    trimHistory: trimHistory,
    clampParam: clampParam,
    applyGenParams: applyGenParams,
    memoryBlock: memoryBlock,
    buildSystem: buildSystem,
    visionCapable: visionCapable,
    luhn_ok: luhn_ok,
    redactPII: redactPII,
    extractVars: extractVars,
    applyTemplate: applyTemplate,
    memoryFromText: memoryFromText,
    dedupeMemory: dedupeMemory,
    followUpPrompt: followUpPrompt,
    parseFollowUps: parseFollowUps,
    aggregateUsage: aggregateUsage,
    pruneChats: pruneChats,
    encryptExport: encryptExport,
    decryptExport: decryptExport,
    shareChatHtml: shareChatHtml,
    escHtml: escHtml,
    formatRelayStatus: formatRelayStatus,
    duplicateChat: duplicateChat
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (typeof globalThis !== "undefined" ? globalThis : window).ImposeFeatures = api;
})();
