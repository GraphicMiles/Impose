/* Nova chat client. Frontend only, no backend. Chats persist to localStorage. */
(function () {
  "use strict";

  var STORE_KEY = "nova.clone.v1";
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- canned replies (stand in for a real API) ---------- */

  var REPLIES = {
    greeting: "Hello. What would you like to work on?\n\nI can help with writing, code, planning, or working through an idea. Just type below to start.",

    thanks: "You are welcome. Let me know if you want to take it further.",

    email: "Here is a draft you can send as is, plus two subject lines.\n\n**Subject options**\n- Quick follow up on invoice INV-2041\n- Checking in on payment for INV-2041\n\n**Draft**\n> Hi Amaka,\n>\n> I hope you are well. I am writing to follow up on invoice INV-2041 for 450,000 NGN, which was due on 28 August.\n>\n> Please let me know if you need anything from my side to process it. I have attached a copy for ease.\n>\n> Best regards,\n> Adaeze\n\nWant a firmer version for a second reminder, or a shorter one for WhatsApp?",

    code: "Here is what that function does, line by line.\n\n```python\ndef total(prices, tax_rate=0.075):\n    subtotal = sum(prices)\n    tax = subtotal * tax_rate\n    return round(subtotal + tax, 2)\n```\n\n1. **Signature**: takes a list of prices and an optional tax rate that defaults to 7.5%.\n2. **Subtotal**: `sum(prices)` adds every item in the list.\n3. **Tax**: multiplies the subtotal by the rate.\n4. **Return**: adds tax to the subtotal and rounds to 2 decimals.\n\n| Input | Meaning |\n| --- | --- |\n| `prices` | A list of numbers, e.g. `[1200, 3400]` |\n| `tax_rate` | A decimal rate, so `0.075` means 7.5% |\n\nCall it with `total([1200, 3400])` and you get `4945.0`. Paste your own function and I will walk through it the same way.",

    ideas: "Here are 8 options, grouped by tone. My top 3 are marked.\n\n**Playful**\n- Chop Central ★\n- Belle Full Diaries\n- Amala After Hours\n\n**Clean and modern**\n- Lagos Plate ★\n- The Chop List ★\n- Suya and Stories\n\n**Local flavor**\n- Bukka Diaries\n- Owambe Eats\n\nQuick checks before you commit: search the name on Instagram and TikTok, confirm the .com or .com.ng domain is free, and say it out loud to test how it sounds. Want tagline ideas for your favorite?",

    mortgage: "A mortgage is a long term loan used to buy a home. The bank pays most of the price now, and you repay monthly over 15 to 30 years. The house itself is the security, so if you stop paying, the bank can sell it.\n\n**A simple example**\n- House price: 60,000,000 NGN\n- Down payment (20%): 12,000,000 NGN\n- Loan: 48,000,000 NGN at 18% for 20 years\n- Monthly payment: about 740,000 NGN\n\n**Three terms to know**\n- **Down payment**: cash you pay upfront. Larger means smaller monthly bills.\n- **Interest rate**: the bank's fee for lending. Fixed stays the same, variable can move.\n- **Tenure**: how long you repay. Longer means lower monthly cost but more total interest.\n\nWant me to compare two loan offers, or estimate what fits a given salary?",

    travel: "For Lagos to London, here is the practical picture.\n\n**Direct flights (LOS to LHR)**\n- British Airways: daily service, about 6h 40m\n- Virgin Atlantic: daily service, similar timing\n- Air Peace: direct option, often lower fares\n\n**Booking tips**\n- Midweek departures (Tue, Wed) are usually cheaper than weekends.\n- Compare the direct fare against one stop options via Casablanca or Istanbul. The saving can be large.\n- Check the baggage allowance before you book. Some cheaper fares include only 23kg.\n\nTell me your dates and budget and I will sketch a shortlist of options.",

    fallback: "Got it. Here is how I would break that down.\n\n**First pass**\n- Define the outcome in one sentence.\n- List what you already know and what is missing.\n- Start with the step that removes the most doubt.\n\nTell me which part to go deeper on, or paste any details you have (numbers, drafts, error messages), and I will get specific."
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

  /* ---------- state ---------- */

  var HOUR = 3600 * 1000;
  var now = Date.now();

  function seedChats() {
    return [
      {
        id: uid() + "a",
        title: "Flight options to London",
        model: "Nova 5",
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
        model: "Nova 5",
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
        model: "Nova 5",
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
        model: "Nova 5 Mini",
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
        model: "Nova 5",
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
    return { theme: "dark", enterToSend: true, showChips: true, model: "Nova 5" };
  }

  function loadState() {
    var raw = store.read();
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.chats)) {
          parsed.settings = Object.assign(defaultSettings(), parsed.settings || {});
          return parsed;
        }
      } catch (e) { /* fall through to seed */ }
    }
    return { chats: seedChats(), settings: defaultSettings() };
  }

  var state = loadState();
  var activeId = null;
  var stream = null; // { timer, thinkTimer, chatId, index, tokens, pos, row, body }

  function save() {
    store.write(JSON.stringify({ chats: state.chats, settings: state.settings }));
  }

  function getChat(id) {
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === id) return state.chats[i];
    }
    return null;
  }

  function titleFrom(text) {
    var t = text.replace(/\s+/g, " ").trim();
    if (t.length <= 42) return t;
    var cut = t.slice(0, 42);
    var lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + "...";
  }

  /* ---------- markdown renderer (escapes first, then formats) ---------- */

  function inlineMd(s) {
    var t = escapeHtml(s);
    var stash = [];
    function hold(html) { stash.push(html); return " " + (stash.length - 1) + " "; }
    t = t.replace(/`([^`\n]+?)`/g, function (m, g) { return hold('<code class="md-code">' + g + "</code>"); });
    t = t.replace(/\[([^\]]+?)\]\((https?:[^)\s]+)\)/g, function (m, g1, g2) {
      return hold('<a href="' + g2 + '" target="_blank" rel="noopener">' + g1 + "</a>");
    });
    t = t.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|\W)\*([^*\n]+?)\*/g, "$1<em>$2</em>");
    t = t.replace(/(^|\W)_([^_\n]+?)_/g, "$1<em>$2</em>");
    t = t.replace(/ (\d+) /g, function (m, g) { return stash[+g]; });
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
    if (window.innerWidth <= 768) document.body.classList.remove("nav-open");
  }

  function newChat() {
    stopStream();
    activeId = null;
    renderList();
    messagesEl.innerHTML = "";
    showEmpty();
    autogrow();
    syncSend();
    if (window.innerWidth <= 768) document.body.classList.remove("nav-open");
    if (window.innerWidth > 768) input.focus();
  }

  /* ---------- streaming ---------- */

  function setStreamingUI(on) {
    sendBtn.hidden = on;
    stopBtn.hidden = !on;
  }

  function stopStream() {
    if (!stream) return;
    clearTimeout(stream.thinkTimer);
    clearInterval(stream.timer);
    if (stream.row && stream.row.isConnected && stream.chatId === activeId) {
      finalizeStreamRow(stream, true);
    }
    stream = null;
    setStreamingUI(false);
  }

  function finalizeStreamRow(s, partial) {
    var chat = getChat(s.chatId);
    var content = s.tokens.slice(0, s.pos).join("");
    if (chat && chat.messages[s.index]) {
      chat.messages[s.index].content = content;
      chat.updatedAt = Date.now();
      save();
    }
    s.body.innerHTML = renderMarkdown(content || (partial ? "" : "..."));
    if (!s.row.querySelector(".msg-actions")) {
      s.row.insertAdjacentHTML("beforeend", actionsHtml());
    }
    refreshIcons();
    if (!partial) renderList();
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
        finalizeStreamRow(s, false);
        if (stick) scrollBottom();
      }
    }

    s.thinkTimer = setTimeout(function () {
      if (stream !== s) return;
      tick();
      s.timer = setInterval(tick, REDUCED ? 10 : 26);
    }, REDUCED ? 60 : 520);
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
        model: state.settings.model,
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

    streamAssistant(chat, generateReply(text));
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
      var prevUser = null;
      for (var k = idx - 1; k >= 0; k--) {
        if (chat.messages[k].role === "user") { prevUser = chat.messages[k].content; break; }
      }
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
          finalizeStreamRow(s, false);
        }
      }, REDUCED ? 10 : 22);
      s.timer = timer;
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
    syncModelMenu();
    showPop($("modelMenu"), $("modelBtn"), { side: "bottom", align: "start" });
  });

  $("modelMenu").addEventListener("click", function (e) {
    var item = e.target.closest(".pop-model");
    if (!item) return;
    state.settings.model = item.dataset.model;
    save();
    syncModelLabel();
    syncModelMenu();
    hidePop();
  });

  function syncModelLabel() { $("modelName").textContent = state.settings.model; }

  function syncModelMenu() {
    var items = $("modelMenu").querySelectorAll(".pop-model");
    items.forEach(function (item) {
      var on = item.dataset.model === state.settings.model;
      item.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

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
    syncSettingsUI();
    openModal($("settingsModal"));
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

  function applyTheme(theme) {
    state.settings.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    save();
    syncSettingsUI();
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
    syncModelLabel();
    renderList();
    showEmpty();
    autogrow();
    syncSend();
    refreshIcons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
