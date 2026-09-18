/* The only place Community talks to the server.

   community.js renders and never imports the SDK. It asks this module for
   data and gets plain objects back in the shape it already uses, which is
   what keeps a backend swap from turning into edits at twenty-one
   scattered call sites.

   Three rules the rest of the app can rely on:

     THE SERVER IS CANONICAL. Nothing here computes a value the database
     also computes. Counts arrive derived; ids, timestamps and handles are
     whatever Postgres said. A cached row is display material, never an
     input to a later write.

     EVERY WRITE IS RETRYABLE. Each carries a client-generated idempotency
     key, so a retry after a timeout returns the original result instead of
     creating a second row. This is the one thing a flaky connection makes
     unavoidable: the request may have succeeded while the response was
     lost (architect 5.5).

     FAILURE IS A VALUE, NOT AN EXCEPTION. Every call resolves to
     { ok, data } or { ok:false, error, retryable }. Callers render a
     state; they never have to guess whether a rejection was the network,
     a policy, or a bug. flow.txt 10 and 11: no async action without a
     defined failure, and no raw technical text in front of a user.
*/
(function () {
  "use strict";

  var cfg = window.BotoConfig || {};
  var client = null;

  var PAGE_SIZE = 10;
  var REQUEST_TIMEOUT = 15000;

  function configured() {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
              window.supabase && window.supabase.createClient);
  }

  function db() {
    if (client) return client;
    if (!configured()) throw new Error("not_configured");
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    return client;
  }

  /* ---------- failure shaping ----------
     Postgres codes and PostgREST messages are for the log, not the reader.
     Each case below names what happened and what to do next, and says
     whether trying again is worth anything. */
  function shape(error) {
    var raw = (error && (error.message || error.error_description)) || "";
    var code = (error && (error.code || error.status)) || "";
    var text = String(raw);

    if (window.BotoDebug) window.BotoDebug.error("data", text, code ? "code " + code : "");

    if (/not_authenticated|42501|JWT/i.test(text + code)) {
      return { message: "Sign in to do that.", retryable: false, code: "auth" };
    }
    if (/idempotency_key_reused/i.test(text)) {
      return { message: "That looked like a duplicate. Nothing was posted twice.", retryable: false, code: "duplicate" };
    }
    if (/parent_gone/i.test(text)) {
      return { message: "The comment you were replying to is gone. Your draft was kept.", retryable: false, code: "parent_gone" };
    }
    if (/post_gone/i.test(text)) {
      return { message: "That post was removed while you were writing.", retryable: false, code: "post_gone" };
    }
    /* Check constraints before RLS. Both Postgres messages contain the
       word "violates", so matching on that alone told someone whose post
       was simply too long that they lacked permission: wrong, and it sends
       them to ask for access they already have. 23514 is a constraint,
       which is a fact about the input. */
    if (/check constraint|23514/i.test(text + code)) {
      if (/prompt/i.test(text)) {
        return { message: "That post is too long. Shorten it and try again.", retryable: false, code: "too_long" };
      }
      if (/body/i.test(text)) {
        return { message: "That comment is too long. Shorten it and try again.", retryable: false, code: "too_long" };
      }
      return { message: "Some of that could not be saved as written. Try shortening it.", retryable: false, code: "invalid" };
    }
    if (/row-level security|violates row-level/i.test(text)) {
      return { message: "You do not have permission to do that.", retryable: false, code: "denied" };
    }
    /* A null byte cannot be stored in a text column. Postgres calls this
       an "unsupported Unicode escape sequence", which means nothing to
       anyone typing into a box. */
    if (/unsupported unicode|invalid byte sequence|0x00/i.test(text)) {
      return { message: "That text contains a character we cannot store. Try retyping it.", retryable: false, code: "bad_text" };
    }
    if (/timeout|aborted/i.test(text)) {
      return { message: "That took too long. Check your connection and try again.", retryable: true, code: "timeout" };
    }
    if (/Failed to fetch|NetworkError|offline/i.test(text)) {
      return { message: "You appear to be offline.", retryable: true, code: "offline" };
    }
    /* Anything unrecognised is assumed transient: telling someone to retry
       a permanent failure wastes a tap, but telling them a transient one
       is permanent loses their work. */
    return { message: "Something went wrong. Try again in a moment.", retryable: true, code: "unknown" };
  }

  function fail(error) {
    var s = shape(error);
    return { ok: false, error: s.message, retryable: s.retryable, code: s.code };
  }

  /* A request that never settles is worse than one that fails: the UI
     spins forever and flow.txt 10 forbids exactly that. */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(fail({ message: "timeout" }));
      }, ms || REQUEST_TIMEOUT);

      promise.then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fail(err));
      });
    });
  }

  function run(builder) {
    if (!configured()) return Promise.resolve(fail({ message: "not_configured" }));
    var started = Date.now();
    return withTimeout(
      Promise.resolve(builder()).then(function (res) {
        if (res && res.error) return fail(res.error);
        if (window.BotoDebug) {
          window.BotoDebug.log("data", "ok in " + (Date.now() - started) + "ms");
        }
        return { ok: true, data: res ? res.data : null };
      })
    );
  }

  /* ---------- shape translation ----------
     The client model predates the schema and the rest of the app is built
     on it. Translating here, once, is cheaper and safer than renaming
     fields across a thousand lines of rendering. */
  function toGeneration(row, myId) {
    return {
      id: row.id,
      own: !!myId && row.author_id === myId,
      creator: {
        name: row.display_name || row.handle || "Someone",
        handle: row.handle ? "@" + String(row.handle).replace(/^@/, "") : "@someone"
      },
      prompt: row.prompt,
      response: row.response || "",
      status: row.status || "complete",
      kind: row.kind || "original",
      parentId: row.remix_of || null,
      rootId: row.root_id || row.id,
      locked: !!row.locked,
      visibility: row.visibility || "public",
      saved: !!row.saved_by_me,
      addressed: !!row.addressed,
      createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
      deleted: !!row.deleted_at,
      counts: {
        remix: row.remix_count || 0,
        challenge: row.challenge_count || 0,
        comment: row.comment_count || 0,
        save: row.save_count || 0
      }
    };
  }

  function toComment(row, myId) {
    return {
      id: row.id,
      genId: row.generation_id,
      parentId: row.parent_id || null,
      own: !!myId && row.author_id === myId,
      creator: {
        name: row.display_name || row.handle || "Someone",
        handle: row.handle ? "@" + String(row.handle).replace(/^@/, "") : "@someone"
      },
      text: row.body || "",
      createdAt: row.created_at ? Date.parse(row.created_at) : Date.now(),
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
      deleted: !!row.deleted_at
    };
  }

  /* ---------- identity ----------
     The profile is cached alongside the user because the write RPCs return
     a bare table row: `generations` has no handle column, so a freshly
     posted card would render "@someone" until something refetched it. The
     author of a write is always the person doing it, so the name is known
     without asking the server again. */
  var cachedUser = null;
  var cachedProfile = null;

  function currentUser() {
    if (!configured()) return Promise.resolve(null);
    if (cachedUser !== null) return Promise.resolve(cachedUser || null);
    return db().auth.getUser().then(function (res) {
      cachedUser = (res && res.data && res.data.user) || false;
      return cachedUser || null;
    }, function () { return null; });
  }

  function myProfile() {
    if (cachedProfile) return Promise.resolve(cachedProfile);
    return currentUser().then(function (user) {
      if (!user) return null;
      return db().from("profiles").select("handle, display_name")
        .eq("id", user.id).maybeSingle()
        .then(function (res) {
          cachedProfile = (res && res.data) || null;
          return cachedProfile;
        }, function () { return null; });
    });
  }

  function forgetUser() { cachedUser = null; cachedProfile = null; }

  /* Fills in the author on a row that came back from a write. */
  function withMe(row, profile) {
    if (!profile) return row;
    row.handle = profile.handle;
    row.display_name = profile.display_name;
    return row;
  }

  /* ---------- reads ---------- */

  /* Keyset, not offset. The feed is written to while it is read, and an
     offset shifts under inserts: the reader sees a row twice and misses
     another. A cursor names a position in the ordering instead. */
  function feedPage(cursor) {
    return currentUser().then(function (user) {
      var myId = user && user.id;
      return run(function () {
        return db().rpc("feed_page", {
          p_before_time: (cursor && cursor.time) || null,
          p_before_id: (cursor && cursor.id) || null,
          p_limit: PAGE_SIZE
        });
      }).then(function (out) {
        if (!out.ok) return out;
        var rows = out.data || [];
        var items = rows.map(function (r) { return toGeneration(r, myId); });
        var last = rows[rows.length - 1];
        return {
          ok: true,
          data: {
            items: items,
            /* A short page is the end. Asking again would be a wasted
               round trip and an "end of feed" that never arrives. */
            done: rows.length < PAGE_SIZE,
            cursor: last ? { time: last.created_at, id: last.id } : null
          }
        };
      });
    });
  }

  /* Costs one integer. The bodies are fetched only if the reader taps the
     pill, so an idle tab is nearly free. */
  function newSince(isoTime) {
    if (!isoTime) return Promise.resolve({ ok: true, data: 0 });
    return run(function () {
      return db().rpc("feed_since", { p_after: isoTime });
    }).then(function (out) {
      return out.ok ? { ok: true, data: out.data || 0 } : out;
    });
  }

  function generation(id) {
    return currentUser().then(function (user) {
      var myId = user && user.id;
      return run(function () {
        return db().from("generations")
          .select("*, profiles!inner(handle, display_name)")
          .eq("id", id).maybeSingle();
      }).then(function (out) {
        if (!out.ok) return out;
        if (!out.data) return { ok: true, data: null };
        var row = out.data;
        var p = row.profiles || {};
        row.handle = p.handle;
        row.display_name = p.display_name;
        return { ok: true, data: toGeneration(row, myId) };
      });
    });
  }

  function thread(genId) {
    return currentUser().then(function (user) {
      var myId = user && user.id;
      return run(function () {
        return db().rpc("thread_for", { p_gen: genId });
      }).then(function (out) {
        if (!out.ok) return out;
        return {
          ok: true,
          data: (out.data || []).map(function (r) { return toComment(r, myId); })
        };
      });
    });
  }

  /* ---------- writes ----------
     Each takes a key the caller keeps across retries. The caller owning
     the key is the point: a key generated here would be new on every
     attempt, which is the same as having none. */

  function newKey() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  function createGeneration(key, fields) {
    return Promise.all([currentUser(), myProfile()]).then(function (both) {
      var myId = both[0] && both[0].id;
      var profile = both[1];
      return run(function () {
        return db().rpc("create_generation", {
          p_key: key,
          p_prompt: fields.prompt,
          p_response: fields.response || "",
          p_addressed: !!fields.addressed,
          p_status: fields.status || "complete",
          p_visibility: fields.visibility || "public",
          p_kind: fields.kind || "original",
          p_remix_of: fields.remixOf || null
        });
      }).then(function (out) {
        if (!out.ok) return out;
        var row = withMe(Array.isArray(out.data) ? out.data[0] : out.data, profile);
        return { ok: true, data: toGeneration(row, myId) };
      });
    });
  }

  function createComment(key, genId, body, parentId) {
    return Promise.all([currentUser(), myProfile()]).then(function (both) {
      var myId = both[0] && both[0].id;
      var profile = both[1];
      return run(function () {
        return db().rpc("create_comment", {
          p_key: key, p_gen: genId, p_body: body, p_parent: parentId || null
        });
      }).then(function (out) {
        if (!out.ok) return out;
        var row = withMe(Array.isArray(out.data) ? out.data[0] : out.data, profile);
        return { ok: true, data: toComment(row, myId) };
      });
    });
  }

  /* Soft delete, both directions. Naturally idempotent: setting a
     timestamp twice is the same as setting it once (architect 5.5). */
  function deleteGeneration(id) {
    return run(function () {
      return db().from("generations").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    });
  }

  function restoreGeneration(id) {
    return run(function () {
      return db().from("generations").update({ deleted_at: null }).eq("id", id);
    });
  }

  function deleteComment(id) {
    return run(function () { return db().rpc("soft_delete_comment", { p_id: id }); });
  }

  /* The body is cleared on delete so it is genuinely gone from the server,
     which means undo has to send it back. The caller holds it for the
     length of the undo window. */
  function restoreComment(id, body) {
    return run(function () { return db().rpc("restore_comment", { p_id: id, p_body: body }); });
  }

  function setLocked(id, locked) {
    return run(function () {
      return db().from("generations").update({ locked: !!locked }).eq("id", id);
    });
  }

  function setSaved(genId, saved) {
    return currentUser().then(function (user) {
      if (!user) return fail({ message: "not_authenticated" });
      return run(function () {
        return saved
          ? db().from("saves").upsert(
              { user_id: user.id, generation_id: genId },
              { onConflict: "user_id,generation_id", ignoreDuplicates: true })
          : db().from("saves").delete().eq("user_id", user.id).eq("generation_id", genId);
      });
    });
  }

  /* ---------- the outbox ----------

     You chose: an offline write queues and says so, rather than being
     refused. That is the only honest way to keep one canonical database
     and still accept a post on a flaky connection, and it costs a state
     the reader has to be able to see. A post that looks published but
     lives only in this browser is the failure mode worth avoiding.

     The idempotency key is minted once, when the write is queued, and
     survives every retry. That is what makes the queue safe: if the first
     attempt reached Postgres and the response was lost, the retry returns
     the original row instead of posting twice.

     Persisted, because "queued" has to survive the tab closing. flow.txt
     13: work is either lost, saved, resumed, cancelled or rolled back, and
     never left undefined. */

  var OUTBOX_KEY = "impose.cm.outbox.v1";
  var outbox = [];
  var draining = false;
  var onChange = null;

  /* Callbacks cannot be persisted: JSON.stringify drops functions, so a job
     resumed after a reload used to reach Postgres and then have nothing to
     reconcile the optimistic card with. It stayed "Sending" forever beside
     the real row it had just created.

     Handlers are registered by job type instead, so a resumed job settles
     the same way a fresh one does. */
  var handlers = { generation: null, comment: null };

  function setJobHandler(type, onDone, onFail) {
    handlers[type] = { done: onDone, fail: onFail };
  }

  function settle(job, kind, payload) {
    var inline = kind === "done" ? job.onDone : job.onFail;
    if (inline) { try { inline(payload, job); } catch (e) {} return; }
    var h = handlers[job.type];
    if (h && h[kind]) { try { h[kind](payload, job); } catch (e) {} }
  }

  function loadOutbox() {
    try {
      var raw = localStorage.getItem(OUTBOX_KEY);
      outbox = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(outbox)) outbox = [];
    } catch (e) { outbox = []; }
    return outbox;
  }

  function saveOutbox() {
    try {
      /* Store the data, never the closures: they would serialise to
         nothing and give a false impression that the job is complete. */
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.map(function (j) {
        return {
          type: j.type, key: j.key, fields: j.fields, genId: j.genId,
          body: j.body, parentId: j.parentId, localId: j.localId,
          queuedAt: j.queuedAt, attempts: j.attempts, error: j.error
        };
      })));
    } catch (e) {}
    if (onChange) { try { onChange(outbox.slice()); } catch (e) {} }
  }

  function queue(job) {
    job.key = job.key || newKey();
    job.queuedAt = Date.now();
    job.attempts = 0;
    job.error = "";
    outbox.push(job);
    saveOutbox();
    return job;
  }

  function dropJob(key) {
    outbox = outbox.filter(function (j) { return j.key !== key; });
    saveOutbox();
  }

  function pending() { return outbox.slice(); }

  function runJob(job) {
    if (job.type === "generation") {
      return createGeneration(job.key, job.fields);
    }
    if (job.type === "comment") {
      return createComment(job.key, job.genId, job.body, job.parentId);
    }
    return Promise.resolve(fail({ message: "unknown job" }));
  }

  /* One at a time and in order, so a reply cannot reach the server before
     the comment it answers. Stops on the first retryable failure rather
     than burning the whole queue against a wall. */
  /* Callers wait on the drain that is actually running, not on a fresh
     resolved promise. Returning Promise.resolve() while a drain was
     already in flight meant a caller chaining .then() ran before the queue
     had settled, which is how an orphan sweep managed to run against a
     queue that was about to empty. */
  var drainPromise = null;

  function drain() {
    if (draining) return drainPromise || Promise.resolve();
    if (!outbox.length || !configured()) return Promise.resolve();
    draining = true;

    function step() {
      if (!outbox.length) { draining = false; return Promise.resolve(); }
      var job = outbox[0];
      job.attempts += 1;
      return runJob(job).then(function (out) {
        if (out.ok) {
          dropJob(job.key);
          settle(job, "done", out.data);
          return step();
        }
        if (!out.retryable) {
          /* A permanent failure must leave the queue, or it blocks every
             write behind it forever. The caller is told so the card can
             show why rather than sitting on "Sending" for good. */
          job.error = out.error;
          dropJob(job.key);
          settle(job, "fail", out);
          return step();
        }
        job.error = out.error;
        saveOutbox();
        draining = false;
        return Promise.resolve();
      });
    }
    drainPromise = step().then(function (v) { drainPromise = null; return v; });
    return drainPromise;
  }

  function setOutboxListener(fn) { onChange = fn; }

  loadOutbox();
  /* Reconnecting is the moment queued work should move. */
  window.addEventListener("online", function () { drain(); });

  window.BotoData = {
    configured: configured,
    queue: queue,
    drain: drain,
    pending: pending,
    dropJob: dropJob,
    setOutboxListener: setOutboxListener,
    setJobHandler: setJobHandler,
    PAGE_SIZE: PAGE_SIZE,
    newKey: newKey,
    currentUser: currentUser,
    myProfile: myProfile,
    forgetUser: forgetUser,
    feedPage: feedPage,
    newSince: newSince,
    generation: generation,
    thread: thread,
    createGeneration: createGeneration,
    createComment: createComment,
    deleteGeneration: deleteGeneration,
    restoreGeneration: restoreGeneration,
    deleteComment: deleteComment,
    restoreComment: restoreComment,
    setLocked: setLocked,
    setSaved: setSaved,
    toGeneration: toGeneration,
    toComment: toComment
  };
})();
