/* Auth transport. The only place that talks to Supabase or the relay.

   auth.js stays presentation: it validates shapes, moves between views and
   renders errors. Everything that decides whether a credential is real
   happens here, and mostly on a server.

   Two backends, deliberately:

     SUPABASE   owns accounts, passwords and sessions. It is the authority
                on identity. Nothing here mints a session locally.

     RELAY      owns the one-time codes, because emailing them needs a
                credential the browser must never hold.

   Verifying a code proves control of an inbox. It does not sign anyone in.
   The session still comes from Supabase, checked against its own records,
   so a tampered response from the code endpoint buys an attacker nothing.

   Degraded mode: with no SUPABASE_URL configured the module reports
   `configured() === false` and auth.js keeps the previous local-only
   behaviour. That keeps the demo deployable while the project is being set
   up, and it is why every call here fails loudly rather than silently
   pretending to succeed. */
(function () {
  "use strict";

  var cfg = window.BotoConfig || {};
  var SESSION_KEY = "impose.auth.v1";
  var client = null;

  function configured() {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  }

  function relayBase() {
    var url = String(cfg.RELAY_URL || "").trim();
    return url.replace(/\/+$/, "");
  }

  /* Lazily built so a missing SDK does not break page load. */
  function supabase() {
    if (client) return client;
    if (!configured()) throw new Error("Accounts are not configured yet.");
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error("Could not reach the accounts service. Check your connection.");
    }
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    return client;
  }

  /* Supabase messages are written for developers and occasionally leak
     whether an address exists. Translate to something a person can act on,
     and keep the enumeration-safe wording. */
  function humanize(error) {
    var raw = String((error && (error.message || error.error_description)) || "");
    var low = raw.toLowerCase();
    if (!raw) return "Something went wrong. Try again.";
    if (low.indexOf("invalid login") !== -1 || low.indexOf("invalid credentials") !== -1) {
      return "That email and password do not match.";
    }
    if (low.indexOf("already registered") !== -1 || low.indexOf("already exists") !== -1) {
      return "That address already has an account. Try signing in.";
    }
    if (low.indexOf("weak password") !== -1 || low.indexOf("password should") !== -1) {
      return "Pick a stronger password.";
    }
    if (low.indexOf("rate") !== -1 || low.indexOf("too many") !== -1) {
      return "Too many attempts. Wait a minute and try again.";
    }
    if (low.indexOf("failed to fetch") !== -1 || low.indexOf("networkerror") !== -1) {
      return "Could not reach the server. Check your connection.";
    }
    return raw;
  }

  function postJson(path, body) {
    var base = relayBase();
    if (!base) return Promise.reject(new Error("Verification is not configured yet."));
    return fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.detail || "That did not work. Try again.");
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error("Could not reach the server. Check your connection.");
    });
  }

  /* ---------- one-time codes ---------- */

  function requestCode(email, purpose) {
    return postJson("/v1/auth/otp/request", { email: email, purpose: purpose });
  }

  function verifyCode(email, purpose, code) {
    return postJson("/v1/auth/otp/verify", { email: email, purpose: purpose, code: code });
  }

  /* ---------- accounts ---------- */

  /* Creates the account, then asks for a code. Order matters: if the
     address is already taken we want to say so before an email goes out,
     and Supabase is the only thing that knows.

     Requires "Confirm email" to be OFF in the Supabase dashboard
     (Authentication, Sign In / Providers, Email). Left on, Supabase sends
     its own confirmation link and the user receives two emails for one
     signup: an unbranded link from Supabase and our code from Sendlib.
     Verification is ours to own, so Supabase's copy is the one that goes. */
  function signUp(email, password) {
    return supabase().auth.signUp({ email: email, password: password })
      .then(function (res) {
        if (res.error) throw new Error(humanize(res.error));
        return requestCode(email, "signup").then(function (out) { return out; });
      });
  }

  function signIn(email, password) {
    return supabase().auth.signInWithPassword({ email: email, password: password })
      .then(function (res) {
        if (res.error) throw new Error(humanize(res.error));
        cacheSession(res.data && res.data.user);
        return res.data;
      });
  }

  /* Reset asks for a code without revealing whether the account exists.
     The relay issues one either way; an address with no account simply
     never receives it. */
  function requestReset(email) {
    return requestCode(email, "reset");
  }

  /* A verified reset code is proof of inbox control, so we exchange it for
     a real session via Supabase's own OTP channel, then set the password.
     Without that exchange the client would be asserting its own
     authorisation, which is exactly what must not happen. */
  function completeReset(email, code, password) {
    return verifyCode(email, "reset", code).then(function () {
      return supabase().auth.verifyOtp({ email: email, token: code, type: "recovery" });
    }).then(function (res) {
      if (res.error) throw new Error(humanize(res.error));
      return supabase().auth.updateUser({ password: password });
    }).then(function (res) {
      if (res.error) throw new Error(humanize(res.error));
      return res.data;
    });
  }

  function signOut() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    if (!configured()) return Promise.resolve();
    return supabase().auth.signOut().catch(function () {});
  }

  function currentUser() {
    if (!configured()) return Promise.resolve(null);
    return supabase().auth.getUser().then(function (res) {
      return (res && res.data && res.data.user) || null;
    }).catch(function () { return null; });
  }

  /* A display-only copy for the shell's avatar and name. Never read for an
     authorisation decision: Supabase's session is the authority, and the
     server re-checks every write regardless. */
  function cacheSession(user) {
    if (!user) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        name: (user.user_metadata && user.user_metadata.name) || String(user.email || "").split("@")[0],
        email: user.email || "",
        id: user.id || "",
        signedInAt: Date.now()
      }));
    } catch (e) {}
  }

  window.BotoAuth = {
    configured: configured,
    humanize: humanize,
    requestCode: requestCode,
    verifyCode: verifyCode,
    signUp: signUp,
    signIn: signIn,
    requestReset: requestReset,
    completeReset: completeReset,
    signOut: signOut,
    currentUser: currentUser,
    cacheSession: cacheSession,
    SESSION_KEY: SESSION_KEY
  };
})();
