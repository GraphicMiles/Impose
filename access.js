/* BotoAccess: who may enter the Workspace.
   Community is open to everyone; the Workspace is grant-gated. The client
   renders the gate, but the grant itself is authoritative server-side: the
   workspace_grants table is RLS-protected and every future workspace-bound
   API call re-checks ownership/access on the server. This module can never
   be the security boundary, only the UX for it (system-design rule: the
   client is untrusted).

   Talks to Supabase over plain REST (PostgREST + GoTrue): no SDK, matching
   the repo's zero-dependency approach.

   States: unknown -> checking -> granted | waitlisted | anonymous
   Failure mode: any network error degrades to the cached grant, or
   "checking" -> denied-with-retry. It never silently unlocks. */
(function () {
  "use strict";

  var GRANT_KEY = "impose.access.v1";
  var GRANT_TTL = 10 * 60 * 1000; /* trust a cached grant for 10 minutes */
  var state = "unknown";
  var stateFor = ""; /* mode `state` was computed under; guards a runtime flip */
  var grantCache = null;
  var listeners = [];

  function configured() {
    return !!(window.BotoConfig && window.BotoConfig.SUPABASE_URL && window.BotoConfig.SUPABASE_ANON_KEY);
  }

  function enforce() {
    /* Fail-closed: "enforce" gates even if the backend is not yet wired
       (nobody has a grant then); wire Supabase before flipping the mode. */
    return window.BotoConfig.ACCESS_MODE === "enforce";
  }

  function readCache() {
    try {
      var raw = JSON.parse(localStorage.getItem(GRANT_KEY) || "null");
      if (raw && raw.at && Date.now() - raw.at < GRANT_TTL) return raw;
    } catch (e) { /* fall through */ }
    return null;
  }

  function writeCache(grant) {
    try { localStorage.setItem(GRANT_KEY, JSON.stringify(grant)); } catch (e) { /* private mode */ }
  }

  function headers(extra) {
    var h = {
      "apikey": window.BotoConfig.SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + window.BotoConfig.SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  /* The signed-in user's token, if any. */
  function accessToken() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf("sb-") === 0 && k.indexOf("-auth-token") > -1) {
          var v = JSON.parse(localStorage.getItem(k));
          if (v && v.access_token && v.user) return v.access_token;
        }
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  function authedHeaders() {
    var tok = accessToken();
    if (!tok) return null;
    return headers({ "Authorization": "Bearer " + tok });
  }

  /* Ask the server for the truth: one RPC returns the caller's grant. */
  function refresh() {
    if (!enforce()) {
      state = "granted";
      stateFor = "open";
      return Promise.resolve({ status: "granted", mode: "open" });
    }
    stateFor = "enforce";
    var h = authedHeaders();
    if (!h) {
      state = "anonymous";
      grantCache = { status: "anonymous", at: Date.now() };
      writeCache(grantCache);
      notify();
      return Promise.resolve(grantCache);
    }
    return fetch(window.BotoConfig.SUPABASE_URL + "/rest/v1/rpc/my_workspace_access", {
      method: "POST", headers: h, body: "{}"
    }).then(function (r) {
      if (!r.ok) throw new Error("access check failed: " + r.status);
      return r.json();
    }).then(function (grant) {
      /* The RPC returns exactly one typed verdict; nothing else is trusted. */
      state = grant && grant.can_use_workspace ? "granted" : "waitlisted";
      grantCache = { status: state, email: grant.email || "", position: grant.waitlist_position || null, at: Date.now() };
      writeCache(grantCache);
      notify();
      return grantCache;
    }).catch(function () {
      /* Degraded: keep the last known grant; a stale MEMBER stays in,
         everyone else stays out. Never fail open. */
      var cached = readCache();
      if (cached && cached.status === "granted") { state = "granted"; notify(); return cached; }
      state = "unknown";
      notify();
      return { status: "unknown" };
    });
  }

  /* Idempotent join: the waitlist table has a unique email, so a retry or
     double-tap returns the same row (position included) instead of
     creating a duplicate. Rate limiting lives at the gateway (see the
     operations plan); the unique constraint is the last line of defense. */
  function joinWaitlist(email) {
    if (!enforce()) return Promise.resolve({ status: "granted", mode: "open" });
    var clean = String(email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return Promise.reject(new Error("Enter a valid email address."));
    }
    return fetch(window.BotoConfig.SUPABASE_URL + "/rest/v1/rpc/join_waitlist", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ p_email: clean })
    }).then(function (r) {
      if (r.status === 429) throw new Error("Too many attempts. Try again in a minute.");
      if (!r.ok) throw new Error("Could not join the waitlist. Try again.");
      return r.json();
    }).then(function (res) {
      grantCache = { status: "waitlisted", email: clean, position: res && res.position || null, at: Date.now() };
      writeCache(grantCache);
      state = "waitlisted";
      notify();
      return grantCache;
    });
  }

  function canUseWorkspace() {
    if (!enforce()) return true;
    if (state === "granted" && stateFor === "enforce") return true;
    var cached = readCache();
    return !!(cached && cached.status === "granted");
  }

  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach(function (fn) { try { fn(state, grantCache); } catch (e) {} }); }

  function getStatus() { return { state: state, grant: grantCache, enforce: enforce() }; }

  window.BotoAccess = {
    init: refresh,
    refresh: refresh,
    joinWaitlist: joinWaitlist,
    canUseWorkspace: canUseWorkspace,
    getStatus: getStatus,
    onChange: onChange
  };
})();
