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

/* ---------- render pipeline ---------- */

test("every authored public asset is copied by the Render build", function () {
  var build = read("render.yaml");
  ["fonts.css", "404.html", "public.css", "public.js"].forEach(function (asset) {
    ok(build.indexOf(asset) > -1, asset + " is not in the Render build command");
  });
});

/* ---------- run ---------- */

queue.forEach(function (entry) {
  try { entry[1](); passed++; console.log("PASS: " + entry[0]); }
  catch (e) { failed++; console.log("FAIL: " + entry[0] + "\n      " + e.message); }
});
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
