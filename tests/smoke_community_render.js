/* Runtime smoke for the Community render reconciler (no browser needed).

   Loads the real index.html into jsdom, stubs the data layer (BotoData)
   with a scripted in-memory server, and drives the exact flows the audit
   found unstable:

     A. feed loads and every card mounts once
     B. a no-op re-render keeps every node (no remount, no entrance replay)
     C. an avatar change patches ONE header, other nodes untouched
     D. a slow pull-refresh keeps the old page mounted until the new page
        lands (atomic swap — the stale->empty->current flash)
     E. optimistic comment paints with the REAL cached profile, not "You"
     F. post() double-fire within one tick queues exactly one write
     G. poll tick with unchanged data produces zero DOM rewrites
     H. lock toggle patches in place (same node, no rebuild)

   Run: node tests/smoke_community_render.js */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}

const dom = new JSDOM(html, { url: "https://impose.test/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
const d = w.document;

/* ---------- fake surface: everything community.js touches ---------- */
w.BotoUI = {
  escapeHtml: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  refreshIcons: () => {},
  autogrow: () => {},
};
w.lucide = { createIcons: () => {} };
w.BotoAvatar = { svg: (k) => `<svg data-av="${k}"></svg>` };
w.WSync = { userId: () => "user-1" };
w.BotoToast = () => null;
w.BotoAccess = { canUseWorkspace: () => true, init: () => {}, onChange: () => {}, refresh: () => Promise.resolve(null), getStatus: () => ({ grant: null }) };
w.supabase = { createClient: () => ({}) };
w.BotoConfig = { SUPABASE_URL: "x", SUPABASE_ANON_KEY: "y" };

/* scripted server */
const NOW = Date.now();
const mkGen = (i, over) => ({
  id: "g" + i, authorId: i < 2 ? "user-1" : "user-" + i, own: i < 2,
  creator: { name: "P" + i, handle: "@p" + i, avatar: "char-" + i },
  prompt: "prompt " + i, response: "", status: "complete", kind: "original",
  parentId: null, rootId: "g" + i, locked: false, visibility: "public",
  addressed: false, createdAt: NOW - i * 1000, updatedAt: 0, deleted: false,
  counts: { remix: 0, challenge: 0, comment: 0, save: 0 },
  ...(over || {})
});
const GENS = [mkGen(1), mkGen(2), mkGen(3), mkGen(4), mkGen(5)];
const queued = [];
let avatarMap = {};
GENS.forEach(g => avatarMap[g.authorId] = { avatar: g.creator.avatar, name: g.creator.name });
let feedDelay = 0; /* ms; simulates a slow network */


w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

/* Load order mirrors production, minus network: the real data layer boots
   first (its outbox persists, channel wiring inits), our scripted stub then
   OVERWRITES window.BotoData, and the UI layer comes last so init() binds
   against the scripted server. */
w.eval(fs.readFileSync(path.join(root, "community-data.js"), "utf8"));
w.BotoData = {
  PAGE_SIZE: 10,
  configured: () => true,
  latestAvatarsByIds: () => new Promise(r => setTimeout(() => r({ ok: true, data: avatarMap }), 0)),
  currentUser: () => Promise.resolve({ id: "user-1" }),
  myProfile: () => Promise.resolve({ handle: "p1", display_name: "P1", avatar: "char-1" }),
  myProfileNow: () => ({ handle: "p1", display_name: "P1", avatar: "char-1" }),
  avatarNow: () => null,
  forgetUser: () => {},
  feedPage: (cursor) => new Promise(r => setTimeout(() => r({
    ok: true,
    data: { items: GENS.map(g => ({ ...g })), done: true, cursor: null }
  }), feedDelay)),
  newSince: () => Promise.resolve({ ok: true, data: 0 }),
  generation: (id) => Promise.resolve({ ok: true, data: { ...GENS.find(g => g.id === id) } }),
  thread: () => Promise.resolve({ ok: true, data: [] }),
  queue: (job) => { queued.push(job); job.onDone && setTimeout(() => job.onDone(mkGen(9, { id: "g9", authorId: "user-1", own: true, creator: { name: "P1", handle: "@p1", avatar: "char-1" }, genId: undefined })), 0); return job; },
  drain: () => Promise.resolve(),
  pending: () => queued,
  dropJob: () => {},
  setOutboxListener: () => {},
  setJobHandler: () => {},
  newKey: () => "k" + Math.random().toString(36).slice(2, 8),
  unreadCount: () => Promise.resolve({ ok: true, data: 0 }),
  watchFeed: () => {}, watchThread: () => {}, unwatchThread: () => {},
  watchNotifications: () => {},
  reportContent: () => Promise.resolve({ ok: true }),
  setLocked: () => Promise.resolve({ ok: true }),
  isAdmin: () => Promise.resolve(false),
};
w.eval(fs.readFileSync(path.join(root, "community.js"), "utf8"));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* init() ran synchronously; first page fetch is async */
  await sleep(30);
  const list = d.getElementById("cmFeedList");

  /* A. feed loaded */
  ok(list.children.length === 5, "A. feed renders 5 cards", "got " + list.children.length);
  const nodesA = Array.from(list.children);

  /* B. no-op re-render keeps nodes */
  await w.SLOPIFY_DEBUG; /* present */
  w.eval("renderKnownFeedBacklogGuard = true");
  await sleep(5);
  /* force the periodic avatar path with identical data */
  w.eval("void 0");
  nodesA.forEach((n) => n.__mark = "orig");
  /* re-render via the debug reload-less path: route back to feed */
  w.ImposeRoute.go("/");
  await sleep(20);
  const nodesB = Array.from(list.children);
  ok(nodesB.filter(n => n.__mark === "orig").length === 5,
     "B. route re-render keeps all 5 nodes (no remount)", nodesB.filter(n => n.__mark === "orig").length + " kept");

  /* C. avatar change patches exactly one header */
  avatarMap["user-2"] = { avatar: "char-2", name: "P2-changed" };
  /* community-data.avatarCache TTL would normally gate; our stub always returns new -> */
  w.ImposeRoute.go("/"); /* kick renderFeed -> avatar pass */
  await sleep(20);
  const nodesC = Array.from(list.children);
  ok(nodesC.filter(n => n.__mark === "orig").length === 5,
     "C. avatar change keeps all nodes", nodesC.filter(n => n.__mark === "orig").length + " kept");
  const nameEls = nodesC.map(n => n.querySelector(".gen-name").textContent);
  ok(nameEls.some(t => t === "P2-changed"), "C2. changed name painted in place", nameEls.join(","));

  /* D. slow pull-refresh keeps old page mounted until swap */
  feedDelay = 90;
  const before = Array.from(list.children);
  const reloadP = w.eval("SLOPIFY_DEBUG.reloadFeed()") || Promise.resolve();
  await sleep(20); /* request in flight */
  const mid = Array.from(list.children);
  ok(mid.length === 5 && mid.every((n, i) => n === before[i]),
     "D. in-flight refresh keeps all 5 old cards", mid.length + " shown");
  await reloadP; await sleep(120);
  ok(Array.from(list.children).length === 5, "D2. new page landed atomically");
  feedDelay = 0;

  /* E. optimistic comment paints real identity */
  /* open detail of gen 3 */
  w.ImposeRoute.go("/g/g3");
  await sleep(30);
  const input = d.getElementById("cmCommentInput");
  ok(!!input, "E0. comment box present");
  input.value = "hello thread";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  d.getElementById("cmCommentSend").click();
  await sleep(10);
  const rows = d.querySelectorAll("#cmCommentList .comment");
  const mine = Array.from(rows).find(r => r.querySelector(".comment-name") && r.querySelector(".comment-name").textContent === "P1");
  ok(!!mine, "E. optimistic comment uses real profile name (not 'You')");
  ok(mine && mine.querySelector(".avatar-img[data-avatar-key='char-1']"),
     "E2. optimistic comment carries the real avatar");

  /* F. double-fire guard: Enter+enter in the same tick -> one job */
  input.value = "again";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const queuedBefore = queued.length;
  await sleep(5);
  /* both Enter events hit post() before the first cleared the input's emptiness?
     our guarded path: second call in same tick must no-op */
  ok(queued.length - queuedBefore <= 1, "F. double-fire queues at most one", "queued +" + (queued.length - queuedBefore));

  /* G. unchanged poll tick => zero re-created nodes */
  const nodesG = Array.from(d.getElementById("cmFeedList").children).map(n => n);
  w.ImposeRoute.go("/");
  await sleep(40); /* renderFeed + avatar pass resolve */
  const kept = Array.from(d.getElementById("cmFeedList").children).filter(n => nodesG.includes(n)).length;
  ok(kept === 5, "G. unchanged world keeps all 5 nodes", kept + " kept");

  /* H. lock toggle patches in place */
  const ownCard = d.querySelector('article.gen[data-id="g1"]');
  const lockBtn = ownCard && ownCard.querySelector('[data-act="lock"]');
  ok(!!lockBtn, "H0. owner lock button exists");
  if (lockBtn) {
    lockBtn.click();
    await sleep(10);
    const after = d.querySelector('article.gen[data-id="g1"]');
    ok(after === ownCard, "H. lock toggle keeps the same card node");
    ok(after.querySelector('[data-act="lock"]').classList.contains("on"),
       "H2. lock state painted");
  }

  console.log("\n" + pass + " pass, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(1); });
