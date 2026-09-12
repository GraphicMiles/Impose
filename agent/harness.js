/* Nova agent harness: a tiny plugin registry plus the one tool that exists
   today (websearch). A second tool later is one registerTool call and
   nothing else. Nothing here touches the DOM; the app injects search,
   complete, and emit. Loads in the browser as window.NovaHarness and
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
       deps: query, search(q, limit), complete(system, user, onDelta),
       emit(event), onDelta(chunk), rewrite(text) (optional, a promise of a
       search query; empty or rejected falls back to the raw words),
       signal (optional AbortSignal). */
    function runAgent(deps) {
      var tool;
      try { tool = resolve("search"); }
      catch (e) { return Promise.reject(e); }
      var question = deps.query;
      function abortErr() {
        var err = new Error("stopped");
        err.name = "AbortError";
        return err;
      }
      function plan() {
        if (typeof deps.rewrite !== "function") return Promise.resolve(question);
        deps.emit({ t: "status", text: "Planning the search" });
        return Promise.resolve().then(function () { return deps.rewrite(question); }).then(function (q) {
          q = q == null ? "" : String(q).trim();
          if (!q || q.length > 500) return question;
          return q;
        }, function () { return question; });
      }
      return plan().then(function (planned) {
        if (deps.signal && deps.signal.aborted) throw abortErr();
        deps.emit({ t: "status", text: "Searching the web" });
        return tool.run({ query: planned, limit: 8 }, { search: deps.search, emit: deps.emit }).then(function (out) {
          if (deps.signal && deps.signal.aborted) throw abortErr();
          if (!out.results || out.results.length === 0) {
            throw new Error("The search came back empty. Try fewer or different words.");
          }
          out.results.forEach(function (r) {
            deps.emit({ t: "source", title: r.title || r.url, sub: domainOf(r.url), href: r.url });
          });
          if (out.results.length > 5) deps.emit({ t: "more", n: out.results.length - 5 });
          deps.emit({ t: "settle", text: "Searched the web" });
          var lines = out.results.map(function (r, i) {
            return "[" + (i + 1) + "] " + (r.title || r.url) + "\n" + r.url + "\n" + (r.snippet || "");
          }).join("\n\n");
          var system = "You are Nova, a helpful assistant. Use the evidence below when it answers the question, " +
            "and cite sources by number like [1]. If the evidence is off topic or too thin, say the search missed " +
            "in one short line, then answer from your own knowledge anyway. Never refuse a question you can answer, " +
            "and never ask the user to provide evidence.";
          return deps.complete(system, question + "\n\nEvidence:\n" + lines, deps.onDelta).then(function () {
            return { sources: out.results, provider: out.provider };
          });
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
    domainOf: domainOf,
    websearchTool: websearchTool,
    harness: createHarness()
  };
  api.harness.registerTool(websearchTool);

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else getRoot().NovaHarness = api;
})();
