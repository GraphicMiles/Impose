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

  /* ---------- accounts ----------

     Nothing here creates an account or a session. The browser asks; the
     relay decides, after checking a code it delivered to the address. The
     earlier version called supabase.auth.signUp() from here and got a
     session back immediately, which made the code that followed it
     decorative: skipping it produced a working account.

     The session that arrives from the relay is a real Supabase session, so
     it is handed to the SDK rather than stored by hand. Supabase remains
     the authority on what a valid session is, and every later request is
     checked against its own records regardless of what this page believes. */

  /* Step one of signup: hand the address and password to the relay, which
     refuses taken addresses, holds the password encrypted, and emails a
     code. No account exists yet at this point. */
  function signUp(email, password) {
    return postJson("/v1/auth/otp/request", {
      email: email,
      password: password,
      purpose: "signup"
    });
  }

  /* Step two: the relay checks the code, creates the confirmed account and
     returns a session. This is the only path to an account. */
  function completeSignUp(email, code) {
    return verifyCode(email, "signup", code).then(function (out) {
      if (!out || !out.session || !out.session.access_token) {
        throw new Error("Verification did not complete. Request a new code.");
      }
      return adoptSession(out.session);
    });
  }

  /* Sign-in stays a direct Supabase call, and that is not an inconsistency:
     it proves possession of a password Supabase already holds, so Supabase
     is the right authority and there is nothing for the relay to add. */
  function signIn(email, password) {
    return supabase().auth.signInWithPassword({ email: email, password: password })
      .then(function (res) {
        if (res.error) throw new Error(humanize(res.error));
        cacheSession(res.data && res.data.user);
        return res.data;
      });
  }

  function requestReset(email) {
    return requestCode(email, "reset");
  }

  /* Reset verification returns a ticket, not a session: proof of inbox
     control that is good for one password change and can read nothing. The
     ticket is what the relay requires before it will set a password, so a
     browser that skips the code has nothing to present. */
  function verifyReset(email, code) {
    return verifyCode(email, "reset", code).then(function (out) {
      if (!out || !out.ticket) throw new Error("Verification did not complete. Request a new code.");
      return out.ticket;
    });
  }

  function completeReset(ticket, password) {
    return postJson("/v1/auth/password/reset", { ticket: ticket, password: password })
      .then(function (out) {
        if (!out || !out.session) throw new Error("Could not set the password. Request a new code.");
        return adoptSession(out.session);
      });
  }

  /* Install a relay-issued session into the SDK so the rest of the app,
     which asks Supabase for the current user, sees it. */
  function adoptSession(session) {
    if (!configured()) return Promise.resolve(session);
    return supabase().auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token
    }).then(function (res) {
      if (res.error) throw new Error(humanize(res.error));
      cacheSession((res.data && res.data.user) || (session && session.user));
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
    completeSignUp: completeSignUp,
    verifyReset: verifyReset,
    signIn: signIn,
    requestReset: requestReset,
    completeReset: completeReset,
    signOut: signOut,
    currentUser: currentUser,
    cacheSession: cacheSession,
    SESSION_KEY: SESSION_KEY
  };
})();
