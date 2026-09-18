/* Community mode for the Botocracy shell: the Slopify prototype, ported 1:1.
   Owns the Community | Workspace mode switch, the engagement ranked feed,
   generation detail with threaded discussion, remix/challenge flows, the new
   posts pill, pull to refresh, and paginated infinite scroll. It never
   touches wsContent (the workspace chat world), workspace state, or its storage;
   its own state lives under the same LS key as always. Local data stands in
   for the backend so the core loop can be felt end to end. */
(function () {
  "use strict";

  /* v6: ported into the Botocracy shell as Community mode. The cache is
     scoped per identity: every signed-in account gets its own key plus
     one shared anonymous key. A cache is only ever read by the identity
     that wrote it, so another person's private posts or "own" flags can
     no longer resurface for whoever opens the app next. */
  var LS_KEY_BASE = "slopify:v6";
  var myUserId = (window.WSync && WSync.userId) ? WSync.userId() : null;
  function cacheKeyFor(uid) { return uid ? LS_KEY_BASE + "::" + uid : LS_KEY_BASE + ":anon"; }
  var LS_KEY = cacheKeyFor(myUserId);

  /* One-time migration of the pre-scoping key. Its `own` flags were set
     by whoever used this device before, so they cannot be trusted: keep
     only what any viewer may see, drop the rest, then retire the key. */
  (function migrateLegacyCommunityCache() {
    try {
      var raw = localStorage.getItem(LS_KEY_BASE);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.generations) && !localStorage.getItem(LS_KEY)) {
        parsed.generations = parsed.generations.filter(function (g) {
          return g && typeof g === "object" && !g.own && (g.visibility || "public") === "public";
        });
        parsed.comments = (Array.isArray(parsed.comments) ? parsed.comments : []).filter(function (c) {
          return c && typeof c === "object" && !c.own;
        });
        localStorage.setItem(LS_KEY, JSON.stringify(parsed));
      }
      localStorage.removeItem(LS_KEY_BASE);
    } catch (e) {
      try { localStorage.removeItem(LS_KEY_BASE); } catch (e2) { /* leave it unreadable */ }
    }
  })();

  /* Deepest level a comment may nest. Root(0) + replies(1) + sub-replies(2)
     = 3 visible rows, the YouTube rule. Replying to a comment already at the
     cap re-attaches the new comment to that comment's parent: it renders as a
     flattened sibling, and the @mention carries who it was really aimed at.
     Threads can grow long but never deep, so columns never march right. */
  var MAX_REPLY_DEPTH = 2;
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var YOU = { name: "You", handle: "@you" };

  /* ---------- utils ---------- */

  function $(id) { return document.getElementById(id); }

  /* Identity avatar for a creator. Seeded by handle (stable) and falling
     back to name, so the same person shows the same face everywhere. If
     avatars.js is missing from a half-deployed tree, this degrades to the
     old initial rather than rendering an empty circle. */
  function avatar(creator, cls) {
    var who = creator || {};
    var seed = who.handle || who.name || "?";
    var klass = "avatar " + (cls || "");
    if (window.BotoAvatar) {
      return '<span class="' + klass.trim() + ' avatar-img">' + BotoAvatar.svg(seed) + "</span>";
    }
    return '<span class="' + klass.trim() + '">' +
      esc(String(who.name || "?").charAt(0).toUpperCase()) + "</span>";
  }

  /* ---------- @bot addressing ----------
     A post is a generation only when it is addressed to the agent with a
     leading @bot. Anything else is a plain post: it is shared to the feed,
     it can be discussed and saved, and no agent is called for it. The
     composer, the send path, and the card renderer all read this one
     function so they can never disagree about what counts. */
  var BOT_MENTION = /^\s*@bot\b[ \t]*/i;

  function addressesBot(raw) {
    return BOT_MENTION.test(String(raw == null ? "" : raw));
  }

  /* Whether a stored generation asked the agent for something. Anything
     saved before plain posts existed has no `addressed` field and was an
     agent generation by definition, so a missing flag reads as true. That
     keeps every seeded card and every already-stored post rendering
     exactly as it did. */
  function isAddressed(gen) {
    return !gen || gen.addressed === undefined ? true : !!gen.addressed;
  }

  /* Shared kernel: identical escaping to the workspace. */
  function esc(value) {
    return window.BotoUI ? BotoUI.escapeHtml(value) : String(value == null ? "" : value);
  }

  function rich(value) {
    return esc(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function timeAgo(ms) {
    var s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }

  /* ---------- state ---------- */

  function load() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.generations)) return null;
      if (!myUserId) {
        /* Signed out: public content only. The server enforces this via
           RLS on every fetch; the cache enforces it again here so a
           stale or hand-edited blob cannot leak private posts or
           someone else's "own" records into an anonymous session. */
        parsed.generations = parsed.generations.filter(function (g) {
          return !g || typeof g !== "object" || (!g.own && (g.visibility || "public") === "public");
        });
        parsed.comments = (Array.isArray(parsed.comments) ? parsed.comments : []).filter(function (c) {
          return !c || typeof c !== "object" || !c.own;
        });
      }
      /* Migration: freshPinned was persisted by an earlier build, so stored
         posts can carry a pin that would otherwise sit at the top of the
         feed forever. Pins are session state now, so strip any that were
         written to disk. Harmless for users who never had them. */
      parsed.generations.forEach(function (gen) {
        if (gen && gen.freshPinned) delete gen.freshPinned;
      });
      return normalizeState(parsed);
    } catch (e) { return null; }
  }


  /* ---------- defensive normalisation ----------

     Everything below the load boundary is allowed to assume a generation has
     a creator with a name and a handle, an object of numeric counts, a string
     prompt and a string response. Nothing above it can guarantee that: the
     store is localStorage, which a user can hand-edit, another tab can write,
     a half-finished migration can mangle, and a future server response can
     disagree with.

     Before this, a single malformed record threw inside the render loop and
     took the rest of the feed down with it: one null creator rendered five
     cards instead of ten and killed pagination from that point on. The blast
     radius of bad data is now one card, not the page.

     This runs once at load rather than as a guard at every call site, so the
     invariant holds in one place instead of being re-argued in a dozen. */

  var UNKNOWN = { name: "Unknown", handle: "@unknown" };

  function normCreator(c) {
    if (!c || typeof c !== "object") return { name: UNKNOWN.name, handle: UNKNOWN.handle };
    var name = typeof c.name === "string" && c.name ? c.name : null;
    var handle = typeof c.handle === "string" && c.handle ? c.handle : null;
    /* Derive whichever half is missing from the half that survived, so a
       partial record still reads as one coherent person. */
    if (!name && handle) name = handle.replace(/^@/, "") || UNKNOWN.name;
    if (!handle && name) handle = "@" + String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
    return { name: name || UNKNOWN.name, handle: handle || UNKNOWN.handle };
  }

  function normCounts(c) {
    var out = { remix: 0, challenge: 0, comment: 0, save: 0 };
    if (!c || typeof c !== "object") return out;
    Object.keys(out).forEach(function (k) {
      var n = Number(c[k]);
      /* Negative or non-finite counts are display lies; clamp rather than
         propagate them into the UI. */
      out[k] = isFinite(n) && n > 0 ? Math.floor(n) : 0;
    });
    return out;
  }

  function normTime(t) {
    var n = Number(t);
    return isFinite(n) && n > 0 ? n : Date.now();
  }

  function normalizeState(st) {
    if (!st || typeof st !== "object") return st;
    var seen = Object.create(null);
    st.generations = (Array.isArray(st.generations) ? st.generations : []).filter(function (g) {
      /* A record with no usable id cannot be addressed, deleted, replied to
         or deduped, so it is dropped rather than half-supported. */
      if (!g || typeof g !== "object" || !g.id || seen[g.id]) return false;
      seen[g.id] = true;
      return true;
    }).map(function (g) {
      g.creator = normCreator(g.creator);
      g.counts = normCounts(g.counts);
      g.prompt = typeof g.prompt === "string" ? g.prompt : "";
      g.response = typeof g.response === "string" ? g.response : "";
      /* "failed" is a real terminal state that owns the retry affordance;
         coercing it to "complete" would strand the post with an empty
         response and no way to recover it. */
      g.status = (g.status === "streaming" || g.status === "failed") ? g.status : "complete";
      g.visibility = g.visibility === "private" ? "private" : "public";
      g.createdAt = normTime(g.createdAt);
      /* A post that is its own parent would spin the lineage walk forever. */
      if (g.parentId === g.id) g.parentId = null;
      return g;
    });

    var ids = Object.create(null);
    st.generations.forEach(function (g) { ids[g.id] = true; });

    var cseen = Object.create(null);
    st.comments = (Array.isArray(st.comments) ? st.comments : []).filter(function (c) {
      if (!c || typeof c !== "object" || !c.id || cseen[c.id]) return false;
      cseen[c.id] = true;
      /* A comment whose generation no longer exists can never be rendered
         or reached; keeping it only inflates counts. */
      return !!ids[c.genId];
    }).map(function (c) {
      c.creator = normCreator(c.creator);
      c.text = typeof c.text === "string" ? c.text : "";
      c.createdAt = normTime(c.createdAt);
      if (c.parentId === c.id) c.parentId = null;
      return c;
    });

    /* Counts are derived for comments, so repair them here too: a hand
       edited or partially migrated store should not leave the discussion
       chip disagreeing with the thread underneath it. */
    var tally = Object.create(null);
    st.comments.forEach(function (c) {
      if (c.deleted) return;
      tally[c.genId] = (tally[c.genId] || 0) + 1;
    });
    st.generations.forEach(function (g) { g.counts.comment = tally[g.id] || 0; });
    return st;
  }

  /* No fixtures. Every post and comment comes from Postgres now, and a
     seeded row would be a post that exists on one device and nowhere else,
     which is the divergence this whole cutover removes. An empty state is
     the honest first-run experience. */
  function seed() {
    return { visibility: "public", generations: [], comments: [] };
  }

  var state = load() || seed();
  var streamingNow = false;

  /* True once a write has failed, so the warning is shown once rather than
     on every keystroke-triggered save. */
  var persistBroken = false;

  /* Ids this tab has deliberately removed. reconcileWithDisk merges back
     anything on disk that is missing from memory, which is right for a
     row another tab created and wrong for one this tab just replaced: the
     optimistic placeholder was resurrected on the very next persist, and
     reappeared as a card stuck on "Sending" beside the real post.

     A tombstone is cheaper and safer than making the merge guess. */
  var retired = Object.create(null);

  function retire(id) { if (id) retired[id] = true; }

  function reconcileWithDisk() {
    var disk;
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      disk = JSON.parse(raw);
    } catch (e) { return; }
    if (!disk || !Array.isArray(disk.generations)) return;

    function mergeById(mine, theirs) {
      if (!Array.isArray(theirs)) return mine;
      var have = Object.create(null);
      mine.forEach(function (r) { if (r && r.id) have[r.id] = true; });
      theirs.forEach(function (r) {
        if (r && r.id && !have[r.id] && !retired[r.id]) mine.push(r);
      });
      return mine;
    }
    mergeById(state.generations, disk.generations);
    mergeById(state.comments, disk.comments);
    /* Counts for comments are derived, so recompute rather than trusting
       either side's copy after a merge. */
    state.generations.forEach(function (g) {
      g.counts.comment = liveCommentCount(g.id);
    });
  }

  function persist() {
    try {
      reconcileWithDisk();
      localStorage.setItem(LS_KEY, JSON.stringify(state));
      persistBroken = false;
      return true;
    } catch (e) {
      /* Storage full, or blocked by private-mode / cookie settings. This was
         swallowed silently, so the UI happily rendered a post that was never
         written: it looked saved until the next reload, when it vanished
         with no explanation. Failing loudly is the honest outcome, and the
         in-memory state is still usable for this session. */
      if (!persistBroken) {
        persistBroken = true;
        notify("Could not save to this browser. Your posts will disappear when you reload.");
      }
      return false;
    }
  }

  /* ---------- cross-tab coherence ----------

     Two tabs each held their own copy of state and wrote it back whole, so
     whichever saved last erased everything the other had done. The storage
     event fires only in the *other* tabs, which makes it exactly the signal
     needed: adopt their write, then re-render so this tab stops showing a
     timeline that no longer exists.

     Reloading the store rather than merging field by field keeps one writer
     model and avoids inventing a conflict resolution scheme this product
     does not need; the loser of a race is the tab that was not being used. */
  function adoptExternalState() {
    var known = Object.create(null);
    state.generations.forEach(function (g) { known[g.id] = true; });

    var fresh = load();
    if (!fresh) return;
    state = fresh;

    if (location.hash.indexOf("#/g/") === 0) {
      /* State 11: another tab added a comment while this one is reading the
         thread. The post itself may also now be a tombstone, which is a
         routing event. But if the post is still here, a full route() would
         rebuild the detail page and take the composer - and any draft in it,
         and the reader's expanded branches - down with it. Repaint the
         thread in place instead. */
      var openId = location.hash.slice(4);
      var stillHere = genById(openId);
      if (stillHere && !isDeleted(stillHere)) {
        refreshThreadOnly(openId);
        return;
      }
      route();
      return;
    }

    /* Anything this tab has not seen before is announced through the same
       pill the demo poller uses, rather than being spliced into the feed
       under the reader's thumb. Re-rendering in place would reshuffle the
       timeline mid-scroll, which is exactly what the pill exists to avoid.
       Posts already known are just re-rendered, so edits and deletes from
       the other tab still land immediately. */
    var arrivals = state.generations.filter(function (g) {
      return !known[g.id] && !g.own && !isDeleted(g);
    });
    if (arrivals.length) {
      arrivals.forEach(function (g) {
        /* Pin so the merge actually surfaces them. The demo poller sets
           freshPinned on the records it invents; arrivals from another tab
           are already-persisted records, so they are pinned for this view
           instead of having a flag written back to disk. */
        pinForThisView(g.id);
      });
      syncPill();
    } else {
      renderFeed();
    }
  }

  /* Interrupted streams from a refresh or closed tab become failed generations
     with a retry path, instead of silently vanishing or duplicating. */
  state.generations.forEach(function (gen) {
    if (gen.status === "streaming") { gen.status = "failed"; }
  });
  persist();

  function genById(id) {
    for (var i = 0; i < state.generations.length; i++) {
      if (state.generations[i].id === id) return state.generations[i];
    }
    return null;
  }

  /* ---------- delete and recovery ----------

     Delete is soft: the record keeps its id and its place in the reply
     graph so replies survive as children of a tombstone. Nothing is
     removed from storage, which is what makes Undo exact rather than a
     best-effort rebuild.

     The flag is persisted at the moment of deletion, not when the undo
     window expires. A reload mid-window therefore lands on "deleted",
     never on "restored": if we must be wrong, be wrong in the direction
     the author actually asked for.

     See docs/delete-flow-plan.md for the full semantics and the reasons
     the alternatives were rejected. */

  var UNDO_MS = 6000;

  function isDeleted(rec) { return !!(rec && rec.deleted); }

  /* Ownership is the only permission input, and it is re-checked here
     rather than trusted from the DOM. The control is hidden on content
     the user does not own, but a hidden control is a UI convenience, not
     a security boundary: a forged data-id must still be rejected. */
  function canDelete(rec) {
    return !!rec && rec.own === true && !isDeleted(rec);
  }

  /* Replies keep pointing at a deleted parent, so a tombstone has to
     render whenever anything still descends from it. A leaf comment
     leaves no trace instead of littering the thread. */
  /* A tombstone only earns its slot by holding up something a reader can
     still see. The test has to be "is there a LIVE comment somewhere below
     me", not "do I have any children": a deleted comment whose only children
     are themselves deleted was keeping itself on screen, and because each
     tombstone justified the one above it, deleting a whole branch left a
     stack of "Comment deleted." rows propping each other up with nothing
     underneath. Walking the subtree makes the emptiness collapse from the
     leaves upward on its own. */
  function hasLiveDescendants(commentId, all) {
    var list = all || state.comments;
    var kids = list.filter(function (c) { return c.parentId === commentId; });
    for (var i = 0; i < kids.length; i++) {
      if (!isDeleted(kids[i])) return true;
      if (hasLiveDescendants(kids[i].id, list)) return true;
    }
    return false;
  }

  /* The set a reader should actually be shown: every live comment, plus only
     those tombstones that still have a live descendant to parent. Deleted
     leaves and deleted branches disappear entirely.

     Pruning here rather than at render time means the tree builder, the
     reply-count chips and the rail geometry all agree on one set, so a
     tombstone can never be counted as a reply that is not there. */
  function visibleComments(genId) {
    var all = state.comments.filter(function (c) { return c.genId === genId; });
    return all.filter(function (c) {
      if (!isDeleted(c)) return true;
      return hasLiveDescendants(c.id, all);
    });
  }

  /* Comment counts describe what a reader can actually see, so they are
     derived from the live set instead of being incremented and
     decremented in parallel. A count that is computed cannot drift. */
  function liveCommentCount(genId) {
    return state.comments.filter(function (c) {
      return c.genId === genId && !isDeleted(c);
    }).length;
  }

  function syncCommentCount(genId) {
    var gen = genById(genId);
    if (gen) gen.counts.comment = liveCommentCount(genId);
  }

  /* Reporting is deliberately one tap past the kebab, with the outcome
     stated plainly: the report is stored for the operator, the reporter
     hears that it landed, and nothing visible changes for the reported
     user (revealing a review state would hand abusers a probe). A second
     report of the same target by the same person is idempotent by
     schema, so the wording is the same either way. */
  function sendReport(kind, targetId) {
    if (!myUserId) {
      notify("Sign in to report this.", "Sign in", goSignIn);
      return;
    }
    BotoData.reportContent(kind, targetId).then(function (out) {
      if (out.ok) {
        notify("Reported. We'll take a look.");
        return;
      }
      if (out.code === "auth") notify(out.error, "Sign in", goSignIn);
      else notify(out.error);
    });
  }

  function reportPost(gen) {
    if (!gen || gen.pending) return;
    sendReport("post", gen.id);
  }

  function reportComment(c) {
    if (!c || c.pending) return;
    sendReport("comment", c.id);
  }

  function deleteGeneration(id) {
    var gen = genById(id);
    if (!canDelete(gen)) return;
    /* A generation that is still streaming has an in-flight writer that
       would resurrect fields behind the tombstone. */
    if (gen.status === "streaming") return;

    gen.deleted = true;
    gen.deletedAt = Date.now();
    persist();
    /* Local first so Undo is instant, server immediately after. If the
       server refuses, the post comes back rather than being hidden here
       and alive everywhere else. */
    if (!gen.pending) {
      BotoData.deleteGeneration(gen.id).then(function (out) {
        if (out.ok) return;
        gen.deleted = false;
        delete gen.deletedAt;
        persist();
        renderFeed();
        notify(out.error);
      });
    }

    var replies = state.generations.filter(function (g) {
      return g.parentId === id && !isDeleted(g);
    }).length;

    /* State the dependent-data consequence, because that is the part the
       author cannot see from the button. */
    var msg = replies === 0
      ? "Post deleted."
      : "Post deleted. " + replies + (replies === 1 ? " reply" : " replies") +
        " kept, shown under a removed post.";

    notify(msg, "Undo", function () { restoreGeneration(id); });
    rerenderAfterDelete(id);
  }

  function restoreGeneration(id) {
    var gen = genById(id);
    if (!gen || !isDeleted(gen)) return; /* idempotent: undo twice is a no-op */
    delete gen.deleted;
    delete gen.deletedAt;
    if (!gen.pending) {
      BotoData.restoreGeneration(gen.id).then(function (out) {
        if (out.ok) return;
        gen.deleted = true;
        gen.deletedAt = Date.now();
        persist();
        renderFeed();
        notify(out.error);
      });
    }
    persist();
    notify("Post restored.");
    renderFeed();
  }

  function deleteComment(id) {
    var c = commentById(id);
    if (!canDelete(c)) return;
    c.deleted = true;
    c.deletedAt = Date.now();
    syncCommentCount(c.genId);
    persist();
    /* The body is kept locally for the undo window: the server clears it
       on delete, so restoring has to send it back. */
    var keptBody = c.text;
    if (!c.pending) {
      BotoData.deleteComment(c.id).then(function (out) {
        if (out.ok) return;
        c.deleted = false;
        delete c.deletedAt;
        syncCommentCount(c.genId);
        persist();
        refreshThreadOnly(c.genId);
        notify(out.error);
      });
    }
    c.__body = keptBody;
    notify("Comment deleted.", "Undo", function () { restoreComment(id); });
    /* Deleting one comment used to rebuild the whole detail page. That threw
       away the composer node mid-edit - a draft the user had typed vanished
       with no warning and the Post button went dead - and reset every thread
       they had opened. A comment changing state is a thread-level event, so
       only the thread is repainted when the page is already up. */
    refreshThreadOnly(c.genId);
  }

  /* Repaint the thread in place, preserving the composer (and its draft) and
     the current expansion state. Falls back to a full render when the detail
     page for this generation is not the thing on screen. */
  function refreshThreadOnly(genId) {
    var gen = genById(genId);
    var listEl = $("cmCommentList");
    if (gen && listEl && location.hash === "#/g/" + genId) {
      /* The composer may be aimed at a comment that just became a tombstone,
         or that a cross-tab merge removed outright. Either way it is no
         longer a real target. Re-resolve by id: after a merge the object in
         replyingTo is a discarded copy even when the comment still exists. */
      if (replyingTo) {
        var live = commentById(replyingTo.id);
        if (!live || isDeleted(live)) clearReplyTarget(true);
        else replyingTo = live;
      }
      renderThread(gen, listEl);
      replaceCard(gen);
      updateDiscussionTitle(gen);
      return;
    }
    refreshDetail(genId);
  }

  function restoreComment(id) {
    var c = commentById(id);
    if (!c || !isDeleted(c)) return;
    delete c.deleted;
    delete c.deletedAt;
    if (!c.pending) {
      BotoData.restoreComment(c.id, c.__body || c.text).then(function (out) {
        if (out.ok) return;
        c.deleted = true;
        c.deletedAt = Date.now();
        syncCommentCount(c.genId);
        persist();
        refreshThreadOnly(c.genId);
        notify(out.error);
      });
    }
    syncCommentCount(c.genId);
    persist();
    notify("Comment restored.");
    refreshThreadOnly(c.genId);
  }

  function commentById(id) {
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id === id) return state.comments[i];
    }
    return null;
  }

  /* Deleting the generation you are currently reading has nowhere to
     stand, so the detail view hands back to the feed. Deleting from the
     feed just re-renders in place. */
  function rerenderAfterDelete(id) {
    if (location.hash === "#/g/" + id) {
      location.hash = "#/";
      return;
    }
    renderFeed();
  }

  function refreshDetail(genId) {
    var gen = genById(genId);
    if (gen && location.hash === "#/g/" + genId) renderDetail(gen);
    else renderFeed();
  }

  /* One door to the shared toast stack. Community runs in its own IIFE,
     so app.js exports it; if that export is ever missing the product
     still works, it just loses the undo affordance rather than throwing
     inside a delete handler. */
  function notify(msg, actionLabel, onAction) {
    if (window.BotoToast) return window.BotoToast(msg, actionLabel, onAction, UNDO_MS);
    return null;
  }

  /* Hosted @bot runs on a local demo engine until the relay path is
     wired (TASK-02 in PLAN_V2_AUDIT). One flag drives every disclosure
     so the day real replies land, flipping it removes all of them. */
  var BOT_DEMO = true;

  /* The tag on every @bot answer. "Demo" is the whole point: a reader must
     never believe a canned reply came from a live model (flow.txt 3). */
  function botDemoTag() {
    return BOT_DEMO
      ? ' <span class="gen-resp-demo" title="Hosted @bot runs on demo replies until launch">demo</span>'
      : "";
  }

  /* The failure cards say "Sign in to do that"; this is the doing. The
     return hash is stashed so auth.js can land the reader back where
     the attempt happened instead of dropping them at the feed root. */
  function goSignIn() {
    try { localStorage.setItem("impose.auth.returnTo", location.hash || "#/"); } catch (e) { /* private mode */ }
    window.location.href = window.location.protocol === "file:" ? "./auth.html#sign-in" : "./sign-in";
  }

  /* Community is read-only for signed-out visitors. Every write path
     checks this first and stops BEFORE any optimistic row exists: no
     fake "Sending" card, no popup after the fact - the server would
     refuse the write anyway, so the honest UX is to ask for sign-in
     first and create nothing until the write can actually happen. */
  function signedIn() { return !!myUserId; }

  function requireSignIn(verb) {
    if (myUserId) return true;
    notify("Sign in to " + verb + ".", "Sign in", goSignIn);
    return false;
  }

  /* Thread read path. Returns what should be rendered, which is not the same
     as what is stored: spent tombstones are pruned out. Callers that need the
     raw records (counts, deletion, undo) go to state.comments directly. */
  function commentsFor(genId) {
    return visibleComments(genId)
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }

  /* Comment tree, ported from NearSpace utils/postText.js.
     buildCommentTree links parent to child with cycle protection,
     emitTree emits a flat row list carrying rail geometry so the
     DOM never nests, and pathToRoot marks the branch being replied to. */

  function buildCommentTree(comments) {
    var list = Array.isArray(comments) ? comments : [];
    var nodes = new Map();
    list.forEach(function (c) { nodes.set(c.id, Object.assign({}, c, { replies: [] })); });

    var safe = new Map();
    function hasSafeAncestry(id) {
      if (safe.has(id)) return safe.get(id);
      var path = [];
      var seen = new Set();
      var cur = id;
      var ok = true;
      while (cur != null) {
        if (seen.has(cur)) { ok = false; break; }
        if (safe.has(cur)) { ok = safe.get(cur); break; }
        seen.add(cur);
        path.push(cur);
        var node = nodes.get(cur);
        var pid = node ? node.parentId : null;
        if (!pid || pid === cur || !nodes.has(pid)) break;
        cur = pid;
      }
      for (var i = 0; i < path.length; i++) safe.set(path[i], ok);
      return ok;
    }

    var roots = [];
    list.forEach(function (c) {
      var node = nodes.get(c.id);
      var pid = c.parentId;
      var parent = pid && pid !== c.id ? nodes.get(pid) : null;
      if (parent && hasSafeAncestry(c.id)) parent.replies.push(node);
      else roots.push(node);
    });
    return roots;
  }

  function pathToRoot(comments, id) {
    var byId = new Map((Array.isArray(comments) ? comments : []).map(function (c) { return [c.id, c]; }));
    var out = new Set();
    var cur = byId.get(id);
    while (cur && !out.has(cur.id)) {
      out.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return out;
  }

  /* Deterministic trending score, documented: remix 4, challenge 3,
     comment 2, save 1, newest wins ties. No hidden ranking. */
  function score(gen) {
    var c = gen.counts;
    return c.remix * 4 + c.challenge * 3 + c.comment * 2 + c.save;
  }

  /* ---------- view routing ---------- */

  function moveGlide(tab) {
    var glide = $("cmModeGlide");
    /* The switch row is display:none while Workspace is front; measuring
       hidden tabs yields 0px and would park the glide mis-sized for when
       Community reappears. showMode/setModeTab re-run this after the row
       is visible again, so skipping here is safe. */
    if (!glide || !tab || !tab.getClientRects().length) return;
    glide.style.width = tab.offsetWidth + "px";
    glide.style.transform = "translateX(" + (tab.offsetLeft - 3) + "px)";
  }

  /* ---------- mode + view integration ----------

     Hash grammar for the merged app: #/workspace switches to the chat
     shell (its own state and hash idiom are untouched), #chat=<id> stays
     entirely workspace owned, everything else is Community. #/g/<id> is the
     generation detail. The mode is a body class because the workspace chrome
     hides with pure CSS. */
  function currentMode() {
    return document.body.classList.contains("community-mode") ? "community" : "workspace";
  }

  function setModeTab(isWorkspace) {
    $("cmTabCommunity").classList.toggle("active", !isWorkspace);
    $("cmTabWorkspace").classList.toggle("active", isWorkspace);
    $("cmTabCommunity").setAttribute("aria-selected", String(!isWorkspace));
    $("cmTabWorkspace").setAttribute("aria-selected", String(isWorkspace));
    moveGlide(isWorkspace ? $("cmTabWorkspace") : $("cmTabCommunity"));
  }

  /* The mode switcher belongs to the two top-level surfaces. On a
     generation page the user is one level down, inside a thread, and the
     page already has its own "< Generation" header: showing a second,
     higher-level switcher above it stacked two navigations and let a tap
     throw away the reader's place in the thread. The detail view hides it
     and the back arrow is the only way up. */
  function setDetailChrome(on) {
    document.body.classList.toggle("cm-detail-mode", !!on);
  }

  function showMode(mode) {
    var isCommunity = mode === "community";
    /* while the chat is mid stream the workspace is just hidden, never torn
       down; same for the community views when the user switches away */
    document.body.classList.toggle("community-mode", isCommunity);
    $("wsContent").hidden = isCommunity;
    $("cmMain").hidden = !isCommunity;
    setModeTab(!isCommunity);
    /* The newly shown composer may carry a stale inline height from time
       spent hidden (no input events fire then). A synthetic input event
       reruns its own autogrow + send sync once it can be measured. */
    var shownInput = isCommunity ? $("cmInput") : $("input");
    if (shownInput && shownInput.value) shownInput.dispatchEvent(new Event("input"));
  }

  function route() {
    var hash = location.hash || "#/";
    /* Shareable alias: /u/@handle/post/<id> names the same post detail as
       /g/<id>. The handle segment is descriptive; the post id is
       authoritative, so the short form stays canonical everywhere the
       app generates links and the long form is simply accepted. */
    var postAt = hash.indexOf("/post/");
    if (hash.indexOf("#/u/") === 0 && postAt > -1) {
      hash = "#/g/" + decodeURIComponent(hash.slice(postAt + 6));
    }
    if (hash === "#/workspace" || hash.indexOf("#chat=") === 0) {
      if (window.BotoAccess && !BotoAccess.canUseWorkspace()) {
        /* Community is open; the Workspace is grant-gated. Land the user in
           Community and show the waitlist sheet. The grant itself is checked
           server-side (RLS); this is the UX for that gate, not the gate. */
        if (hash !== "#/") history.replaceState(null, "", location.pathname + location.search + "#/");
        showMode("community");
        setDetailChrome(false);
        if (window.BotoAccess && !BotoAccess.canUseWorkspace()) openAccessSheet();
        return;
      }
      showMode("workspace");
      setDetailChrome(false);
      return;
    }
    var feedView = $("cmFeedView");
    var detailView = $("cmDetailView");
    if (hash.indexOf("#/u/") === 0) {
      if (window.BotoData && BotoData.unwatchThread) BotoData.unwatchThread();
      renderProfile(decodeURIComponent(hash.slice(4)));
      showMode("community");
      setDetailChrome(true);
      feedView.hidden = true;
      detailView.hidden = true;
      $("cmProfileView").hidden = false;
      setGenDock(false);
      window.scrollTo(0, 0);
      return;
    }
    $("cmProfileView").hidden = true;

    if (hash.indexOf("#/g/") === 0) {
      var id = hash.slice(4);
      var gen = genById(id);

      /* A deep link is often the first thing this browser has ever seen:
         shared from another device, reopened from history, or arriving
         from search. The cache is empty then, and answering "this post
         does not exist" for a post that plainly does is the worst kind of
         dead end, because the reader has no way to tell our ignorance
         from a deletion.

         So fetch it, and fetch its thread, before deciding. */
      if (!gen && liveOnline()) {
        renderDetailLoading();
        showMode("community");
        setDetailChrome(true);
        feedView.hidden = true;
        detailView.hidden = false;
        setGenDock(false);
        hydrateDetail(id);
        return;
      }
      /* A link to a deleted post is a real destination with a real answer,
         not a reason to silently dump the reader on the home feed. Same
         for an id that never existed: both get the missing state, which
         explains what happened and offers a way out. */
      if (!gen || isDeleted(gen)) {
        renderMissing(!!gen);
        showMode("community");
        setDetailChrome(true);
        feedView.hidden = true;
        detailView.hidden = false;
        setGenDock(false);
        window.scrollTo(0, 0);
        return;
      }
      if (gen) {
        expandedThreads.clear(); /* fresh view: all chains start collapsed */
        renderDetail(gen);
        /* Comments live on the server, and the cache holds only what this
           browser has already seen. Without this the thread rendered
           empty for anyone arriving fresh, which read as "no comments"
           rather than "not loaded yet". */
        hydrateThread(id);
        watchOpenThread(id);
        showMode("community");
        setDetailChrome(true);
        feedView.hidden = true;
        detailView.hidden = false;
        /* The feed's generation composer is docked as a sibling of both
           views, so without this it stayed mounted on top of the detail
           page and the user saw two composers: "Ask @bot anything" over
           "Add to the discussion". The detail page owns exactly one
           composer, the comment box. */
        setGenDock(false);
        window.scrollTo(0, 0);
        return;
      }
    }
    /* Leaving the detail view: stop listening for that thread so a busy
       post does not keep waking a reader who has gone back to the feed. */
    if (window.BotoData && BotoData.unwatchThread) BotoData.unwatchThread();
    $("cmProfileView").hidden = true;
    renderFeed();
    showMode("community");
    setDetailChrome(false);
    feedView.hidden = false;
    detailView.hidden = true;
    setGenDock(true);
  }

  /* flow.txt 10: an async destination needs a loading state of its own.
     Landing on a blank detail page while a fetch runs is indistinguishable
     from a broken one. */
  function renderDetailLoading() {
    var detail = $("cmDetail");
    detail.innerHTML = '<div class="detail-loading"><span class="spinner"></span>' +
      "<p>Loading this post</p></div>";
    refreshIcons();
  }

  /* Fetch a post this browser has never seen, then its thread. Only then
     is "missing" an honest answer. */
  function hydrateDetail(id) {
    BotoData.generation(id).then(function (out) {
      if (location.hash !== "#/g/" + id) return; /* the reader moved on */
      if (!out.ok) {
        var detail = $("cmDetail");
        detail.innerHTML = '<div class="detail-loading"><p>' + esc(out.error) + "</p>" +
          '<button class="btn" id="cmDetailRetry" type="button">Try again</button></div>';
        var retry = $("cmDetailRetry");
        if (retry) retry.addEventListener("click", function () { hydrateDetail(id); });
        refreshIcons();
        return;
      }
      if (!out.data || out.data.deleted) { renderMissing(!!(out.data && out.data.deleted)); return; }
      absorb([out.data]);
      persist();
      expandedThreads.clear();
      renderDetail(out.data);
      hydrateThread(id);
      watchOpenThread(id);
    });
  }

  /* Merge the server's thread into the cache and repaint. Local pending
     comments are kept: they are not on the server yet and dropping them
     would make a queued reply vanish while it waits to send. */
  function hydrateThread(genId) {
    if (!liveOnline()) return;
    BotoData.thread(genId).then(function (out) {
      if (!out.ok) return;
      if (location.hash !== "#/g/" + genId) return;
      var keep = state.comments.filter(function (c) {
        return c.genId !== genId || c.pending;
      });
      state.comments = keep.concat(out.data.filter(function (row) {
        return !keep.some(function (c) { return c.id === row.id; });
      }));
      syncCommentCount(genId);
      persist();
      var gen = genById(genId);
      if (!gen || location.hash !== "#/g/" + genId) return;

      /* refreshThreadOnly, not renderDetail. renderDetail rebuilds the
         whole page including the composer, which discards whatever the
         reader was typing. That was tolerable when this only ran on
         navigation; with realtime it runs whenever anyone else comments,
         so someone mid-reply would lose their draft to a stranger's
         message. Measured: the draft was gone within four seconds.

         refreshThreadOnly repaints the list and leaves the composer,
         its draft and its reply target alone. */
      if ($("cmCommentList")) refreshThreadOnly(genId);
      else renderDetail(gen);
    });
  }

  /* ---------- notifications ----------
     The other half of a social loop. Realtime already updated a page you
     were looking at; this tells you about the ones you are not. */

  function notifLabel(n) {
    if (n.kind === "reply") return "replied to your comment";
    if (n.kind === "comment") return "commented on your post";
    if (n.kind === "challenge") return "challenged your post";
    return "remixed your post";
  }

  function syncNotifBadge() {
    var btn = $("cmNotifBtn");
    if (!btn) return;
    /* Signed out there is no inbox, so the bell is not a control that
       does nothing: it is absent. */
    if (!myUserId || !liveOnline()) { btn.hidden = true; return; }
    btn.hidden = false;
    BotoData.unreadCount().then(function (out) {
      if (!out.ok) return;
      var dot = $("cmNotifDot");
      if (dot) dot.hidden = !out.data;
    });
  }

  function openNotifications() {
    var sheet = $("cmNotifSheet");
    var list = $("cmNotifList");
    sheet.hidden = false;
    list.innerHTML = '<div class="detail-loading"><span class="spinner"></span><p>Loading notifications…</p></div>';
    refreshIcons();

    BotoData.notifications(30).then(function (out) {
      if (!out.ok) {
        list.innerHTML = '<p class="feed-empty-sub">' + esc(out.error) + "</p>";
        return;
      }
      if (!out.data.length) {
        list.innerHTML = '<p class="feed-empty-sub">Nothing yet. ' +
          "When someone replies to you it shows up here.</p>";
        return;
      }
      list.innerHTML = out.data.map(function (n) {
        return '<button class="notif-row' + (n.read ? "" : " unread") +
                 '" data-gen="' + esc(n.genId || "") + '">' +
                 '<span class="notif-who">' + esc(n.actor.name) + "</span> " +
                 '<span class="notif-what">' + notifLabel(n) + "</span>" +
                 (n.excerpt ? '<span class="notif-excerpt">' + esc(n.excerpt) + "</span>" : "") +
                 '<span class="notif-when">' + esc(timeAgo(n.createdAt)) + "</span>" +
               "</button>";
      }).join("");

      /* Marked read on open, not on tap: having seen the list is the
         thing the badge is about. */
      BotoData.markAllRead().then(function () {
        var dot = $("cmNotifDot");
        if (dot) dot.hidden = true;
      });
    });
  }

  function initNotifications() {
    var btn = $("cmNotifBtn");
    if (!btn) return;
    btn.addEventListener("click", openNotifications);
    $("cmNotifClose").addEventListener("click", function () {
      $("cmNotifSheet").hidden = true;
    });
    $("cmNotifSheet").addEventListener("click", function (e) {
      if (e.target === $("cmNotifSheet")) { $("cmNotifSheet").hidden = true; return; }
      var row = e.target.closest("[data-gen]");
      if (!row) return;
      var id = row.getAttribute("data-gen");
      $("cmNotifSheet").hidden = true;
      /* Every notification opens the thing it is about. A list of events
         with nowhere to go is a dead end. */
      if (id) location.hash = "#/g/" + id;
    });
  }

  /* ---------- profiles ----------
     @handle rendered on every card and linked nowhere, so a reader could
     not see who they were talking to. flow.txt 3: every button must have a
     destination. */

  var profileCursor = null;
  var profileDone = false;
  var profileLoading = false;
  var profileHandle = null;
  var profileIsMe = false;

  function renderProfile(handle) {
    profileHandle = String(handle || "").replace(/^@/, "");
    profileCursor = null;
    profileDone = false;
    profileLoading = false;
    profileIsMe = false;
    $("cmProfileList").innerHTML = "";
    $("cmProfileEmpty").hidden = true;
    $("cmProfile").innerHTML = '<div class="detail-loading"><span class="spinner"></span></div>';

    if (!liveOnline()) {
      $("cmProfile").innerHTML = '<div class="detail-loading"><p>Profiles need a connection.</p></div>';
      return;
    }

    BotoData.profile(profileHandle).then(function (out) {
      if (location.hash !== "#/u/" + encodeURIComponent(profileHandle)) return;
      if (!out.ok) {
        $("cmProfile").innerHTML = '<div class="detail-loading"><p>' + esc(out.error) + "</p></div>";
        return;
      }
      if (!out.data) {
        /* An unknown handle is a real destination with a real answer, not
           a blank page. */
        $("cmProfile").innerHTML =
          '<div class="detail-missing"><h2>No such person</h2>' +
          "<p>Nobody here uses " + esc("@" + profileHandle) + ".</p>" +
          '<a class="btn" href="#/">Back to the feed</a></div>';
        refreshIcons();
        return;
      }
      var p = out.data;
      profileIsMe = !!p.isMe;
      $("cmProfile").innerHTML =
        '<div class="profile-card">' +
          avatar(p, "profile-ava") +
          '<div class="profile-id">' +
            '<h2 class="profile-name">' + esc(p.name) + "</h2>" +
            '<span class="profile-handle">' + esc(p.handle) + "</span>" +
          "</div>" +
          (p.bio ? '<p class="profile-bio">' + esc(p.bio) + "</p>" : "") +
          '<p class="profile-meta">' +
            p.posts + (p.posts === 1 ? " post" : " posts") +
            (p.joinedAt ? " \u00b7 joined " + timeAgo(p.joinedAt) : "") +
          "</p>" +
          (p.isMe ? '<button class="btn" id="cmEditProfile" type="button">Edit profile</button>' : "") +
        "</div>";
      refreshIcons();
      var edit = $("cmEditProfile");
      if (edit) edit.addEventListener("click", editProfile);
      loadProfilePage();
    });
  }

  function loadProfilePage() {
    if (profileLoading || profileDone || !profileHandle) return;
    profileLoading = true;
    $("cmProfileLoader").hidden = false;
    BotoData.profileFeed(profileHandle, profileCursor).then(function (out) {
      profileLoading = false;
      $("cmProfileLoader").hidden = true;
      if (!out.ok) return;
      absorb(out.data.items);
      var list = $("cmProfileList");
      out.data.items.forEach(function (gen) { list.appendChild(buildCard(gen, false)); });
      profileCursor = out.data.cursor;
      profileDone = out.data.done;
      var none = profileDone && list.children.length === 0;
      $("cmProfileEmpty").hidden = !none;
      if (none) {
        /* flow.txt 9: an empty state says what to do next. Your own empty
           profile points at the composer; someone else's just states fact. */
        $("cmProfileEmpty").innerHTML = profileIsMe
          ? '<p class="feed-empty-sub">Nothing here yet. Start a generation and it shows up on your profile.</p>'
          : '<p class="feed-empty-sub">No posts yet.</p>';
      }
      refreshIcons();
    });
  }

  /* Editing is a prompt rather than a form: two fields did not justify a
     modal, and a prompt cannot leave the page in a half-saved state. */

  /* The server enforces these inside update_my_profile; checking here too
     is only the instant answer. Anything this misses, the database
     refuses, so the rules live where requests cannot go around them. */
  function spammyName(text) {
    var v = String(text || "");
    if (/(.)\1{4}/.test(v)) return true;
    if (/(..)\1\1/.test(v) || /(...)\1\1/.test(v)) return true;
    var letters = v.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 6 && !/[aeiouAEIOU]/.test(letters)) return true;
    return false;
  }

  function nameProblem(name) {
    var v = String(name == null ? "" : name).trim();
    if (!v) return ""; /* blank keeps the current name */
    if (v.length < 2) return "Names need at least 2 characters.";
    if (v.length > 40) return "Names are 40 characters at most.";
    /* eslint-disable-next-line no-control-regex */
    if (/[\u0001-\u001f\u007f]/.test(v)) return "Names cannot contain control characters.";
    if (!/[A-Za-z0-9]/.test(v)) return "Include at least one letter or number.";
    if (spammyName(v)) return "That name looks made up. Use a name people can read.";
    return "";
  }

  function bioProblem(bio) {
    var v = String(bio == null ? "" : bio);
    if (v.length > 300) return "Bios are 300 characters at most.";
    /* eslint-disable-next-line no-control-regex */
    if (/[\u0001-\u001f\u007f]/.test(v)) return "Bios cannot contain control characters.";
    return "";
  }

  function editProfile() {
    BotoData.profile(profileHandle).then(function (out) {
      if (!out.ok || !out.data) return;
      var name = window.prompt("Display name", out.data.name);
      if (name === null) return;
      var problem = nameProblem(name);
      if (problem) { notify(problem); return; }
      var bio = window.prompt("Bio, up to 300 characters", out.data.bio || "");
      if (bio === null) return;
      problem = bioProblem(bio);
      if (problem) { notify(problem); return; }
      BotoData.updateProfile(name, bio).then(function (res) {
        if (!res.ok) { notify(res.error); return; }
        renderProfile(profileHandle);
      });
    });
  }

  /* The missing state for #/g/<id>. wasDeleted distinguishes "the author
     removed it" from "this link never pointed at anything", because those
     are different facts and the reader can act on the difference. */
  function renderMissing(wasDeleted) {
    /* Writes into #cmDetail, the inner container. Replacing #cmDetailView
       itself would delete that container and break every later render. */
    var detail = $("cmDetail");
    if (!detail) return;
    detail.innerHTML =
      '<div class="detail-missing">' +
        '<i data-lucide="' + (wasDeleted ? "trash-2" : "unlink") + '"></i>' +
        "<h1>" + (wasDeleted ? "This post was deleted" : "This post does not exist") + "</h1>" +
        "<p>" + (wasDeleted
          ? "The author removed it. The replies it started are gone with it."
          : "The link may be mistyped, or it pointed at something that was never public.") +
        "</p>" +
        '<a class="detail-missing-back" href="#/">Back to the feed</a>' +
      "</div>";
    refreshIcons();
  }

  /* Show or hide the feed's generation composer dock. Kept as one function
     so the two call sites above can never disagree about it. */
  function setGenDock(show) {
    var dock = $("cmComposerDock");
    if (dock) dock.hidden = !show;
  }

  /* ---------- card rendering ---------- */

  function badge(gen, icon, label, extraClass) {
    return '<span class="gen-badge' + (extraClass ? " " + extraClass : "") + '">' +
      '<i data-lucide="' + icon + '"></i>' + esc(label) + "</span>";
  }

  function lineageLabel(gen) {
    if (!gen.parentId) return "";
    var parent = genById(gen.parentId);
    var who = parent ? parent.creator.handle : "a deleted generation";
    var verb = gen.kind === "challenge" ? "Challenging" : "Remixed from";
    var icon = gen.kind === "challenge" ? "swords" : "repeat-2";
    return '<div class="gen-lineage"><i data-lucide="' + icon + '"></i><span>' +
      esc(verb) + " " + esc(who) + "</span></div>";
  }

  function actionRow(gen, detail) {
    var lockedByOther = gen.locked && !gen.own;
    var lockTitle = gen.locked ? "Locked by creator" : "";
    var disAttr = lockedByOther ? ' disabled title="' + lockTitle + '" aria-disabled="true"' : "";
    var c = gen.counts;
    var html = '<div class="gen-actions">';
    html += '<button class="gen-act" data-act="remix"' + disAttr + ' aria-label="Remix this generation" title="Remix">' +
      '<i data-lucide="repeat-2"></i><span class="act-cnt">' + c.remix + "</span></button>";
    html += '<button class="gen-act" data-act="challenge"' + disAttr + ' aria-label="Challenge this generation" title="Challenge">' +
      '<i data-lucide="swords"></i><span class="act-cnt">' + c.challenge + "</span></button>";
    html += '<button class="gen-act" data-act="discuss" aria-label="Discuss this generation" title="Discuss">' +
      '<i data-lucide="message-circle"></i><span class="act-cnt">' + c.comment + "</span></button>";
    html += '<button class="gen-act' + (gen.saved ? " on" : "") + '" data-act="save" aria-label="Save this generation" aria-pressed="' + gen.saved + '" title="Save">' +
      '<i data-lucide="bookmark"></i><span class="act-cnt">' + c.save + "</span></button>";
    html += '<span class="gen-act-spacer"></span>';
    if (gen.visibility === "private") {
      html += '<span class="gen-visibility-note"><i data-lucide="eye-off"></i>Only you</span>';
    }
    if (gen.own) {
      html += '<button class="gen-act gen-act--icon' + (gen.locked ? " on" : "") + '" data-act="lock" aria-label="' +
        (gen.locked ? "Unlock this generation" : "Lock this generation") + '" aria-pressed="' + gen.locked + '" title="' +
        (gen.locked ? "Unlock" : "Lock") + '">' +
        '<i data-lucide="' + (gen.locked ? "lock" : "lock-open") + '"></i></button>';
    }
    /* Never mid-stream: a streaming post has a writer still appending to
       it. Delete sits behind the kebab for the same reason it does on a
       comment: it is destructive and does not belong in the row of counts
       the reader taps to browse. Report rides the same kebab on someone
       else's post so there is exactly one quiet place for both. */
    if (gen.status !== "streaming" && !gen.pending) {
      html += '<button class="gen-act gen-act--icon gen-kebab" data-act="menu" aria-label="More actions" ' +
        'aria-haspopup="menu" aria-expanded="false"><i data-lucide="ellipsis"></i></button>';
    }
    html += "</div>";
    return html;
  }

  function responseBlock(gen, detail) {
    if (gen.status === "failed") {
      return '<div class="gen-resp"><div class="gen-resp-label"><i data-lucide="sparkles"></i>BOTOCRACY' + botDemoTag() + '</div>' +
        '<p class="gen-error">' + esc(gen.errorText || "The generation was interrupted before it finished.") + "</p>" +
        '<button class="gen-retry" data-act="retry"><i data-lucide="refresh-cw"></i>Retry generation</button></div>';
    }
    var body = rich(gen.response);
    var isLong = !detail && gen.status === "complete" && gen.response.length > 320;
    var streaming = gen.status === "streaming";
    return '<div class="gen-resp">' +
      '<div class="gen-resp-label"><i data-lucide="sparkles"></i>BOTOCRACY' + botDemoTag() + '</div>' +
      '<div class="gen-resp-body' + (isLong ? " clamped" : "") + '" data-resp="' + gen.id + '">' +
      (streaming && gen.response === "" ? '<span class="gen-thinking">@bot is thinking</span>' : "") +
      body +
      (streaming ? '<span class="gen-cursor"></span>' : "") +
      "</div>" +
      (isLong ? '<button class="gen-expand" data-act="expand">Show more</button>' : "") +
      "</div>";
  }

  function buildCard(gen, detail) {
    var article = document.createElement("article");
    article.className = "gen" + (gen.status === "streaming" ? " streaming" : "");
    article.dataset.id = gen.id;

    var badges = "";
    if (gen.locked) badges += badge(gen, "lock", "Locked", "locked");
    if (gen.visibility === "private") badges += badge(gen, "eye-off", "Private");

    article.innerHTML =
      '<header class="gen-head">' +
        avatar(gen.creator, "gen-avatar") +
        '<div class="gen-id">' +
          '<span class="gen-name">' + esc(gen.creator.name) + "</span>" +
          '<a class="gen-handle" href="#/u/' +
            encodeURIComponent(String(gen.creator.handle).replace(/^@/, "")) + '">' +
            esc(gen.creator.handle) + "</a>" +
          '<span class="gen-time">' + esc(timeAgo(gen.createdAt)) + "</span>" +
          badges +
        "</div>" +
      "</header>" +
      lineageLabel(gen) +
      '<div class="gen-body">' +
        '<p class="gen-prompt">' +
          (isAddressed(gen) ? '<span class="gen-at">@bot</span>' : "") +
          esc(gen.prompt) +
        "</p>" +
        (isAddressed(gen) ? responseBlock(gen, detail) : "") +
        /* On the card, not in the response block: a plain post has no
           response block, and a plain post is exactly the kind most likely
           to be queued offline. The badge was invisible for them. */
        (gen.pending ? '<span class="gen-pending"><i data-lucide="clock"></i>Sending</span>' : "") +
        (gen.errorText && gen.status === "failed" && !isAddressed(gen)
          ? '<span class="gen-failed">' + esc(gen.errorText) +
            (gen.errorCode === "auth"
              ? ' <button class="gen-failed-auth" data-act="signin">Sign in</button>'
              : "") +
            "</span>" : "") +
        actionRow(gen, detail) +
      "</div>";
    return article;
  }

  /* Shared kernel: identical icon refresh to the workspace. Falls back to a
     direct lucide pass when the kernel file is missing (e.g. a half-deployed
     tree), so icons degrade instead of silently vanishing. */
  function refreshIcons() {
    if (window.BotoUI) BotoUI.refreshIcons();
    else if (window.lucide && lucide.createIcons) lucide.createIcons();
  }

  function replaceCard(gen) {
    var existing = document.querySelector('article.gen[data-id="' + gen.id + '"]');
    if (!existing) return;
    var detail = !!existing.closest("#view-detail");
    var fresh = buildCard(gen, detail);
    existing.replaceWith(fresh);
    refreshIcons();
  }

  /* ---------- feed ---------- */

  /* One deterministic ranking, no filter UI. Streaming gens pin on top so
     the posting user watches their generation land. Freshly merged arrivals
     (via the pill or pull to refresh) pin exactly once below those so new
     posts surface where the reader looks first, then steady state is pure
     engagement: viral means it earned remixes, challenges, discussion and
     saves, recency only breaks ties. */
  /* Needs the reader's attention now: still arriving, or stalled and
     waiting on them to retry it. */
  function urgent(gen) {
    return gen.status === "streaming" || (gen.status === "failed" && gen.own);
  }

  /* ---------- the feed ----------

     Server-paged. The rows arrive from feed_page in the order Postgres
     decided and are rendered in that order, which is the part that makes
     keyset pagination work: a cursor names a position in an ordering, so
     the client cannot re-sort a page without breaking the next one.

     That retires the local engagement ranking. It could only ever sort the
     slice already downloaded, so a highly-ranked post on page four stayed
     on page four and the ordering was a lie told one page at a time.
     Ranking belongs in the query when it is wanted; until then, newest
     first is honest and stable.

     Local state still holds what the server sent, because the renderer,
     the delete flow and the thread all read from it. It is a cache: every
     value in it came from Postgres and nothing writes to it that has not
     been through the server first. */

  var PAGE_SIZE = (window.BotoData && BotoData.PAGE_SIZE) || 10;
  var feedCursor = null;
  var feedDone = false;
  var feedLoading = false;
  var feedFailed = false;

  function liveOnline() {
    return !!(window.BotoData && BotoData.configured());
  }

  /* Urgent posts are the author's own streaming or failed ones. They are
     not in the server feed while they are still local, so they ride on top
     of whatever page one returned rather than being sorted into it. */
  function pendingLocal() {
    return state.generations.filter(function (gen) {
      return !isDeleted(gen) && (urgent(gen) || gen.pending);
    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  function visibleGenerations() {
    var list = state.generations.filter(function (gen) {
      /* A deleted post leaves the feed entirely. It still exists for its
         replies to point at, which is what renders the tombstone on the
         detail view. */
      if (isDeleted(gen)) return false;
      return gen.visibility === "public" || gen.own;
    });
    list.sort(function (a, b) {
      var pa = urgent(a) ? 1 : 0;
      var pb = urgent(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      var fa = isPinned(a) ? 1 : 0;
      var fb = isPinned(b) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return b.createdAt - a.createdAt;
    });
    return list;
  }

  function syncFeedTail() {
    var end = $("cmFeedEnd");
    var shown = $("cmFeedList").children.length;
    $("cmFeedLoader").hidden = !feedLoading;
    end.hidden = !(feedDone && shown > PAGE_SIZE);
  }

  /* One place decides which of the four states the feed is in, so two of
     them can never be on screen together. flow.txt 9: loading, empty,
     failed and populated are different answers and each needs its own. */
  function syncFeedState() {
    var shown = $("cmFeedList").children.length;
    $("cmFeedError").hidden = !(feedFailed && shown === 0);
    $("cmFeedEmpty").hidden = !(!feedFailed && !feedLoading && feedDone && shown === 0);
    syncFeedTail();
  }

  /* Merge rather than replace: a card already on screen keeps its DOM node
     and its expansion state, and a re-fetch of page one after a refresh
     does not duplicate what is already there. */
  function absorb(items) {
    var seen = {};
    state.generations.forEach(function (g, i) { seen[g.id] = i; });
    items.forEach(function (row) {
      if (seen[row.id] === undefined) {
        state.generations.push(row);
        seen[row.id] = state.generations.length - 1;
        return;
      }
      var existing = state.generations[seen[row.id]];
      /* The server is canonical, but a post still streaming locally has
         text the server has not been told about yet. Overwriting it would
         blank the response mid-answer. */
      if (existing.status === "streaming" && row.status !== "complete") return;
      state.generations[seen[row.id]] = row;
    });
  }

  function renderKnownFeed() {
    var list = $("cmFeedList");
    list.innerHTML = "";
    var pending = pendingLocal();
    var pendingIds = {};
    pending.forEach(function (gen) {
      pendingIds[gen.id] = true;
      list.appendChild(buildCard(gen, false));
    });
    feedOrder.forEach(function (id) {
      if (pendingIds[id]) return;
      var gen = genById(id);
      if (!gen || isDeleted(gen)) return;
      list.appendChild(buildCard(gen, false));
    });
    refreshIcons();
    syncFeedState();
  }

  /* The order the server returned, kept separately so re-rendering does
     not depend on a client sort that would contradict the cursor. */
  var feedOrder = [];

  function loadMoreFeed() {
    if (feedLoading || feedDone || !liveOnline()) return;
    feedLoading = true;
    feedFailed = false;
    syncFeedState();

    BotoData.feedPage(feedCursor).then(function (out) {
      feedLoading = false;
      if (!out.ok) {
        feedFailed = true;
        $("cmFeedErrorMsg").textContent = out.error;
        /* Only offer a retry for something that might work next time.
           text.txt 11: do not ask someone to try again at a wall. */
        $("cmFeedRetry").hidden = !out.retryable;
        syncFeedState();
        return;
      }
      absorb(out.data.items);
      out.data.items.forEach(function (row) {
        if (feedOrder.indexOf(row.id) === -1) feedOrder.push(row.id);
      });
      feedCursor = out.data.cursor;
      feedDone = out.data.done;
      persist();
      renderKnownFeed();
      fillViewport();
    });
  }

  function feedScroller() { return $("cmFeedView"); }

  function fillViewport() {
    if (currentMode() !== "community") return;
    var box = feedScroller();
    if (!box || box.hidden) return;
    var nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 320;
    if (nearBottom) loadMoreFeed();
  }

  /* A full reload of page one. Used by pull to refresh and by the pill,
     both of which mean "show me the current truth". */
  function reloadFeed() {
    feedCursor = null;
    feedDone = false;
    feedFailed = false;
    feedOrder = [];
    loadMoreFeed();
  }

  function renderFeed() {
    renderKnownFeed();
    if (feedOrder.length === 0) reloadFeed();
    else fillViewport();
  }

  /* ---------- detail ---------- */

  function renderDetail(gen) {
    var detail = $("cmDetail");
    detail.innerHTML = "";
    expandedThreads.clear(); /* fresh view: all chains start collapsed */
    var back = document.createElement("div");
    back.className = "detail-back";
    back.innerHTML = '<button class="icon-btn" id="backBtn" aria-label="Back to Community"><i data-lucide="arrow-left"></i></button>' +
      '<span class="detail-back-title">Generation</span>';
    detail.appendChild(back);
    back.querySelector("#backBtn").addEventListener("click", function () {
      location.hash = "#/";
    });

    detail.appendChild(buildCard(gen, true));

    var comments = commentsFor(gen.id);
    var section = document.createElement("div");
    section.className = "comments";
    /* With no discussion yet there is no thread to title: a "DISCUSSION · 0"
       heading over an empty box announces an absence. The empty state below
       carries the invitation instead. */
    section.innerHTML = comments.length
      ? '<div class="comments-title">DISCUSSION · ' + comments.length + "</div>"
      : "";
    var listEl = document.createElement("div");
    listEl.id = "cmCommentList";
    section.appendChild(listEl);
    renderThread(gen, listEl);

    var box = document.createElement("div");
    /* The composer is a response to an intent, not permanent furniture. On a
       post with no discussion it stays closed until the reader taps Reply.
       Once a thread exists the box is the thread's own footer and stays
       open, exactly like X: you can always add a top-level reply to a
       conversation you are already reading. */
    box.className = "comment-box" + (comments.length ? "" : " comment-box--closed");
    box.innerHTML =
      '<div class="remix-ctx comment-ctx" id="cmCommentCtx" hidden>' +
        '<i data-lucide="corner-down-right" class="remix-ctx-icon"></i>' +
        '<div class="remix-ctx-text">' +
          '<span class="remix-ctx-label" id="cmCommentCtxLabel"></span>' +
          '<button class="remix-ctx-clear" id="cmCommentCtxClear" aria-label="Cancel reply"><i data-lucide="x"></i></button>' +
        "</div>" +
      "</div>" +
      '<div class="composer" id="commentComposer">' +
        '<textarea id="cmCommentInput" rows="1" maxlength="1000" placeholder="Add to the discussion" aria-label="Add to the discussion"></textarea>' +
        '<div class="composer-row">' +
          '<div class="composer-spacer"></div>' +
          '<button class="send-btn" id="cmCommentSend" aria-label="Post comment" disabled><i data-lucide="arrow-up"></i></button>' +
        "</div>" +
      "</div>";
    section.appendChild(box);
    detail.appendChild(section);
    refreshIcons();
    wireCommentBox(gen, listEl);
  }

  /* ---------- per-comment kebab menu ----------
     Delete is destructive and permanent-looking, so it does not sit in the
     row the reader taps to move around the thread. It lives one level down,
     behind the kebab, reusing the app's .pop popover styling.

     One menu element is reused for every comment rather than rendering a
     menu per row: the thread re-renders constantly and a menu owned by a
     row would be destroyed underneath the user mid-interaction. */
  var commentMenuEl = null;
  var commentMenuFor = null;
  var commentMenuTrigger = null;
  var commentMenuOnPick = null;
  var menuOpenedAt = 0;

  function closeCommentMenu() {
    if (commentMenuTrigger) commentMenuTrigger.setAttribute("aria-expanded", "false");
    if (commentMenuEl) { commentMenuEl.classList.remove("open"); commentMenuEl.hidden = true; }
    commentMenuFor = null;
    commentMenuTrigger = null;
    commentMenuOnPick = null;
  }

  /* items: [{ act, label, icon, danger }]. onPick(act) runs after the menu
     closes, so a handler is free to re-render the row that owned it. */
  function openKebabMenu(trigger, key, items, onPick) {
    if (!commentMenuEl) {
      commentMenuEl = document.createElement("div");
      commentMenuEl.className = "pop pop-sm comment-menu";
      commentMenuEl.setAttribute("role", "menu");
      commentMenuEl.hidden = true;
      /* The menu is mounted on body, outside the thread's delegated
         listener, so it owns its own click handling. */
      commentMenuEl.addEventListener("click", function (ev) {
        var item = ev.target.closest("[data-mact]");
        if (!item) return;
        var act = item.getAttribute("data-mact");
        var pick = commentMenuOnPick;
        closeCommentMenu();
        if (pick) pick(act);
      });
      document.body.appendChild(commentMenuEl);
    }
    /* Tapping the same kebab again closes it. */
    if (commentMenuFor === key && !commentMenuEl.hidden) { closeCommentMenu(); return; }
    closeCommentMenu();

    commentMenuFor = key;
    commentMenuTrigger = trigger;
    commentMenuOnPick = onPick;
    trigger.setAttribute("aria-expanded", "true");
    commentMenuEl.innerHTML = items.map(function (it) {
      return '<button class="pop-item' + (it.danger ? " danger" : "") +
        '" role="menuitem" data-mact="' + it.act + '">' +
        '<i data-lucide="' + it.icon + '"></i><span>' + esc(it.label) + "</span>" +
      "</button>";
    }).join("");
    commentMenuEl.hidden = false;
    refreshIcons();

    /* Anchor to the kebab. position:fixed, so these are viewport
       coordinates, and the menu must stay visually attached to the icon
       that opened it: right edges flush, 6px below, flipping above only
       when there is genuinely no room below. The flip is measured against
       the space available on each side rather than assuming below-first,
       so a kebab near the bottom of the screen gets a menu that still
       touches it instead of one stranded across the viewport. */
    var r = trigger.getBoundingClientRect();
    var mw = commentMenuEl.offsetWidth || 190;
    var mh = commentMenuEl.offsetHeight || 44;
    var GAP = 6;
    var EDGE = 8;

    var spaceBelow = window.innerHeight - r.bottom - GAP - EDGE;
    var spaceAbove = r.top - GAP - EDGE;
    var placeAbove = mh > spaceBelow && spaceAbove > spaceBelow;

    var top = placeAbove ? r.top - mh - GAP : r.bottom + GAP;
    /* Clamp into the viewport without letting it drift off the trigger. */
    top = Math.max(EDGE, Math.min(top, window.innerHeight - mh - EDGE));

    /* Right edges flush with the kebab, then clamped to the screen. */
    var left = Math.max(EDGE, Math.min(r.right - mw, window.innerWidth - mw - EDGE));

    commentMenuEl.style.left = Math.round(left) + "px";
    commentMenuEl.style.top = Math.round(top) + "px";
    /* Scale out from the corner nearest the trigger. */
    commentMenuEl.style.setProperty("--origin", placeAbove ? "bottom right" : "top right");
    menuOpenedAt = Date.now();
    /* Next frame so the transition runs from the collapsed state. */
    requestAnimationFrame(function () { commentMenuEl.classList.add("open"); });
  }

  /* Any tap outside, any scroll, or Escape dismisses it. Capture phase so a
     re-render cannot swallow the event first. */
  document.addEventListener("click", function (e) {
    if (!commentMenuFor) return;
    if (e.target.closest(".comment-menu") || e.target.closest("[data-cmenu]")) return;
    closeCommentMenu();
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && commentMenuFor) closeCommentMenu();
  });
  /* Scroll dismisses, because a fixed menu would otherwise slide away from
     the icon it belongs to. Guarded by a timestamp: opening a kebab that is
     partially off-screen scrolls it into view, and that programmatic scroll
     was firing this handler and closing the menu in the same gesture. */
  /* Bound on document in the capture phase: the feed and the detail page
     scroll inside their own containers, and those scroll events do not
     bubble to window, so a window-only listener never fired and the menu
     rode along detached from its kebab. */
  document.addEventListener("scroll", function () {
    if (!commentMenuFor) return;
    if (Date.now() - menuOpenedAt < 350) return;
    closeCommentMenu();
  }, true);

  /* Which comment the composer is currently replying to; replies highlight
     their branch while it is targeted. Per page load, no persistence. */
  var replyingTo = null;

  /* Drops the composer's reply target and hides the context bar. Lives at
     module scope because delete and restore happen outside the composer's
     closure but can invalidate its target. Does NOT touch the input value:
     the user's typed draft is theirs and survives the target changing. */
  /* Set when a reply target is taken away by something other than the user:
     a delete, or a merge from another tab. The composer still holds their
     draft, and that draft was written as an answer to a specific comment, so
     posting it as a new top-level comment would put words in a place the
     user never chose. The next post() refuses and explains instead.
     Cancelling or aiming somewhere else clears the flag. */
  var replyTargetLost = false;

  function clearReplyTarget(lost) {
    replyingTo = null;
    replyTargetLost = !!lost;
    var bar = $("cmCommentCtx");
    if (bar) bar.hidden = true;
  }

  function commentRow(c, row, onPath) {
    var el = document.createElement("div");
    /* trow--open marks a row whose replies are currently revealed, which is
       what earns it the spine down its own avatar column (community.css). */
    el.className = "trow" +
      (onPath.has(c.id) ? " trow--on-path" : "") +
      (expandedThreads.has(c.id) && countDescendants(c) > 0 ? " trow--open" : "");
    el.dataset.depth = row.depth;

    var rails = "";
    row.guides.forEach(function (g) {
      rails += '<span class="trail' + (g ? " trail--line" : "") + '" aria-hidden="true"></span>';
    });
    var elbow = row.depth > 0
      ? '<span class="telbow' + (row.isLast ? " telbow--last" : "") + '" aria-hidden="true"></span>'
      : "";

    var kidCount = countDescendants(c); /* total replies under this comment */

    /* A deleted comment that still has replies has to hold its slot, or
       the children below it lose their parent and the rails point at
       nothing. It keeps the geometry and drops the content: no text, no
       author, no reply affordance. */
    if (isDeleted(c)) {
      el.innerHTML =
        rails + elbow +
        '<div class="trow-main">' +
          '<div class="comment comment--gone' + (row.depth > 0 ? " comment--reply" : "") + '">' +
            '<span class="comment-gone-text">Comment deleted.</span>' +
            (kidCount > 0
              ? '<button class="comment-replies-btn" data-expand="' + c.id + '" aria-expanded="' + String(expandedThreads.has(c.id)) + '">' +
                  '<i data-lucide="message-square"></i><span>' + kidCount + (kidCount === 1 ? " reply" : " replies") + "</span>" +
                "</button>"
              : "") +
          "</div>" +
        "</div>";
      return el;
    }

    el.innerHTML =
      rails + elbow +
      '<div class="trow-main">' +
        '<div class="comment' + (row.depth > 0 ? " comment--reply" : "") + '" data-reply-id="' + c.id + '">' +
          avatar(c.creator, "avatar-sm") +
          '<div class="comment-main">' +
            '<div class="comment-id">' +
              '<span class="comment-name">' + esc(c.creator.name) + "</span>" +
              '<a class="comment-handle" href="#/u/' +
                encodeURIComponent(String(c.creator.handle).replace(/^@/, "")) + '">' +
                esc(c.creator.handle) + "</a>" +
              '<span class="comment-time">' + esc(timeAgo(c.createdAt)) + "</span>" +
            "</div>" +
            '<p class="comment-text">' +
              (c.replyingToName ? '<span class="comment-mention">' + esc("@" + c.replyingToName) + "</span> " : "") +
              esc(c.text) +
            "</p>" +
            '<div class="comment-ops">' +
              /* Row grammar, fixed. There is exactly ONE reply control per
                 comment and it always says Reply, so a row never shows two
                 things that look like the same action. The reply count is
                 not a button competing with it: it is the disclosure for the
                 sub-thread, styled as a quiet toggle, and it reads
                 "2 replies" / "Hide replies" so its job is obvious.

                 Destructive actions do not sit in a row the user taps to
                 read. Delete lives behind the kebab, one level down, where
                 it cannot be hit by accident. */
              '<button class="comment-reply-btn" data-reply="' + c.id + '">' +
                '<i data-lucide="corner-down-right"></i><span>Reply</span>' +
              "</button>" +
              (kidCount > 0
                ? '<button class="comment-thread-toggle" data-expand="' + c.id +
                    '" aria-expanded="' + String(expandedThreads.has(c.id)) + '">' +
                    "<span>" +
                      (expandedThreads.has(c.id)
                        ? "Hide replies"
                        : kidCount + (kidCount === 1 ? " reply" : " replies")) +
                    "</span>" +
                  "</button>"
                : "") +
              '<span class="comment-ops-end">' +
                '<button class="comment-kebab" data-cmenu="' + c.id +
                  '" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">' +
                  '<i data-lucide="ellipsis"></i>' +
                "</button>" +
              "</span>" +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>";
    return el;
  }

  /* Replies sit behind a count chip beside the Reply button, Twitter style:
     "3 replies" tells you what is underneath, tapping it reveals that
     comment's tree with the connector lines, tapping again hides it. One
     ops row per comment, never a reply-looking row twice. expandedThreads
     holds every comment id whose children are currently revealed. */
  var expandedThreads = new Set();

  /* Every id in the subtree rooted at rootId, that id included. Used to keep
     expansion state consistent with what emitAll actually renders. */
  function subtreeIds(genId, rootId) {
    var all = commentsFor(genId);
    var out = [rootId];
    var frontier = [rootId];
    var guard = 0;
    while (frontier.length && guard++ < 5000) {
      var cur = frontier.shift();
      all.forEach(function (c) {
        if (c.parentId === cur && out.indexOf(c.id) === -1) {
          out.push(c.id);
          frontier.push(c.id);
        }
      });
    }
    return out;
  }

  function countDescendants(node) {
    var n = 0;
    (node.replies || []).forEach(function (kid) { n += 1 + countDescendants(kid); });
    return n;
  }

  /* One tap on the count chip shows the full comment tree under that comment:
     emitTree only ever stops at unexpanded comments, while emitAll walks an
     expanded subtree to its leaves so nothing hides behind a second tap.
     Guides carry the ancestor rail decisions for the connector lines. */
  function emitTree(node, depth, guides, isLast, out) {
    out.push({ node: node, depth: depth, guides: guides.slice(0, MAX_REPLY_DEPTH), isLast: isLast });
    if (!expandedThreads.has(node.id)) return;
    emitAll(node, depth, guides, isLast, out);
  }

  function emitAll(node, depth, guides, isLast, out) {
    var kids = node.replies || [];
    var childGuides = depth === 0 ? [] : guides.concat([!isLast]);
    kids.forEach(function (kid, i) {
      /* Three visual layers maximum (depth 0, 1, 2), YouTube and Twitter
         style. Past the cap a reply keeps its true parent in the data and
         in its @mention, but renders at the cap's indent instead of
         stepping further right. Without this clamp a long chain walked off
         the right edge of a 390px screen. */
      var kidDepth = Math.min(depth + 1, MAX_REPLY_DEPTH);
      out.push({ node: kid, depth: kidDepth, guides: childGuides.slice(0, MAX_REPLY_DEPTH), isLast: i === kids.length - 1 });
      emitAll(kid, depth + 1, childGuides, i === kids.length - 1, out);
    });
  }

  function renderThread(gen, listEl) {
    if (!listEl) listEl = $("cmCommentList");
    if (!listEl) return;
    /* The kebab that anchors the menu is about to be replaced, so a menu
       left open would float detached next to nothing. */
    closeCommentMenu();
    var comments = commentsFor(gen.id);
    listEl.innerHTML = "";
    if (comments.length === 0) {
      /* Zero comments is not an empty list, it is an invitation. The reader
         gets one clear action; the composer stays out of the way until they
         take it, so an unanswered post does not open with a blinking box
         demanding input. */
      listEl.innerHTML =
        '<div class="comments-empty">' +
          "<p>No replies yet. The sharpest take usually goes first.</p>" +
          '<button class="btn primary comments-empty-cta" data-first-reply="1">' +
            '<i data-lucide="corner-down-right"></i><span>Reply</span>' +
          "</button>" +
        "</div>";
      refreshIcons();
      return;
    }
    var onPath = replyingTo ? pathToRoot(comments, replyingTo.id) : new Set();
    var rows = [];
    buildCommentTree(comments).forEach(function (root) {
      emitTree(root, 0, [], true, rows);
    });
    rows.forEach(function (row) {
      listEl.appendChild(commentRow(row.node, row, onPath));
    });
    refreshIcons();
  }

  function wireCommentBox(gen, listEl) {
    var input = $("cmCommentInput");
    var send = $("cmCommentSend");
    var ctxBar = $("cmCommentCtx");
    var ctxLabel = $("cmCommentCtxLabel");
    replyingTo = null;
    if (ctxBar) { ctxBar.hidden = true; }

    function sync() { send.disabled = input.value.trim().length === 0; autogrow(input); }
    input.addEventListener("input", sync);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); }
      if (e.key === "Escape" && replyingTo) { clearReply(); }
    });
    send.addEventListener("click", post);

    /* Reply and reply-count expander run off one delegated listener so
       re-renders never rebind. */
    listEl.addEventListener("click", function (e) {
      /* Expanding is a read. It reveals replies and returns; it must not
         touch the composer. */
      var expandBtn = e.target.closest("[data-expand]");
      if (expandBtn) {
        /* emitAll reveals the entire subtree in one tap, so the whole
           subtree's state has to move with it. Toggling only the tapped id
           left descendants rendered on screen while their own chips still
           said aria-expanded="false" - the control lied about what the
           reader was looking at, and collapsing a child then did nothing
           visible because the parent was still force-showing it. */
        var rid = expandBtn.getAttribute("data-expand");
        var branch = subtreeIds(gen.id, rid);
        if (expandedThreads.has(rid)) {
          branch.forEach(function (bid) { expandedThreads.delete(bid); });
        } else {
          branch.forEach(function (bid) { expandedThreads.add(bid); });
        }
        renderThread(gen, listEl);
        return;
      }
      /* Kebab: Delete on your own comment, Report on someone else's. */
      var kebab = e.target.closest("[data-cmenu]");
      if (kebab) {
        var cid = kebab.getAttribute("data-cmenu");
        var rec = commentById(cid);
        var cItems = rec && rec.own
          ? [{ act: "delete", label: "Delete", icon: "trash-2", danger: true }]
          : [{ act: "report", label: "Report", icon: "flag" }];
        openKebabMenu(kebab, "c:" + cid, cItems, function (act) {
          if (act === "delete") {
            if (replyingTo && replyingTo.id === cid) clearReplyTarget(true);
            deleteComment(cid);
          }
          if (act === "report" && rec) reportComment(rec);
        });
        return;
      }
      var delBtn = e.target.closest("[data-del]");
      if (delBtn) {
        /* If the composer is aimed at the comment being deleted, drop the
           target first: replying to a tombstone is not a real state. */
        var delId = delBtn.getAttribute("data-del");
        closeCommentMenu();
        if (replyingTo && replyingTo.id === delId) clearReply();
        deleteComment(delId);
        return;
      }
      /* First-reply CTA on an empty thread: opens the composer for a NEW
         top-level comment. No parent, so it must not set a reply target. */
      if (e.target.closest("[data-first-reply]")) {
        clearReplyTarget(false);
        openComposer();
        return;
      }
      var replyBtn = e.target.closest("[data-reply]");
      if (replyBtn) {
        var wantId = replyBtn.getAttribute("data-reply");
        var target = null;
        commentsFor(gen.id).forEach(function (c) { if (c.id === wantId) target = c; });
        if (target) startReply(target);
      }
    });

    if (ctxBar) {
      $("cmCommentCtxClear").addEventListener("click", clearReply);
    }

    /* Reveals the composer and puts the caret in it. Used by the empty
       state's Reply and by every per-comment Reply. */
    function openComposer() {
      var wrap = document.querySelector(".comment-box");
      if (wrap) wrap.classList.remove("comment-box--closed");
      input.focus();
      /* A composer that opens below the fold has not really opened. */
      if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: "nearest" });
    }

    function startReply(target) {
      if (!requireSignIn("reply")) return;
      replyingTo = target;
      replyTargetLost = false;
      if (ctxBar) {
        ctxLabel.innerHTML = "<strong>Replying to " + esc(target.creator.handle) + "</strong> · " + esc(target.text);
        ctxBar.hidden = false;
      }
      openComposer();
      renderThread(gen, listEl); /* repaints the branch highlight */
    }

    /* The user's own cancel. Unlike a target being taken away, this is a
       deliberate choice to stop replying, so the draft is now a top-level
       comment and must not be blocked. */
    function clearReply() {
      clearReplyTarget(false);
      renderThread(gen, listEl);
    }

    function post() {
      if (!requireSignIn("comment")) return;
      var text = input.value.trim();
      /* State 8: empty or whitespace-only submission is not an error, it is
         a no-op. The send button is already disabled; this is the guard for
         Enter and for any programmatic path. */
      if (!text) return;

      /* THE REPLY-TARGET RULE. A draft written as a reply must never quietly
         become a top-level comment. Two ways that could happen, and both are
         refused here.

         First: the target was taken away while the draft sat in the box (a
         delete, or a cross-tab merge). clearReplyTarget already dropped it,
         so replyingTo is null and the guard below would not fire - hence the
         explicit flag. */
      if (replyTargetLost && !replyingTo) {
        notify("The comment you were replying to is no longer available. Your draft was kept.");
        replyTargetLost = false;
        return;
      }

      /* Second: replyingTo is an object captured when the user tapped Reply
         and the world moved underneath it. Re-resolve by id against live
         state before trusting it. */
      if (replyingTo) {
        var live = commentById(replyingTo.id);
        if (!live || isDeleted(live) || live.genId !== gen.id) {
          clearReplyTarget();
          renderThread(gen, listEl);
          notify("The comment you were replying to is no longer available. Your draft was kept.");
          return;
        }
        replyingTo = live;
      }

      var parentId = replyingTo ? replyingTo.id : null;
      /* Depth cap: replying to a comment already at MAX_REPLY_DEPTH attaches
         the new comment as that comment's sibling instead of its child,
         YouTube style, so the tree never gains a fourth layer. The @mention
         keeps the true addressee visible in the text.

         This walks up until the parent is above the cap rather than
         stepping up exactly once: a single step is only enough when the
         target sits exactly at the cap, and data that already runs deeper
         (an import, or a chain built before the cap existed) would still
         land past it. */
      if (replyingTo) {
        var all = commentsFor(gen.id);
        var byId = {};
        all.forEach(function (c) { byId[c.id] = c; });
        var anchor = replyingTo;
        var hops = 0;
        while (anchor && pathToRoot(all, anchor.id).size - 1 >= MAX_REPLY_DEPTH &&
               anchor.parentId && byId[anchor.parentId] && hops < 64) {
          anchor = byId[anchor.parentId];
          hops++;
        }
        parentId = anchor ? anchor.id : null;
      }
      /* Optimistic, then reconciled. A comment on a post that is itself
         still pending is queued behind it, because the outbox runs in
         order and the post's real id is patched into this job when it
         lands. */
      var ckey = BotoData.newKey();
      var optimistic = {
        id: ckey, pending: true,
        genId: gen.id, own: true, creator: YOU,
        text: text,
        parentId: parentId,
        replyingToName: replyingTo ? replyingTo.creator.name : null,
        createdAt: Date.now()
      };
      state.comments.push(optimistic);
      BotoData.queue({
        type: "comment", key: ckey, localId: ckey,
        genId: gen.id, body: text, parentId: parentId,
        onDone: function (row) { adoptServerComment(ckey, row); },
        onFail: function (out) {
          var local = commentById(ckey);
          if (local) { local.pending = false; local.failed = true; local.errorText = out.error; local.errorCode = out.code || null; }
          persist();
          refreshThreadOnly(gen.id);
          if (out.code === "auth") notify(out.error, "Sign in", goSignIn);
          else notify(out.error);
        }
      });
      BotoData.drain();
      /* A fresh reply must be visible: reveal every ancestor in its chain
         (each level gates its own children), plus the reply target itself. */
      if (replyingTo) {
        pathToRoot(commentsFor(gen.id), replyingTo.id).forEach(function (id) {
          expandedThreads.add(id);
        });
        expandedThreads.add(replyingTo.id);
      }
      /* State 10: derive, never increment. A parallel += drifts the moment
         anything else touches the set (a delete, an undo, a merge from
         another tab), and the chip then disagrees with the thread. */
      syncCommentCount(gen.id);
      /* State 9: a failed write must not look like a success. persist()
         reports it and has already told the user storage is broken; the
         comment stays in memory for this session so their text is not
         destroyed, but we do not pretend it was saved. */
      persist();
      input.value = "";
      replyingTo = null;
      replyTargetLost = false;
      if (ctxBar) ctxBar.hidden = true;
      sync();
      renderThread(gen, listEl);
      replaceCard(gen);
      updateDiscussionTitle(gen);
    }
  }

  /* The heading only exists while there is a discussion, so going 0 -> 1 has
     to create it and 1 -> 0 has to remove it. Only rewriting an existing node
     left the first comment with no heading until a full page render. */
  function updateDiscussionTitle(gen) {
    var section = document.querySelector(".comments");
    if (!section) return;
    var title = section.querySelector(".comments-title");
    var n = commentsFor(gen.id).length;
    if (!n) {
      if (title) title.remove();
      return;
    }
    if (!title) {
      title = document.createElement("div");
      title.className = "comments-title";
      section.insertBefore(title, section.firstChild);
    }
    title.textContent = "DISCUSSION · " + n;
  }

  /* ---------- pins ----------

     The timeline must not shift under a reader's thumb mid scroll, so new
     arrivals are announced by the pill and merged only when asked for.

  /* Ids pinned to the top for this page view only.

     freshPinned used to live on the generation itself and be persisted. It
     was documented as riding to the top "exactly once", but it only cleared
     on a merge, so a plain post (which has no streaming phase and therefore
     needs the pin to be seen at all) kept its pin across every reload. Four
     plain posts meant four permanent tenants at the top of a feed that is
     supposed to rank on engagement.

     Holding the set in memory makes "once" true by construction: a reload
     starts empty, so the pin cannot outlive the view that created it. */
  var sessionPins = Object.create(null);

  function pinForThisView(id) { sessionPins[id] = true; }
  function isPinned(gen) {
    return !!sessionPins[gen.id] || !!gen.freshPinned;
  }
  function clearPins() {
    sessionPins = Object.create(null);
  }


  /* ---------- new arrivals ----------

     Asks the server for a count, not for rows. An idle tab costs one
     integer per tick and the bodies are fetched only if the reader taps
     the pill, which is the difference between a feed that polls and a feed
     that downloads itself repeatedly.

     Backs off when the tab is hidden and stops after repeated failures:
     a phone in a pocket should not keep a radio busy, and a server that is
     down should not be hammered by every open tab (architect 6.4). */

  var POLL_MIN = 25000;
  var POLL_MAX = 90000;
  var pollDelay = POLL_MIN;
  var pollTimer = null;
  var pollFailures = 0;
  var newestSeen = null;

  function newestTimestamp() {
    var newest = 0;
    state.generations.forEach(function (gen) {
      if (!isDeleted(gen) && gen.createdAt > newest) newest = gen.createdAt;
    });
    return newest ? new Date(newest).toISOString() : new Date().toISOString();
  }

  /* ---------- realtime ----------
     The poll stays: a websocket that dies quietly would otherwise leave
     the feed frozen with no sign anything is wrong. Realtime makes the
     common case immediate, the poll guarantees the worst case is 25
     seconds rather than never. */

  function startRealtime() {
    if (!liveOnline() || !BotoData.watchFeed) return;

    BotoData.watchFeed(function (payload) {
      var row = payload["new"] || payload.old || {};
      /* Your own post already appeared optimistically; announcing it back
         to you would be a pill that reveals something you are looking at. */
      if (myUserId && row.author_id === myUserId) return;

      if (payload.eventType === "INSERT") {
        if (row.visibility !== "public") return;
        pendingCount += 1;
        syncPill();
        return;
      }
      /* An edit, a lock or a delete to a post already on screen. Repaint
         that card rather than the feed: the reader may be mid-scroll. */
      if (row.id && genById(row.id)) refreshOne(row.id);
    });
  }

  function watchOpenThread(genId) {
    if (!liveOnline() || !BotoData.watchThread) return;
    BotoData.watchThread(genId, function (payload) {
      var row = payload["new"] || payload.old || {};
      if (myUserId && row.author_id === myUserId) return;
      /* Refetch rather than trusting the payload, so one code path builds
         the thread and a comment arriving mid-draft cannot clobber the
         composer. hydrateThread already preserves pending local rows. */
      if (location.hash === "#/g/" + genId) hydrateThread(genId);
    });
  }

  /* myUserId is declared once at the top of the module, seeded
     synchronously from the Supabase session so write gating is correct
     from the very first render; the async refresh below only confirms
     it. Do not re-initialise it here. */

  function pollOnce() {
    if (!liveOnline() || currentMode() !== "community") return Promise.resolve();
    if (document.hidden) return Promise.resolve();
    newestSeen = newestSeen || newestTimestamp();
    return BotoData.newSince(newestSeen).then(function (out) {
      if (!out.ok) {
        pollFailures += 1;
        /* Exponential backoff rather than a fixed retry: a server that is
           struggling is made worse by every client retrying on a timer. */
        pollDelay = Math.min(POLL_MAX, pollDelay * 2);
        return;
      }
      pollFailures = 0;
      pollDelay = POLL_MIN;
      pendingCount = out.data || 0;
      syncPill();
    });
  }

  var pendingCount = 0;

  function schedulePoll() {
    clearTimeout(pollTimer);
    /* Six consecutive failures is a server that is not coming back in the
       next minute. Stop, and let a deliberate refresh restart it. */
    if (pollFailures >= 6) return;
    pollTimer = setTimeout(function () {
      pollOnce().then(schedulePoll);
    }, pollDelay + Math.floor(Math.random() * 5000));
  }

  /* A hidden tab is not reading. Resuming on focus is also the moment the
     reader is most likely to want fresh data. */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { clearTimeout(pollTimer); return; }
    pollFailures = 0;
    pollDelay = POLL_MIN;
    pollOnce().then(schedulePoll);
  });

  function mergeFresh() {
    pendingCount = 0;
    newestSeen = null;
    clearPins();
    $("cmNewPostsPill").hidden = true;
  }

  /* The pill says how many, not who: the avatars needed the rows, and the
     whole point of the count-only poll is that the rows have not been
     fetched yet. Naming a number we actually know beats showing faces we
     would have to download to be honest about. */
  function syncPill() {
    if ($("cmFeedView").hidden) return;
    var pill = $("cmNewPostsPill");
    if (!pendingCount) { pill.hidden = true; return; }
    var label = pill.querySelector(".npp-label");
    if (label) {
      label.textContent = pendingCount === 1 ? "1 new post" : pendingCount + " new posts";
    }
    $("cmNppAvas").innerHTML = "";
    pill.hidden = false;
  }

  function initFeedRetry() {
    $("cmFeedRetry").addEventListener("click", function () {
      /* A deliberate retry also restarts the poll: the reader is telling
         us they think the connection is back. */
      pollFailures = 0;
      pollDelay = POLL_MIN;
      reloadFeed();
      schedulePoll();
    });
  }

  function initPill() {
    $("cmNewPostsPill").addEventListener("click", function () {
      /* The rows were never downloaded, so this is a real fetch, not a
         re-render of something already held. */
      reloadFeed();
      mergeFresh();
      /* The feed scrolls inside #cmFeedView; window.scrollTo does nothing
         here, so the reader stayed where they were after tapping a pill
         that promises to take them to the new posts. */
      var box = feedScroller();
      if (box) box.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function initPullRefresh() {
    var ind = $("cmPullRefresh");
    var arrow = $("cmPullArrow");
    var spin = $("cmPullSpin");
    var startY = 0, dist = 0, active = false, refreshing = false;
    var TRIGGER = 72; /* dampened px; the raw pull is about 160px */

    function place(px) { ind.style.transform = "translate(-50%, " + px + "px)"; }
    function hide() {
      ind.classList.add("is-settling");
      place(-80);
      setTimeout(function () { ind.hidden = true; ind.classList.remove("is-settling"); }, 220);
    }

    document.addEventListener("touchstart", function (e) {
      if (refreshing || $("cmFeedView").hidden || window.scrollY > 0) return;
      var t = e.target;
      if (t && t.closest && t.closest("#cmComposerDock")) return;
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      active = true;
      dist = 0;
    }, { passive: true });

    document.addEventListener("touchmove", function (e) {
      if (!active || refreshing) return;
      dist = e.touches[0].clientY - startY;
      if (dist <= 0 || window.scrollY > 0) {
        if (!ind.hidden) hide();
        dist = 0;
        return;
      }
      var d = Math.min(96, dist * 0.45); /* rubber band damping */
      ind.hidden = false;
      arrow.style.transform = "rotate(" + Math.min(180, (d / TRIGGER) * 180) + "deg)";
      place(d - 56);
    }, { passive: true });

    document.addEventListener("touchend", function () {
      if (!active) return;
      active = false;
      if (refreshing) return;
      if (dist * 0.45 >= TRIGGER) refresh();
      else if (!ind.hidden) hide();
      dist = 0;
    });

    function refresh() {
      refreshing = true;
      spin.hidden = false;
      arrow.hidden = true;
      ind.classList.add("is-settling");
      place(8); /* hold as a spinner while the reload runs */
      setTimeout(function () {
        renderFeed();
        mergeFresh();
        refreshing = false;
        spin.hidden = true;
        arrow.hidden = false;
        arrow.style.transform = "";
        hide();
      }, 700);
    }
  }

  /* Debug handle for previews and the smoke tests. */
  window.SLOPIFY_DEBUG = {
    pollOnce: function () { return pollOnce(); },
    pendingCount: function () { return pendingCount; },
    reloadFeed: function () { return reloadFeed(); }
  };

  /* ---------- composer ---------- */

  var composeCtx = null; /* { mode: "remix" | "challenge", parentId } */

  function autogrow(textarea) {
    /* Same guard as the workspace composer: a hidden textarea measures 0 and
       would get pinned to a 0px inline height. Leave the natural height. */
    if (!textarea.getClientRects().length) { textarea.style.height = ""; return; }
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
  }

  function syncSend() {
    $("cmSendBtn").disabled = streamingNow || $("cmInput").value.trim().length === 0;
  }

  function setContext(mode, gen) {
    composeCtx = { mode: mode, parentId: gen.id };
    $("cmRemixCtx").hidden = false;
    var verb = mode === "challenge" ? "Challenging" : "Remixing";
    $("cmRemixCtxLabel").innerHTML =
      "<strong>" + verb + " " + esc(gen.creator.handle) + "</strong> · " + esc(gen.prompt);
    $("cmRemixCtx").querySelector(".remix-ctx-icon").setAttribute("data-lucide", mode === "challenge" ? "swords" : "repeat-2");
    refreshIcons();
    var input = $("cmInput");
    /* Remixing an agent generation re-addresses the agent, since the point
       is a new answer. Remixing a plain post carries the text as-is. */
    input.value = (isAddressed(gen) ? "@bot " : "") + gen.prompt;
    autogrow(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    syncSend();
    paintHighlight();
    syncSendIntent();
  }

  function clearContext() {
    composeCtx = null;
    $("cmRemixCtx").hidden = true;
  }

  /* Strip the @bot mention off an addressed prompt. The card re-adds it as
     its own coloured span, so the stored prompt never carries it twice. */
  function parsePrompt(raw) {
    return String(raw == null ? "" : raw).replace(BOT_MENTION, "").trim();
  }

  function sendGeneration() {
    if (streamingNow) return;
    var verb = composeCtx ? (composeCtx.mode === "challenge" ? "challenge" : "remix") : "post";
    if (!requireSignIn(verb)) return;
    var input = $("cmInput");
    var raw = input.value;
    /* Addressed to the agent or not. Unaddressed text is a plain post: it
       goes to the feed as itself and no agent is called for it. */
    var toBot = addressesBot(raw);
    var prompt = toBot ? parsePrompt(raw) : String(raw).trim();
    if (!prompt) { input.value = ""; syncSend(); return; }

    var kind = "original";
    var parentId = null;
    var rootId = null;
    if (composeCtx) {
      var parent = genById(composeCtx.parentId);
      if (parent) {
        kind = composeCtx.mode;
        parentId = parent.id;
        rootId = parent.rootId || parent.id;
        /* No local increment. The server derives remix_count and
           challenge_count from the rows that actually exist, and a client
           that adds one itself is claiming a remix the database may never
           receive: queue the write offline and the card reads 1 while
           Postgres says 0.

           Removing it alone was not enough either: the card then sat at 0
           while the database said 1, which is the same lie inverted. The
           parent is refetched once the child lands, so the number on the
           card is always one the server actually holds. */
        replaceCard(parent);
      }
    }

    /* Optimistic, with the truth attached. The card appears immediately
       because waiting on a round trip to see your own words is worse, but
       it says "Sending" until Postgres has it, so nothing on screen claims
       to be published when it is not.

       The id is temporary and the server's replaces it on success. Every
       reference to the local id is rewritten at that point, which is why
       nothing may persist a relationship to a post that is still pending. */
    var key = BotoData.newKey();
    var gen = {
      id: key,
      pending: true,
      own: true,
      creator: YOU,
      prompt: prompt,
      /* addressed: this post asked the agent for something. A plain post
         has no response block, is never streamed, and never reaches the
         demo engine or (in production) the provider layer. */
      addressed: toBot,
      response: "",
      status: toBot ? "streaming" : "complete",

      kind: kind,
      parentId: parentId,
      rootId: rootId,
      locked: false,
      visibility: state.visibility,
      saved: false,
      createdAt: Date.now(),
      counts: { remix: 0, challenge: 0, comment: 0, save: 0 }
    };
    state.generations.push(gen);
    if (!toBot) pinForThisView(gen.id);
    persist();

    input.value = "";
    autogrow(input);
    paintHighlight();
    syncSendIntent();
    clearContext();
    renderFeed();

    /* A plain post is final the moment it is made, so it can go now. An
       addressed one has to finish streaming first: sending an empty
       response and updating it later would be two writes and a window in
       which the feed shows a post with no answer. */
    if (!toBot) publishGeneration(gen, key);
    if (toBot) streamGeneration(gen, key);
  }

  /* Hands a finished post to the outbox and reconciles the optimistic card
     with whatever the server says it is. */
  function publishGeneration(gen, key) {
    BotoData.queue({
      type: "generation",
      key: key,
      localId: gen.id,
      fields: {
        prompt: gen.prompt,
        response: gen.response,
        addressed: gen.addressed,
        status: gen.status,
        visibility: gen.visibility,
        kind: gen.kind,
        remixOf: gen.parentId || null
      },
      /* Bound to the key, not to gen.id. gen.id is read when the callback
         fires, and by then it may already be the server's value: the
         lookup then matched nothing and the optimistic row was left
         pending forever, rendering as a ghost card beside the real one. */
      onDone: function (row) {
        adoptServerRow(key, row);
        /* The parent's derived counts moved when this child landed. */
        if (row.parentId) refreshOne(row.parentId);
      },
      onFail: function (out) { markFailed(key, out.error, out.code); }
    });
    BotoData.drain();
    syncOutboxChrome();
  }

  /* The local id was a placeholder. Everything pointing at it has to move
     to the real one in the same breath, or a comment written while the
     post was in flight would be orphaned. */
  /* Pulls one post's current state back from the server and repaints it.
     Used after a write that changes a row this client does not own the
     truth for, such as a remix bumping its parent's count. */
  function refreshOne(genId) {
    if (!genId || !liveOnline()) return;
    BotoData.generation(genId).then(function (out) {
      if (!out.ok || !out.data) return;
      var idx = -1;
      state.generations.forEach(function (g, i) { if (g.id === genId) idx = i; });
      if (idx === -1) return;
      state.generations[idx] = out.data;
      persist();
      replaceCard(out.data);
    });
  }

  function adoptServerRow(localId, row) {
    /* Drop the placeholder first, then insert the server row. Doing it in
       that order makes the outcome identical whether the local row is
       still present (the common case), was already replaced, or was lost
       to a reload: there is exactly one row for this post afterwards
       either way.

       The earlier version branched on whether the placeholder was found
       and the two branches drifted, which left a card stuck on "Sending"
       beside the real post it had just become. One path is easier to keep
       correct than two. */
    var wasPinned = false;
    retire(localId);
    state.generations = state.generations.filter(function (g) {
      if (g.id !== localId) return true;
      wasPinned = isPinned(g);
      return false;
    });
    state.generations = state.generations.filter(function (g) { return g.id !== row.id; });
    state.generations.push(row);

    state.comments.forEach(function (c) { if (c.genId === localId) c.genId = row.id; });
    state.generations.forEach(function (g) {
      if (g.parentId === localId) g.parentId = row.id;
      if (g.rootId === localId) g.rootId = row.id;
    });

    var at = feedOrder.indexOf(localId);
    if (at !== -1) feedOrder[at] = row.id;
    else if (feedOrder.indexOf(row.id) === -1) feedOrder.unshift(row.id);
    if (wasPinned) pinForThisView(row.id);

    persist();
    if (location.hash === "#/g/" + localId) location.hash = "#/g/" + row.id;
    else renderFeed();
    syncOutboxChrome();
    return;
  }

  function adoptServerRowLegacy(localId, row) {
    var idx = -1;
    state.generations.forEach(function (g, i) { if (g.id === localId) idx = i; });

    /* No local row to replace. That is the reload case: the optimistic row
       was written to storage under the local id, the tab closed, and the
       resumed job has just created the real one. Adding it and dropping
       any stale placeholder is the same reconciliation, done late. */
    if (idx === -1) {
      state.generations = state.generations.filter(function (g) {
        return g.id !== localId;
      });
      state.generations.push(row);
      if (feedOrder.indexOf(row.id) === -1) feedOrder.unshift(row.id);
      persist();
      renderFeed();
      syncOutboxChrome();
      return;
    }

    var wasPinned = isPinned(state.generations[idx]);
    state.generations[idx] = row;

    state.comments.forEach(function (c) { if (c.genId === localId) c.genId = row.id; });
    state.generations.forEach(function (g) {
      if (g.parentId === localId) g.parentId = row.id;
      if (g.rootId === localId) g.rootId = row.id;
    });
    var at = feedOrder.indexOf(localId);
    if (at !== -1) feedOrder[at] = row.id;
    else feedOrder.unshift(row.id);
    if (wasPinned) pinForThisView(row.id);

    persist();
    if (location.hash === "#/g/" + localId) location.hash = "#/g/" + row.id;
    else renderFeed();
    syncOutboxChrome();
  }

  function adoptServerComment(localId, row) {
    var found = false;
    retire(localId);
    state.comments.forEach(function (c) { if (c.parentId === localId) c.parentId = row.id; });
    for (var i = 0; i < state.comments.length; i++) {
      if (state.comments[i].id === localId) { state.comments[i] = row; found = true; break; }
    }
    if (!found) state.comments.push(row);
    if (expandedThreads.has(localId)) { expandedThreads.delete(localId); expandedThreads.add(row.id); }
    syncCommentCount(row.genId);
    persist();
    refreshThreadOnly(row.genId);
    syncOutboxChrome();
  }

  /* A write the server refused for good. The post stays on screen carrying
     the reason: silently deleting someone's words because a policy said no
     is worse than showing them why. */
  function markFailed(localId, reason, code) {
    var gen = genById(localId);
    if (!gen) return;
    gen.pending = false;
    gen.status = "failed";
    gen.errorText = reason;
    gen.errorCode = code || null;
    persist();
    renderFeed();
    syncOutboxChrome();
  }

  function syncOutboxChrome() {
    var n = BotoData.pending().length;
    var el = $("cmOutbox");
    if (!el) return;
    el.hidden = n === 0;
    if (n) {
      el.querySelector(".outbox-label").textContent =
        n === 1 ? "1 post waiting to send" : n + " posts waiting to send";
    }
  }

  /* Demo engine: deterministic canned responses shaped by the prompt.
     Production swaps this for the Botocracy provider layer over SSE. */
  function replyFor(gen) {
    var p = gen.prompt.toLowerCase();
    var out = "";
    if (gen.kind === "remix") {
      out += "Tighter version of the original ask.\n\n";
    } else if (gen.kind === "challenge") {
      out += "Same task. Different approach.\n\n";
    }
    if (/(business|startup|idea|venture|side hustle|make money)/.test(p)) {
      out += "1. **Pick the most complained-about workflow in your circle.** Complaints are free market research. Build the smallest tool that makes one of them stop.\n\n2. **Sell the result, not the software.** A fixed price outcome converts better than a feature list.\n\n3. **Use a channel you already have.** Your first ten customers should come from people who already reply to your messages.\n\n4. **Charge early.** A paid pilot is the only validation that survives contact with reality.\n\n5. **Keep operations manual until they hurt.** Automation before volume is procrastination in a costume.";
    } else if (/(explain|why|how does|how do|what is)/.test(p)) {
      out += "Short version: the visible symptom is usually a coordination problem wearing a costume.\n\n**First**, name the actors and what each one optimizes for. Once incentives are on the table, the confusing behavior stops being confusing.\n\n**Second**, find the constraint that everything queues behind. Fixing anything upstream or downstream of that constraint does nothing until the constraint moves.\n\n**Third**, ask what feedback loop keeps the current state stable. States that persist are being maintained by something, and it is rarely the thing getting blamed in public.";
    } else if (/(code|function|script|python|javascript|debug|bug)/.test(p)) {
      out += "Before writing any code, do three things.\n\n1. **Reproduce the behavior on the smallest input.** If you cannot trigger it on demand, you cannot verify the fix.\n\n2. **State the invariant that is being violated.** Most bugs are a broken assumption that was never written down.\n\n3. **Fix at the layer that owns the invariant.** Patching the caller works today and returns as a stranger tomorrow.\n\nShare the failing snippet and I will walk through it line by line.";
    } else {
      out += "Working take, stated plainly.\n\n**The strong version of this ask** has a concrete user, a moment where the pain shows up, and a cost when nothing happens. Sharpen all three and the answer usually falls out on its own.\n\n**Where people get stuck** is treating the generation as the finish line. The value is in the next action: remix it with a harder constraint, or challenge it with a better frame, and see what survives.\n\nThat is the whole game here. Your move.";
    }
    return out;
  }

  function streamGeneration(gen, key) {
    streamingNow = true;
    syncSend();
    var full = replyFor(gen);
    var pos = 0;
    var lastSave = 0;

    function node() {
      return document.querySelector('[data-resp="' + gen.id + '"]');
    }

    if (reducedMotion) {
      gen.response = full;
      finish();
      return;
    }

    var timer = setInterval(function () {
      pos = Math.min(full.length, pos + 3 + Math.floor(Math.random() * 4));
      gen.response = full.slice(0, pos);
      var el = node();
      if (el) {
        el.innerHTML = rich(gen.response) + '<span class="gen-cursor"></span>';
      }
      /* Local only while it streams. This used to persist every 700ms,
         which as a server write would be a row update every few
         characters: the answer is not a fact until it is finished. */
      var now = Date.now();
      if (now - lastSave > 700) { lastSave = now; persist(); }
      if (pos >= full.length) {
        clearInterval(timer);
        finish();
      }
    }, 28);

    function finish() {
      gen.status = "complete";
      gen.response = full;
      persist();
      streamingNow = false;
      syncSend();
      replaceCard(gen);
      /* One write, at the point the post is actually what it will be. */
      if (key) publishGeneration(gen, key);
    }
  }

  function retryGeneration(gen) {
    if (streamingNow) return;
    gen.status = "streaming";
    gen.response = "";
    gen.errorText = null;
    persist();
    replaceCard(gen);
    streamGeneration(gen);
  }

  /* ---------- card actions ---------- */

  function onCardAction(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var card = e.target.closest("article.gen");
    if (!card) return;
    var gen = genById(card.dataset.id);
    if (!gen) return;
    var act = btn.dataset.act;
    if (btn.disabled) return;
    e.stopPropagation();

    if (act === "save") {
      if (!requireSignIn("save posts")) return;
      if (gen.pending) { notify("Wait for the post to send first."); return; }
      /* Optimistic, and reverted on refusal. The count is nudged locally
         only so the number under the thumb matches the icon; the server
         recomputes it from the saves table and the next read corrects any
         drift. */
      var next = !gen.saved;
      gen.saved = next;
      gen.counts.save += next ? 1 : -1;
      persist();
      replaceCard(gen);
      BotoData.setSaved(gen.id, next).then(function (out) {
        if (out.ok) return;
        gen.saved = !next;
        gen.counts.save += next ? -1 : 1;
        persist();
        replaceCard(gen);
        notify(out.error);
      });
      return;
    }
    if (act === "menu") {
      var items = gen.own
        ? [{ act: "delete", label: "Delete post", icon: "trash-2", danger: true }]
        : [{ act: "report", label: "Report post", icon: "flag" }];
      openKebabMenu(btn, "g:" + gen.id, items, function (picked) {
        if (picked === "delete") deleteGeneration(gen.id);
        if (picked === "report") reportPost(gen);
      });
      return;
    }
    if (act === "signin") {
      goSignIn();
      return;
    }
    if (act === "lock" && gen.own) {
      if (gen.pending) { notify("Wait for the post to send first."); return; }
      var want = !gen.locked;
      gen.locked = want;
      persist();
      replaceCard(gen);
      BotoData.setLocked(gen.id, want).then(function (out) {
        if (out.ok) return;
        gen.locked = !want;
        persist();
        replaceCard(gen);
        notify(out.error);
      });
      return;
    }
    if (act === "remix" || act === "challenge") {
      if (!requireSignIn(act)) return;
      if (gen.locked) return;
      location.hash = "#/";
      setContext(act, gen);
      return;
    }
    if (act === "discuss") {
      location.hash = "#/g/" + gen.id;
      return;
    }
    if (act === "expand") {
      var body = card.querySelector(".gen-resp-body");
      if (body) {
        body.classList.toggle("clamped");
        btn.textContent = body.classList.contains("clamped") ? "Show more" : "Show less";
      }
      return;
    }
    if (act === "retry") {
      retryGeneration(gen);
      return;
    }
  }

  document.addEventListener("click", onCardAction);

  document.addEventListener("click", function (e) {
    var card = e.target.closest("article.gen");
    if (!card) return;
    if (e.target.closest("[data-act]") || e.target.closest("a")) return;
    var gen = genById(card.dataset.id);
    if (!gen || gen.status === "streaming") return;
    if ((location.hash || "").indexOf("#/g/" + gen.id) === 0) return;
    location.hash = "#/g/" + gen.id;
  });

  /* ---------- wiring ---------- */

  /* Repaint the highlight layer under the composer. The layer mirrors the
     textarea's exact string and metrics, so the coloured @bot sits pixel
     for pixel under the real (transparent) text. Only the leading mention
     is coloured: a stray "@bot" mid-sentence does not address the agent,
     and colouring it would promise behaviour that will not happen. */
  /* The layer ships with an inline transparent/absolute failsafe so a stale
     or missing community.css can never paint a second copy of the text above
     the input. Inline styles outrank the stylesheet, so once the stylesheet
     is verifiably applied the inline colour has to be handed back, otherwise
     the mention would stay invisible. The probe is the textarea's own
     transparent fill, which only that stylesheet sets. */
  function releaseHighlightFailsafe(input, layer) {
    /* Re-evaluated on every paint rather than latched once: the stylesheet
       can arrive late, and it can also go away. Both directions have to be
       handled, and the safe state is the one that cannot double the text. */
    var fill = getComputedStyle(input).webkitTextFillColor || "";
    var styled = fill.indexOf("rgba(0, 0, 0, 0)") !== -1 || fill === "transparent";
    layer.style.color = styled ? "" : "transparent";
  }

  function paintHighlight() {
    var input = $("cmInput");
    var layer = $("cmInputHl");
    if (!input || !layer) return;
    releaseHighlightFailsafe(input, layer);
    var raw = input.value;
    var m = raw.match(BOT_MENTION);
    if (m) {
      /* Split on the real match so whitespace is preserved exactly. */
      var mention = raw.slice(0, m[0].length);
      layer.innerHTML = '<span class="hl-at">' + esc(mention) + "</span>" + esc(raw.slice(m[0].length));
    } else {
      layer.textContent = raw;
    }
    /* The textarea scrolls independently once it hits its max height. */
    layer.scrollTop = input.scrollTop;
  }

  /* Tell the user which of the two things the send button will do, so the
     outcome is never a surprise (flow rule: every control states its
     consequence). */
  function syncSendIntent() {
    var btn = $("cmSendBtn");
    var dock = $("cmComposerDock");
    if (!btn) return;
    var toBot = addressesBot($("cmInput").value);
    /* Signed-out visitors are read-only: the button states the truth up
       front instead of starting a send that the server will refuse. */
    var label = !signedIn() ? "Sign in to post" : (toBot ? "Ask @bot" : "Post to the feed");
    btn.title = label;
    btn.setAttribute("aria-label", label);
    if (dock) dock.classList.toggle("to-bot", toBot && signedIn());
  }

  function initComposer() {
    var input = $("cmInput");
    input.addEventListener("input", function () {
      autogrow(input); syncSend(); paintHighlight(); syncSendIntent();
    });
    input.addEventListener("scroll", function () {
      var layer = $("cmInputHl");
      if (layer) layer.scrollTop = input.scrollTop;
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendGeneration();
      }
    });
    $("cmSendBtn").addEventListener("click", sendGeneration);
    $("cmRemixCtxClear").addEventListener("click", clearContext);

    $("cmVisBtn").addEventListener("click", function () {
      state.visibility = state.visibility === "public" ? "private" : "public";
      persist();
      syncVisBtn();
    });
    syncVisBtn();
    paintHighlight();
    syncSendIntent();
  }

  function syncVisBtn() {
    var btn = $("cmVisBtn");
    var isPublic = state.visibility === "public";
    btn.innerHTML = '<i data-lucide="' + (isPublic ? "globe" : "eye-off") + '"></i>';
    btn.setAttribute("aria-pressed", String(!isPublic));
    var label = "Visibility: " + (isPublic ? "Public" : "Private");
    btn.title = label;
    btn.setAttribute("aria-label", label);
    refreshIcons();
  }

  function initModeSeg() {
    $("cmTabCommunity").addEventListener("click", function () {
      if (location.hash === "#/" || location.hash === "") {
        route(); /* already there: pull the feed view forward */
      } else {
        location.hash = "#/";
      }
    });
    $("cmTabWorkspace").addEventListener("click", function () {
      if (window.BotoAccess && !BotoAccess.canUseWorkspace()) {
        openAccessSheet();
        return;
      }
      location.hash = "#/workspace";
    });
    window.addEventListener("resize", function () {
      moveGlide(currentMode() === "workspace" ? $("cmTabWorkspace") : $("cmTabCommunity"));
      var cmInput = $("cmInput");
      if (cmInput) autogrow(cmInput);
    });
  }

  /* ---------- workspace access gate (waitlist) ---------- */

  var accessSheetOpen = false;

  function openAccessSheet() {
    var m = $("accessModal");
    if (!m || accessSheetOpen) return;
    accessSheetOpen = true;
    if (window.BotoUI && BotoUI.openModal) BotoUI.openModal(m);
    else m.hidden = false;
    var st = window.BotoAccess ? BotoAccess.getStatus() : { grant: null };
    if (st.grant && st.grant.status === "waitlisted") showWaitlistDone(st.grant);
    var email = $("waitlistEmail");
    if (email) setTimeout(function () { email.focus(); }, 120);
    refreshIcons();
  }

  function closeAccessSheet() {
    var m = $("accessModal");
    if (!m) return;
    accessSheetOpen = false;
    if (window.BotoUI && BotoUI.closeModal) BotoUI.closeModal(m);
    else { m.classList.remove("open"); m.hidden = true; }
  }

  function showWaitlistDone(grant) {
    $("waitlistForm").hidden = true;
    $("waitlistDone").hidden = false;
    var pos = $("waitlistPosition");
    if (pos && grant && grant.position) {
      pos.textContent = "You are number " + grant.position + " in line. We'll email you when your seat opens.";
    }
    refreshIcons();
  }

  function initAccessGate() {
    if (!window.BotoAccess) return;
    BotoAccess.init();
    /* a grant that lands while the sheet is open unlocks out of it */
    BotoAccess.onChange(function () {
      if (accessSheetOpen && BotoAccess.canUseWorkspace()) closeAccessSheet();
    });
    var form = $("waitlistForm");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = $("waitlistJoin");
      var email = $("waitlistEmail").value;
      btn.disabled = true;
      BotoAccess.joinWaitlist(email).then(function (grant) {
        if (grant && grant.status === "granted") closeAccessSheet();
        else showWaitlistDone(grant);
      }).catch(function (err) {
        var note = $("waitlistNote");
        note.textContent = err && err.message ? err.message : "Could not join. Try again.";
      }).finally(function () { btn.disabled = false; });
    });
    $("accessContinue").addEventListener("click", closeAccessSheet);
    mClickListener();
  }

  function mClickListener() {
    $("accessModal").addEventListener("click", function (e) {
      if (e.target === this) closeAccessSheet();
    });
  }

  function init() {
    initAccessGate();
    initComposer();
    initModeSeg();
    /* Work queued before the tab closed resumes here. flow.txt 13: it is
       saved and resumed, not silently lost. */
    /* A pending row whose job is no longer queued is a ghost: the write
       either finished after the tab closed, or the queue was cleared while
       the optimistic row stayed behind. Either way it describes something
       that is not happening, and left alone it renders forever as a card
       stuck on "Sending" beside the real post it duplicates.

       Reconciled against the outbox rather than against the server,
       because the outbox is the record of what is actually in flight. If
       the write did land, the next feed page brings the real row in. */
    function reapOrphanedPending() {
      if (!window.BotoData) return;
      var queued = Object.create(null);
      BotoData.pending().forEach(function (j) {
        queued[j.localId || j.key] = true;
      });
      var before = state.generations.length + state.comments.length;
      state.generations = state.generations.filter(function (g) {
        if (!g.pending || queued[g.id]) return true;
        retire(g.id);
        return false;
      });
      state.comments = state.comments.filter(function (c) {
        if (!c.pending || queued[c.id]) return true;
        retire(c.id);
        return false;
      });
      if (state.generations.length + state.comments.length !== before) {
        persist();
        renderFeed();
      }
    }

    if (window.BotoData) {
      BotoData.currentUser().then(function (u) {
        myUserId = u && u.id;
        startRealtime();
        syncNotifBadge();
        if (BotoData.watchNotifications) {
          BotoData.watchNotifications(syncNotifBadge);
        }
      });
      /* A job that outlived the tab has no closures left, so settlement
         goes through these. Same path, whether the write was queued a
         second ago or a session ago. */
      BotoData.setJobHandler("generation",
        function (row, job) {
          adoptServerRow(job.localId || job.key, row);
          if (row.parentId) refreshOne(row.parentId);
        },
        function (out, job) { markFailed(job.localId || job.key, out.error, out.code); });
      BotoData.setJobHandler("comment",
        function (row, job) { adoptServerComment(job.localId || job.key, row); },
        function (out, job) {
          var local = commentById(job.localId || job.key);
          if (local) { local.pending = false; local.failed = true; local.errorText = out.error; local.errorCode = out.code || null; }
          persist();
          refreshThreadOnly(job.genId);
        });
      BotoData.setOutboxListener(syncOutboxChrome);
      syncOutboxChrome();
      /* Drain first, then sweep. Reaping before the queue runs looks at an
         outbox that has not been given a chance to settle, so a job about
         to succeed is indistinguishable from one that vanished. Sweeping
         afterwards means every pending row left over is genuinely orphaned:
         nothing is in flight to claim it. */
      BotoData.drain().then(reapOrphanedPending);
    }
    initPill();
    initNotifications();
    initFeedRetry();
    initPullRefresh();
    schedulePoll();
    var sentinel = $("cmFeedSentinel");
    if (sentinel && "IntersectionObserver" in window) {
      /* root must be the scrolling element, not the viewport. With the
         default root the sentinel's intersection is computed against the
         window, which does not scroll in community mode, so it read as
         permanently visible and kept requesting pages. */
      new IntersectionObserver(function (entries) {
        if ($("cmFeedView").hidden) return;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) { loadMoreFeed(); break; }
        }
      }, { root: feedScroller(), rootMargin: "0px 0px 480px" }).observe(sentinel);
    }
    /* The feed scrolls inside #cmFeedView, so a window scroll listener never
       fires for it. Kept on the scroller as the fallback for browsers that
       drop observer callbacks during fast flings. */
    var scrollBox = feedScroller();
    if (scrollBox) scrollBox.addEventListener("scroll", fillViewport, { passive: true });
    window.addEventListener("scroll", fillViewport, { passive: true });
    /* Fires only in other tabs, so this is the cross-tab write signal.
       Guarded on the key because the workspace and the access gate share
       this origin's storage. */
    window.addEventListener("storage", function (e) {
      if (e.key && e.key !== LS_KEY) return;
      adoptExternalState();
    });
    window.addEventListener("hashchange", route);
    route();
    route();
    requestAnimationFrame(function () {
      moveGlide(currentMode() === "workspace" ? $("cmTabWorkspace") : $("cmTabCommunity"));
    });
    refreshIcons();
  }

  /* Signing out does not reload the page, and Community stays mounted,
     so the workspace sign-out flow tells it to drop the previous
     identity here: switch to the anonymous cache (public content only),
     clear any compose context, and repaint. */
  window.BotoCommunity = {
    signOutReset: function () {
      myUserId = null;
      LS_KEY = cacheKeyFor(null);
      state = load() || seed();
      composeCtx = null;
      var ctx = $("cmRemixCtx");
      if (ctx) ctx.hidden = true;
      route();
      syncSend();
      syncSendIntent();
      refreshIcons();
    }
  };

  init();
})();
