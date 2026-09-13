/* Impose agent harness: a tiny plugin registry plus the one tool that exists
   today (websearch). A second tool later is one registerTool call and
   nothing else. Nothing here touches the DOM; the app injects search,
   complete, and emit. Loads in the browser as window.ImposeHarness and
   under node via require. */
(function () {
  "use strict";

  function getRoot() {
    if (typeof globalThis !== "undefined") return globalThis;
    return typeof window !== "undefined" ? window : {};
  }

  function domainOf(url) {
    try { return new URL(String(url)).hostname.replace(/^www\./, ""); }
    catch (e) { return ""; }
  }

  /* Second attempt helper: strip question framing so a failed query gets
     one simpler retry before the run admits defeat. */
  function simplifyQuery(q) {
    var s = String(q || "").replace(/[?.,!;:()[\]"]+/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/^(who|what|whats|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|the|a|an)\b\s*/i, "");
    return s.trim();
  }

  /* Does this request want pictures? Needs an image noun plus a request
     frame, so "who is Mark Rober" stays a plain search while "show me 4
     images of Mark Rober" flips the gallery on. */
  var IMAGE_NOUN = /\b(images?|photos?|photographs?|pictures?|pics?|wallpapers?|screenshots?)\b/i;
  var IMAGE_FRAME = /^(\s*(please\s+)?(can|could)?\s*(you\s+)?(show|find|get|search|pull|fetch|give)\b|i want|looking for|send)\b/i;

  function looksLikeImageRequest(text) {
    var s = String(text || "");
    if (!IMAGE_NOUN.test(s)) return false;
    if (IMAGE_FRAME.test(s)) return true;
    return /\b(images?|photos?|pictures?|pics?)\s+(of|for|from|about)\b/i.test(s);
  }

  /* "Show me 4 images of Mark Rober" -> "Mark Rober": strip the request
     framing so the image engine gets a clean subject. */
  function imageSubject(text) {
    var s = String(text || "").replace(/[?!.]+$/g, " ").replace(/\s+/g, " ").trim();
    s = s.replace(/^\s*(please\s+)?(can|could)?\s*(you\s+)?(show|find|get|search|pull|fetch|give)\s+(me\s+)?/i, "");
    s = s.replace(/^\s*(i\s+(want|need|would like)\s+|looking\s+for\s+)/i, "");
    s = s.replace(/^\s*(a\s+|an\s+|the\s+|some\s+)?\d*\s*(highest\s+quality\s+|hd\s+|best\s+)?(images?|photos?|photographs?|pictures?|pics?|wallpapers?|screenshots?)\s*(of|for|from|about|:\s?)\s*/i, "");
    s = s.replace(/\b(in\s+(the\s+)?web|online|from\s+the\s+(web|internet))\s*$/i, "");
    return s.trim() || String(text || "").trim();
  }

  /* Drop years and counts: "odunlade adekola 2024" hunts one photo set,
     "odunlade adekola" finds the person. */
  function broadenSubject(s) {
    return String(s || "").replace(/\b(?:19|20)\d{2}\b/g, " ").replace(/\s+/g, " ").trim();
  }

  /* Search attempts for one gallery: the clean subject, its broadened
     form, then the simplified question. Deduped, order kept. */
  function uniqueVariants(subject) {
    var out = [], i, v;
    for (i = 0; i < arguments.length; i++) {
      v = String(arguments[i] || "").trim();
      if (v && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  var imagesTool = {
    id: "images.search",
    version: "1.0",
    description: "Finds real photos on the web and returns gallery results.",
    capabilities: ["images"],
    inputSchema: { query: "string, 1 to 500 chars", limit: "int, 1 to 12" },
    run: function (args, ctx) {
      var query = args && typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return Promise.reject(new Error("Image search needs a query."));
      if (query.length > 500) return Promise.reject(new Error("Image query is too long."));
      var limit = args && args.limit ? Math.max(1, Math.min(12, parseInt(args.limit, 10) || 6)) : 6;
      return ctx.images(query, limit).then(function (out) {
        var seen = {}, clean = [];
        var rows = (out && out.results) || [];
        for (var i = 0; i < rows.length && clean.length < limit; i++) {
          var r = rows[i];
          var img = String(r.image || "");
          if (!/^https?:\/\//i.test(img) || seen[img]) continue;
          seen[img] = 1;
          clean.push({
            title: String(r.title || "image").slice(0, 160),
            image: img,
            thumb: /^https?:\/\//i.test(String(r.thumb || "")) ? String(r.thumb) : img,
            page: /^https?:\/\//i.test(String(r.page || "")) ? String(r.page) : "",
            source: String(r.source || "").slice(0, 80),
            w: r.w || null,
            h: r.h || null
          });
        }
        return { images: clean, provider: (out && out.provider) || "", query: query };
      });
    }
  };

  var websearchTool = {
    id: "web.search",
    version: "1.0",
    description: "Searches the web and returns ranked results with sources.",
    capabilities: ["search"],
    inputSchema: { query: "string, 1 to 500 chars", limit: "int, 1 to 20" },
    run: function (args, ctx) {
      var query = args && typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return Promise.reject(new Error("Search needs a query."));
      if (query.length > 500) return Promise.reject(new Error("Search query is too long."));
      var limit = args && args.limit ? Math.max(1, Math.min(20, parseInt(args.limit, 10) || 8)) : 8;
      ctx.emit({ t: "query", q: query });
      return ctx.search(query, limit).then(function (out) {
        var results = (out && out.results) || [];
        if (results.length > 0) {
          return { results: results, provider: out.provider || "", query: query, retried: false };
        }
        var simpler = simplifyQuery(query);
        if (!simpler || simpler === query) {
          return { results: [], provider: out.provider || "", query: query, retried: false };
        }
        ctx.emit({ t: "query", q: simpler });
        return ctx.search(simpler, limit).then(function (out2) {
          return {
            results: (out2 && out2.results) || [],
            provider: (out2 && out2.provider) || "",
            query: simpler,
            retried: true
          };
        });
      });
    }
  };

  function createHarness() {
    var tools = [];

    function resolve(capability) {
      for (var i = 0; i < tools.length; i++) {
        if (tools[i].capabilities.indexOf(capability) !== -1) return tools[i];
      }
      throw new Error("No tool registered for capability: " + capability);
    }

    /* One researched answer: plan the query, search, then complete.
       Empty results still complete, from knowledge with a one-line note.
       deps: query, search(q, limit), complete(system, user, onDelta),
       images(q, limit) (optional, enables the image gallery on image asks),
       emit(event), onDelta(chunk), rewrite(text) (optional, a promise of a
       search query; empty or rejected falls back to the raw words),
       signal (optional AbortSignal), excluded (optional array of domains),
       context (optional string of recent turns, used to resolve follow-ups). */
    function runAgent(deps) {
      var tool;
      try { tool = resolve("search"); }
      catch (e) { return Promise.reject(e); }
      var question = deps.query;
      var imagesFn = (typeof deps.images === "function") ? function () {
        try { return resolve("images"); } catch (e) { return null; }
      }() : null;
      var wantImages = !!(imagesFn && (deps.forceImages || looksLikeImageRequest(question)));
      var ctxBlock = deps.context && String(deps.context).trim()
        ? "Conversation so far:\n" + String(deps.context).trim() + "\n\n" : "";
      function withContext(q) { return ctxBlock + "Question: " + q; }
      function abortErr() {
        var err = new Error("stopped");
        err.name = "AbortError";
        return err;
      }
      /* The critic: one small completion judging whether a result serves
         the request. Answers GO (or SUFFICIENT), or QUERY: with a better
         search. Missing critic dep or a failed call stays fail-open. */
      function askCritic(prompt) {
        if (typeof deps.critique !== "function") return Promise.resolve("GO");
        return Promise.resolve().then(function () { return deps.critique(prompt); })
          .then(function (ans) { return String(ans == null ? "GO" : ans); },
                function () { return "GO"; });
      }
      function parseQueryAns(ans) {
        if (!/^QUERY:/i.test(String(ans || "").trim())) return "";
        return String(ans).replace(/^QUERY:\s*/i, "").trim().slice(0, 200);
      }
      function plan() {
        if (typeof deps.rewrite !== "function") return Promise.resolve(question);
        deps.emit({ t: "status", text: "Planning the search" });
        return Promise.resolve().then(function () { return deps.rewrite(question, deps.context || ""); }).then(function (q) {
          q = q == null ? "" : String(q).trim();
          if (!q || q.length > 500) return question;
          return q;
        }, function () { return question; });
      }
      return plan().then(function (planned) {
        if (deps.signal && deps.signal.aborted) throw abortErr();
        deps.emit({ t: "status", text: "Searching the web" });
        var gallery = null;
        var galleryFailed = false;
        function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        var galleryJob = wantImages ? (function () {
          var subject = imageSubject(planned);
          deps.emit({ t: "status", text: "Finding images" });
          var raw = subject || planned;
          var variants = uniqueVariants(raw, broadenSubject(raw), simplifyQuery(raw));
          function attempt(i) {
            if (deps.signal && deps.signal.aborted) return Promise.reject(abortErr());
            if (i >= variants.length) return Promise.reject(new Error("every image attempt failed"));
            if (i > 0) {
              deps.emit({ t: "imagestry", q: variants[i], n: i + 1 });
              return pause(400).then(function () { return imagesTool.run({ query: variants[i], limit: 6 }, { images: deps.images }); })
                .then(good, function () { return attempt(i + 1); });
            }
            return imagesTool.run({ query: variants[i], limit: 6 }, { images: deps.images }).then(good, function () { return attempt(i + 1); });
            function good(g) { return g.images.length ? g : attempt(i + 1); }
          }
          function criticRound(g) {
            if (!g.images.length) return g;
            var titles = g.images.slice(0, 6).map(function (x) { return "- " + x.title; }).join("\n");
            return askCritic("Request: photos of \"" + (subject || planned) + "\". The image search returned:\n" + titles +
              "\nDo these images match the subject? Answer exactly GO if they do. If they do not, answer exactly QUERY: followed by one better image search query.")
              .then(function (ans) {
                var q2 = parseQueryAns(ans);
                if (!q2 || q2.toLowerCase() === String(g.query).toLowerCase()) return g;
                deps.emit({ t: "imagestry", q: q2, better: true });
                return imagesTool.run({ query: q2, limit: 6 }, { images: deps.images })
                  .then(function (g2) { return g2.images.length ? g2 : g; }, function () { return g; });
              });
          }
          return attempt(0).then(criticRound, function () {
            /* No gallery after every attempt, but silence reads as broken. */
            galleryFailed = true;
            deps.emit({ t: "imagesfail" });
          }).then(function (g) {
            if (g && g.images && g.images.length) {
              gallery = g;
              deps.emit({ t: "images", n: g.images.length, provider: g.provider, images: g.images });
            }
          });
        })() : null;
        return tool.run({ query: planned, limit: 8 }, { search: deps.search, emit: deps.emit }).then(function (out) {
          if (deps.signal && deps.signal.aborted) throw abortErr();
          var results = (out.results || []).filter(function (r) {
            if (!deps.excluded || !deps.excluded.length) return true;
            return deps.excluded.indexOf(domainOf(r.url)) === -1;
          });
          /* Read at completion time: the gallery job settles in parallel
             with the search, so the note can only be built afterwards. */
          function galleryNote() {
            var note = "";
            if (gallery) {
              note = " An image gallery for this request is already shown to the user next to your reply. " +
                "Never say you cannot display images, and do not list image links in the answer; " +
                "talk about the subject naturally instead.";
            }
            if (galleryFailed) {
              note += " The user asked for photos but the image search failed after several attempts. " +
                "Do NOT invent, guess, or paste any image URLs, stock photo links, or thumbnails - fabricated links " +
                "render broken and mislead. Answer in text only; naming a site in prose is fine, but never fabricate " +
                "a link or a gallery table.";
            }
            return note;
          }
          /* The gate: a critic pass over the sources. One round, then the
             pipeline moves on with whatever is best. */
          function sourcesGate(rows) {
            if (typeof deps.critique !== "function" || rows.length === 0) return Promise.resolve(rows);
            if (deps.signal && deps.signal.aborted) return Promise.resolve(rows);
            var lines = rows.slice(0, 8).map(function (r, i) {
              return (i + 1) + ". " + (r.title || "") + " [" + domainOf(r.url) + "] " + String(r.snippet || "").slice(0, 120);
            }).join("\n");
            return askCritic("Request: " + question + "\nThe web search returned these sources:\n" + lines +
              "\nAre these sources on topic and enough to answer the request well? " +
              "Answer exactly SUFFICIENT if they are. If not, answer exactly QUERY: followed by one better web search query.")
              .then(function (ans) {
                var q2 = parseQueryAns(ans);
                if (!q2) return rows;
                deps.emit({ t: "status", text: "First pass looked weak - searching again" });
                deps.emit({ t: "query", q: q2 });
                return Promise.resolve().then(function () { return deps.search(q2, 8); }).then(function (out2) {
                  var rows2 = (out2 && out2.results) || [];
                  if (!rows2.length) return rows;
                  var seen = {}, merged = [];
                  rows2.concat(rows).forEach(function (r) {
                    if (r && r.url && !seen[r.url]) { seen[r.url] = 1; merged.push(r); }
                  });
                  return merged.slice(0, 10);
                }, function () { return rows; });
              });
          }
          function finishWith(rows) {
            results = rows;
            if (rows.length === 0) {
            return (galleryJob || Promise.resolve()).then(function () {
              deps.emit({ t: "settle", text: "Searched the web" });
              var bare = "You are Impose, a helpful assistant running in a web app that renders rich content; never call yourself a CLI or terminal. The web search found nothing for this question. " +
                "Say so in one short line, then answer from your own knowledge anyway. " +
                "Never refuse a question you can answer, and never ask the user to provide evidence. Use the conversation to resolve names and pronouns." +
                galleryNote();
              return deps.complete(bare, withContext(question), deps.onDelta, deps.onThink).then(function () {
                return { sources: [], provider: out.provider || "", images: gallery ? gallery.images : null };
              });
            });
            }
          deps.emit({ t: "status", text: "Reading " + results.length + " sources", provider: out.provider || "" });
          results.forEach(function (r) {
            deps.emit({ t: "source", title: r.title || r.url, sub: domainOf(r.url), href: r.url });
          });
          if (results.length > 5) deps.emit({ t: "more", n: results.length - 5 });
          var readFn = typeof deps.read === "function" ? deps.read : null;
          var reading = readFn
            ? Promise.all(results.slice(0, 2).map(function (r) {
                deps.emit({ t: "reading", title: r.title || r.url });
                return Promise.resolve().then(function () { return readFn(r.url); }).then(function (page) {
                  if (!page) return null;
                  if (typeof page === "string") return { url: r.url, title: r.title || r.url, text: page };
                  return { url: r.url, title: page.title || r.title || r.url, text: page.text || "" };
                }, function () { return null; });
              }))
            : Promise.resolve([]);
          return reading.then(function (pages) {
            var lines = results.map(function (r, i) {
              return "[" + (i + 1) + "] " + (r.title || r.url) + "\n" + r.url + "\n" + (r.snippet || "");
            });
            var pageBlocks = [];
            var pageBudget = 9000;
            pages.forEach(function (pg) {
              if (!pg || !pg.text || pageBudget <= 0) return;
              var body = String(pg.text).slice(0, Math.min(4500, pageBudget));
              pageBudget -= body.length;
              pageBlocks.push("[" + (results.indexOf(results.filter(function (x) { return x.url === pg.url; })[0]) + 1) + "] " +
                pg.title + "\n" + pg.url + "\n" + body);
            });
            var evidence = lines.join("\n\n");
            if (pageBlocks.length) evidence += "\n\nPage contents:\n\n" + pageBlocks.join("\n\n");
            return (galleryJob || Promise.resolve()).then(function () {
              deps.emit({ t: "settle", text: "Searched the web" });
              var system = "You are Impose, a helpful assistant running in a web app that renders rich content; never call yourself a CLI or terminal. Use the evidence below when it answers the question, " +
                "and cite sources by number like [1]. Page contents, when present, outrank the short snippets. " +
                "If the evidence is off topic or too thin, say the search missed " +
                "in one short line, then answer from your own knowledge anyway. Never refuse a question you can answer, " +
                "and never ask the user to provide evidence. Use the conversation to resolve names and pronouns." +
                galleryNote();
              return deps.complete(system, withContext(question) + "\n\nEvidence:\n" + evidence, deps.onDelta, deps.onThink).then(function () {
                return { sources: results, provider: out.provider, read: pages.filter(Boolean).length,
                         images: gallery ? gallery.images : null };
              });
            });
          });
          }
          return sourcesGate(results).then(finishWith);
        });
      });
    }

    return {
      registerTool: function (tool) {
        if (!tool || typeof tool.id !== "string" || !tool.id) throw new Error("Tool needs a string id.");
        if (Object.prototype.toString.call(tool.capabilities) !== "[object Array]" || tool.capabilities.length === 0) {
          throw new Error("Tool needs a non-empty capabilities array.");
        }
        if (typeof tool.run !== "function") throw new Error("Tool needs a run function.");
        for (var i = 0; i < tools.length; i++) {
          if (tools[i].id === tool.id) throw new Error("Tool already registered: " + tool.id);
        }
        tools.push(tool);
        return tool;
      },
      resolve: resolve,
      tools: function () { return tools.slice(); },
      runAgent: runAgent
    };
  }

  var api = {
    createHarness: createHarness,
    simplifyQuery: simplifyQuery,
    looksLikeImageRequest: looksLikeImageRequest,
    imageSubject: imageSubject,
    imagesTool: imagesTool,
    broadenSubject: broadenSubject,
    domainOf: domainOf,
    websearchTool: websearchTool,
    harness: createHarness()
  };
  api.harness.registerTool(websearchTool);
  api.harness.registerTool(imagesTool);

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else getRoot().ImposeHarness = api;
})();
