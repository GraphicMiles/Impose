/* Round-trip test for workspace-sync.js, the per-account persistence and
   key-sealing layer. Stubs localStorage and a Supabase session, then runs
   the real module: device-tier sealing, boot unlock, passphrase tier,
   locked-save key preservation, and sign-out cache wipe. Any plaintext
   key reaching the cache fails the run. */
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  globalThis.crypto = require("node:crypto").webcrypto;
}
var fs = require("fs");
var path = require("path");
var store = {};
global.localStorage = {
  get length() { return Object.keys(store).length; },
  key: function (i) { return Object.keys(store)[i]; },
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};
// fake signed-in session for uid "u1"
store["sb-xgqcvuzkeaferjsnpjjw-auth-token"] = JSON.stringify({
  access_token: "fake-token", user: { id: "u1" }, expires_at: Math.floor(Date.now()/1000) + 3600
});
global.window = global;
global.BotoConfig = { SUPABASE_URL: "", SUPABASE_ANON_KEY: "" };  // unconfigured: no network paths
eval(fs.readFileSync(path.join(__dirname, "..", "workspace-sync.js"), "utf8"));

(async function () {
  var assert = require("assert");
  assert.strictEqual(WSync.userId(), "u1", "uid from session");
  assert.strictEqual(WSync.accountMode(), true, "account mode");

  var payload = {
    chats: [{ id: "c1", title: "Hello", messages: [] }],
    providers: [{ id: "p1", name: "OpenAI", authStyle: "bearer", apiKey: "sk-SECRET-123", model: "gpt-x" }],
    folders: [], outbox: [], library: [], memories: [],
    settings: { theme: "dark" }
  };

  // 1. device-tier persist seals the key in the cache
  await WSync.persist(JSON.parse(JSON.stringify(payload)));
  var cached = JSON.parse(store["impose.cache.u1"]);
  assert.strictEqual(cached.data.providers[0].apiKey, undefined, "no plaintext apiKey in cache");
  assert.ok(cached.data.providers[0].keyEnc && cached.data.providers[0].keyEnc.ct, "keyEnc present");
  assert.ok(Object.keys(store).join().indexOf("impose.wsk.u1") > -1, "device wrapping key created");
  assert.ok(store["impose.wsk.u1"].length >= 40, "wrapping key is 32 bytes b64");
  var leaked = JSON.stringify(cached);
  assert.ok(leaked.indexOf("sk-SECRET-123") === -1, "plaintext never serialized");

  // 2. boot + unlock restores it
  var boot = WSync.bootPayload();
  assert.strictEqual(boot.providers[0].apiKey, undefined, "boot payload still sealed");
  var gained = await WSync.unlockProviders(boot.providers, boot.settings, "u1");
  assert.strictEqual(gained, 1, "one key unlocked");
  assert.strictEqual(boot.providers[0].apiKey, "sk-SECRET-123", "round-trip plaintext restored");

  // 3. passphrase tier: arm lock, persist, then only the passphrase opens it
  boot.settings.keyMode = "passphrase";
  boot.settings.keySalt = WSync.newSalt();
  await WSync.armPassphraseLock("correct-horse-battery", boot.settings.keySalt);
  await WSync.persist(boot);
  cached = JSON.parse(store["impose.cache.u1"]);
  assert.ok(JSON.stringify(cached).indexOf("sk-SECRET-123") === -1, "passphrase-sealed cache has no plaintext");
  // fresh session: clear the in-memory unlocked key
  WSync.setUnlockedKey(null);
  var boot2 = WSync.bootPayload();
  var locked = WSync.anySealedProvider(boot2.providers);
  assert.strictEqual(locked, true, "sealed without unlock");
  var err = null;
  await WSync.unlockWithPassphrase(boot2.providers, boot2.settings, "wrong-passphrase").catch(function (e) { err = e; });
  assert.ok(err, "wrong passphrase rejected");
  await WSync.unlockWithPassphrase(boot2.providers, boot2.settings, "correct-horse-battery");
  assert.strictEqual(boot2.providers[0].apiKey, "sk-SECRET-123", "passphrase unlock restores key");

  // 4. locked provider survives a save while locked (no key loss):
  // fresh boot payload is still sealed, user edits chats without unlocking
  WSync.setUnlockedKey(null);
  var boot3 = WSync.bootPayload();
  boot3.chats.push({ id: "c2", title: "More", messages: [] });
  await WSync.persist(boot3);
  var cached2 = JSON.parse(store["impose.cache.u1"]);
  assert.ok(cached2.data.providers[0].keyEnc && cached2.data.providers[0].keyEnc.ct, "keyEnc preserved through locked save");
  assert.strictEqual(cached2.data.chats.length, 2, "chat edit landed");
  await WSync.unlockWithPassphrase(cached2.data.providers, cached2.data.settings, "correct-horse-battery");
  assert.strictEqual(cached2.data.providers[0].apiKey, "sk-SECRET-123", "key still recoverable after locked save");

  // 5. sign-out wipes the cache
  WSync.signOutReset("u1");
  assert.strictEqual(store["impose.cache.u1"], undefined, "cache removed on sign-out");
  assert.strictEqual(WSync.userId(), "u1", "session token untouched by WSync (SDK owns it)");

  console.log("WSYNC ROUND-TRIP: all assertions passed");
})().catch(function (e) { console.error("FAIL", e); process.exit(1); });
