/* BotoUI: the shared interaction kernel.
   One canonical implementation of the behaviors both surfaces use, so the
   workspace (app.js) and Community (community.js) can never drift into
   clashing copies of the same logic.

   Test contract: app.js keeps native escapeHtml/sanitizeUrl because the
   regression suite lifts those functions out of app.js source text and
   executes them in a bare VM. Everything else delegates here. */
(function () {
  "use strict";

  /* Autogrow a textarea to its content, capped. Shared by the workspace
     composer, the community composer, and every reply box. */
  function autogrow(ta, max) {
    if (!ta) return;
    /* A hidden textarea measures 0 and would be pinned to a 0px height
       (the collapsed-composer regression). Leave the natural height. */
    if (!ta.getClientRects().length) { ta.style.height = ""; return; }
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max || 200) + "px";
  }

  /* Escape a string for HTML interpolation. */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* The composer send-pair contract: a send button is enabled exactly when
     its textarea has trimmable content and the surface is not streaming. */
  function syncSend(input, sendBtn, busy) {
    if (!input || !sendBtn) return;
    sendBtn.disabled = !!busy || input.value.trim().length === 0;
  }

  /* Re-render lucide icons inside a subtree (or the document). */
  function refreshIcons(rootEl) {
    if (window.lucide && window.lucide.createIcons) {
      window.lucide.createIcons(rootEl ? { nameAttr: "data-lucide", attrs: {}, root: rootEl } : undefined);
    }
  }

  /* Compact relative time for feed rows: 42s, 7m, 3h, 5d, then a date. */
  function relativeTime(ts) {
    var d = typeof ts === "number" ? ts : Date.parse(ts);
    if (isNaN(d)) return "";
    var s = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 7 * 86400) return Math.floor(s / 86400) + "d";
    try { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
    catch (e) { return ""; }
  }

  window.BotoUI = {
    autogrow: autogrow,
    escapeHtml: escapeHtml,
    syncSend: syncSend,
    refreshIcons: refreshIcons,
    relativeTime: relativeTime
  };
})();
