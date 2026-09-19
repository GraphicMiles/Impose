/* Per-account workspace persistence.

   The workspace used to live in one device-global localStorage key,
   shared by every identity that ever opened this browser. This module
   makes the workspace belong to the signed-in account:

   - Backend is the durable store: one row per user in
     public.workspace_state (migration 0016), written through the
     save_workspace RPC. It syncs across devices.
   - localStorage is a transient per-account cache. It exists so the
     app boots instantly and survives flaky networks; it is never the
     record of truth and it is removed on sign-out.
   - Provider API keys are sealed with AES-GCM before they are written
     anywhere (cache or backend). Default tier: a random per-account
     wrapping key that never leaves this device. Optional tier: a
     wrapping key derived from a passphrase (PBKDF2), where nothing at
     all is stored and the keys stay locked until the passphrase is
     entered. The server only ever sees ciphertext.

   Identity comes from the Supabase session stored by the auth SDK,
   read synchronously so the app can boot without waiting on a network
   round trip. */
(function () {
  "use strict";

  var CFG = window.BotoConfig || {};
  var CACHE_PREFIX = "impose.cache.";
  var WSK_PREFIX = "impose.wsk.";
  var LEGACY_KEY = "impose.clone.v1";
  var PUSH_DEBOUNCE_MS = 0;

  /* ---------- small utilities ---------- */

  function b64(bytes) {
    var s = "";
    var u = new Uint8Array(bytes);
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  function unb64(s) {
    var raw = atob(String(s || ""));
    var u = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
    return u;
  }
  function webCrypto() {
    return ((typeof globalThis !== "undefined" && globalThis.crypto) || window.crypto) || null;
  }
  function subtleCrypto() {
    var c = webCrypto();
    return (c && c.subtle) ? c.subtle : null;
  }
  function randomBytes(n) {
    var u = new Uint8Array(n);
    var c = webCrypto();
    if (c && c.getRandomValues) c.getRandomValues(u);
    return u;
  }

  /* ---------- identity ---------- */

  /* The auth SDK stores the live session under sb-<ref>-auth-token.
     Reading it directly (instead of asking the SDK) keeps this module
     usable before supabase.min.js has loaded, and gives a synchronous
     identity at boot. */
  function sessionInfo() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf("sb-") === 0 && k.indexOf("-auth-token") > -1) {
          var v = JSON.parse(localStorage.getItem(k));
          if (v && v.access_token && v.user && v.user.id) return v;
        }
      }
    } catch (e) { /* unreadable session: treat as signed out */ }
    return null;
  }
  function userId() {
    var s = sessionInfo();
    return s ? s.user.id : null;
  }

  function configured() {
    return !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  }

  /* "account": signed in, so the workspace belongs to that account.
     "local": no session. The app keeps its previous device-local demo
     behaviour so ACCESS_MODE=open deployments still work offline. */
  function accountMode() {
    return !!userId();
  }

  /* ---------- per-account cache ---------- */

  function cacheKey(uid) { return CACHE_PREFIX + (uid || "anon"); }

  function readCache(uid) {
    try {
      var raw = localStorage.getItem(cacheKey(uid));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && parsed.v === 2 && parsed.data) return parsed;
      return null;
    } catch (e) { return null; }
  }

  function writeCache(uid, wrapper) {
    /* Throws on quota errors: the caller owns the rescue (image trim). */
    localStorage.setItem(cacheKey(uid), JSON.stringify(wrapper));
  }

  function removeCache(uid) {
    try { localStorage.removeItem(cacheKey(uid)); } catch (e) { /* gone anyway */ }
  }

  /* Clean up caches that belong to accounts no longer signed in here.
     Called with the uid that is staying; everything else goes. */
  function sweepCaches(keepUid) {
    try {
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf(CACHE_PREFIX) === 0 && k !== cacheKey(keepUid)) drop.push(k);
      }
      drop.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* best effort */ }
  }

  function hasLegacyBlob() {
    try {
      var raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return false;
      var parsed = JSON.parse(raw);
      return !!(parsed && Array.isArray(parsed.chats));
    } catch (e) { return false; }
  }
  function readLegacy() {
    try { return JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); }
    catch (e) { return null; }
  }
  function removeLegacy() {
    try { localStorage.removeItem(LEGACY_KEY); localStorage.removeItem("nova.clone.v1"); }
    catch (e) { /* already gone */ }
  }

  /* ---------- key wrapping (AES-GCM) ---------- */

  function importAes(rawB64) {
    return subtleCrypto().importKey("raw", unb64(rawB64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  /* Default tier: a random 256-bit wrapping key per account, kept in
     this browser only. The backend never receives it, so a database
     breach yields ciphertext without the key. Honest caveat: anyone
     with full access to this signed-in browser profile can decrypt,
     because the key sits beside the lock; that is inherent to any
     client-side decryption. The passphrase tier removes even that. */
  function deviceKey(uid, createIfMissing) {
    var storeKey = WSK_PREFIX + uid;
    var raw = null;
    try { raw = localStorage.getItem(storeKey); } catch (e) { /* private mode */ }
    if (!raw) {
      if (!createIfMissing) return Promise.resolve(null);
      raw = b64(randomBytes(32));
      try { localStorage.setItem(storeKey, raw); } catch (e) { return Promise.resolve(null); }
    }
    return importAes(raw);
  }

  function removeDeviceKey(uid) {
    try { localStorage.removeItem(WSK_PREFIX + uid); } catch (e) { /* best effort */ }
  }

  /* Passphrase tier: PBKDF2 -> AES-GCM. Same parameters as the
     encrypted backup format so both locks feel identical. */
  function passphraseKey(passphrase, saltB64) {
    var sub = subtleCrypto();
    return sub.importKey("raw", new TextEncoder().encode(String(passphrase || "")), "PBKDF2", false, ["deriveKey"])
      .then(function (material) {
        return sub.deriveKey(
          { name: "PBKDF2", salt: unb64(saltB64), iterations: 200000, hash: "SHA-256" },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]);
      });
  }

  function newSalt() { return b64(randomBytes(16)); }

  function sealText(plain, key) {
    var iv = randomBytes(12);
    return subtleCrypto().encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plain))
      .then(function (enc) { return { v: 1, iv: b64(iv), ct: b64(enc) }; });
  }
  function openText(blob, key) {
    return subtleCrypto().decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ct))
      .then(function (dec) { return new TextDecoder().decode(dec); });
  }

  /* Sealed copy: apiKey replaced by keyEnc. The in-memory state keeps
     the plaintext for live use; only the serialized form is sealed. */
  function sealProviders(providers, key) {
    var chain = Promise.resolve([]);
    (providers || []).forEach(function (p) {
      chain = chain.then(function (out) {
        if (!p || (typeof p.apiKey !== "string") || !p.apiKey) {
          /* No live key to seal. Keep keyEnc untouched: for a locked
             provider it is the only surviving form of the key. */
          out.push(Object.assign({}, p));
          return out;
        }
        return sealText(p.apiKey, key).then(function (blob) {
          var sealed = Object.assign({}, p, { keyEnc: blob });
          delete sealed.apiKey;
          out.push(sealed);
          return out;
        });
      });
    });
    return chain;
  }

  function openProviders(providers, key) {
    var chain = Promise.resolve([]);
    (providers || []).forEach(function (p) {
      chain = chain.then(function (out) {
        if (!p || !p.keyEnc || typeof p.apiKey === "string") { out.push(p); return out; }
        return openText(p.keyEnc, key).then(function (plain) {
          var opened = Object.assign({}, p, { apiKey: plain });
          delete opened.keyEnc;
          out.push(opened);
          return out;
        }, function () {
          out.push(p); /* wrong key or corrupt blob: stays locked */
          return out;
        });
      });
    });
    return chain;
  }

  /* The key used for writing. Passphrase mode requires an unlocked key
     in memory (set via setUnlockedKey); if the user has not unlocked
     yet this session, providers are written without their keys rather
     than re-encrypting with the wrong key - the next save after unlock
     restores them. */
  var unlockedPassphraseKey = null;
  function setUnlockedKey(key) { unlockedPassphraseKey = key; }

  function writeKey(uid, settings) {
    if (!subtleCrypto()) return Promise.resolve(null);
    var mode = settings && settings.keyMode === "passphrase" ? "passphrase" : "device";
    if (mode === "passphrase") return Promise.resolve(unlockedPassphraseKey);
    return deviceKey(uid, true);
  }

  function anySealedProvider(providers) {
    for (var i = 0; i < (providers || []).length; i++) {
      if (providers[i] && providers[i].keyEnc && typeof providers[i].apiKey !== "string") return true;
    }
    return false;
  }

  /* The relay key mints workspace grants and sends mail: it is the most
     powerful credential the workspace can hold, and it used to travel
     plaintext through the cache and the backend blob while the provider
     keys beside it were sealed. Same treatment now. */
  function sealSettings(settings, key) {
    if (!settings || typeof settings.relayKey !== "string" || !settings.relayKey) {
      /* No live key: keep relayKeyEnc as the surviving sealed form. */
      return Promise.resolve(settings);
    }
    return sealText(settings.relayKey, key).then(function (blob) {
      var sealed = Object.assign({}, settings, { relayKeyEnc: blob });
      delete sealed.relayKey;
      return sealed;
    });
  }

  function openSettings(settings, key) {
    if (!settings || !settings.relayKeyEnc || typeof settings.relayKey === "string") {
      return Promise.resolve(false);
    }
    return openText(settings.relayKeyEnc, key).then(function (plain) {
      settings.relayKey = plain;
      delete settings.relayKeyEnc;
      return true;
    }, function () { return false; /* wrong key: stays locked */ });
  }

  /* ---------- persistence ---------- */

  var lastRev = 0;
  var pushTimer = null;
  var pushing = false;
  var pendingPayload = null;

  /* Called when a save is refused because another device wrote first
     (stale_workspace from migration 0019). Receives the remote copy and
     a keepMine() that re-pushes this device's payload as an informed
     overwrite. The app decides what the person sees. */
  var onConflict = null;
  function setConflictHandler(fn) { onConflict = fn; }

  function client() {
    /* The shared SDK client handles token refresh; reuse it whenever it
       exists. Falls back to raw REST for contexts where the SDK never
       loaded. */
    if (window.__imposeSupabaseClient) return window.__imposeSupabaseClient;
    if (window.BotoData && BotoData.db) {
      try { return BotoData.db(); } catch (e) { /* fall through */ }
    }
    if (window.supabase && supabase.createClient) {
      window.__imposeSupabaseClient = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      return window.__imposeSupabaseClient;
    }
    return null;
  }

  function pull(uid) {
    var c = client();
    if (!c) return Promise.resolve(null);
    return c.from("workspace_state").select("data,rev").limit(1).maybeSingle()
      .then(function (res) {
        if (res && res.data && res.data.data) {
          return { data: res.data.data, rev: res.data.rev || 0 };
        }
        return null;
      }, function () { return null; });
  }

  function push(uid, payloadObj, force) {
    var c = client();
    if (!c) return Promise.resolve(null);
    /* The rev this device last saw travels with the write. The database
       refuses the save if another device wrote since (stale_workspace),
       which is the difference between losing a workspace silently and
       asking the person in front of it. force=true is the informed
       overwrite after they chose "keep mine". */
    var args = { p_data: payloadObj,
                 p_expected_rev: (force || !lastRev) ? null : lastRev };
    return c.rpc("save_workspace", args).then(function (res) {
      if (res && res.error) {
        var msg = String(res.error.message || "");
        /* An unupgraded database does not know p_expected_rev yet.
           Retry the old shape rather than failing every save. */
        if (/save_workspace/.test(msg) && /function|schema cache/i.test(msg)) {
          return c.rpc("save_workspace", { p_data: payloadObj });
        }
        return res;
      }
      return res;
    }).then(function (res) {
      if (res && res.error) throw res.error;
      var rev = res && res.data && res.data.rev;
      if (rev) {
        lastRev = Math.max(lastRev, rev);
        /* Bring the cache's rev up to the backend's. persist() wrote the
           cache before this push knew its rev, so without this a tab that
           closes between the two would boot one rev behind and do one
           needless adopt-and-reload. */
        try {
          var cached = readCache(uid);
          if (cached && (cached.rev || 0) < lastRev) {
            cached.rev = lastRev;
            writeCache(uid, cached);
          }
        } catch (e) { /* cache rev drift is cosmetic */ }
      }
      return rev || null;
    });
  }

  /* A refused save means another device holds a newer rev. Fetch that
     copy and hand both to the app; swallowing the refusal here would be
     the same silent loss the CAS exists to prevent. */
  function handleStale(uid, payload) {
    return pull(uid).then(function (remote) {
      if (remote && remote.rev) lastRev = remote.rev;
      if (onConflict) {
        try {
          onConflict(remote, function keepMine() {
            return push(uid, payload, true).catch(function () { return null; });
          });
        } catch (e) { /* the handler is advisory */ }
        return null;
      }
      /* No handler registered: adopt the server's rev and re-push this
         payload as the newer write. Last-write-wins, but at a known rev
         instead of blind. */
      return push(uid, payload, true).catch(function () { return null; });
    });
  }

  function isStale(err) {
    return !!err && /stale_workspace/i.test(String(err.message || err));
  }

  function schedulePush(uid, payloadObj) {
    pendingPayload = payloadObj;
    if (pushTimer) return;
    pushTimer = setTimeout(function () {
      pushTimer = null;
      var payload = pendingPayload;
      pendingPayload = null;
      if (!payload || !userId()) return;
      pushing = true;
      push(uid, payload).catch(function (err) {
        if (isStale(err)) return handleStale(uid, payload);
        /* Offline or transient failure: the payload stays in the local
           cache and the next save pushes it. */
      }).then(function () { pushing = false; });
    }, PUSH_DEBOUNCE_MS);
  }

  function flushNow() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    var payload = pendingPayload;
    pendingPayload = null;
    var uid = userId();
    if (payload && uid) {
      return push(uid, payload).catch(function (err) {
        if (isStale(err)) return handleStale(uid, payload);
        return null;
      });
    }
    return Promise.resolve(null);
  }

  /* Serialize + seal + cache + push. Throws quota errors upward so the
     caller can trim images and retry, exactly like the local path. */
  function persist(payloadObj) {
    var uid = userId();
    if (!uid) return Promise.resolve();
    var copy = {
      chats: payloadObj.chats,
      providers: payloadObj.providers,
      folders: payloadObj.folders,
      outbox: payloadObj.outbox,
      library: payloadObj.library || [],
      memories: payloadObj.memories || [],
      settings: Object.assign({}, payloadObj.settings || {})
    };
    return writeKey(uid, copy.settings).then(function (key) {
      if (!key || !subtleCrypto()) return copy;
      return sealProviders(copy.providers, key).then(function (sealed) {
        copy.providers = sealed;
        return sealSettings(copy.settings, key);
      }).then(function (sealedSettings) {
        copy.settings = sealedSettings;
        return copy;
      });
    }).then(function (sealedCopy) {
      writeCache(uid, { v: 2, rev: lastRev, data: sealedCopy }); /* may throw quota */
      schedulePush(uid, sealedCopy);
    });
  }

  /* ---------- boot ---------- */

  /* Returns the account payload if the cache holds one. Providers may be
     sealed; unlockProviders runs right after boot. */
  function bootPayload() {
    var uid = userId();
    if (!uid) return null;
    var cached = readCache(uid);
    if (cached) { lastRev = cached.rev || 0; return cached.data; }
    return null;
  }

  /* Backend wins when it is newer than the cache (another device wrote
     since). Returns the fresher payload or null when the cache stands. */
  function pullIfNewer(adopt) {
    var uid = userId();
    if (!uid || !configured()) return Promise.resolve(false);
    return pull(uid).then(function (remote) {
      if (!remote || !remote.data) return false;
      if ((remote.rev || 0) > lastRev) {
        lastRev = remote.rev || 0;
        var wrapped = { v: 2, rev: lastRev, data: remote.data };
        try { writeCache(uid, wrapped); } catch (e) { /* cache is optional */ }
        adopt(remote.data);
        return true;
      }
      return false;
    });
  }

  /* Take the other device's copy: cache it and let the caller reload so
     the whole engine boots from it, same path as pullIfNewer. */
  function adoptRemote(remote) {
    var uid = userId();
    if (!uid || !remote || !remote.data) return false;
    lastRev = remote.rev || lastRev;
    try { writeCache(uid, { v: 2, rev: lastRev, data: remote.data }); }
    catch (e) { /* cache is optional; the backend copy stands */ }
    return true;
  }

  /* Unlock provider keys for this session. Returns the number of
     providers that became usable. */
  function unlockProviders(providers, settings, uid) {
    var sealedRelay = !!(settings && settings.relayKeyEnc && typeof settings.relayKey !== "string");
    if (!anySealedProvider(providers) && !sealedRelay) return Promise.resolve(0);
    if (!subtleCrypto()) return Promise.resolve(0);
    var mode = settings && settings.keyMode === "passphrase" ? "passphrase" : "device";
    var keyPromise = mode === "passphrase"
      ? Promise.resolve(unlockedPassphraseKey)
      : deviceKey(uid, true);
    return keyPromise.then(function (key) {
      if (!key) return 0;
      return openProviders(providers, key).then(function (opened) {
        var gained = 0;
        for (var i = 0; i < opened.length; i++) {
          var before = providers[i];
          if (before && before.keyEnc && typeof before.apiKey !== "string" && typeof opened[i].apiKey === "string") gained++;
          providers[i] = opened[i];
        }
        if (!sealedRelay) return gained;
        return openSettings(settings, key).then(function (openedRelay) {
          return gained + (openedRelay ? 1 : 0);
        });
      });
    });
  }

  /* Turn the passphrase tier on: derive the wrapping key from the new
     passphrase and hold it in memory so the next save seals provider
     keys with it. The salt lives in settings and syncs with the blob. */
  function armPassphraseLock(passphrase, saltB64) {
    if (String(passphrase || "").length < 8) return Promise.reject(new Error("Use a passphrase of at least 8 characters."));
    return passphraseKey(passphrase, saltB64).then(function (key) {
      setUnlockedKey(key);
      return true;
    });
  }

  function unlockWithPassphrase(providers, settings, passphrase) {
    if (!settings || !settings.keySalt) return Promise.reject(new Error("No passphrase lock is set."));
    return passphraseKey(passphrase, settings.keySalt).then(function (key) {
      return openProviders(providers, key).then(function (opened) {
        var gained = 0;
        for (var i = 0; i < opened.length; i++) {
          if (opened[i] && typeof opened[i].apiKey === "string" && providers[i] && providers[i].keyEnc) gained++;
        }
        if (!gained && anySealedProvider(providers)) throw new Error("That passphrase could not unlock the keys.");
        setUnlockedKey(key);
        for (var j = 0; j < opened.length; j++) providers[j] = opened[j];
        return openSettings(settings, key).then(function (openedRelay) {
          return gained + (openedRelay ? 1 : 0);
        });
      });
    });
  }

  /* Sign-out: the session that owned this cache is over. The durable
     copy stays safely in the backend for the next sign-in; the device
     keeps nothing. uidBefore is captured before the SDK clears the
     session token, and the caller flushes pending writes BEFORE the
     session ends (afterwards userId() is null and pushes are no-ops). */
  function signOutReset(uidBefore) {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    pendingPayload = null;
    if (uidBefore) {
      removeCache(uidBefore);
      sweepCaches(null);
    }
    unlockedPassphraseKey = null;
    lastRev = 0;
  }

  window.WSync = {
    userId: userId,
    configured: configured,
    accountMode: accountMode,
    bootPayload: bootPayload,
    pullIfNewer: pullIfNewer,
    persist: persist,
    flushNow: flushNow,
    setConflictHandler: setConflictHandler,
    adoptRemote: adoptRemote,
    unlockProviders: unlockProviders,
    unlockWithPassphrase: unlockWithPassphrase,
    armPassphraseLock: armPassphraseLock,
    setUnlockedKey: setUnlockedKey,
    anySealedProvider: anySealedProvider,
    newSalt: newSalt,
    signOutReset: signOutReset,
    sweepCaches: sweepCaches,
    hasLegacyBlob: hasLegacyBlob,
    readLegacy: readLegacy,
    removeLegacy: removeLegacy,
    removeDeviceKey: removeDeviceKey
  };
})();
