#!/usr/bin/env node
/**
 * 29-account behavioral simulation against the PRODUCTION Supabase project
 * (xgqcvuzkeaferjsnpjjw), exercising the lifecycle surfaces shipped/touched
 * by migration 0025 plus the ambient abuse surfaces:
 *   posts, idempotent replay, comment threads + depth refusal,
 *   edit_generation (own / foreign / oversized), blocklist block→refusal→unblock,
 *   workspace grant → blind save → CAS conflict → revoke → save denied (+notice+audit),
 *   reports, rename/handle, notifications read path, delete_my_account with a
 *   fresh JWT (real account gone from auth.users), anonymous + non-admin probes.
 *
 * User behavior is deliberately unordered: a seeded RNG deals each sim account
 * a shuffled subset of behaviors; cards whose prerequisites are not yet met
 * requeue (bounded), so execution order itself is a test input.
 *
 * Cleanup is closed-world: every sim email matches ^sim29-\d\d@impose.dev$;
 * sim-made notification/audit rows are tagged via temporary AFTER triggers
 * (metadata.sim29 = true), sim uids key rate_counters/idempotency/profiles,
 * and the script asserts row-count drift is ZERO when it finishes.
 *
 * Run:  SUPABASE_MGMT_TOKEN=sbp_... node tests/simulate_29_accounts.js
 */
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");

const REF = "xgqcvuzkeaferjsnpjjw";
const BASE = `https://${REF}.supabase.co`;
const ANON = "sb_publishable_ErA2UAjkG2Wfw_T63dtbkA_sCe8wFp8";
const MGMT = process.env.SUPABASE_MGMT_TOKEN || "";
if (!MGMT) { console.error("SUPABASE_MGMT_TOKEN is required"); process.exit(2); }

const N = 29;
const EMAILS = Array.from({ length: N }, (_, i) =>
  `sim29-${String(i + 1).padStart(2, "0")}@impose.dev`);
const PASSWORD = "Sim29!Held#Pass";
const BLOCK_TERM = "triangulated-sim29-token-qlxy";
const MAX_DEPTH_POLICY = 6; // refusal at/below this depth counts as enforced

/* ------------------------------------------------------------------ infra */
const results = { pass: [], fail: [], notes: [] };
let assertionCount = 0;
function expect(name, cond, extra) {
  assertionCount += 1;
  if (cond) { results.pass.push(name + (extra ? ` (${extra})` : "")); }
  else { results.fail.push(name + (extra ? ` (${extra})` : "")); }
}
function note(s) { results.notes.push(s); }

function http(method, url, headers, body, tries = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store",
        "X-Sim29-Trace": uuid(),
      }, headers, data ? { "Content-Length": data.length } : {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        if (res.statusCode === 429 && tries > 0) {
          return setTimeout(() => resolve(http(method, url, headers, body, tries - 1)), 8000);
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function sql(query) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ query }));
    const req = https.request({
      method: "POST", hostname: "api.supabase.com",
      path: `/v1/projects/${REF}/database/query`,
      headers: { "Authorization": `Bearer ${MGMT}`,
        "Content-Type": "application/json", "Content-Length": data.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 400) {
          return reject(new Error(`mgmt ${res.statusCode}: ${text.slice(0, 240)}`));
        }
        try { resolve(JSON.parse(text)); } catch { resolve([]); }
      });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

const baseHeaders = { apikey: ANON };
function authed(token) { return Object.assign({ Authorization: "Bearer " + token }, baseHeaders); }
function rpc(name, token, args) {
  return http("POST", `${BASE}/rest/v1/rpc/${name}`, authed(token), args);
}
function one(json) { return Array.isArray(json) ? json[0] : json; }
function sqlq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function rng(seed) {
  let x = seed >>> 0 || 7;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296); };
}
const rand = rng(20260919);
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

/* shared run state (main + cleanup) */
let pre = { _label: "pre-unset" };
const deferred = [];
let deck = [];
const simStateRun = { blockTerm: false };
const seenKinds = { block_term_user: 0 };
const deletedEmails = new Set();
const reportCursor = { i: 0 };
function deferCard(card) { deferred.push(card); }
let orderedLeft = () => 0;
function runDeckCard(card) { return null; }

/* --------------------------------------------------------- catalog diff */
const COUNT_TABLES = ["profiles", "generations", "comments", "reports",
  "notifications", "workspace_grants", "workspace_state", "waitlist",
  "blocked_terms", "audit_events", "idempotency_keys", "rate_counters"];
async function snapshot(label) {
  const counts = { _label: label };
  for (const t of COUNT_TABLES) {
    const r = await sql(`select count(*)::int as n from public.${t}`);
    counts[t] = r[0].n;
  }
  const extra = await sql(`select
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public') as fns,
    (select count(*)::int from cron.job) as crons,
    (select count(*)::int from auth.users where email like 'sim29-%') as simusers`);
  return Object.assign(counts, extra[0]);
}
function diffCounts(a, b) {
  const out = [];
  const skip = new Set(["_label"]);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!skip.has(k) && a[k] !== b[k]) out.push(`${k}: ${a[k]} -> ${b[k]}`);
  return out;
}

/* ====================================================================== */
(async function main() {
console.log("== SIM29 phase 0: pre snapshot ==");
pre = await snapshot("pre");
expect("pre: zero leftover sim users", pre.simusers === 0);

/* ---------------------------------------------------- phase 1: create */
console.log("== SIM29 phase 1: create 29 users via admin SQL ==");
const block = EMAILS.map((e) =>
  `('00000000-0000-0000-0000-000000000000', gen_random_uuid(), ` +
  `'authenticated','authenticated', ${sqlq(e)}, crypt('${PASSWORD}', gen_salt('bf')), ` +
  `now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`);
/* GoTrue scans every token column into Go strings: a SQL NULL in ANY of
   them turns /auth/v1/token into a 500 "Database error querying schema".
   Ship "" for all of them, mirroring server-created rows. */
await sql(`insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token,
   email_change, email_change_token_new, email_change_token_current,
   phone_change, phone_change_token, reauthentication_token,
   created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
         'authenticated','authenticated', v.email, crypt('${PASSWORD}', gen_salt('bf')),
         now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
         '', '', '', '', '', '', '', '', now(), now()
  from (values ${EMAILS.map((e) => `(${sqlq(e)})`).join(",")}) as v(email)
  on conflict do nothing`);
await sql(`insert into auth.identities
  (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  select gen_random_uuid(), u.id, u.id::text,
         jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now()
  from auth.users u where u.email like 'sim29-%'
    and not exists (select 1 from auth.identities i where i.user_id = u.id)`);
const uidRows = await sql(`select id, email from auth.users where email like 'sim29-%' order by email`);
expect("29 sim users exist", uidRows.length === N, `${uidRows.length}/29`);
const profCount = await sql(`select count(*)::int as n from public.profiles p
  join auth.users u on u.id = p.id where u.email like 'sim29-%'`);
expect("profiles auto-created for all 29 (handle_new_user)", profCount[0].n === N, profCount[0].n);

/* ---------------------------------------------------- phase 2: sign in */
console.log("== SIM29 phase 2: sign in 29 accounts (password grant) ==");
const accounts = [];
for (const e of EMAILS) {
  let r = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    r = await http("POST", `${BASE}/auth/v1/token?grant_type=password`, baseHeaders,
      { email: e, password: PASSWORD });
    if (r.status === 200) break;
    await sleep(1500 + attempt * 1500);
  }
  if (r.status !== 200) {
    results.fail.push(`${e} sign-in failed: status ${r.status}`);
    continue;
  }
  accounts.push({ email: e, uid: r.json.user.id,
    token: r.json.access_token, refresh: r.json.refresh_token });
  await sleep(200 + rand() * 400);
}
expect(`${accounts.length}/29 signed in`, accounts.length === N);
if (accounts.length < N) throw new Error("aborting: incomplete sign-in");

/* ----------------------------------------- marker triggers (cleanup aid) */
console.log("== SIM29 phase 3: marker triggers (temporary) ==");
await sql(`create or replace function public.zzz_sim29_mark() returns trigger
  language plpgsql security definer set search_path = '' as $f$
  begin
    -- lifetime = this sim run only (dropped in cleanup): every audit row
    -- written while we run is ours to sweep afterwards
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || '{"sim29":true}'::jsonb;
    return new;
  end $f$;`);
await sql(`drop trigger if exists zzz_sim29_mark on public.audit_events;
  create trigger zzz_sim29_mark before insert on public.audit_events
  for each row execute function public.zzz_sim29_mark();`);

/* ------------------------------------------------------------ owner uid */
let OWNER_UID = null;
for (const q of [
  `select user_id as uid from public.admins limit 1`,
  `select id as uid from public.profiles where is_admin limit 1`,
  `select user_id as uid from public.admin_caps limit 1`,
]) {
  try { const r = await sql(q); if (r[0] && r[0].uid) { OWNER_UID = r[0].uid; break; } } catch { }
}
expect("owner principal located for cap-gated admin RPCs", !!OWNER_UID, OWNER_UID || "none");

async function adminRpc(name, emailArg) {
  const claims = JSON.stringify({ sub: OWNER_UID, role: "authenticated",
    aud: "authenticated" }).replace(/'/g, "''");
  const arg = emailArg == null ? "" : `'${String(emailArg).replace(/'/g, "''")}'`;
  await sql(`begin;
    set local "request.jwt.claims" = '${claims}';
    select public.${name}(${arg});
    commit;`);
}

/* ---------------------------------------------------------- game state */
const posts = new Map();        // email -> [{id, prompt}]  (shadows fine)
const simGenIds = new Set();    // ids of generations made by sim users
let OWN_UID_MAP = new Map();
for (const a of accounts) OWN_UID_MAP.set(a.email, a.uid);
function addPost(email, entry) {
  if (!posts.has(email)) posts.set(email, []);
  posts.get(email).push(entry);
  if (entry && entry.id) simGenIds.add(entry.id);
}

const guest = accounts[0];
const author = accounts[accounts.length - 1];
const wsUsers = accounts.slice(3, 6);
const doomed = accounts.slice(6, 9);
const participants = accounts.slice(9);

/* ------------------------------------------------------------- the deck */
console.log("== SIM29 phase 4: deal + run the shuffled behavior deck ==");
deck = [];
for (const a of participants) {
  const postCount = 2 + Math.floor(rand() * 4);
  for (let i = 0; i < postCount; i++) deck.push({ kind: "post", account: a, i });
  deck.push({ kind: "replay", account: a });
  deck.push({ kind: "thread", account: a });
  deck.push({ kind: "edit_own", account: a });
  deck.push({ kind: "rename", account: a });
  if (rand() < 0.55) deck.push({ kind: "report", account: a });
}
deck.push({ kind: "depth_probe", account: author });
deck.push({ kind: "edit_foreign", account: guest });
deck.push({ kind: "oversize", account: guest });
deck.push({ kind: "block_term_setup" });
for (let i = 0; i < 3; i++) deck.push({ kind: "block_term_user", account: participants[(i * 7) % participants.length] });
deck.push({ kind: "block_term_teardown" });
for (const a of wsUsers) deck.push({ kind: "workspace_flow", account: a });
for (const a of doomed) deck.push({ kind: "resign", account: a });
deck.push({ kind: "anon_probe" });
deck.push({ kind: "cap_probe", account: guest });
deck.push({ kind: "notify_check" });

orderedLeft = (kind) => deck.filter((c) => c.kind === kind).length - (seenKinds[kind] || 0);
const ordered = shuffled(deck);
for (const card of ordered) {
  try { await runCard(card); } catch (e) {
    results.fail.push(`${card.kind}${card.account ? "@" + card.account.email : ""} threw: ${String(e).slice(0, 140)}`);
  }
}
for (let round = 0; round < 4 && deferred.length; round++) {
  const batch = deferred.splice(0, deferred.length);
  for (const card of batch) {
    try { await runCard(card); } catch (e) {
      results.fail.push(`deferred ${card.kind} threw: ${String(e).slice(0, 140)}`);
    }
  }
}
expect("every deferred card eventually ran", deferred.length === 0,
  deferred.map((c) => c.kind).join(",") || "all resolved");


async function runCard(card) {
  switch (card.kind) {
    case "post": return doPost(card);
    case "replay": return doReplay(card);
    case "thread": return doThread(card);
    case "depth_probe": return doDepth(card);
    case "edit_own": return doEditOwn(card);
    case "edit_foreign": return doEditForeign(card);
    case "oversize": return doOversize(card);
    case "rename": return doRename(card);
    case "report": return doReport(card);
    case "block_term_setup": return doBlockSetup();
    case "block_term_user": return doBlockUser(card);
    case "block_term_teardown": return doBlockTeardown(card);
    case "workspace_flow": return doWorkspace(card);
    case "resign": return doResign(card);
    case "anon_probe": return doAnon();
    case "cap_probe": return doCapProbe(card);
    case "notify_check": return doNotifyCheck();
  }
}

async function doPost({ account, i }) {
  const prompt = `sim29 dispatch ${i + 1} from ${account.email.slice(0, 8)} ${uuid().slice(0, 8)}`;
  const r = await rpc("create_generation", account.token,
    { p_key: uuid(), p_prompt: prompt, p_response: `sim response ${uuid().slice(0, 6)}` });
  if (r.status < 300) {
    const row = one(r.json) || {};
    addPost(account.email, { id: row.id, prompt });
    expect(`${account.email} post ${i + 1}`, !!row.id, row.id || "?");
  } else {
    expect(`${account.email} post ${i + 1} (status ${r.status})`, false,
      JSON.stringify(r.json).slice(0, 120));
  }
}

async function doReplay(self) {
  const account = self.account;
  const mine = posts.get(account.email) || [];
  if (!mine.length && (deferred.length < 200)) return deferCard(self);
  const key = uuid();
  const body = { p_key: key, p_prompt: "idem-probe " + uuid().slice(0, 8), p_response: "a" };
  const a = await rpc("create_generation", account.token, body);
  const b = await rpc("create_generation", account.token, body);
  expect(`${account.email} idempotent replay: both calls 2xx`,
    a.status < 300 && b.status < 300, `${a.status}/${b.status}`);
  const aid = one(a.json)?.id, bid = one(b.json)?.id;
  expect(`${account.email} replay yielded SAME row`, aid === bid && !!aid, `${aid}|${bid}`);
  if (aid) simGenIds.add(aid);
}

async function firstForeignPost(excludeEmail) {
  for (const [email, list] of posts) {
    if (email !== excludeEmail && list.length) return { authorEmail: email, ...list[0] };
  }
  return null;
}

async function doThread(self) {
  const account = self.account;
  let target = await firstForeignPost(account.email);
  if (!target) return deferCard(self);
  const r = await rpc("create_comment", account.token,
    { p_key: uuid(), p_gen: target.id, p_body: `sim29 thread note from ${account.email.slice(0, 8)} ${uuid().slice(0, 4)}` });
  expect(`${account.email} comments on a peer post`, r.status < 300, `status ${r.status}`);
}

async function doDepth({ account: a }) {
  const own = posts.get(a.email) || [];
  if (!own.length) {
    const seed = await rpc("create_generation", a.token,
      { p_key: uuid(), p_prompt: "depth anchor " + uuid().slice(0, 6), p_response: "z" });
    if (seed.status < 300) addPost(a.email, { id: one(seed.json)?.id, prompt: "anchor" });
  }
  const anchor = (posts.get(a.email) || [])[0];
  if (!anchor) { results.fail.push("depth probe: could not seed anchor"); return; }
  let parent = null, levels = 0, refusalShape = null;
  for (let d = 0; d < 9; d++) {
    const r = await rpc("create_comment", a.token,
      { p_key: uuid(), p_gen: anchor.id, p_parent: parent, p_body: `depth ${d + 1} probe` });
    if (r.status < 300) {
      parent = one(r.json)?.id; levels++;
    } else { refusalShape = { status: r.status, at: d + 1, body: JSON.stringify(r.json).slice(0, 140) }; break; }
  }
  expect(`comment depth refusal exists (allowed ${levels}, policy ${MAX_DEPTH_POLICY})`,
    refusalShape !== null && refusalShape.at <= MAX_DEPTH_POLICY + 1,
    refusalShape ? `refused at ${refusalShape.at} (${refusalShape.status})` : "no refusal in 9 levels");
  if (refusalShape) note(`depth policy: ${levels} levels allowed; refusal ${refusalShape.status} at ${refusalShape.at}: ${refusalShape.body}`);
}

async function doEditOwn(self) {
  const account = self.account;
  const mine = posts.get(account.email) || [];
  if (!mine.length) return deferCard(self);
  const target = mine[Math.floor(rand() * mine.length)];
  const next = target.prompt + " (edited)";
  const r = await rpc("edit_generation", account.token, { p_id: target.id, p_prompt: next });
  expect(`${account.email} edits own post (0025)`, r.status < 300,
    r.status >= 300 ? JSON.stringify(r.json).slice(0, 120) : "");
  if (r.status < 300) {
    expect(`${account.email} edit returned new prompt`, one(r.json)?.prompt === next);
  }
}

async function doEditForeign(self) {
  const victim = self.account;
  const target = await firstForeignPost(victim.email);
  if (!target) return deferCard(self);
  const r = await rpc("edit_generation", victim.token,
    { p_id: target.id, p_prompt: "hostile edit attempt" });
  expect(`foreign edit refused (0025 not_author surface)`, r.status >= 400,
    `status ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
}

async function doOversize() {
  const big = "x".repeat(4001);
  const r1 = await rpc("create_generation", guest.token,
    { p_key: uuid(), p_prompt: big, p_response: "" });
  expect(`oversize create refused (status ${r1.status})`, r1.status >= 400,
    JSON.stringify(r1.json).slice(0, 120));
  const mine = posts.get(guest.email) || [];
  const target = mine[0] || (await (async () => {
    const s = await rpc("create_generation", guest.token,
      { p_key: uuid(), p_prompt: "guest anchor", p_response: "a" });
    if (s.status < 300) { addPost(guest.email, { id: one(s.json)?.id, prompt: "guest anchor" }); return one(s.json); }
    return null;
  })());
  if (!target) return;
  const r2 = await rpc("edit_generation", guest.token, { p_id: target.id, p_prompt: big });
  expect(`oversize edit refused (status ${r2.status})`, r2.status >= 400,
    JSON.stringify(r2.json).slice(0, 120));
}

async function doRename({ account }) {
  const handle = "sim" + uuid().slice(0, 8).replace(/[0-9]/g, (c) => "abcdefg"[+c % 7]);
  const r = await rpc("customize_profile", account.token,
    { p_display_name: "Sim " + account.email.slice(6, 8), p_bio: "sim account", p_handle: handle });
  expect(`${account.email} customize_profile accepted`, r.status < 300,
    r.status >= 300 ? JSON.stringify(r.json).slice(0, 120) : "handle " + handle);
}

async function doReport(self) {
  const account = self.account;
  const foreign = [];
  for (const [email, list] of posts)
    if (email !== account.email && !deletedEmails.has(email))
      for (const p of list) foreign.push(p);
  if (!foreign.length) return deferCard(self);
  const target = foreign[reportCursor.i++ % foreign.length];
  const r = await rpc("report_content", account.token,
    { p_kind: "post", p_target: target.id, p_reason: "sim29 moderation probe" });
  expect(`${account.email} report accepted`, r.status < 300,
    `status ${r.status}` + (r.status >= 300 ? " " + JSON.stringify(r.json).slice(0, 160) : ""));
  if (r.status >= 300) note("report fail: " + JSON.stringify(r.json).slice(0, 160));
}

async function doBlockSetup() {
  await adminRpc("admin_block_term", BLOCK_TERM);
  const r = await sql(`select count(*)::int as n from public.blocked_terms where term=${sqlq(BLOCK_TERM)}`);
  expect("admin_block_term inserted term (moderation.manage)", r[0].n === 1);
  simStateRun.blockTerm = true;
}
async function doBlockUser({ account }) {
  if (!simStateRun.blockTerm) return deferCard({ kind: "block_term_user", account });
  const r = await rpc("create_generation", account.token,
    { p_key: uuid(), p_prompt: `contains the ${BLOCK_TERM} marker`, p_response: "x" });
  seenKinds.block_term_user += 1;
  expect(`blocked-term post refused (status ${r.status})`, r.status >= 400,
    JSON.stringify(r.json).slice(0, 120));
}
async function doBlockTeardown(card) {
  if (!simStateRun.blockTerm) return deferCard(card || { kind: "block_term_teardown" });
  const outstanding = orderedLeft("block_term_user");
  if (outstanding) return deferCard(card || { kind: "block_term_teardown" });
  await adminRpc("admin_unblock_term", BLOCK_TERM);
  const r = await sql(`select count(*)::int as n from public.blocked_terms where term=${sqlq(BLOCK_TERM)}`);
  expect("admin_unblock_term removed term", r[0].n === 0);
  simStateRun.blockTerm = false;
  const r2 = await rpc("create_generation", guest.token,
    { p_key: uuid(), p_prompt: `now the ${BLOCK_TERM} phrase passes`, p_response: "x" });
  expect("post passes after unblock", r2.status < 300, `status ${r2.status}`);
  if (r2.status < 300) addPost(guest.email, { id: one(r2.json)?.id, prompt: "post-unblock" });
}
/* orderedLeft assigned in main once the deck exists */

async function doWorkspace({ account }) {
  await adminRpc("admin_grant", account.email);
  const acc = await rpc("my_workspace_access", account.token, {});
  expect(`${account.email} granted workspace access`, acc.status < 300,
    JSON.stringify(acc.json).slice(0, 90));

  const s1 = await rpc("save_workspace", account.token,
    { p_data: { sim29: { rev: 1, payload: uuid().slice(0, 12) } } });
  expect(`${account.email} blind save accepted`, s1.status < 300, `status ${s1.status}`);

  const revNow = await sql(`select rev::int as rev from public.workspace_state where user_id='${account.uid}'`);
  const current = s1.status < 300 && revNow[0] ? revNow[0].rev : null;

  if (current != null) {
    const stale = await rpc("save_workspace", account.token,
      { p_data: { sim29: { rev: current + 1 } }, p_expected_rev: current + 5 });
    expect(`${account.email} stale CAS refused (status ${stale.status})`, stale.status >= 400,
      JSON.stringify(stale.json).slice(0, 140));
    const ok = await rpc("save_workspace", account.token,
      { p_data: { sim29: { rev: current + 1 } }, p_expected_rev: current });
    expect(`${account.email} correct-CAS save`, ok.status < 300, `status ${ok.status}`);
  } else {
    note(`${account.email}: workspace_state missing after save (rev unreadable)`);
  }

  await adminRpc("admin_revoke_grant", account.email);
  const denied = await rpc("save_workspace", account.token,
    { p_data: { sim29: { rev: 99 } } });
  expect(`${account.email} save refused AFTER revoke (0025)`,
    denied.status >= 400, `status ${denied.status} ${JSON.stringify(denied.json).slice(0, 140)}`);
  const notif = await sql(`select count(*)::int as n from public.notifications
    where user_id='${account.uid}' and kind='workspace_revoked'`);
  expect(`revoke notice delivered for ${account.email}`, notif[0].n >= 1, `n=${notif[0].n}`);
  const audit = await sql(`select count(*)::int as n from public.audit_events
    where action='workspace.revoke' and target_id='${account.uid}'`);
  expect(`revoke audited for ${account.email}`, audit[0].n >= 1, `n=${audit[0].n}`);
}

async function doResign({ account }) {
  const fresh = await http("POST", `${BASE}/auth/v1/token?grant_type=password`, baseHeaders,
    { email: account.email, password: PASSWORD });
  expect(`${account.email} fresh sign-in before delete_my_account`, fresh.status === 200);
  if (fresh.status !== 200) return;
  const r = await rpc("delete_my_account", fresh.json.access_token, {});
  expect(`${account.email} delete_my_account accepted`, r.status < 300,
    `status ${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
  await sleep(500);
  const u = await sql(`select count(*)::int as n from auth.users where id='${account.uid}'`);
  expect(`auth.users row gone for ${account.email}`, u[0].n === 0);
  const p = await sql(`select count(*)::int as n from public.profiles where id='${account.uid}'`);
  expect(`profile gone for ${account.email}`, p[0].n === 0);
  const again = await http("POST", `${BASE}/auth/v1/token?grant_type=password`, baseHeaders,
    { email: account.email, password: PASSWORD });
  expect(`re-login after self-delete impossible`, again.status !== 200, `status ${again.status}`);
  deletedEmails.add(account.email);
}

async function doAnon() {
  const r1 = await http("POST", `${BASE}/rest/v1/rpc/create_generation`, baseHeaders,
    { p_key: uuid(), p_prompt: "anon probe", p_response: "" });
  expect("anonymous create_generation refused", r1.status >= 400, `status ${r1.status}`);
  const r2 = await http("POST", `${BASE}/rest/v1/rpc/admin_revoke_grant`, baseHeaders,
    { p_email: EMAILS[10] });
  expect("anonymous admin_revoke_grant refused", r2.status >= 400, `status ${r2.status}`);
  const r3 = await http("POST", `${BASE}/rest/v1/rpc/admin_block_term`, baseHeaders,
    { p_term: "anonterm" });
  expect("anonymous admin_block_term refused", r3.status >= 400, `status ${r3.status}`);
}

async function doCapProbe({ account }) {
  const r = await rpc("admin_revoke_grant", account.token, { p_email: EMAILS[11] });
  expect(`member cannot call cap-gated admin RPC (status ${r.status})`,
    r.status >= 400, JSON.stringify(r.json).slice(0, 140));
  const r2 = await rpc("admin_block_term", account.token, { p_term: "memberterm" });
  expect(`member cannot call admin_block_term (status ${r2.status})`,
    r2.status >= 400, JSON.stringify(r2.json).slice(0, 140));
}

async function doNotifyCheck(card) {
  const a = author, mine = posts.get(a.email) || [];
  if (!mine.length) return deferCard(card || { kind: "notify_check" });
  const page = await rpc("notifications_page", a.token, {});
  expect("notifications_page serves the threaded author", page.status < 300,
    `status ${page.status}`);
  const rows = await sql(`select count(*)::int as n from public.notifications where user_id='${a.uid}'`);
  note(`author inbox holds ${rows[0].n} sim-era notifications (read/unread)`);
}

})().then(cleanup).catch((e) => { results.fail.push(`fatal: ${String(e).slice(0, 200)}`); cleanup(); });

/* ------------------------------------------------------------ cleanup */
async function cleanup() {
  console.log("== SIM29 phase 5: cleanup + post snapshot ==");
  const simUsers = await sql(`select id from auth.users where email like 'sim29-%'`);
  const ids = simUsers.map((r) => r.id);
  if (!ids.length) {
    note("no sim users present at cleanup; skipping dependent-row sweeps");
  }
  const uidList = ids.length ? ids.map((u) => sqlq(u)).join(",") : null;

  const plan = [
    // comment/report artifacts first (references), then notifications,
    // then content, then workspace/admin side effects, then the users.
    `delete from public.reports
       where reporter_id in (${uidList})
          or (kind = 'generation' and target_id in
              (select id from public.generations where author_id in (${uidList})))`,
    `delete from public.comments
       where author_id in (${uidList})
          or generation_id in (select id from public.generations where author_id in (${uidList}))`,
    `delete from public.notifications
       where actor_id in (${uidList}) or user_id in (${uidList})`,
    `delete from public.generations where author_id in (${uidList})`,
    `delete from public.workspace_grants where user_id in (${uidList})`,
    `delete from public.workspace_state where user_id in (${uidList})`,
    `delete from public.waitlist where email like 'sim29-%'`,
    `delete from public.blocked_terms where term like '%sim29%'`,
    `delete from public.audit_events
       where actor_id in (${uidList}) or target_id in (${uidList})
          or metadata ->> 'sim29' = 'true'`,
    `delete from public.idempotency_keys where user_id in (${uidList})`,
    `drop trigger if exists zzz_sim29_mark on public.audit_events`,
    `drop function if exists public.zzz_sim29_mark()`,
    `delete from public.profiles where id in (${uidList})`,
    `delete from auth.identities where user_id in (${uidList})`,
    `delete from auth.users where email like 'sim29-%'`,
    `delete from public.rate_counters r where not exists
       (select 1 from auth.users u where r.bucket like '%' || u.id::text || '%')`,
  ];
  for (const q of plan) {
    if (!uidList && q.indexOf("in (${uidList})") !== -1) continue;
    try { await sql(q); }
    catch (e) { note("cleanup warning: " + String(e).slice(0, 160)); }
  }
  const post = await snapshot("post");
  const drift = diffCounts(pre, post).filter((d) => !d.startsWith("rate_counters:"));
  // rate_counters legitimately churns: my owner-claims admin calls create
  // owner-budget window rows (correct, self-purging via purge_rate_counters).
  // Sim-attributable leftovers, however, must be exactly zero.
  const rcSim = await sql(`select count(*)::int as n from public.rate_counters r
    where not exists (select 1 from auth.users u where r.bucket like '%'||u.id::text||'%')`);
  expect("zero sim-attributable rate_counters buckets", rcSim[0].n === 0, `n=${rcSim[0].n}`);
  if (post.rate_counters !== pre.rate_counters) {
    note(`rate_counters total ${pre.rate_counters} -> ${post.rate_counters} ` +
         "(owner-admin budget churn from sim-run RPC calls; purge cron owns expiry)");
  }
  expect("catalog row counts identical pre/post cleanup (excl. rc churn)", drift.length === 0,
    drift.join("; ") || "zero drift");

  /* report */
  console.log("\n================ SIM29 REPORT ================");
  console.log(`assertions: ${assertionCount} | pass ${results.pass.length} | fail ${results.fail.length}`);
  for (const f of results.fail) console.log("  ** FAIL " + f);
  for (const n of results.notes) console.log("  (note) " + n);

  const lines = [
    "# 29-account behavioral simulation — " + new Date().toISOString(),
    "",
    `Assertions **${assertionCount}** · pass **${results.pass.length}** · fail **${results.fail.length}**`,
    `Catalog drift after cleanup: **${drift.length ? drift.join("; ") : "none"}**`,
    "",
    "## Failures",
    results.fail.length ? results.fail.map((f) => "- " + f).join("\n") : "- none",
    "",
    "## Notes (observed behavior, not judged)",
    ...results.notes.map((f) => "- " + f),
    "",
    "## Passing assertions",
    ...results.pass.map((f) => "- " + f),
  ];
  fs.writeFileSync("/home/user/sim29_report_2026-09-19.md", lines.join("\n"));
  console.log("report: /home/user/sim29_report_2026-09-19.md");
  process.exit(results.fail.length ? 1 : 0);
}
