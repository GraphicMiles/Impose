/* Taste and flow gate.

   The design pass applied from the taste-skill redesign protocol is mostly
   static assets, which means nothing in the existing suites would notice if
   a later edit quietly undid it. These tests pin the findings that pass was
   built to fix, so a regression fails the build instead of shipping.

   Every assertion below maps to a specific rule:
     - taste-skill 9.G   : zero em-dashes and en-dashes in shipped source
     - taste-skill 9.A   : no pure #000 backgrounds, one gray family
     - redesign-skill    : real type face, shared across every surface
     - redesign-skill    : skip link, 404 page, active-nav indication
     - flow.txt rule 3   : no control that looks functional but does nothing
     - flow.txt rule 15  : deep links resolve, no unexplained dead ends
     - text.txt rule 10  : errors and empty states read like a human wrote them

   Run: node agent/tests/taste.js */
"use strict";
var fs = require("fs");
var path = require("path");

var root = path.join(__dirname, "..", "..");
var read = function (rel) { return fs.readFileSync(path.join(root, rel), "utf8"); };
var exists = function (rel) { return fs.existsSync(path.join(root, rel)); };

var passed = 0, failed = 0;
var queue = [];
function test(name, fn) { queue.push([name, fn]); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

/* The public marketing and legal surface, plus the auth screens. */
var PUBLIC_PAGES = [
  "about.html", "privacy.html", "terms.html",
  "contact.html", "acceptable-use.html", "data-security.html", "404.html"
];

/* Source we actually ship and author. Vendored libraries and the generated
   single-file build are excluded: they mirror these files by construction. */
var AUTHORED = [
  "index.html", "auth.html", "styles.css", "public.css", "auth.css",
  "community.css", "app.js", "community.js", "public.js", "auth.js",
  "ui-core.js", "access.js", "config.js", "fonts.css"
].concat(PUBLIC_PAGES);

/* ---------- taste-skill 9.G: the em-dash ban ---------- */

test("no em-dash or en-dash anywhere in authored source", function () {
  var offenders = [];
  AUTHORED.forEach(function (rel) {
    if (!exists(rel)) return;
    read(rel).split("\n").forEach(function (line, i) {
      if (line.indexOf("\u2014") > -1 || line.indexOf("\u2013") > -1) {
        offenders.push(rel + ":" + (i + 1));
      }
    });
  });
  ok(offenders.length === 0, "dash characters found at " + offenders.join(", "));
});

/* ---------- taste-skill 9.A: surfaces ---------- */

test("no pure black background tokens", function () {
  ["styles.css", "public.css", "auth.css", "community.css"].forEach(function (rel) {
    var css = read(rel);
    ok(!/--bg:\s*#000000?\b/i.test(css), rel + " sets a pure black --bg");
  });
});

test("public palette matches the app shell, one gray family", function () {
  var pub = read("public.css");
  ok(pub.indexOf("--bg: #202124;") > -1, "public --bg drifted from the app shell");
  ok(pub.indexOf("--sidebar: #16171a;") > -1, "public --sidebar drifted from the app shell");
});

/* ---------- redesign-skill: type ---------- */

test("fonts.css is byte-identical to the face in styles.css", function () {
  var shell = read("styles.css").match(/@font-face \{[\s\S]*?\n\}\n/);
  ok(shell, "styles.css no longer declares an @font-face block");
  var shared = read("fonts.css");
  ok(shared.indexOf(shell[0]) > -1,
    "fonts.css is stale against styles.css. Run: python3 tools/sync_fonts.py");
});

test("every public page and the auth screens load the shared face", function () {
  PUBLIC_PAGES.concat(["auth.html"]).forEach(function (rel) {
    ok(exists(rel), rel + " is missing");
    ok(read(rel).indexOf('href="./fonts.css"') > -1, rel + " does not link fonts.css");
  });
});

test("public and auth CSS ask for Geist before the system stack", function () {
  ok(/--font-ui:\s*"Geist"/.test(read("public.css")), "public.css lost the Geist token");
  ok(/font-family:\s*"Geist"/.test(read("auth.css")), "auth.css lost the Geist face");
});

/* ---------- redesign-skill: strategic omissions ---------- */

test("every public page has a skip link pointing at real content", function () {
  PUBLIC_PAGES.forEach(function (rel) {
    var html = read(rel);
    ok(html.indexOf('class="skip-link" href="#main"') > -1, rel + " has no skip link");
    ok(html.indexOf('id="main"') > -1, rel + " has no #main target for its skip link");
  });
  ok(read("public.css").indexOf(".skip-link") > -1, "public.css has no skip-link styles");
});

test("the 404 page exists, is routed, and is not indexed", function () {
  ok(exists("404.html"), "404.html is missing");
  var html = read("404.html");
  ok(html.indexOf('name="robots" content="noindex"') > -1, "404 is missing noindex");
  ok(html.indexOf('href="./index.html"') > -1, "404 offers no route back into the app");
  ok(read("render.yaml").indexOf("404.html") > -1, "404.html is not shipped by the Render build");
});

/* ---------- flow.txt rule 3: no dead controls ---------- */

test("the 404 back control has a destination in both history states", function () {
  var js = read("public.js");
  ok(js.indexOf("backBtn") > -1, "public.js no longer wires the back control");
  ok(js.indexOf("window.history.back()") > -1, "back control does not use history");
  ok(js.indexOf("window.history.length > 1") > -1,
    "back control does not check for history, so it can render as a dead button");
  ok(js.indexOf('window.location.href = "./about"') > -1,
    "back control has no fallback destination when there is no history");
});

test("every 404 destination link resolves to a real route", function () {
  var routes = read("render.yaml");
  var hrefs = read("404.html").match(/href="\.\/([a-z0-9-]+)"/g) || [];
  ok(hrefs.length > 0, "404 lists no destinations");
  hrefs.forEach(function (raw) {
    var name = raw.slice(8, -1);
    var routed = routes.indexOf("source: /" + name) > -1;
    ok(routed || exists(name + ".html"), "404 links /" + name + " which is not routed or built");
  });
});

/* ---------- redesign-skill: navigation state ---------- */

test("the table of contents marks the section in view without a scroll listener", function () {
  var js = read("public.js");
  ok(js.indexOf("IntersectionObserver") > -1, "TOC tracking is missing");
  ok(js.indexOf('addEventListener("scroll"') === -1,
    "public.js uses a scroll listener; use IntersectionObserver");
  ok(read("public.css").indexOf('.toc a[aria-current="true"]') > -1,
    "the current TOC entry has no visual treatment");
});

test("the mobile menu can be dismissed, not just opened", function () {
  var js = read("public.js");
  ok(js.indexOf('e.key === "Escape"') > -1, "Escape does not close the mobile menu");
});

/* ---------- taste-skill 9.C: layout ---------- */

test("the public card grid is not three equal columns", function () {
  var css = read("public.css");
  ok(css.indexOf(".card-grid > .info-card:first-child") > -1,
    "the card grid lost its asymmetric lead tile and is three equal cards again");
  /* The lead tile must span, on either axis. Which axis is a layout choice
     and may change; that it spans at all is the rule being enforced. */
  ok(/\.card-grid[\s\S]{0,400}grid-(row|column): span 2/.test(css),
    "the lead card no longer spans, so the grid is three equal tiles again");
  ok(!/\.card-grid \{[^}]*grid-template-columns:\s*repeat\(3, 1fr\)/.test(css),
    "the card grid is back to three equal columns");
});

test("data surfaces use tabular figures", function () {
  ok(/font-variant-numeric:\s*tabular-nums/.test(read("public.css")),
    "public.css lost tabular figures on tables and meta rows");
});

/* ---------- text.txt: product language ---------- */

test("no AI-company filler verbs in user-facing public copy", function () {
  var banned = /\b(elevate|seamless(ly)?|unleash|next-gen|game-?changer|supercharge|revolutioniz\w*|effortless(ly)?)\b/i;
  PUBLIC_PAGES.concat(["index.html", "auth.html"]).forEach(function (rel) {
    var text = read(rel).replace(/<script[\s\S]*?<\/script>/g, "");
    var hit = text.match(banned);
    ok(!hit, rel + " uses filler marketing language: " + (hit && hit[0]));
  });
});

test("the 404 explains what happened and what to do next", function () {
  var html = read("404.html");
  ok(!/oops/i.test(html), "the 404 says Oops");
  ok(!/something went wrong/i.test(html), "the 404 uses a generic failure line");
  ok(html.indexOf("The link may be old") > -1, "the 404 no longer explains the cause");
});

test("the waitlist gate explains the Workspace in plain language", function () {
  var html = read("index.html");
  ok(html.indexOf("The Community feed is open to everyone.") > -1,
    "the access gate copy drifted from the plain-language version");
});

/* ---------- generation detail view ----------
   Three defects reported against the detail page: a duplicated composer, a
   collapsed comment-tree rail, and unbounded reply nesting. Each is pinned
   here because all three were silent: nothing threw, the page just looked
   wrong. */

test("the feed composer dock is dismissed on the detail view", function () {
  var js = read("community.js");
  ok(js.indexOf("function setGenDock") > -1,
    "setGenDock is gone; the two views can drift on dock visibility again");
  /* Both routes must set it, or the detail page shows two composers. */
  ok(js.indexOf("setGenDock(false)") > -1, "the detail route does not hide the generation dock");
  ok(js.indexOf("setGenDock(true)") > -1, "the feed route does not restore the generation dock");
});

test("each surface owns exactly one composer", function () {
  var html = read("index.html");
  /* Two static composers is correct: #composer is the workspace's and
     #cmComposer is the Community feed's. They live in different views.
     The detail page's comment composer is built by renderDetail. The bug
     was never a third composer, it was the feed's dock staying mounted
     over the detail view, which setGenDock now prevents. */
  ok(html.indexOf('class="composer" id="composer"') > -1, "the workspace composer is gone");
  ok(html.indexOf('class="composer" id="cmComposer"') > -1, "the community composer is gone");
  var ids = html.match(/class="composer" id="\w+"/g) || [];
  ok(ids.length === 2, "index.html declares " + ids.length + " static composers, expected 2");
  ok(read("community.js").indexOf('id="commentComposer"') > -1,
    "the comment composer is no longer built by the detail view");
});

test("the thread rail token is declared on a selector that can match", function () {
  var css = read("community.css");
  ok(css.indexOf(".cm-scope { --thread-rail:") > -1,
    "--thread-rail is not declared on .cm-scope");
  /* `.cm-scope :root` can never match: :root is <html>, which is never a
     descendant. That typo silently collapsed every rail to zero width. */
  /* Strip comments first: the CSS deliberately names the broken selector
     in the note explaining why it was removed. Only real declarations
     count. */
  var live = css.replace(/\/\*[\s\S]*?\*\//g, "");
  ok(live.indexOf(".cm-scope :root") === -1,
    "--thread-rail is declared under `.cm-scope :root`, a selector that can never match");
});

test("the elbow arm is derived from the rail, not hardcoded", function () {
  var css = read("community.css");
  ok(/\.telbow::after[\s\S]{0,300}width: calc\(var\(--thread-rail\)/.test(css),
    "the elbow arm width is hardcoded and will not line up when the rail changes");
});

test("reply depth is clamped at render, not only in the guide rails", function () {
  var js = read("community.js");
  ok(js.indexOf("Math.min(depth + 1, MAX_REPLY_DEPTH)") > -1,
    "emitAll no longer clamps depth, so a deep chain indents off screen");
});

test("the reply depth cap walks up to the cap instead of stepping once", function () {
  var js = read("community.js");
  ok(js.indexOf("while (anchor && pathToRoot(all, anchor.id).size - 1 >= MAX_REPLY_DEPTH") > -1,
    "the depth cap steps up only one level, so data already past the cap stays past it");
  ok(js.indexOf("hops < 64") > -1, "the depth-cap walk has no cycle guard");
});

test("three visual layers maximum", function () {
  ok(read("community.js").indexOf("var MAX_REPLY_DEPTH = 2;") > -1,
    "MAX_REPLY_DEPTH changed; the tree is no longer capped at three layers");
});

/* ---------- render pipeline ---------- */

test("every authored public asset is copied by the Render build", function () {
  var build = read("render.yaml");
  ["fonts.css", "404.html", "public.css", "public.js"].forEach(function (asset) {
    ok(build.indexOf(asset) > -1, asset + " is not in the Render build command");
  });
});

/* ---------- run ---------- */

/* ---- Task 3: identity avatars + @bot addressing ---- */

var avatarsJs = read("avatars.js");
var communityJs = read("community.js");
var communityCss = read("community.css");
var indexHtml = read("index.html");
var appJs = read("app.js");
var stylesCss = read("styles.css");

test("avatars.js exposes the BotoAvatar API", function () {
  ok(avatarsJs.indexOf("window.BotoAvatar") !== -1 &&
    avatarsJs.indexOf("svg:") !== -1);
});
test("avatar SVG ids are per instance, never a fixed id", function () {
  /* Strip comments first: the source documents the fixed-id bug it fixed,
     and an unstripped scan matches that prose instead of real code. */
  var code = avatarsJs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  ok(code.indexOf('id="m"') === -1, "a fixed mask id would collide across avatars");
  ok(code.indexOf("uidCounter++") !== -1, "mask ids must vary per instance");
});
test("avatars.js is registered everywhere a root asset must be", function () {
  ok(indexHtml.indexOf('src="./avatars.js"') !== -1 &&
    read("render.yaml").indexOf("avatars.js") !== -1 &&
    read("sw.js").indexOf('"./avatars.js"') !== -1 &&
    read("build_inline.py").indexOf("avatars.js") !== -1);
});
test("avatar circles clip the artwork instead of centering a letter", function () {
  ok(stylesCss.indexOf(".avatar-img") !== -1 &&
    communityCss.indexOf(".avatar-img") !== -1);
});
test("community renders avatars through the shared helper", function () {
  ok(communityJs.indexOf('avatar(gen.creator, "gen-avatar")') !== -1 &&
    communityJs.indexOf('avatar(c.creator, "avatar-sm")') !== -1);
});
test("addressesBot is the single source of truth for calling the agent", function () {
  /* The call now carries the idempotency key, so the assertion pins the
     branch rather than the exact argument list. */
  ok(communityJs.indexOf("function addressesBot") !== -1 &&
    /if \(toBot\) streamGeneration\(gen/.test(communityJs) &&
    /if \(!toBot\) publishGeneration\(gen/.test(communityJs),
    "one predicate decides both whether the agent runs and how the post is published");
});
test("a plain post never enters a streaming state", function () {
  ok(communityJs.indexOf('status: toBot ? "streaming" : "complete"') !== -1);
});
test("legacy stored posts keep rendering as agent generations", function () {
  ok(communityJs.indexOf("function isAddressed") !== -1 &&
    communityJs.indexOf("gen.addressed === undefined ? true") !== -1);
});
test("only addressed cards show the @bot chip and a response block", function () {
  ok(communityJs.indexOf('isAddressed(gen) ? \'<span class="gen-at">@bot</span>\' : ""') !== -1 &&
    communityJs.indexOf('isAddressed(gen) ? responseBlock(gen, detail) : ""') !== -1);
});
test("plain posts pin once so they do not sink on zero engagement", function () {
  ok(communityJs.indexOf("if (!toBot) pinForThisView(gen.id);") !== -1);
});

test("the pin is session state and cannot survive a reload", function () {
  ok(communityJs.indexOf("var sessionPins") !== -1);
  ok(communityJs.indexOf("freshPinned: !toBot") === -1,
    "a persisted pin stacked plain posts at the top of the feed forever");
  ok(communityJs.indexOf("if (gen && gen.freshPinned) delete gen.freshPinned;") !== -1,
    "stores written by the old build must be migrated");
});

test("a failed own generation surfaces so its retry is reachable", function () {
  ok(communityJs.indexOf("function urgent") !== -1);
  ok(communityJs.indexOf('gen.status === "failed" && gen.own') !== -1);
});

test("malformed stored records cannot take the feed down", function () {
  ok(communityJs.indexOf("function normalizeState") !== -1);
  ok(communityJs.indexOf("function normCreator") !== -1);
  ok(communityJs.indexOf("function normCounts") !== -1);
  ok(communityJs.indexOf("return normalizeState(parsed);") !== -1,
    "normalisation must happen at the load boundary, not per call site");
});

test("normalisation preserves the failed state", function () {
  ok(communityJs.indexOf('g.status === "streaming" || g.status === "failed"') !== -1,
    "coercing failed to complete would strand the post with no retry");
});

test("a failed write is reported instead of silently losing the post", function () {
  ok(communityJs.indexOf("Could not save to this browser") !== -1);
  ok(communityJs.indexOf("persistBroken") !== -1);
});

test("concurrent tabs cannot clobber each other", function () {
  ok(communityJs.indexOf("function reconcileWithDisk") !== -1);
  ok(communityJs.indexOf('addEventListener("storage"') !== -1);
  ok(communityJs.indexOf("function adoptExternalState") !== -1);
});

test("another tab's posts arrive through the pill, not a feed reshuffle", function () {
  ok(communityJs.indexOf("pinForThisView(g.id);") !== -1);
  ok(communityJs.indexOf("syncPill();") !== -1);
});

test("the pill scrolls the element that actually scrolls", function () {
  ok(communityJs.indexOf("box.scrollTo({ top: 0, behavior: \"smooth\" })") !== -1,
    "window.scrollTo is a no-op for this feed");
});

test("the show-more control meets the touch target floor", function () {
  var i = communityCss.indexOf(".cm-scope .gen-expand {");
  ok(i !== -1);
  var rule = communityCss.slice(i, i + 700);
  ok(rule.indexOf("min-height: 34px") !== -1);
  ok(rule.indexOf("padding: 7px 12px") !== -1);
});
test("composer highlight layer exists and is hidden from assistive tech", function () {
  ok(indexHtml.indexOf('id="cmInputHl"') !== -1 &&
    indexHtml.indexOf('class="composer-hl" id="cmInputHl" aria-hidden="true"') !== -1);
});
test("highlight layer and textarea share the metrics that drive wrapping", function () {
  ok(communityCss.indexOf(".cm-scope .composer-field .composer-hl,") !== -1 &&
    communityCss.indexOf(".cm-scope .composer-field textarea {") !== -1);
});
test("the real textarea keeps its caret while handing off glyph painting", function () {
  ok(communityCss.indexOf("caret-color: var(--text)") !== -1 &&
    communityCss.indexOf("-webkit-text-fill-color: transparent") !== -1);
});
test("placeholder is not swallowed by the transparent text fill", function () {
  ok(communityCss.indexOf(".cm-scope .composer-field textarea::placeholder") !== -1);
});
test("only a leading mention is highlighted", function () {
  ok(communityJs.indexOf("BOT_MENTION = /^") !== -1);
});


/* ---- Task 4: delete, undo, tombstones, missing state ---- */

test("delete is soft so replies and undo remain possible", function () {
  ok(communityJs.indexOf("function isDeleted") !== -1);
  ok(communityJs.indexOf("gen.deleted = true") !== -1, "soft flag, not a splice");
  ok(communityJs.indexOf("state.generations.splice") === -1, "hard delete would break undo");
});

test("ownership is re-checked in the handler, not trusted from the DOM", function () {
  ok(communityJs.indexOf("function canDelete") !== -1);
  ok(communityJs.indexOf("rec.own === true") !== -1);
});

test("a streaming generation cannot be deleted", function () {
  ok(communityJs.indexOf('if (gen.status === "streaming") return;') !== -1);
});

test("deleted posts leave the feed", function () {
  ok(communityJs.indexOf("if (isDeleted(gen)) return false;") !== -1);
});

test("comment counts are derived, so they cannot drift or go negative", function () {
  ok(communityJs.indexOf("function liveCommentCount") !== -1);
  ok(communityJs.indexOf("function syncCommentCount") !== -1);
});

test("undo is idempotent", function () {
  ok(communityJs.indexOf("if (!gen || !isDeleted(gen)) return;") !== -1);
  ok(communityJs.indexOf("if (!c || !isDeleted(c)) return;") !== -1);
});

test("the destructive toast states the reply consequence", function () {
  ok(communityJs.indexOf("kept, shown under a removed post.") !== -1);
  ok(communityJs.indexOf('"Undo"') !== -1, "a reversible action must offer the reversal");
});

test("copy never asks 'are you sure' without a consequence", function () {
  ok(communityJs.toLowerCase().indexOf("are you sure") === -1);
});

test("a dead generation link explains itself instead of silently redirecting", function () {
  ok(communityJs.indexOf("function renderMissing") !== -1);
  ok(communityJs.indexOf("This post was deleted") !== -1);
  ok(communityJs.indexOf("This post does not exist") !== -1, "deleted and never-existed are different facts");
});

test("the missing state always offers a route out", function () {
  ok(communityJs.indexOf("detail-missing-back") !== -1);
  ok(communityCss.indexOf(".cm-scope .detail-missing-back") !== -1);
});

test("a deleted comment with replies keeps its slot and drops its content", function () {
  ok(communityJs.indexOf("comment--gone") !== -1);
  ok(communityJs.indexOf("Comment deleted.") !== -1);
  ok(communityCss.indexOf(".cm-scope .comment--gone") !== -1);
});

test("the toast stack is shared, not reimplemented per surface", function () {
  ok(read("app.js").indexOf("window.BotoToast = toast;") !== -1);
  ok(communityJs.indexOf("window.BotoToast") !== -1);
});

test("the delete plan is written down and traceable", function () {
  ok(exists("docs/delete-flow-plan.md"));
  var plan = read("docs/delete-flow-plan.md");
  ok(plan.indexOf("## 2. Traceability") !== -1);
  ok(plan.indexOf("## 8. Non-goals") !== -1, "scope lock needs explicit non-goals");
});


/* ---- Task 5: pagination, pull-to-refresh spinner, cache correctness ---- */

test("the feed measures the element that actually scrolls", function () {
  ok(communityJs.indexOf("function feedScroller") !== -1);
  ok(communityJs.indexOf("box.scrollTop + box.clientHeight >= box.scrollHeight") !== -1,
    "measuring the window is wrong: body is overflow:hidden in community mode");
  ok(communityJs.indexOf("document.documentElement.scrollHeight - 320") === -1,
    "the window-based near-bottom test was always true and loaded every page at once");
});

test("the sentinel observer is rooted on the scroller", function () {
  ok(communityJs.indexOf("root: feedScroller()") !== -1);
});

test("the scroll fallback listens on the scroller, not only the window", function () {
  ok(communityJs.indexOf('scrollBox.addEventListener("scroll", fillViewport') !== -1);
});

test("the feed pages ten at a time", function () {
  /* The size moved to the data layer when the feed became server paged:
     the client and the RPC have to agree, because a page shorter than the
     requested size is how "you are at the end" is detected. Two copies of
     the number would eventually disagree and the feed would either stop
     early or never stop. */
  var data = read("community-data.js");
  ok(/var PAGE_SIZE = 10;/.test(data), "the data layer owns the page size");
  ok(communityJs.indexOf("BotoData.PAGE_SIZE") !== -1,
    "the view reads it rather than declaring its own");
  ok(/p_limit: PAGE_SIZE/.test(data), "and the same value is what the server is asked for");
});

test("the spinner is a block so its ring cannot collapse", function () {
  var i = communityCss.indexOf(".cm-scope .spinner {");
  ok(i !== -1);
  var rule = communityCss.slice(i, i + 400);
  ok(rule.indexOf("display: block") !== -1,
    "width/height/border-radius are all ignored on an inline box");
  ok(rule.indexOf("box-sizing: border-box") !== -1);
});

test("the pull indicator's smaller ring wins on source order", function () {
  var base = communityCss.indexOf(".cm-scope .spinner {");
  var override = communityCss.indexOf(".cm-scope .pull-spin .spinner {");
  ok(base !== -1 && override !== -1);
  ok(override > base, "equal specificity, so the override must come after the base rule");
});

test("the service worker cache version moved with the shipped assets", function () {
  var sw = read("sw.js");
  ok(sw.indexOf('var CACHE = "impose-shell-v44"') === -1,
    "v44 shipped avatars.js and the highlight layer without a version bump");
  ok(/var CACHE = "impose-shell-v(4[5-9]|[5-9][0-9])"/.test(sw));
});

test("the highlight layer cannot double the text without its stylesheet", function () {
  ok(indexHtml.indexOf('id="cmInputHl"') !== -1);
  var i = indexHtml.indexOf('id="cmInputHl"');
  var tag = indexHtml.slice(i - 200, i + 300);
  ok(tag.indexOf("position:absolute") !== -1, "an unstyled layer must stay out of flow");
  ok(tag.indexOf("color:transparent") !== -1, "an unstyled layer must stay invisible");
  ok(communityJs.indexOf("releaseHighlightFailsafe") !== -1,
    "and the JS must hand the colour back once the stylesheet is verifiably applied");
});

test("a tombstone only survives if something live still hangs below it", function () {
  /* The bug: the keep-test counted children, not LIVE children, so a deleted
     comment whose replies were also deleted kept itself on screen and each
     tombstone justified the one above it. Deleting a branch left a stack of
     "Comment deleted." rows propping each other up over nothing. */
  var i = communityJs.indexOf("function hasLiveDescendants");
  ok(i !== -1, "the keep-test must exist");
  var fn = communityJs.slice(i, i + 420);
  ok(/hasLiveDescendants\(kids\[i\]\.id/.test(fn),
    "the test must recurse: a live comment any depth below still earns the tombstone");
  ok(fn.indexOf("if (!isDeleted(kids[i])) return true;") !== -1,
    "a live direct child is the base case");
});

test("the thread render path is pruned of spent tombstones", function () {
  ok(communityJs.indexOf("function visibleComments") !== -1,
    "there must be one pruned set the tree, counts and rails all agree on");
  var v = communityJs.indexOf("function visibleComments");
  var body = communityJs.slice(v, v + 360);
  ok(body.indexOf("if (!isDeleted(c)) return true;") !== -1, "live comments always render");
  ok(/return hasLiveDescendants\(c\.id, all\);/.test(body),
    "deleted comments render only to hold up a live descendant");
  var c = communityJs.indexOf("function commentsFor");
  ok(communityJs.slice(c, c + 200).indexOf("visibleComments(genId)") !== -1,
    "the thread read path must go through the pruned set, not state.comments");
});

test("comment counts stay derived from live records, never from rendered rows", function () {
  var i = communityJs.indexOf("function liveCommentCount");
  ok(communityJs.slice(i, i + 220).indexOf("!isDeleted(c)") !== -1,
    "pruning tombstones must not make the count chip drift");
});

test("the workspace empty state carries no starter cards", function () {
  ok(indexHtml.indexOf('id="chips"') === -1, "the four suggestion cards are gone from the markup");
  ok(indexHtml.indexOf("late invoice") === -1 && indexHtml.indexOf("Lagos food blog") === -1,
    "and none of their copy survives");
  ok(appJs.indexOf("chipsEl") === -1, "no JS may reference the removed node");
  ok(indexHtml.indexOf('id="tglChips"') === -1 && appJs.indexOf("showChips") === -1,
    "the setting that governed them must go too rather than control nothing");
  ok(indexHtml.indexOf('id="emptyState"') !== -1 && indexHtml.indexOf("What can I help with?") !== -1,
    "the greeting itself stays");
});

test("a generation page shows no second, higher-level navigation", function () {
  ok(communityJs.indexOf("function setDetailChrome") !== -1,
    "the detail view must be able to drop the mode switcher");
  ok(/body\.cm-detail-mode \.modebar \{ display: none; \}/.test(communityCss),
    "and the switcher must actually be hidden there");
  ok(communityCss.indexOf("body.cm-detail-mode .cm-scope .cm-view") !== -1,
    "the view must reclaim the space the floating bar was reserving");
  var db = communityCss.indexOf(".cm-scope .detail-back {");
  ok(communityCss.slice(db, db + 320).indexOf("env(safe-area-inset-top)") !== -1,
    "the back header is now the top chrome, so it owns the notch inset");
});

test("a comment row has one reply action and no exposed delete", function () {
  /* Two controls that both look like reply ("Reply" beside a "2 replies"
     chip) read as the same action twice. And delete does not belong in a
     row the user taps to move around the thread. */
  var i = communityJs.indexOf('class="comment-ops"');
  var ops = communityJs.slice(i, communityJs.indexOf('"</div>" +', i));
  ok((ops.match(/data-reply="/g) || []).length === 1, "exactly one reply control");
  ok(ops.indexOf("comment-thread-toggle") !== -1,
    "the reply count is a disclosure toggle, not a second button");
  ok(ops.indexOf('"Hide replies"') !== -1, "and it names its own state");
  ok(ops.indexOf("comment-del-btn") === -1, "delete is not in the row");
  ok(ops.indexOf("data-cmenu") !== -1, "it sits behind a kebab instead");
});

test("reading replies never hijacks the composer", function () {
  /* Expanding is a read: it must not aim the composer at a comment the
     user never chose to answer. */
  var h = communityJs.indexOf('e.target.closest("[data-expand]")');
  var handler = communityJs.slice(h, h + 1200);
  ok(handler.indexOf('hasAttribute("data-reply")') === -1,
    "the expand branch must not fall through into the reply branch");
  ok(/renderThread\(gen, listEl\);\s*return;/.test(handler),
    "expanding renders and returns, full stop");
});

test("signing out ends the session, not just the local copy", function () {
  /* flow.txt 6: authentication is a system, not a login page. Sign out
     removed a localStorage key and nothing else, so the Supabase session
     survived: the menu said signed out and the user could still post,
     comment and delete. Measured before it was fixed. */
  var app = read("app.js");
  var at = app.indexOf('$("acctAuth").addEventListener');
  var handler = app.slice(at, at + 1400);
  ok(handler.indexOf("BotoAuth.signOut()") !== -1,
    "the real session is ended, not only the display cache");
  ok(handler.indexOf("BotoData.forgetUser") !== -1,
    "and the cached identity is dropped with it");
  ok(/signOut\(\)\.then\(done, function/.test(handler),
    "a failed sign out still clears locally rather than leaving someone signed in");
  ok(read("index.html").indexOf("auth-client.js") !== -1,
    "auth-client is loaded where the menu lives, or the call silently no-ops");
});

test("a rejected value is not reported as a permission problem", function () {
  /* Postgres says "violates" for both a check constraint and an RLS
     policy. Matching on that word alone told someone whose post was too
     long that they lacked permission, which sends them to ask for access
     they already have. */
  var data = read("community-data.js");
  var i = data.indexOf("function shape");
  var body = data.slice(i, i + 2600);
  ok(body.indexOf("check constraint") < body.indexOf("row-level security"),
    "constraints are matched before RLS, not swallowed by it");
  ok(/That post is too long/.test(body), "and a length problem says so");
  ok(/cannot store/.test(body),
    "a byte Postgres cannot store is explained in words, not as an escape error");
});

test("a server misconfiguration is not shown to the user as their problem", function () {
  /* Reported from production: signing up answered 503 "accounts are not
     configured on the server", and that string was rendered verbatim
     under the email field. True, unactionable, and it reads as though the
     person typed something wrong. text.txt 10. */
  var client = read("auth-client.js");
  ok(client.indexOf("function humanizeRelay") !== -1,
    "relay detail strings are translated before they reach a form");
  ok(/new Error\(humanizeRelay\(res\.status, data\.detail\)\)/.test(client),
    "and the translation is actually on the path, not merely defined");
  ok(/on us, not you/.test(client),
    "a deployment gap is named as ours, so nobody retypes a correct password");
  ok(/err\.detail = data\.detail/.test(client),
    "and the original text is kept on the error for the debug log");

  /* The deeper fix: the relay should say this at boot, not leave it to be
     discovered by someone filling in a form. */
  var server = read("backend/relay/server.py");
  ok(server.indexOf("ACCOUNTS DISABLED, missing:") !== -1,
    "the relay names the missing variables at startup");
  ok(/SUPABASE_URL", "SUPABASE_SERVICE_KEY", "OTP_PEPPER"/.test(server),
    "all three that accounts depend on");
  ok(server.indexOf("codes will be printed to this log, not") !== -1,
    "and warns when Sendlib is half configured, which silently emails nobody");
});

test("the service worker version tracks the files it caches", function () {
  /* The debug panel fix shipped correct and invisible: the origin served
     the new app.js and styles.css, and every returning visitor kept the
     old ones because the worker precaches and its version string had not
     changed. A fix nobody receives is not a fix.

     This pins the version to a hash of the precached sources, so editing
     any of them without bumping CACHE fails here rather than in someone's
     stale browser. */
  var sw = read("sw.js");
  var m = sw.match(/var CACHE = "impose-shell-v(\d+)"/);
  ok(!!m, "the cache name carries a version");

  /* Derived from sw.js rather than hand-listed. A hand-written list covered
     8 of the 31 code assets the worker actually precaches, so a change to
     auth-client.js or public.js would have shipped behind a stale cache
     exactly like the debug panel did. The list that matters is the one the
     worker uses. */
  var crypto = require("crypto");
  var watched = (sw.match(/"\.\/[A-Za-z0-9._/-]+\.(?:js|css|html)"/g) || [])
    .map(function (m) { return m.slice(3, -1); })
    .filter(function (f) { return f.indexOf(".min.") === -1; })
    .sort()
    .filter(function (f, i, a) { return a.indexOf(f) === i; });
  ok(watched.length > 20, "the fingerprint covers the whole precache list, not a sample");

  var h = crypto.createHash("sha256");
  watched.forEach(function (f) { if (exists(f)) h.update(read(f)); });
  var digest = h.digest("hex").slice(0, 12);

  var stamp = sw.match(/precache-fingerprint: ([0-9a-f]{12})/);
  ok(!!stamp && stamp[1] === digest,
    "sw.js records the fingerprint of what it caches (expected " + digest +
    (stamp ? ", found " + stamp[1] : ", none recorded") +
    "). Bump CACHE and update the fingerprint comment when a cached file changes.");
});

test("the debug log is reachable on every page and nothing covers it", function () {
  /* It was mounted only in index.html and hid itself until something had
     already failed, so on the auth and marketing pages the bus recorded
     faithfully and there was no way to read it: the log existed, the door
     did not. And plenty of bugs never raise an error. */
  var bus = read("debug-bus.js");
  ok(bus.indexOf("function mountPortablePanel") !== -1,
    "a self-contained panel travels with the bus");
  ok(bus.indexOf("hostAlreadyHasPanel") !== -1,
    "and stands down where the full panel exists, so there is never a second button");
  ["auth.html", "about.html", "contact.html", "privacy.html", "terms.html",
   "data-security.html", "acceptable-use.html", "404.html"].forEach(function (page) {
    ok(read(page).indexOf("debug-bus.js") !== -1, page + " loads the bus");
  });

  var app = read("app.js");
  ok(/tab\.hidden = panelOpen;/.test(app),
    "the tab no longer waits for a failure before appearing");

  /* Above every other layer. The app's highest is 120: toasts, citation
     cards and the lightbox. A debug surface a modal can cover is useless
     exactly when it is needed. */
  var css = read("styles.css");
  ok((css.match(/z-index: 2147483000/g) || []).length === 2,
    "both the tab and the panel sit above everything else");
  ok(bus.indexOf("var LAYER = 2147483000") !== -1, "and so does the portable one");
});

test("the debug log captures without call sites", function () {
  /* The old panel only recorded what someone remembered to call dnote()
     for: 39 hand-placed lines in app.js and none at all in Community. The
     things you actually need when something breaks, the request that
     500ed and the promise nobody caught, were never in it. */
  var bus = read("debug-bus.js");
  ok(/window\.fetch = function/.test(bus), "fetch is wrapped");
  ok(bus.indexOf("XMLHttpRequest.prototype.send") !== -1, "XHR is wrapped too");
  ok(bus.indexOf('addEventListener("unhandledrejection"') !== -1, "rejections are caught");
  ok(bus.indexOf("res.clone().text()") !== -1,
    "a failed response body is read from a clone, so the caller still gets its stream");
  ok(bus.indexOf("isThirdPartyBeacon") !== -1,
    "third-party beacons must not light the error badge for a fault that is not ours");

  /* One wrapper, or every request appears twice. */
  var app = read("app.js");
  var wrap = app.indexOf("function wrapFetch()");
  ok(app.slice(wrap, wrap + 160).indexOf("if (window.BotoDebug) return;") !== -1,
    "app.js stands down its own fetch wrapper when the bus is present");
});

test("nothing credential shaped survives the debug log", function () {
  /* The log is copied into bug reports and pasted into chats. Redaction
     happens on the way in, so there is no path that stores the raw value. */
  var bus = read("debug-bus.js");
  ok(bus.indexOf("function redactUrl") !== -1 && bus.indexOf("function redactText") !== -1,
    "urls and free text are both redacted");
  ok(/sbp_|sb_secret_/.test(bus), "this project's own key shapes are covered");
  ok(bus.indexOf("redacted jwt") !== -1, "bearer tokens and JWTs are stripped");
  ok(/password\|passwd\|pass\|secret\|token/.test(bus) || bus.indexOf("password|passwd") !== -1,
    "password fields are removed from request bodies before truncation");
  var push = bus.indexOf("function push(");
  ok(bus.slice(push, push + 500).indexOf("redactText(what)") !== -1,
    "redaction is applied at the entry point, not at render time");
});

test("the feed has a failure state, not just an empty one", function () {
  /* flow.txt 9: "failed to load" and "nothing here" are different answers.
     Showing the empty state on a dead connection tells the reader the feed
     is empty, which is a lie they cannot correct. */
  ok(read("index.html").indexOf('id="cmFeedError"') !== -1, "the state exists in the markup");
  var view = read("community.js");
  ok(view.indexOf("function syncFeedState") !== -1,
    "one place decides which state is on screen, so two cannot show at once");
  ok(/feedFailed && shown === 0/.test(view), "the error only replaces an empty list");
  ok(/!feedFailed && !feedLoading && feedDone && shown === 0/.test(view),
    "empty is only claimed once the server has actually said so");
  ok(view.indexOf("cmFeedRetry") !== -1, "and it offers a way out");
});

test("polling asks for a count and backs off", function () {
  var view = read("community.js");
  ok(view.indexOf("BotoData.newSince") !== -1,
    "the poll costs one integer, not a page of bodies");
  ok(view.indexOf("document.hidden") !== -1, "a hidden tab stops polling");
  ok(/pollDelay = Math.min\(POLL_MAX, pollDelay \* 2\)/.test(view),
    "a failing server is backed off, not retried on a fixed timer");
  ok(/pollFailures >= 6/.test(view), "and eventually left alone");
  /* The fabricated arrivals had to go, not sit alongside the real poll. */
  ok(view.indexOf("ARRIVAL_POOL") === -1 && view.indexOf("simulateIncoming") === -1,
    "no invented posts once the feed is real");
});

test("a queued write is honest about not being sent", function () {
  /* The offline choice was: queue and say so, rather than refuse. That is
     only safe if the card admits its state, or an optimistic render
     becomes a claim we cannot back. */
  var view = read("community.js");
  ok(view.indexOf("gen-pending") !== -1, "a pending card is marked");
  ok(/isAddressed\(gen\) \? responseBlock[\s\S]{0,400}gen\.pending/.test(view),
    "the badge is on the card, not in the response block: a plain post has " +
    "no response block and is the kind most likely to be queued");
  ok(view.indexOf("cmOutbox") !== -1, "and the feed says how much is waiting");
  var data = read("community-data.js");
  ok(data.indexOf("OUTBOX_KEY") !== -1, "the queue survives the tab closing");
  ok(/localStorage\.setItem\(OUTBOX_KEY, JSON\.stringify\(outbox\.map/.test(data),
    "it stores the data, never the closures, which serialise to nothing");
  ok(/function settle\(job, kind, payload\)/.test(data) && /handlers\[job\.type\]/.test(data),
    "a job resumed after a reload has no closures left, so settlement falls " +
    "back to a handler registered by type");
});

test("a replaced row cannot be resurrected from disk", function () {
  /* persist() merges anything on disk that is missing from memory, which
     is right for another tab's row and wrong for a placeholder this tab
     just swapped for the server's. Without a tombstone the optimistic row
     came back on the very next save and sat there reading "Sending" next
     to the real post. */
  var view = read("community.js");
  ok(view.indexOf("var retired") !== -1, "removals are remembered");
  ok(/!have\[r\.id\] && !retired\[r\.id\]/.test(view),
    "and the disk merge honours them");
  ok(/retire\(localId\)/.test(view), "reconciliation retires the placeholder");
});

test("a deep link works on a browser that has never seen the post", function () {
  /* Found in the pre-build audit: route() decided "this post does not
     exist" from the local cache alone, so a shared link opened on a fresh
     device denied a post that plainly existed. The reader had no way to
     tell our ignorance from a deletion. */
  var view = read("community.js");
  ok(view.indexOf("function hydrateDetail") !== -1,
    "an unknown id is fetched before it is declared missing");
  ok(view.indexOf("function hydrateThread") !== -1,
    "and its comments are fetched, not assumed to be cached");
  ok(view.indexOf("function renderDetailLoading") !== -1,
    "with a loading state, because a blank panel reads as broken");
  ok(/location\.hash !== "#\/g\/" \+ id/.test(view),
    "a late response for a page the reader has left is discarded");
  ok(/c\.genId !== genId \|\| c\.pending/.test(view),
    "merging the server thread keeps queued local comments");
});

test("lineage counts come from the server, never from the client", function () {
  /* Also from the audit: counts.remix += 1 survived the cutover. Queue a
     remix offline and the card read 1 while Postgres said 0. Removing the
     increment alone inverted the lie, so the parent is refetched once the
     child lands. */
  var view = read("community.js");
  ok(view.indexOf("counts.remix +=") === -1 && view.indexOf("counts.challenge +=") === -1,
    "no client-side lineage increment");
  ok(view.indexOf("function refreshOne") !== -1,
    "the parent is refetched after a child is written");
  ok((view.match(/refreshOne\(row\.parentId\)/g) || []).length === 2,
    "on both the fresh write path and the one resumed after a reload");
});

test("one module owns the server, so a swap is not twenty-one edits", function () {
  /* community.js renders. It asks community-data.js for data and never
     touches the SDK itself, which is the difference between changing a
     backend and rewriting a feed. */
  var view = read("community.js");
  ok(view.indexOf("createClient") === -1, "the view must not build a Supabase client");
  ok(view.indexOf("supabase.from(") === -1 && view.indexOf(".rpc(") === -1,
    "the view must not issue queries of its own");

  var data = read("community-data.js");
  ok(data.indexOf("function feedPage") !== -1, "reads live in the data layer");
  ok(data.indexOf("p_before_time") !== -1,
    "the feed pages by cursor: OFFSET shifts under inserts and repeats rows");
  ok(/newKey|p_key/.test(data), "writes carry an idempotency key");
});

test("every server call resolves to a state the UI can render", function () {
  /* flow.txt 10 and 11: no async action without a defined failure, and
     nothing spins forever. */
  var data = read("community-data.js");
  ok(data.indexOf("function withTimeout") !== -1,
    "a request that never settles is worse than one that fails");
  ok(/retryable/.test(data), "callers are told whether trying again is worth anything");
  ok(data.indexOf("You appear to be offline") !== -1, "offline is named, not guessed at");
  ok(data.indexOf("function shape") !== -1 && data.indexOf("Something went wrong") !== -1,
    "Postgres codes are translated before they reach a reader");
  /* text.txt 10: never show raw technical text. */
  ok(data.indexOf("PGRST") === -1 && data.indexOf("42501") !== -1,
    "codes are matched on, never displayed");
});

test("action rows sit on one centre line", function () {
  /* Taste skill 9.C: mathematically perfect padding, no floating elements
     with awkward gaps. Count buttons set their height from a text line box
     while icon-only buttons collapsed, so the post row rendered 32px and
     28px controls side by side. */
  var g = communityCss.indexOf(".cm-scope .gen-act {");
  var gen = communityCss.slice(g, g + 620);
  ok(gen.indexOf("min-height: 32px") !== -1, "one fixed height for every post control");
  ok(gen.indexOf("line-height: 1") !== -1, "text must not push the box taller than the icons");
  ok(communityCss.indexOf(".cm-scope .gen-act--icon { width: 32px; padding: 0; }") !== -1,
    "icon-only controls are square at that height");
  ok(communityCss.indexOf(":has(.act-cnt)") === -1,
    ":has() is not safe to rely on for layout here; use the explicit class");
  var r = communityCss.indexOf(".cm-scope .comment-reply-btn {");
  ok(communityCss.slice(r, r + 420).indexOf("min-height: 34px") !== -1,
    "the comment row shares one height across Reply, the toggle and the kebab");
  ok(/\.comment-kebab i\[data-lucide\] \{ width: 14px/.test(communityCss),
    "the kebab icon matches the 14px icons beside it, not the 16px post scale");
});

test("the kebab menu stays attached to its trigger", function () {
  var o = communityJs.indexOf("function openKebabMenu");
  var body = communityJs.slice(o, o + 3400);
  ok(body.indexOf("var GAP = 6") !== -1 && body.indexOf("r.bottom + GAP") !== -1,
    "the menu hangs a fixed 6px off the icon, not wherever there is room");
  ok(body.indexOf("spaceBelow") !== -1 && body.indexOf("spaceAbove") !== -1,
    "it flips only when the space genuinely runs out, comparing both sides");
  ok(body.indexOf('placeAbove ? "bottom right" : "top right"') !== -1,
    "and scales out of the corner nearest the trigger");
  /* The feed and detail page scroll inside containers; those events do not
     reach window. */
  ok(/document\.addEventListener\("scroll"/.test(communityJs),
    "scroll dismissal must be bound on document in capture, not window");
  ok(communityJs.indexOf("Date.now() - menuOpenedAt < 350") !== -1,
    "opening a partly off-screen kebab scrolls it into view; that programmatic " +
    "scroll must not close the menu it just opened");
});

test("delete lives in exactly one place per object", function () {
  /* A kebab that duplicates a button still on the row is worse than either
     alone: two controls for one destructive action. */
  ok(communityJs.indexOf('data-act="delete"') === -1,
    "the post's exposed delete button must be gone, not merely hidden");
  ok(communityJs.indexOf("gen-act-danger") === -1, "and its styling hook with it");
  ok(communityJs.indexOf("comment-del-btn") === -1, "same for the comment's inline delete");
  ok(communityJs.indexOf('data-act="menu"') !== -1, "the post gets a kebab");
  ok(communityJs.indexOf("data-cmenu") !== -1, "the comment keeps its own");
  /* Both routed through the one menu, so they cannot drift apart. */
  ok((communityJs.match(/openKebabMenu\(/g) || []).length >= 3,
    "one menu implementation serves both, plus its definition");
});

test("the comment kebab menu cannot outlive what it points at", function () {
  ok(communityJs.indexOf("function openKebabMenu") !== -1, "the menu exists");
  ok(communityJs.indexOf("commentMenuEl.className = \"pop pop-sm comment-menu\"") !== -1,
    "it reuses the app's popover styling rather than inventing one");
  var r = communityJs.indexOf("function renderThread");
  ok(communityJs.slice(r, r + 400).indexOf("closeCommentMenu()") !== -1,
    "a thread repaint replaces the kebab, so the floating menu must close with it");
  ok(communityJs.indexOf('e.key === "Escape" && commentMenuFor') !== -1, "Escape dismisses");
});

test("expanding moves the whole subtree it reveals", function () {
  /* emitAll renders the entire subtree on one tap, so state must move with
     it or nested chips report aria-expanded="false" for rows that are
     visibly on screen, and collapsing a child does nothing. */
  ok(communityJs.indexOf("function subtreeIds") !== -1, "needs a subtree walker");
  var h = communityJs.indexOf('e.target.closest("[data-expand]")');
  var handler = communityJs.slice(h, h + 1200);
  ok(handler.indexOf("subtreeIds(gen.id, rid)") !== -1,
    "the toggle must apply to the branch, not just the tapped id");
  ok(/branch\.forEach\(function \(bid\) \{ expandedThreads\.delete\(bid\); \}\)/.test(handler) &&
     /branch\.forEach\(function \(bid\) \{ expandedThreads\.add\(bid\); \}\)/.test(handler),
    "both directions move the whole branch");
});

test("deleting a comment does not destroy a draft in progress", function () {
  /* deleteComment rebuilt the entire detail page, which replaced the
     composer node: typed text vanished with no warning and Post went dead. */
  var d = communityJs.indexOf("function deleteComment");
  var body = communityJs.slice(d, d + 900);
  ok(body.indexOf("refreshThreadOnly") !== -1 && body.indexOf("refreshDetail(") === -1,
    "a comment changing state is a thread event, not a page rebuild");
  ok(communityJs.indexOf("function refreshThreadOnly") !== -1, "needs the in-place path");
  var r = communityJs.indexOf("function refreshThreadOnly");
  var rb = communityJs.slice(r, r + 800);
  ok(rb.indexOf("renderThread(") !== -1 && rb.indexOf("renderDetail(") === -1,
    "it must repaint the thread, never the page that owns the composer");
  ok(rb.indexOf("clearReplyTarget(true)") !== -1,
    "a composer aimed at a fresh tombstone must lose its target, and be " +
    "told the loss was involuntary so the draft cannot post as top-level");
  ok(communityJs.indexOf("function clearReplyTarget") !== -1,
    "delete lives outside the composer closure, so the target drop is hoisted");
  var c = communityJs.indexOf("function clearReplyTarget");
  ok(communityJs.slice(c, c + 320).indexOf(".value") === -1,
    "dropping the target must not touch the user's typed text");
});

test("a reply connects visibly to the comment it answers", function () {
  ok(communityCss.indexOf(".cm-scope .trow--open > .trow-main > .comment::before") !== -1,
    "a revealed parent needs a spine through its own avatar column, or the " +
    "reply below hangs off empty space");
  ok(communityJs.indexOf("trow--open") !== -1, "and the row must be marked when open");
  /* The rail width IS the connector's x-position; narrowing it on mobile
     moved the line off the avatar it descends from. */
  ok(!/\.cm-scope \{ --thread-rail: 22px; \}/.test(communityCss),
    "the mobile rail override put the line 8px left of the parent avatar");
  ok(/\.cm-scope \{ --thread-rail: 30px; \}/.test(communityCss), "one rail at every width");
  ok(/\.comment--reply \.avatar \{ width: 28px; height: 28px;/.test(communityCss),
    "every avatar shares one diameter so the rail is centred at every depth");
});

test("the community top fade has no hard edge", function () {
  var i = communityCss.indexOf(".modebar::before");
  var bar = communityCss.slice(i, i + 1200);
  ok((bar.match(/color-mix/g) || []).length >= 4,
    "a two-stop ramp banded: the tint needs intermediate stops");
  ok(bar.indexOf("rgba(0,0,0,0.72)") !== -1 && bar.indexOf("rgba(0,0,0,0.32)") !== -1,
    "the mask must ease out with the tint so the blur does not end on a line");
  ok(bar.indexOf("-webkit-mask-image") !== -1 && bar.indexOf("-webkit-backdrop-filter") !== -1,
    "Safari needs both prefixed properties or the bar turns into a solid slab");
});

test("an unanswered post invites, it does not show an empty thread", function () {
  /* X-style: zero comments is not a list with nothing in it. No heading
     counting to zero, no composer sitting open demanding input. */
  /* Anchored on the thread section rather than on renderDetail: helpers
     were later added between the two and a fixed-size window from the
     function name stopped reaching the markup it was meant to check. A
     slice that silently drifts off its target passes for the wrong
     reason, which is worse than failing. */
  var r = communityJs.indexOf("section.innerHTML = comments.length");
  var body = communityJs.slice(r - 600, r + 2400);
  ok(body.indexOf("comments.length\n      ? '<div class=\"comments-title\">") !== -1 ||
     /comments\.length[\s\S]{0,40}comments-title/.test(body),
    "the DISCUSSION heading is conditional on there being a discussion");
  ok(body.indexOf('"comment-box" + (comments.length ? "" : " comment-box--closed")') !== -1,
    "the composer starts closed when there is nothing to reply to");
  ok(communityJs.indexOf("data-first-reply") !== -1, "the empty state owns a Reply action");
  ok(communityCss.indexOf(".cm-scope .comment-box--closed { display: none; }") !== -1,
    "and the closed composer is actually hidden");
});

test("the three comment actions stay three different actions", function () {
  var h = communityJs.indexOf('e.target.closest("[data-first-reply]")');
  ok(h !== -1, "the empty-state CTA has its own branch");
  var cta = communityJs.slice(h, h + 260);
  ok(cta.indexOf("clearReplyTarget(false)") !== -1 && cta.indexOf("openComposer()") !== -1,
    "first reply opens the composer with NO parent: it is a new top-level comment");
  /* The post-level action routes to the thread and nothing else. */
  var d = communityJs.indexOf('if (act === "discuss")');
  var disc = communityJs.slice(d, d + 160);
  ok(disc.indexOf('location.hash = "#/g/"') !== -1 && disc.indexOf("startReply") === -1,
    "the post's comment button opens the thread, it never aims the composer");
});

test("a reply can never silently become a top-level comment", function () {
  /* The draft was written as an answer to someone. If that target is taken
     away - deleted, or removed by another tab - posting it at the root puts
     the user's words somewhere they did not aim them. */
  ok(communityJs.indexOf("var replyTargetLost") !== -1,
    "an involuntary loss of the target must be remembered, not silently forgotten");
  var pi = communityJs.indexOf("function post()");
  var post = communityJs.slice(pi, pi + 2600);
  ok(post.indexOf("if (replyTargetLost && !replyingTo)") !== -1,
    "post() must refuse when the target was taken away");
  ok(post.indexOf("var live = commentById(replyingTo.id)") !== -1,
    "and must re-resolve the target by id rather than trusting a stale object");
  ok(/!live \|\| isDeleted\(live\) \|\| live\.genId !== gen\.id/.test(post),
    "a target that is gone, deleted, or on another post is not a target");
  /* Deliberate choices must NOT be blocked. */
  var sr = communityJs.indexOf("function startReply");
  ok(communityJs.slice(sr, sr + 200).indexOf("replyTargetLost = false") !== -1,
    "aiming somewhere new clears the flag");
  var cr = communityJs.indexOf("function clearReply()");
  ok(communityJs.slice(cr, cr + 260).indexOf("clearReplyTarget(false)") !== -1,
    "the user's own cancel is deliberate and must still allow a top-level post");
});

test("comment counts are derived at every write, never incremented", function () {
  var pi = communityJs.indexOf("function post()");
  var post = communityJs.slice(pi, pi + 6000);
  ok(post.indexOf("gen.counts.comment += 1") === -1,
    "a parallel counter drifts the moment a delete or a merge touches the set");
  ok(post.indexOf("syncCommentCount(gen.id)") !== -1, "derive it from the live comments");
});

test("the discussion heading can appear and disappear with the thread", function () {
  var u = communityJs.indexOf("function updateDiscussionTitle");
  var body = communityJs.slice(u, u + 700);
  ok(body.indexOf("createElement") !== -1,
    "0 -> 1 must create the heading, not wait for a full page render");
  ok(body.indexOf("title.remove()") !== -1, "1 -> 0 must remove it");
});

test("an external comment does not rebuild the page under the reader", function () {
  var a = communityJs.indexOf("function adoptExternalState");
  var body = communityJs.slice(a, a + 1200);
  ok(body.indexOf("refreshThreadOnly(openId)") !== -1,
    "a still-present post repaints its thread in place, keeping the draft");
  ok(body.indexOf("var stillHere = genById(openId)") !== -1,
    "a post that is gone is still a routing event");
});

queue.forEach(function (entry) {
  try { entry[1](); passed++; console.log("PASS: " + entry[0]); }
  catch (e) { failed++; console.log("FAIL: " + entry[0] + "\n      " + e.message); }
});
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
