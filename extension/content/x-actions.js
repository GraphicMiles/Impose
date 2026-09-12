/* Nova X driver: runs inside x.com pages and only acts when Nova, with the
   user's approval, sends a command. Every selector has fallbacks, and a
   miss reports plainly instead of clicking blindly. */
(function () {
  "use strict";

  var SEL = {
    loggedOut: ['a[href="/i/flow/login"]', 'a[href="/login"]', '[data-testid="loginButton"]'],
    composer: ['[data-testid="dmComposerTextInput"]', 'div[role="textbox"][data-testid^="dmComposer"]', 'div[role="textbox"]'],
    send: ['[data-testid="dmComposerSendButton"]', '[aria-label="Send"][role="button"]', 'button[aria-label="Send"]'],
    threads: 'a[href^="/messages/"]',
    main: "main"
  };

  function first(sels) {
    for (var i = 0; i < sels.length; i++) {
      var n = document.querySelector(sels[i]);
      if (n) return n;
    }
    return null;
  }

  function txt(el) {
    if (!el) return "";
    var t = (el.innerText != null ? el.innerText : el.textContent) || "";
    return String(t);
  }

  function waitFor(sels, ms) {
    ms = ms || 8000;
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        var n = first(sels);
        if (n) { resolve(n); return; }
        if (Date.now() - t0 > ms) { resolve(null); return; }
        setTimeout(poll, 250);
      })();
    });
  }

  function visibleText(root, cap) {
    var t = txt(root).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (t.length > cap) t = t.slice(0, cap) + "…";
    return t;
  }

  /* execCommand keeps React-controlled textboxes happy; the fallback covers
     environments where it is gone. Returns whether the text landed. */
  function typeInto(el, text) {
    try { el.focus(); } catch (e) { /* noop */ }
    try { document.execCommand("selectAll", false, null); } catch (e) { /* noop */ }
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
    if (!ok) {
      try {
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } catch (e2) { return false; }
    }
    return txt(el).indexOf(text.slice(0, 20)) !== -1;
  }

  function dmThreads() {
    var out = [];
    var seen = {};
    var links = document.querySelectorAll(SEL.threads);
    for (var i = 0; i < links.length && out.length < 20; i++) {
      var href = links[i].getAttribute("href");
      if (!href || href === "/messages" || href.indexOf("/messages/compose") === 0) continue;
      if (seen[href]) continue;
      seen[href] = true;
      var bit = txt(links[i]).replace(/\s+/g, " ").trim();
      var nm = links[i].querySelector("span span");
      out.push({
        name: (nm && txt(nm).trim()) || bit.slice(0, 40) || href,
        snippet: bit.slice(0, 140),
        url: "https://x.com" + href
      });
    }
    return out;
  }

  function dmSend(p) {
    var text = String((p && p.text) || "").trim();
    if (!text) return Promise.resolve({ ok: false, error: "Empty reply text." });
    return waitFor(SEL.composer, 10000).then(function (box) {
      if (!box) {
        return { ok: false, error: "No DM composer on this page. Open a message thread first (X may also have changed their markup)." };
      }
      if (!typeInto(box, text)) return { ok: false, error: "Could not type into the composer." };
      return waitFor(SEL.send, 5000).then(function (btn) {
        if (!btn) return { ok: false, error: "Composer filled but no send button found. The draft is in the box; send it by hand." };
        btn.click();
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(txt(box).trim()
              ? { ok: false, error: "Send clicked but the composer still holds text. Check the thread." }
              : { ok: true, sent: true });
          }, 1500);
        });
      });
    });
  }

  function handlers(msg) {
    var p = msg.params || {};
    if (msg.method === "probe") {
      return Promise.resolve({
        url: location.href,
        title: document.title,
        loggedOut: !!first(SEL.loggedOut),
        composer: !!first(SEL.composer),
        send: !!first(SEL.send),
        threads: document.querySelectorAll(SEL.threads).length
      });
    }
    if (msg.method === "snapshot") {
      var main = document.querySelector(SEL.main) || document.body;
      return Promise.resolve({ url: location.href, title: document.title, text: visibleText(main, 4000) });
    }
    if (msg.method === "dm.list") {
      return Promise.resolve({ url: location.href, threads: dmThreads() });
    }
    if (msg.method === "dm.send") return dmSend(p);
    return Promise.resolve({ ok: false, error: "Unknown method: " + msg.method });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (!msg || typeof msg.method !== "string") return false;
    handlers(msg).then(function (res) {
      if (res && typeof res.ok === "boolean") reply(res);
      else reply({ ok: true, result: res });
    }, function (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    });
    return true;
  });
})();
