/* Nova agent pipeline visualization: beautifului Thinking trace plus Task rows,
   translated to vanilla JS. This module drives from plain calls and knows
   nothing about the agent runtime. Phase 2 binds the runtime event bus here;
   until then playDemo acts as the binder with a scripted sample run. */
(function () {
  "use strict";

  var TONES = ["t-accent", "t-warn", "t-ok"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function icon(name) {
    return '<i data-lucide="' + name + '"></i>';
  }

  /* Mounts the expandable trace header plus timeline inside an assistant row,
     above the answer body. Returns a handle the runtime binder drives. */
  function mountTrace(host, opts) {
    opts = opts || {};
    var box = el("div", "agent-trace");
    var head = el("button", "trace-head working");
    head.setAttribute("type", "button");
    head.setAttribute("aria-expanded", "true");
    head.innerHTML =
      '<span class="trace-glyph">' + icon(opts.icon || "sparkles") + "</span>" +
      '<span class="trace-status">' + esc(opts.active || "Thinking") + "</span>" +
      '<span class="trace-time"></span>' +
      '<span class="trace-chev">' + icon("chevron-down") + "</span>";
    var statusEl = head.querySelector(".trace-status");
    var timeEl = head.querySelector(".trace-time");
    var listBody = el("div", "trace-body");
    var clip = el("div", "trace-clip");
    var list = el("div", "trace-list");
    clip.appendChild(list);
    listBody.appendChild(clip);
    box.appendChild(head);
    box.appendChild(listBody);
    var anchor = host.querySelector(".msg-body");
    if (anchor) host.insertBefore(box, anchor);
    else host.appendChild(box);

    var manual = null;
    var working = true;
    var t0 = Date.now();
    var count = 0;
    var moreEl = null;

    function render() {
      var open = manual !== null ? manual : working;
      box.classList.toggle("closed", !open);
      head.classList.toggle("working", working);
      head.setAttribute("aria-expanded", open ? "true" : "false");
    }

    head.addEventListener("click", function () {
      var open = manual !== null ? manual : working;
      manual = !open;
      render();
    });

    function leftFor(def) {
      if (def.kind === "query") return '<span class="trace-ico">' + icon("search") + "</span>";
      if (def.kind === "step") return '<span class="trace-ico spin" data-ico>' + icon("loader-circle") + "</span>";
      var tone = def.tone || TONES[count % TONES.length];
      return '<span class="trace-dot ' + tone + '"><i></i></span>';
    }

    function addRow(def) {
      def = def || {};
      var row = document.createElement(def.href ? "a" : "div");
      row.className = "trace-row" + (def.kind === "query" ? " trace-query" : "");
      if (def.si) row.setAttribute("data-si", def.si);
      row.style.setProperty("--d", (count * 120) + "ms");
      count++;
      var html = leftFor(def) + '<span class="trace-primary' + (def.mono ? " mono" : "") + '">' + esc(def.primary) + "</span>";
      if (def.secondary) html += '<span class="trace-sub' + (def.mono ? " mono" : "") + '">' + esc(def.secondary) + "</span>";
      if (def.add !== undefined) {
        html += '<span class="trace-diff"><span class="add">+' + esc(def.add) + "</span> " +
          '<span class="del">-' + esc(def.del === undefined ? 0 : def.del) + "</span></span>";
      }
      row.innerHTML = html;
      if (def.href) {
        row.setAttribute("href", def.href);
        row.setAttribute("target", "_blank");
        row.setAttribute("rel", "noreferrer");
      }
      if (moreEl) list.insertBefore(row, moreEl);
      else list.appendChild(row);
      return row;
    }

    function setStep(row, done) {
      if (!row || !row.isConnected) return;
      var ico = row.querySelector("[data-ico]");
      if (!ico) return;
      ico.classList.toggle("spin", !done);
      ico.innerHTML = icon(done ? "check" : "loader-circle");
    }

    function setMore(n) {
      if (!moreEl) {
        moreEl = el("div", "trace-more");
        list.appendChild(moreEl);
      }
      moreEl.style.setProperty("--d", (count * 120) + "ms");
      moreEl.textContent = "+" + n + " more";
    }

    function settle(doneText) {
      working = false;
      var secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      statusEl.textContent = doneText || ("Thought for " + secs + " seconds");
      timeEl.textContent = secs + "s";
      var spins = list.querySelectorAll("[data-ico].spin");
      for (var i = 0; i < spins.length; i++) {
        spins[i].classList.remove("spin");
        spins[i].innerHTML = icon("check");
      }
      render();
    }

    render();
    return {
      el: box,
      setStatus: function (t) { statusEl.textContent = t; },
      setElapsed: function () {
        if (working) timeEl.textContent = Math.max(1, Math.round((Date.now() - t0) / 1000)) + "s";
      },
      addRow: addRow,
      setStep: setStep,
      setMore: setMore,
      settle: settle
    };
  }

  /* Mounts the plan step list. Rows flip between pending, running, failed,
     and done. The retry control calls back out; the runtime decides. */
  function mountPlan(host, opts) {
    opts = opts || {};
    var wrap = el("div", "plan-rows");
    var anchor = host.querySelector(".msg-body");
    if (anchor) host.insertBefore(wrap, anchor);
    else host.appendChild(wrap);
    var byKey = {};

    function badgeInner(row) {
      if (row.status === "done") return icon("check");
      if (row.status === "failed") return icon("x");
      return esc(row.step == null ? "" : String(row.step));
    }

    function paint(entry) {
      var row = entry.row;
      var badge = entry.badge;
      var pillSlot = entry.pillSlot;
      badge.className = "plan-badge " + row.status;
      badge.style.setProperty("--p", row.status === "running" ? (row.progress || 0) : 0);
      badge.innerHTML = badgeInner(row);
      entry.meta.textContent = row.meta || "";
      pillSlot.innerHTML = "";
      if (row.status === "done") {
        var pill = el("span", "plan-pill done");
        pill.textContent = "Completed";
        pillSlot.appendChild(pill);
      } else if (row.status === "failed") {
        var fpill = el("span", "plan-pill failed");
        fpill.textContent = "Failed";
        pillSlot.appendChild(fpill);
        var retry = el("button", "icon-btn sm plan-retry");
        retry.setAttribute("type", "button");
        retry.setAttribute("title", "Retry this step");
        retry.setAttribute("aria-label", "Retry " + row.label);
        retry.innerHTML = icon("rotate-ccw");
        retry.addEventListener("click", function (e) {
          e.stopPropagation();
          if (opts.onRetry) opts.onRetry(row.key);
        });
        pillSlot.appendChild(retry);
      }
      entry.node.classList.toggle("closed", !row.open);
    }

    (opts.rows || []).forEach(function (row, i) {
      row.open = !!row.open;
      var node = el("div", "plan-row");
      node.style.setProperty("--d", (i * 80) + "ms");
      var head = el("button", "plan-head");
      head.setAttribute("type", "button");
      head.innerHTML = '<span class="plan-badge"></span>' +
        '<span class="plan-label">' + esc(row.label) + "</span>" +
        '<span class="plan-meta"></span>' +
        '<span class="plan-pills"></span>' +
        '<span class="plan-chev">' + icon("chevron-down") + "</span>";
      var detail = el("div", "plan-detail");
      var dbody = el("div", "plan-dbody");
      (row.details || []).forEach(function (d) {
        var line = el("div", "plan-dline");
        line.innerHTML = "<span>" + esc(d.label) + '</span><span class="mono">' + esc(d.meta) + "</span>";
        dbody.appendChild(line);
      });
      detail.appendChild(dbody);
      node.appendChild(head);
      node.appendChild(detail);
      head.addEventListener("click", function () {
        row.open = !row.open;
        node.classList.toggle("closed", !row.open);
      });
      var entry = {
        row: row,
        node: node,
        badge: head.querySelector(".plan-badge"),
        meta: head.querySelector(".plan-meta"),
        pillSlot: head.querySelector(".plan-pills")
      };
      paint(entry);
      byKey[row.key] = entry;
      wrap.appendChild(node);
    });

    return {
      el: wrap,
      setRow: function (key, patch) {
        var entry = byKey[key];
        if (!entry) return;
        Object.keys(patch || {}).forEach(function (k) { entry.row[k] = patch[k]; });
        paint(entry);
      }
    };
  }

  /* Scripted sample run: thinking trace plus plan rows plus a sample answer.
     Treated as illustrative data, never as real results. */
  function playDemo(root, helpers) {
    var row = el("div", "msg assistant demo");
    row.innerHTML = '<div class="demo-note">Sample run with sample data.</div><div class="msg-body"></div>';
    root.appendChild(row);
    var body = row.querySelector(".msg-body");
    body.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
    helpers.refreshIcons();
    helpers.pin();

    var trace = mountTrace(row, { active: "Thinking" });
    helpers.refreshIcons();
    var plan = null;
    var step1 = null;
    var step2 = null;
    var dead = false;

    function retryCompare() {
      if (!plan || dead) return;
      plan.setRow("compare", { status: "running", step: 3, progress: 30, meta: "retrying", open: true });
      helpers.refreshIcons();
      helpers.pin();
      setTimeout(function () {
        if (dead) return;
        plan.setRow("compare", { status: "done", meta: "3 picks", open: false });
        helpers.refreshIcons();
        helpers.pin();
      }, 1400);
    }

    var beats = [
      [650, function () {
        step1 = trace.addRow({ kind: "step", primary: "Reading the request" });
      }],
      [1350, function () {
        trace.setStep(step1, true);
        step2 = trace.addRow({ kind: "step", primary: "Planning search queries" });
      }],
      [2200, function () {
        trace.setStep(step2, true);
        trace.setStatus("Searching the web");
        trace.addRow({ kind: "query", primary: "best gaming phones under 300000 naira", mono: true });
        plan = mountPlan(row, {
          onRetry: function (key) { if (key === "compare") retryCompare(); },
          rows: [
            { key: "gather", label: "Gather candidates", meta: "8 phones", status: "done", open: false,
              details: [{ label: "Discovery queries", meta: "3" }, { label: "Sources read", meta: "11" }] },
            { key: "verify", label: "Verify prices", meta: "0 of 8", status: "running", step: 2, progress: 0, open: false,
              details: [{ label: "Jumia NG listings", meta: "4" }, { label: "Slot listings", meta: "2" }] },
            { key: "compare", label: "Compare and answer", meta: "waiting", status: "pending", step: 3, progress: 0, open: false,
              details: [{ label: "Shortlist", meta: "3" }, { label: "Sources cited", meta: "3" }] }
          ]
        });
      }],
      [2900, function () {
        trace.addRow({ primary: "GSMArena", secondary: "gsmarena.com", href: "https://www.gsmarena.com/" });
        trace.addRow({ primary: "Jumia NG", secondary: "jumia.com.ng", href: "https://www.jumia.com.ng/" });
        trace.addRow({ primary: "Slot Systems", secondary: "slot.ng", href: "https://slot.ng/" });
        trace.setMore(5);
        plan.setRow("verify", { meta: "6 of 8", progress: 66, open: true });
      }],
      [4300, function () {
        plan.setRow("verify", { status: "done", meta: "8 of 8", open: false });
        plan.setRow("compare", { status: "failed", meta: "no verdict", open: true });
      }],
      [5600, function () {
        retryCompare();
      }],
      [7000, function () {
        trace.settle();
        body.innerHTML = helpers.renderMarkdown(
          "Gaming phones under \u20A6300,000, from the sample run.\n\n" +
          "**Redmi Note 13 Pro 5G** (Dimensity 7200 Ultra) around \u20A6285,000 on Jumia NG. " +
          "Strong sustained performance for the price.\n\n" +
          "**Tecno Camon 30 Pro** (Dimensity 8200) around \u20A6270,000 at Slot. " +
          "Best chip in this bracket, weaker update policy.\n\n" +
          "**Infinix GT 20 Pro** (Dimensity 8200 Ultimate) around \u20A6295,000. " +
          "Built for gaming, ships with a cooling case.\n\n" +
          "Sources: GSMArena, Jumia NG, Slot Systems."
        );
      }]
    ];

    beats.forEach(function (beat) {
      setTimeout(function () {
        if (dead || !row.isConnected) {
          dead = true;
          return;
        }
        beat[1]();
        helpers.refreshIcons();
        helpers.pin();
      }, beat[0]);
    });
  }

  window.NovaTrace = {
    mountTrace: mountTrace,
    mountPlan: mountPlan,
    playDemo: playDemo
  };
})();
