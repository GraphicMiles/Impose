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

  /* ---------- profile display-name contract ---------- */

  /* One rule for every place a display name can be entered (profile modal,
     workspace identity), mirroring the server's word on it: length comes
     from customize_profile (2-40, at least one letter or digit), and since
     migration 0027 display names carry no emoji. Card and thread headers
     truncate long names instead of wrapping, so the length cap is also the
     readability budget. */
  var PROFILE_NAME_MIN = 2;
  var PROFILE_NAME_MAX = 40;
  var PROFILE_NAME_EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]/u;

  /* Returns { ok, value } on success or { ok: false, reason, message }
     with the exact words to show. Empty input is a separate answer from
     an invalid one: some editors treat it as "keep the current name". */
  function validProfileName(value) {
    var v = String(value || "").trim();
    if (!v) return { ok: false, reason: "empty", message: "Enter a display name." };
    if (v.length > PROFILE_NAME_MAX) return { ok: false, reason: "long", message: "Names are " + PROFILE_NAME_MAX + " characters at most." };
    if (v.length < PROFILE_NAME_MIN) return { ok: false, reason: "short", message: "Names need at least 2 characters." };
    if (PROFILE_NAME_EMOJI.test(v)) return { ok: false, reason: "emoji", message: "Emojis can't be used as names." };
    /* The database asks for an ASCII letter or digit (customize_profile),
       so the client asks for the same thing: a name the client accepts
       must never come back refused by the server. */
    if (!/[A-Za-z0-9]/.test(v)) return { ok: false, reason: "plain", message: "Add at least one letter or number." };
    return { ok: true, value: v };
  }

  window.BotoUI = {
    autogrow: autogrow,
    escapeHtml: escapeHtml,
    syncSend: syncSend,
    refreshIcons: refreshIcons,
    relativeTime: relativeTime,
    validProfileName: validProfileName,
    PROFILE_NAME_MAX: PROFILE_NAME_MAX
  };
})();
