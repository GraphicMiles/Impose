/* X adapter for DMs, search results, posts, and replies. Public side effects
   report success only when matching newly rendered content is observed. */
(function () {
  "use strict";

  var SELECTORS = {
    loggedOut: ['a[href="/i/flow/login"]', 'a[href="/login"]', '[data-testid="loginButton"]'],
    dmComposer: ['[data-testid="dmComposerTextInput"]', 'div[role="textbox"][data-testid^="dmComposer"]', 'div[role="textbox"]'],
    dmSend: ['[data-testid="dmComposerSendButton"]', '[aria-label="Send"][role="button"]', 'button[aria-label="Send"]'],
    postComposer: ['[data-testid="tweetTextarea_0"]', 'div[role="textbox"][contenteditable="true"]'],
    postSend: ['[data-testid="tweetButtonInline"]', '[data-testid="tweetButton"]'],
    reply: ['[data-testid="reply"]', 'button[aria-label*="Reply"]'],
    threads: 'a[href^="/messages/"]',
    posts: 'article[data-testid="tweet"]',
    main: "main"
  };
  var SUPPORTED = {
    probe: true,
    snapshot: true,
    "dm.list": true,
    "dm.send": true,
    "x.post": true,
    "x.reply": true,
    "x.results": true
  };

  function first(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var element = document.querySelector(selectors[i]);
      if (element) return element;
    }
    return null;
  }

  function textOf(element) {
    if (!element) return "";
    var text = element.innerText != null ? element.innerText : element.textContent;
    return String(text || "");
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function waitFor(selectors, timeoutMs) {
    var startedAt = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        var element = first(selectors);
        if (element) {
          resolve(element);
          return;
        }
        if (Date.now() - startedAt >= (timeoutMs || 8000)) {
          resolve(null);
          return;
        }
        setTimeout(poll, 250);
      })();
    });
  }

  function visibleText(root, limit) {
    var text = textOf(root).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  }

  function typeInto(element, value) {
    try { element.focus(); } catch (error) { /* Focus is best effort. */ }
    try { document.execCommand("selectAll", false, null); } catch (error) { /* Older page implementation. */ }
    var inserted = false;
    try { inserted = document.execCommand("insertText", false, value); }
    catch (error) { inserted = false; }
    if (!inserted) {
      try {
        element.textContent = value;
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      } catch (error) {
        return false;
      }
    }
    return normalizedText(textOf(element)).indexOf(normalizedText(value).slice(0, 20)) !== -1;
  }

  function dmThreads() {
    var output = [];
    var seen = Object.create(null);
    var links = document.querySelectorAll(SELECTORS.threads);
    for (var i = 0; i < links.length && output.length < 20; i++) {
      var href = links[i].getAttribute("href");
      if (!href || href === "/messages" || href.indexOf("/messages/compose") === 0 || seen[href]) continue;
      seen[href] = true;
      var summary = normalizedText(textOf(links[i]));
      var name = links[i].querySelector("span span");
      output.push({
        name: normalizedText(textOf(name)) || summary.slice(0, 40) || href,
        snippet: summary.slice(0, 140),
        url: "https://x.com" + href
      });
    }
    return output;
  }

  function matchingMessageCount(text, composer) {
    var wanted = normalizedText(text);
    var nodes = document.querySelectorAll('[data-testid="messageEntry"], [data-testid^="messageEntry"], [data-testid="cellInnerDiv"]');
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === composer || nodes[i].contains(composer)) continue;
      if (normalizedText(textOf(nodes[i])).indexOf(wanted) !== -1) count++;
    }
    return count;
  }

  function matchingPostCount(text, composer) {
    var wanted = normalizedText(text);
    var posts = document.querySelectorAll(SELECTORS.posts);
    var count = 0;
    for (var i = 0; i < posts.length; i++) {
      if (composer && (posts[i] === composer || posts[i].contains(composer))) continue;
      if (normalizedText(textOf(posts[i])).indexOf(wanted) !== -1) count++;
    }
    return count;
  }

  function confirmNewContent(options) {
    var startedAt = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        if (options.count() > options.before) {
          resolve({ ok: true, sent: true, confirmed: true, kind: options.kind });
          return;
        }
        if (Date.now() - startedAt >= 7000) {
          var composerHasText = options.composer && normalizedText(textOf(options.composer));
          resolve(composerHasText
            ? { ok: false, error: "The action was clicked but the composer still holds text. Nothing was confirmed." }
            : { ok: false, uncertain: true, error: "The composer cleared, but matching published content was not found. Check X before retrying." });
          return;
        }
        setTimeout(poll, 250);
      })();
    });
  }

  function enabledButton(selectors) {
    return waitFor(selectors, 5000).then(function (button) {
      if (!button) return null;
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return null;
      return button;
    });
  }

  function dmSend(params) {
    var text = String((params && params.text) || "").trim();
    if (!text) return Promise.resolve({ ok: false, error: "Empty reply text." });
    if (text.length > 10000) return Promise.resolve({ ok: false, error: "The reply is longer than X's 10,000 character DM limit." });
    return waitFor(SELECTORS.dmComposer, 10000).then(function (composer) {
      if (!composer) return { ok: false, error: "No DM composer was found. Open a message thread first." };
      var before = matchingMessageCount(text, composer);
      if (!typeInto(composer, text)) return { ok: false, error: "Could not type into the DM composer." };
      return enabledButton(SELECTORS.dmSend).then(function (button) {
        if (!button) return { ok: false, error: "The DM draft is ready, but X's send button is unavailable." };
        button.click();
        return confirmNewContent({
          kind: "dm",
          composer: composer,
          before: before,
          count: function () { return matchingMessageCount(text, composer); }
        });
      });
    });
  }

  function publicSend(params, isReply) {
    var text = String((params && params.text) || "").trim();
    if (!text) return Promise.resolve({ ok: false, error: isReply ? "Reply text is empty." : "Post text is empty." });
    if (text.length > 10000) return Promise.resolve({ ok: false, error: "The text is longer than X allows in its composer." });
    var openComposer = isReply
      ? waitFor(SELECTORS.reply, 8000).then(function (replyButton) {
          if (!replyButton) return null;
          replyButton.click();
          return waitFor(SELECTORS.postComposer, 8000);
        })
      : waitFor(SELECTORS.postComposer, 10000);

    return openComposer.then(function (composer) {
      if (!composer) return { ok: false, error: isReply ? "The reply composer was not found." : "The post composer was not found." };
      var before = matchingPostCount(text, composer);
      if (!typeInto(composer, text)) return { ok: false, error: "Could not type into X's composer." };
      return enabledButton(SELECTORS.postSend).then(function (button) {
        if (!button) return { ok: false, error: "The draft is ready, but X's publish button is unavailable." };
        button.click();
        return confirmNewContent({
          kind: isReply ? "reply" : "post",
          composer: composer,
          before: before,
          count: function () { return matchingPostCount(text, composer); }
        });
      });
    });
  }

  function xResults() {
    var articles = document.querySelectorAll(SELECTORS.posts);
    var results = [];
    for (var i = 0; i < articles.length && results.length < 20; i++) {
      var article = articles[i];
      var body = article.querySelector('[data-testid="tweetText"]');
      var statusLink = article.querySelector('a[href*="/status/"]');
      var user = article.querySelector('[data-testid="User-Name"]');
      var metrics = Array.prototype.map.call(article.querySelectorAll('[role="group"] [aria-label]'), function (element) {
        return element.getAttribute("aria-label");
      }).filter(Boolean).join(" · ");
      var text = normalizedText(textOf(body) || textOf(article));
      if (!text) continue;
      results.push({
        text: text.slice(0, 1000),
        author: normalizedText(textOf(user)).slice(0, 200),
        url: statusLink ? String(statusLink.href || "").slice(0, 1000) : "",
        metrics: metrics.slice(0, 300)
      });
    }
    return { url: location.href, query: new URL(location.href).searchParams.get("q") || "", results: results };
  }

  function handle(message) {
    var params = message.params || {};
    if (message.method === "probe") {
      return Promise.resolve({
        url: location.href,
        title: document.title,
        loggedOut: !!first(SELECTORS.loggedOut),
        composer: !!first(SELECTORS.dmComposer),
        send: !!first(SELECTORS.dmSend),
        threads: document.querySelectorAll(SELECTORS.threads).length
      });
    }
    if (message.method === "snapshot") {
      var main = document.querySelector(SELECTORS.main) || document.body;
      return Promise.resolve({ url: location.href, title: document.title, text: visibleText(main, 4000) });
    }
    if (message.method === "dm.list") return Promise.resolve({ url: location.href, threads: dmThreads() });
    if (message.method === "dm.send") return dmSend(params);
    if (message.method === "x.post") return publicSend(params, false);
    if (message.method === "x.reply") return publicSend(params, true);
    if (message.method === "x.results") {
      return waitFor([SELECTORS.posts], 8000).then(function () { return xResults(); });
    }
    return null;
  }

  chrome.runtime.onMessage.addListener(function (message, sender, reply) {
    if (!message || !SUPPORTED[message.method]) return false;
    var work = handle(message);
    if (!work) return false;
    work.then(function (result) {
      if (result && typeof result.ok === "boolean") reply(result);
      else reply({ ok: true, result: result });
    }, function (error) {
      reply({ ok: false, error: String((error && error.message) || error) });
    });
    return true;
  });
})();
