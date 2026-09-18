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

  /* The relay's detail strings are written for whoever reads the logs, not
     for the person staring at a signup form. "accounts are not configured
     on the server" is true, unactionable, and reads as though the user did
     something wrong.

     text.txt 10: say what happened and what to do next, and keep the
     technical wording in the log where the debug panel already records it. */
  function humanizeRelay(status, detail) {
    var d = String(detail || "").toLowerCase();

    if (status === 503 || d.indexOf("not configured") !== -1) {
      /* A deployment gap, not a user error. Naming it as ours stops
         someone retyping a correct password five times. */
      return "Accounts are not switched on yet. This is on us, not you. " +
             "Try again shortly.";
    }
    if (status === 502 || d.indexOf("could not send") !== -1) {
      return "We could not send the email just now. Try again in a moment.";
    }
    if (status === 429) {
      return "Too many attempts. Wait a minute and try again.";
    }
    if (status === 409 || d.indexOf("already has an account") !== -1) {
      return "That address already has an account. Try signing in.";
    }
    if (d.indexOf("no longer available") !== -1 || d.indexOf("expired") !== -1) {
      return detail;
    }
    if (status >= 500) {
      return "Something went wrong on our side. Try again in a moment.";
    }
    /* 4xx that is genuinely about the input: the relay already words
       those for a person. */
    return detail || "That did not work. Try again.";
  }

  /* A request that never settles is worse than one that fails: the button
     stays disabled and the page waits forever. Measured on a relay that
     accepted the connection and never answered, the signup form was still
     locked after 22 seconds with nothing on screen to explain it.
     flow.txt 10 names this outright.

     AbortController rather than a bare timer, so the socket is released
     instead of being left to finish into a handler nobody is waiting on. */
  var REQUEST_TIMEOUT = 20000;

  function postJson(path, body) {
    var base = relayBase();
    if (!base) return Promise.reject(new Error("Verification is not configured yet."));

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT);

    var opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
    if (controller) opts.signal = controller.signal;

    return fetch(base + path, opts).then(function (res) {
      clearTimeout(timer);
      return res;
    }, function (err) {
      clearTimeout(timer);
      throw timedOut
        ? new Error("That took too long. Check your connection and try again.")
        : err;
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(humanizeRelay(res.status, data.detail));
          err.status = res.status;
          err.detail = data.detail || "";
          throw err;
        }
        return data;
      });
    }, function (err) {
      /* Preserve a message we already shaped. Overwriting it here turned a
         timeout into "could not reach the server", which is a different
         fact and sends the reader to check the wrong thing. */
      if (err && err.message && /took too long|already has an account|switched on/i.test(err.message)) {
        throw err;
      }
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

     Nothing here creates an account. The browser asks; the relay decides,
     after checking a code it delivered to the address. An earlier version
     called the SDK's own signup from here and got a session back
     immediately, which made the code that followed it decorative:
     skipping it produced a working account.

     Sessions still come from Supabase, through an ordinary sign-in once
     the relay has confirmed the address. Nothing here mints or installs a
     token, so Supabase remains the authority on what a valid session is
     and every later request is checked against its own records. */

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

  /* Step two: the relay checks the code and confirms the account, which
     is the flag that makes it usable. Then we sign in normally, because
     the relay does not mint sessions: Supabase stays the authority on what
     a valid session is, and the password is already in its hands. */
  function completeSignUp(email, code, password) {
    return verifyCode(email, "signup", code).then(function (out) {
      if (!out || !out.confirmed) {
        throw new Error("Verification did not complete. Request a new code.");
      }
      return signIn(email, password);
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

  function completeReset(ticket, password, email) {
    return postJson("/v1/auth/password/reset", { ticket: ticket, password: password })
      .then(function () {
        /* Signing in here proves the new password actually took, rather
           than trusting a 200 and stranding the user at a login that
           rejects them. */
        return signIn(email, password);
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

  var authListeners = [];
  function onAuthStateChange(fn) {
    if (typeof fn === "function") authListeners.push(fn);
  }

  function initAuthWatcher() {
    if (!configured()) return;
    try {
      supabase().auth.onAuthStateChange(function (event, session) {
        if (event === "SIGNED_OUT") {
          try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
          if (window.BotoAccess && BotoAccess.resetForSignOut) BotoAccess.resetForSignOut();
          if (window.BotoCommunity && BotoCommunity.signOutReset) BotoCommunity.signOutReset();
          if (window.BotoApp && BotoApp.onSignOut) BotoApp.onSignOut();
        } else if (session && session.user) {
          cacheSession(session.user);
          if (window.BotoAccess && BotoAccess.refresh) BotoAccess.refresh();
          if (window.BotoApp && BotoApp.onSignIn) BotoApp.onSignIn(session.user);
        }
        authListeners.forEach(function (fn) {
          try { fn(event, session); } catch (e) {}
        });
      });
    } catch (e) {}

    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", function (e) {
        if (e.key === SESSION_KEY || (e.key && e.key.indexOf("sb-") === 0 && e.key.indexOf("-auth-token") !== -1)) {
          if (!e.newValue) {
            try { localStorage.removeItem(SESSION_KEY); } catch (err) {}
            if (window.BotoAccess && BotoAccess.resetForSignOut) BotoAccess.resetForSignOut();
            if (window.BotoCommunity && BotoCommunity.signOutReset) BotoCommunity.signOutReset();
            if (window.BotoApp && BotoApp.onSignOut) BotoApp.onSignOut();
            authListeners.forEach(function (fn) {
              try { fn("SIGNED_OUT", null); } catch (err) {}
            });
          } else {
            try {
              var parsed = JSON.parse(e.newValue);
              var u = parsed.user || parsed;
              if (u) {
                cacheSession(u);
                if (window.BotoAccess && BotoAccess.refresh) BotoAccess.refresh();
                if (window.BotoApp && BotoApp.onSignIn) BotoApp.onSignIn(u);
                authListeners.forEach(function (fn) {
                  try { fn("SIGNED_IN", { user: u }); } catch (err) {}
                });
              }
            } catch (err) {}
          }
        }
      });
    }
  }

  initAuthWatcher();

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
    onAuthStateChange: onAuthStateChange,
    SESSION_KEY: SESSION_KEY
  };
})();
