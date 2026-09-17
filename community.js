/* Community mode for the Botocracy shell: the Slopify prototype, ported 1:1.
   Owns the Community | Workspace mode switch, the engagement ranked feed,
   generation detail with threaded discussion, remix/challenge flows, the new
   posts pill, pull to refresh, and paginated infinite scroll. It never
   touches wsContent (the workspace chat world), workspace state, or its storage;
   its own state lives under the same LS key as always. Local data stands in
   for the backend so the core loop can be felt end to end. */
(function () {
  "use strict";

  var LS_KEY = "slopify:v6"; /* v6: ported into the Botocracy shell as Community mode */

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

  function seed() {
    var now = Date.now();
    return {
      visibility: "public",
      generations: [
        {
          id: "g1", own: false,
          creator: { name: "Miles", handle: "@miles" },
          prompt: "Give me 5 business ideas for Nigerian developers.",
          response: "1. **Payroll tooling for remote teams.** Nigerian firms hiring across Africa need compliant payout rails. Build the boring parts nobody enjoys.\n\n2. **Offline-first learning apps.** Data costs shape behavior here. Content that syncs on wifi and works fully offline wins real users.\n\n3. **Agency productization.** Many devs sell hours. Package one narrow service, like payment integration or WhatsApp ordering, as a fixed price product with a sales page.\n\n4. **Local language voice interfaces.** Yoruba, Hausa, and Igbo voice UX is underserved compared to English-first products.\n\n5. **Compliance trackers for small businesses.** Tax dates and filings get missed constantly. A simple reminder tool beats a bloated CRM.\n\nThe thread running through all five: pick a painful, frequent, local problem and let distribution decide the winner.",
          status: "complete", kind: "original", parentId: null, rootId: "g1",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 18 * 60 * 1000,
          counts: { remix: 1, challenge: 0, comment: 5, save: 4 }
        },
        {
          id: "g2", own: false,
          creator: { name: "Ada", handle: "@ada" },
          prompt: "Explain why Lagos traffic is so difficult to solve.",
          response: "Lagos traffic is a systems failure, not a single broken part.\n\n**Demand keeps outrunning supply.** The city adds vehicles and commuters faster than it adds road capacity, so every new expressway fills up within a few years. Induced demand is the tax on each expansion.\n\n**Roads carry jobs they were not designed for.** Danfos and okadas stop anywhere because formal transit never fully absorbed their routes. Every curb becomes a terminal, which converts moving lanes into queues.\n\n**Incidents have no shock absorbers.** One broken-down truck can lock an entire corridor because there are few alternative crossings of the lagoon and few parallel arterials.\n\nThe hard part is that each actor is behaving rationally. Drivers compete for space, operators stop where demand is, agencies optimize for their own budgets. Untangling it needs pricing, transit investment, and incident response to move together, which is why single projects keep disappointing.",
          status: "complete", kind: "original", parentId: null, rootId: "g2",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 52 * 60 * 1000,
          counts: { remix: 0, challenge: 1, comment: 2, save: 3 }
        },
        {
          id: "g3", own: false,
          creator: { name: "Kamsi", handle: "@kamsi" },
          prompt: "Give me 5 business ideas for Nigerian developers that require less than 100,000 naira to start.",
          response: "Tighter constraints, better list. All five stay under 100k in upfront cost.\n\n1. **WhatsApp storefront setup.** Small shops already sell in chat. Charge a fixed fee to structure their catalog, auto replies, and payment links.\n\n2. **Notion and Sheets consulting for SMEs.** Sell working systems, not hours: inventory trackers, invoice books, staff rosters. Templates are nearly free to replicate.\n\n3. **Landing pages on a subscription.** One niche, one stack, flat monthly fee. Churn math works if you pick clients with recurring campaigns.\n\n4. **Excel to automation rescue gigs.** Every office has a spreadsheet held together by one person. Charge to stabilize it, then a retainer to keep it alive.\n\n5. **Tutorial content in local context.** Teach tools using Nigerian business cases. Costs are time plus a mic; distribution compounds.\n\nRemix note: the 100k cap kills anything with inventory, logistics, or hardware. That is a feature. It forces service-shaped ideas with fast feedback loops.",
          status: "complete", kind: "remix", parentId: "g1", rootId: "g1",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 9 * 60 * 1000,
          counts: { remix: 0, challenge: 0, comment: 0, save: 2 }
        },
        {
          id: "g4", own: false,
          creator: { name: "Dami", handle: "@dami" },
          prompt: "Model Lagos traffic as a pricing problem and propose the cheapest intervention that still works.",
          response: "Same task, different approach.\n\nFrame: road space is a scarce good priced at zero, so it is overconsumed at peak hours. The cheapest real lever is not more asphalt, it is price signals on the scarcest corridors.\n\n**Cheapest intervention that still works:** cordon pricing on 3 to 5 bridges and expressway segments during 6:30 to 9:30 and 16:30 to 19:30, collected through existing toll and plate infrastructure.\n\nWhy this one:\n\n- It targets the actual bottleneck instead of the network average.\n- Revenue hypothecates directly into bus rapid transit frequency, so the alternative improves at the same moment driving gets pricier.\n- Exemptions for registered buses keep the system legible and politically survivable.\n\nFailure mode to watch: if enforcement is manual it leaks. Budget for automated plate reading from day one, or the cordon becomes a suggestion.",
          status: "complete", kind: "challenge", parentId: "g2", rootId: "g2",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 4 * 60 * 1000,
          counts: { remix: 0, challenge: 0, comment: 0, save: 1 }
        },
        {
          id: "g5", own: true,
          creator: YOU,
          prompt: "Draft a cold email to a fintech CTO about pilot testing our developer tool.",
          response: "Subject: 20 minute pilot on your payout reconciliation flow\n\nHi Ada,\n\nWe built a tool that flags payout mismatches before your settlement run, and I think it maps directly to the reconciliation pain you mentioned at the Lagos fintech meetup.\n\nWould your team be open to a two week pilot? We handle setup, you point us at a sandbox feed. If it does not catch anything useful, you keep the report and owe nothing.\n\nWorth a short call this week?\n\nBest,\nYou",
          status: "complete", kind: "original", parentId: null, rootId: "g5",
          locked: false, visibility: "private", saved: false,
          createdAt: now - 2 * 60 * 60 * 1000,
          counts: { remix: 0, challenge: 0, comment: 0, save: 0 }
        },
        /* Extended corpus so engagement ranking and pagination are visible.
           Old-but-viral (g9) deliberately outranks fresh-but-quiet posts. */
        {
          id: "g6", own: false,
          creator: { name: "Ireti", handle: "@ireti" },
          prompt: "Design a 5 day sprint to validate a booking app for beauty salons.",
          response: "Day 1: map the riskiest assumption, that salons will share live calendars.\n\nDay 2: landing page plus 10 manual booking DMs.\nDay 3: concierge bookings by hand for 5 salons.\nDay 4: fake the reschedule flow with a spreadsheet.\nDay 5: measure the no show rate and rebooking.\n\nIf no salon shares a calendar by Day 3, the product is dispatching, not booking.",
          status: "complete", kind: "original", parentId: null, rootId: "g6",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 3 * 60 * 60 * 1000,
          counts: { remix: 2, challenge: 0, comment: 0, save: 6 }
        },
        {
          id: "g7", own: false,
          creator: { name: "Tobi", handle: "@tobi" },
          prompt: "Explain vector databases to a backend engineer who has only used Postgres.",
          response: "Stop thinking of it as a new database. A vector db is Postgres with one extra trick: store an embedding per row, then index it so nearest neighbor search is fast.\n\nEverything else you know still applies. Rows, filters, transactions. The difference is the query: instead of WHERE exact match, you ask for the k closest vectors and get semantic search.",
          status: "complete", kind: "original", parentId: null, rootId: "g7",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 5 * 60 * 60 * 1000,
          counts: { remix: 1, challenge: 0, comment: 0, save: 4 }
        },
        {
          id: "g8", own: false,
          creator: { name: "Zainab", handle: "@zainab" },
          prompt: "Roast my landing page headline: We make teams productive.",
          response: "Verdict: the headline says nothing, slowly.\n\nThat line could be any tool from Excel to espresso. Rewrite: cut standup to 90 seconds with updates your team writes once. Specific beats clever. Name the outcome, not the vibe.",
          status: "complete", kind: "original", parentId: null, rootId: "g8",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 7 * 60 * 60 * 1000,
          counts: { remix: 6, challenge: 2, comment: 2, save: 9 }
        },
        {
          id: "g9", own: false,
          creator: { name: "Ada", handle: "@ada" },
          prompt: "Is the 10x engineer real, or a hiring myth?",
          response: "Both, depending on what you multiply.\n\nOne great engineer rarely writes 10x the code. But one great engineer regularly removes 10x of the rework: clearer interfaces, fewer dead end frameworks, docs that stop Slack arguments.\n\nTeams that hire for output get a myth. Teams that hire for leverage find the real thing.",
          status: "complete", kind: "original", parentId: null, rootId: "g9",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 5 * 24 * 60 * 60 * 1000,
          counts: { remix: 14, challenge: 6, comment: 3, save: 31 }
        },
        {
          id: "g10", own: false,
          creator: { name: "Miles", handle: "@miles" },
          prompt: "Write a standup update for a week where everything slipped.",
          response: "Yesterday: burned down 0 of 6. The auth migration discovered a second auth system.\nToday: unifying both into one, genuinely.\nBlockers: the original author left in 2023.\nMood: we now know why it was slow. That is progress, just the expensive kind.",
          status: "complete", kind: "original", parentId: null, rootId: "g10",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 9 * 60 * 60 * 1000,
          counts: { remix: 0, challenge: 1, comment: 0, save: 2 }
        },
        {
          id: "g11", own: false,
          creator: { name: "Kamsi", handle: "@kamsi" },
          prompt: "Monolith first or microservices first for a 4 person team?",
          response: "Monolith first, nearly always.\n\nFour people cannot pay the coordination tax of microservices: service discovery, distributed debugging, versioning contracts between services that all ship together anyway.\n\nThe escape hatch is not services. It is module boundaries inside the monolith, enforced in code review. When a module outgrows the team, that is your first extraction candidate.",
          status: "complete", kind: "original", parentId: null, rootId: "g11",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 26 * 60 * 60 * 1000,
          counts: { remix: 3, challenge: 2, comment: 1, save: 8 }
        },
        {
          id: "g12", own: false,
          creator: { name: "Dami", handle: "@dami" },
          prompt: "Give me the 5 onboarding friction points every B2B SaaS has by user 50.",
          response: "1. Signup asks for a credit card before value.\n2. First run shows an empty dashboard with no sample data.\n3. The one integration everyone needs is hidden in settings.\n4. Docs explain the API before the workflow.\n5. Nobody is told what success looks like in week 1.\n\nBy user 50 every one of these has cost you a team that would have paid.",
          status: "complete", kind: "original", parentId: null, rootId: "g12",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 30 * 60 * 60 * 1000,
          counts: { remix: 1, challenge: 0, comment: 0, save: 5 }
        },
        {
          id: "g13", own: false,
          creator: { name: "Chidi", handle: "@chidi" },
          prompt: "Turn this bug report into a postmortem readers will actually finish.",
          response: "Structure it like a story, not a spreadsheet.\n\nWhat broke, in one sentence a non engineer gets.\nWhat users felt, with timestamps.\nWhat we believed that was wrong. That line is the whole postmortem.\nWhat changed, each fix with an owner and a date.\n\nSkip blame, keep the wrong belief visible. Readers finish stories about beliefs.",
          status: "complete", kind: "original", parentId: null, rootId: "g13",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 2 * 24 * 60 * 60 * 1000,
          counts: { remix: 2, challenge: 1, comment: 0, save: 3 }
        },
        {
          id: "g14", own: false,
          creator: { name: "Ireti", handle: "@ireti" },
          prompt: "Script a 60 second demo video for a CLI tool.",
          response: "0 to 8s: the problem, one line of painful terminal output.\n8 to 20s: install, one command, no music yet.\n20 to 45s: the aha. Run it on a real file, show before and after side by side.\n45 to 55s: the flag everyone asks about.\n55 to 60s: repo URL, done.\n\nNo talking head. The terminal is the demo.",
          status: "complete", kind: "original", parentId: null, rootId: "g14",
          locked: false, visibility: "public", saved: false,
          createdAt: now - (2 * 24 * 60 + 60) * 60 * 1000,
          counts: { remix: 0, challenge: 0, comment: 0, save: 2 }
        },
        {
          id: "g15", own: false,
          creator: { name: "Zainab", handle: "@zainab" },
          prompt: "What metrics prove a community feature is working in week one?",
          response: "Week one proof, in order of honesty:\n\n1. A stranger comments without being tagged.\n2. Someone remixes the featured post instead of posting fresh.\n3. A thread goes two replies deep without the original poster.\n4. The same 10 people return unprompted.\n\nPage views and signups are vanity until number 3 happens.",
          status: "complete", kind: "original", parentId: null, rootId: "g15",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 3 * 24 * 60 * 60 * 1000,
          counts: { remix: 4, challenge: 3, comment: 2, save: 11 }
        },
        {
          id: "g16", own: false,
          creator: { name: "Tobi", handle: "@tobi" },
          prompt: "Rewrite our pricing page so a tired founder understands it at 2am.",
          response: "One page, three cards.\n\nFree: what it does, no asterisks.\nPro: the price, big, per month, not per seat math in footnotes.\nEnterprise: talk to us, no calculator.\n\nAbove the cards, one line: pay only when it saves you a hire. A tired founder reads the headline, picks the middle card, and goes to sleep.",
          status: "complete", kind: "original", parentId: null, rootId: "g16",
          locked: false, visibility: "public", saved: false,
          createdAt: now - (3 * 24 * 60 + 120) * 60 * 1000,
          counts: { remix: 1, challenge: 1, comment: 0, save: 4 }
        },
        {
          id: "g17", own: false,
          creator: { name: "Miles", handle: "@miles" },
          prompt: "Design the empty state for a notes app people abandon after day one.",
          response: "The empty state is the second onboarding.\n\nShow one prewritten note that answers the question every quitter had: what do I even write? Make it editable. Put the keyboard shortcut next to it.\n\nThen one line: people who write 3 notes on day 1 keep the app. Social proof with a job to do.",
          status: "complete", kind: "original", parentId: null, rootId: "g17",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 4 * 24 * 60 * 60 * 1000,
          counts: { remix: 2, challenge: 0, comment: 0, save: 6 }
        },
        {
          id: "g18", own: false,
          creator: { name: "Chidi", handle: "@chidi" },
          prompt: "Explain why our API latency spikes only on Sundays.",
          response: "Sundays are when the batch jobs run.\n\nMore precisely: Sunday is low traffic, so your p99 graph is dominated by cold starts and the weekly analytics rollup, not by users. Check cron first, cache hit rates second. Spiky p99 on the quietest day is almost never a code path problem.",
          status: "complete", kind: "original", parentId: null, rootId: "g18",
          locked: false, visibility: "public", saved: false,
          createdAt: now - (4 * 24 * 60 + 180) * 60 * 1000,
          counts: { remix: 0, challenge: 1, comment: 0, save: 2 }
        },
        {
          id: "g19", own: false,
          creator: { name: "Ada", handle: "@ada" },
          prompt: "Plan a launch on a $0 budget with 200 followers.",
          response: "With 200 followers you do not launch. You premiere.\n\nWeek 1: DM the 20 people who reply to you most. Hand them the thing personally.\nWeek 2: post a build log each day, one screenshot, one honest failure.\nLaunch day: the 20 people post their own results. You amplify.\n\nBudget 0 dollars. The currency is favors you already earned.",
          status: "complete", kind: "original", parentId: null, rootId: "g19",
          locked: false, visibility: "public", saved: false,
          createdAt: now - 6 * 24 * 60 * 60 * 1000,
          counts: { remix: 5, challenge: 2, comment: 1, save: 12 }
        }
      ],
      comments: [
        { id: "c1", genId: "g1", parentId: null, own: false, creator: { name: "Ada", handle: "@ada" }, replyingToName: null, text: "Number 3 is underrated. Fixed price beats hourly in this market.", createdAt: now - 14 * 60 * 1000 },
        { id: "c2", genId: "g1", parentId: "c1", own: false, creator: { name: "Dami", handle: "@dami" }, replyingToName: "Ada", text: "Until the client tries to renegotiate mid project. Scope lock matters more than the price tag.", createdAt: now - 12 * 60 * 1000 },
        { id: "c3", genId: "g1", parentId: "c2", own: false, creator: { name: "Ada", handle: "@ada" }, replyingToName: "Dami", text: "That is the real lesson. Fixed price without a change request rule is just hourly with extra steps.", createdAt: now - 10 * 60 * 1000 },
        { id: "c4", genId: "g1", parentId: null, own: true, creator: YOU, replyingToName: null, text: "Tried the offline learning one last year. The sync logic basically was the product.", createdAt: now - 11 * 60 * 1000 },
        { id: "c6", genId: "g1", parentId: "c1", own: false, creator: { name: "Miles", handle: "@miles" }, replyingToName: "Ada", text: "Agree on fixed price. The real unlock was making the package visible before the pitch, so nobody negotiates from zero.", createdAt: now - 9 * 60 * 1000 },
        { id: "c5", genId: "g2", parentId: null, own: false, creator: { name: "Kamsi", handle: "@kamsi" }, replyingToName: null, text: "The demand side framing is the part most people skip when they argue about traffic.", createdAt: now - 40 * 60 * 1000 },
        { id: "c7", genId: "g2", parentId: "c5", own: true, creator: YOU, replyingToName: "Kamsi", text: "Which is why the pricing challenge above land differently once you read this one first.", createdAt: now - 30 * 60 * 1000 },
        { id: "c8", genId: "g9", parentId: null, own: false, creator: { name: "Miles", handle: "@miles" }, replyingToName: null, text: "The 10x engineer exists. It is one engineer who deletes meetings for nine others.", createdAt: now - 5 * 24 * 60 * 60 * 1000 },
        { id: "c9", genId: "g9", parentId: "c8", own: false, creator: { name: "Ada", handle: "@ada" }, replyingToName: "Miles", text: "That reframing is doing more work than the original question.", createdAt: now - (5 * 24 * 60 - 30) * 60 * 1000 },
        { id: "c10", genId: "g9", parentId: null, own: false, creator: { name: "Zainab", handle: "@zainab" }, replyingToName: null, text: "Hiring myth. The 10x was always leverage, not talent.", createdAt: now - (5 * 24 * 60 - 60) * 60 * 1000 },
        { id: "c11", genId: "g8", parentId: null, own: false, creator: { name: "Kamsi", handle: "@kamsi" }, replyingToName: null, text: "Your rewrite is a promise. The original was a weather report.", createdAt: now - 6 * 60 * 60 * 1000 },
        { id: "c12", genId: "g8", parentId: null, own: false, creator: { name: "Tobi", handle: "@tobi" }, replyingToName: null, text: "Try naming the outcome: ship releases without the group chat.", createdAt: now - 5 * 60 * 60 * 1000 },
        { id: "c13", genId: "g15", parentId: null, own: false, creator: { name: "Miles", handle: "@miles" }, replyingToName: null, text: "Week one is activation, not retention. Did the second comment happen?", createdAt: now - 3 * 24 * 60 * 60 * 1000 },
        { id: "c14", genId: "g15", parentId: "c13", own: false, creator: { name: "Ada", handle: "@ada" }, replyingToName: "Miles", text: "A second comment from a different person. That is the tell.", createdAt: now - (3 * 24 * 60 - 40) * 60 * 1000 },
        { id: "c15", genId: "g19", parentId: null, own: false, creator: { name: "Dami", handle: "@dami" }, replyingToName: null, text: "The 0 dollar launch plan is just distribution you do yourself.", createdAt: now - 5 * 24 * 60 * 60 * 1000 },
        { id: "c16", genId: "g11", parentId: null, own: false, creator: { name: "Ireti", handle: "@ireti" }, replyingToName: null, text: "Monolith first, but draw the module seams like you mean it.", createdAt: now - 20 * 60 * 60 * 1000 }
      ]
    };
  }

  var state = load() || seed();
  var streamingNow = false;

  /* True once a write has failed, so the warning is shown once rather than
     on every keystroke-triggered save. */
  var persistBroken = false;

  /* Merge any records another tab wrote since this tab last read, then write.

     The storage event alone is not enough: it only fires after a write, so
     two tabs opened before either posted still each hold a full snapshot and
     the second save erases the first. Reconciling immediately before the
     write closes that window. Generations and comments are append-mostly and
     carry stable unique ids, so "keep every id either side knows about" is
     both sufficient and safe; for records both sides have, the in-memory
     copy wins, because it is the one the user is currently acting on. */
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
        if (r && r.id && !have[r.id]) mine.push(r);
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
        if (pendingGens.indexOf(g) === -1) pendingGens.push(g);
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

  function deleteGeneration(id) {
    var gen = genById(id);
    if (!canDelete(gen)) return;
    /* A generation that is still streaming has an in-flight writer that
       would resurrect fields behind the tombstone. */
    if (gen.status === "streaming") return;

    gen.deleted = true;
    gen.deletedAt = Date.now();
    persist();

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
    if (hash.indexOf("#/g/") === 0) {
      var id = hash.slice(4);
      var gen = genById(id);
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
    renderFeed();
    showMode("community");
    setDetailChrome(false);
    feedView.hidden = false;
    detailView.hidden = true;
    setGenDock(true);
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
      html += '<button class="gen-act' + (gen.locked ? " on" : "") + '" data-act="lock" aria-label="' +
        (gen.locked ? "Unlock this generation" : "Lock this generation") + '" aria-pressed="' + gen.locked + '" title="' +
        (gen.locked ? "Unlock" : "Lock") + '">' +
        '<i data-lucide="' + (gen.locked ? "lock" : "lock-open") + '"></i></button>';
      /* Own content only, and never mid-stream: a streaming post has a
         writer still appending to it. */
      if (gen.status !== "streaming") {
        html += '<button class="gen-act gen-act-danger" data-act="delete" aria-label="Delete post" title="Delete post">' +
          '<i data-lucide="trash-2"></i></button>';
      }
    }
    html += "</div>";
    return html;
  }

  function responseBlock(gen, detail) {
    if (gen.status === "failed") {
      return '<div class="gen-resp"><div class="gen-resp-label"><i data-lucide="sparkles"></i>BOTOCRACY</div>' +
        '<p class="gen-error">' + esc(gen.errorText || "The generation was interrupted before it finished.") + "</p>" +
        '<button class="gen-retry" data-act="retry"><i data-lucide="refresh-cw"></i>Retry generation</button></div>';
    }
    var body = rich(gen.response);
    var isLong = !detail && gen.status === "complete" && gen.response.length > 320;
    var streaming = gen.status === "streaming";
    return '<div class="gen-resp">' +
      '<div class="gen-resp-label"><i data-lucide="sparkles"></i>BOTOCRACY</div>' +
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
          '<span class="gen-handle">' + esc(gen.creator.handle) + "</span>" +
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

  function visibleGenerations() {
    var list = state.generations.filter(function (gen) {
      /* A deleted post leaves the feed entirely. It still exists for its
         replies to point at, which is what renders the tombstone on the
         detail view. */
      if (isDeleted(gen)) return false;
      return gen.visibility === "public" || gen.own;
    });
    list.sort(function (a, b) {
      /* Streaming and failed posts both pin to the top. Failed is not
         cosmetic: it is the only state that carries a retry control, and a
         freshly interrupted post has no engagement, so ranking it normally
         buried it below the fold on reload and the user could never reach
         the recovery path for their own post. Only the author's, because
         nobody else can retry it. */
      var pa = urgent(a) ? 1 : 0;
      var pb = urgent(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      var fa = isPinned(a) ? 1 : 0;
      var fb = isPinned(b) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      if (fa && fb) return b.createdAt - a.createdAt;
      return score(b) - score(a) || b.createdAt - a.createdAt;
    });
    return list;
  }

  /* Infinite scroll: PAGE_SIZE cards at a time so the platform never loads
     the whole corpus at once. Triggering follows the NearSpace feed: an
     IntersectionObserver sentinel with a bottom rootMargin starts the fetch
     before the user arrives, a raw scroll fallback covers mobile browsers
     that skip observer callbacks, and one timer ref means rapid scrolling
     can never stack parallel page loads. */
  var PAGE_SIZE = 10;
  var feedShown = 0;
  var loadTimer = null;

  function syncFeedTail(total) {
    var loader = $("cmFeedLoader");
    var end = $("cmFeedEnd");
    loader.hidden = true;
    end.hidden = !(feedShown >= total && total > PAGE_SIZE);
  }

  function appendFeedPage() {
    var all = visibleGenerations();
    var list = $("cmFeedList");
    all.slice(feedShown, feedShown + PAGE_SIZE).forEach(function (gen) {
      list.appendChild(buildCard(gen, false));
    });
    feedShown = Math.min(feedShown + PAGE_SIZE, all.length);
    syncFeedTail(all.length);
    refreshIcons();
  }

  function loadMoreFeed() {
    var total = visibleGenerations().length;
    if (loadTimer || feedShown >= total) return;
    $("cmFeedLoader").hidden = false;
    loadTimer = setTimeout(function () {
      loadTimer = null;
      $("cmFeedLoader").hidden = true;
      appendFeedPage();
      /* Still shorter than the viewport (tall screens): keep fetching so the
         page always fills before the user scrolls. The sentinel observer
         will not refire here because its intersection state never changed. */
      fillViewport();
    }, 700); /* deliberate latency so the fetch is felt, like a real backend */
  }

  /* Near the bottom of the feed, or the feed is shorter than its own
     viewport: fetch the next slice. Only while the feed is on screen.

     The measurement has to come from #cmFeedView, which is the element that
     actually scrolls (overflow-y: auto). Measuring the window instead looked
     correct but was always true: body is overflow:hidden in community mode,
     so documentElement.scrollHeight equals innerHeight forever and the
     "near bottom" test never went false. Each page load then re-triggered
     the next one and the whole corpus arrived in one burst, which is exactly
     what paginating is supposed to prevent. */
  function feedScroller() { return $("cmFeedView"); }

  function fillViewport() {
    if (currentMode() !== "community") return;
    var box = feedScroller();
    if (!box || box.hidden) return;
    var nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 320;
    if (nearBottom) loadMoreFeed();
  }

  function renderFeed() {
    $("cmFeedList").innerHTML = "";
    feedShown = 0;
    clearTimeout(loadTimer);
    loadTimer = null;
    appendFeedPage();
    $("cmFeedEmpty").hidden = visibleGenerations().length > 0;
    fillViewport();
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
        '<textarea id="cmCommentInput" rows="1" maxlength="2000" placeholder="Add to the discussion" aria-label="Add to the discussion"></textarea>' +
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

  function closeCommentMenu() {
    if (commentMenuTrigger) commentMenuTrigger.setAttribute("aria-expanded", "false");
    if (commentMenuEl) { commentMenuEl.classList.remove("open"); commentMenuEl.hidden = true; }
    commentMenuFor = null;
    commentMenuTrigger = null;
  }

  function openCommentMenu(trigger, commentId) {
    if (!commentMenuEl) {
      commentMenuEl = document.createElement("div");
      commentMenuEl.className = "pop pop-sm comment-menu";
      commentMenuEl.setAttribute("role", "menu");
      commentMenuEl.hidden = true;
      /* The menu is mounted on body, outside the thread's delegated
         listener, so it owns its own click handling. */
      commentMenuEl.addEventListener("click", function (ev) {
        var item = ev.target.closest("[data-del]");
        if (!item) return;
        var id = item.getAttribute("data-del");
        closeCommentMenu();
        if (replyingTo && replyingTo.id === id) clearReplyTarget(true);
        deleteComment(id);
      });
      document.body.appendChild(commentMenuEl);
    }
    /* Tapping the same kebab again closes it. */
    if (commentMenuFor === commentId && !commentMenuEl.hidden) { closeCommentMenu(); return; }
    closeCommentMenu();

    commentMenuFor = commentId;
    commentMenuTrigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    commentMenuEl.innerHTML =
      '<button class="pop-item danger" role="menuitem" data-del="' + commentId + '">' +
        '<i data-lucide="trash-2"></i><span>Delete</span>' +
      "</button>";
    commentMenuEl.hidden = false;
    refreshIcons();

    /* Anchor to the kebab, flipping up or left when the viewport would clip
       it. position:fixed, so these are viewport coordinates. */
    var r = trigger.getBoundingClientRect();
    var mw = commentMenuEl.offsetWidth || 190;
    var mh = commentMenuEl.offsetHeight || 44;
    var left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
    commentMenuEl.style.left = Math.max(8, left) + "px";
    commentMenuEl.style.top = Math.max(8, top) + "px";
    commentMenuEl.style.setProperty("--origin", "top right");
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
  window.addEventListener("scroll", function () { if (commentMenuFor) closeCommentMenu(); }, true);

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
              '<span class="comment-handle">' + esc(c.creator.handle) + "</span>" +
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
              (c.own
                ? '<span class="comment-ops-end">' +
                    '<button class="comment-kebab" data-cmenu="' + c.id +
                      '" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">' +
                      '<i data-lucide="ellipsis"></i>' +
                    "</button>" +
                  "</span>"
                : "") +
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
      /* Kebab: opens the one-item menu that owns Delete. */
      var kebab = e.target.closest("[data-cmenu]");
      if (kebab) {
        openCommentMenu(kebab, kebab.getAttribute("data-cmenu"));
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
      state.comments.push({
        id: uid(), genId: gen.id, own: true, creator: YOU,
        text: text,
        parentId: parentId,
        replyingToName: replyingTo ? replyingTo.creator.name : null,
        createdAt: Date.now()
      });
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

  /* ---------- new arrivals: poll, pill, pull to refresh ----------

     Production shape: GET /feed?after=<cursor> on an interval. Here the demo
     backend "receives" posts on a timer from a rotating pool. Arrivals enter
     state invisibly with freshPinned set, pendingGens tracks them, and only
     the pill tap or a pull to refresh merges them into the visible feed, so
     the timeline never shifts under the reader's thumb mid scroll. */

  var pendingGens = [];
  var pollCount = 0;

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

  var ARRIVAL_POOL = [
    { creator: { name: "Kamsi", handle: "@kamsi" },
      prompt: "Review this product spec like a hostile VP of Engineering.",
      response: "The spec assumes the migration is free. It is not.\n\nHidden costs you did not budget: dual writes during the cutover, backfill of 40 million rows, and a rollback plan that currently says hope.\n\nFix the spec by adding a kill switch per tenant and a definition of done that includes deleting the old path, not just shipping the new one." },
    { creator: { name: "Ada", handle: "@ada" },
      prompt: "Plan a school fee savings wallet for market traders.",
      response: "Daily micro deposits beat monthly targets because cash arrives daily.\n\nDesign: agent float at the stall, USSD fallback for the days the app is out of data, and fees locked at term start so school resumption never negotiates.\n\nThe feature that retains: a visible countdown to the term, not an interest rate." },
    { creator: { name: "Miles", handle: "@miles" },
      prompt: "Write 3 subject lines for a launch email about offline sync.",
      response: "1. Your app finally works in an elevator.\n2. Data finished? Nothing changed.\n3. We shipped the thing you rage quit over.\n\nPick 2 for the send. It is true, it fits the preview text, and the people who churned over sync will open it on principle." },
    { creator: { name: "Zainab", handle: "@zainab" },
      prompt: "Interview questions that reveal if a startup actually ships.",
      response: "1. Tell me about the last thing you deleted. Vacant stares mean hoarding.\n2. What shipped last Tuesday? Any answer older than a sprint is a process smell.\n3. Who can say no to a feature? If the answer is nobody, nothing ships on purpose." },
    { creator: { name: "Tobi", handle: "@tobi" },
      prompt: "Summarize Nigeria's data protection act for a two person SaaS.",
      response: "You need consent before collection, a reason for every field you store, and a way to delete on request.\n\nThe practical floor: a privacy page a human can read, export and delete endpoints that actually work, and no analytics on data you cannot justify.\n\nIt is less law homework, more table manners with a budget line." },
    { creator: { name: "Dami", handle: "@dami" },
      prompt: "Turn these churn survey answers into a retention roadmap.",
      response: "Group the answers by when users gave up, not why they said they left.\n\nDay 1 churn is onboarding, week 2 is missing habit, month 2 is price realization. One fix per window, shipped in that order.\n\nIgnore the loudest write in. The median abandoned session tells the truer story." }
  ];

  function simulateIncoming() {
    if (state.generations.length >= 90) return; /* demo corpus cap */
    var template = ARRIVAL_POOL[pollCount % ARRIVAL_POOL.length];
    pollCount += 1;
    var gen = {
      id: uid(),
      own: false,
      creator: template.creator,
      prompt: template.prompt,
      response: template.response,
      status: "complete", kind: "original", parentId: null, rootId: null,
      locked: false, visibility: "public", saved: false,
      createdAt: Date.now(),
      counts: { remix: 0, challenge: 0, comment: 0, save: 0 },
      freshPinned: true /* rides to the top exactly once, on merge */
    };
    gen.rootId = gen.id;
    state.generations.push(gen);
    pendingGens.push(gen);
    persist();
    syncPill();
  }

  /* First poll soon enough to be felt in a demo, then a relaxed heartbeat. */
  function schedulePoll() {
    var delay = pollCount === 0 ? 28000 : 45000 + Math.floor(Math.random() * 45000);
    setTimeout(function () {
      simulateIncoming();
      schedulePoll();
    }, delay);
  }

  function mergeFresh() {
    pendingGens.length = 0;
    clearPins();
    state.generations.forEach(function (gen) { gen.freshPinned = false; });
    persist();
    $("cmNewPostsPill").hidden = true;
  }

  function syncPill() {
    if ($("cmFeedView").hidden) return;
    if (pendingGens.length === 0) return;
    /* overlapping initial avatars for up to 3 distinct pending authors,
       newest first, Twitter style */
    var seen = {};
    var avas = "";
    var count = 0;
    for (var i = pendingGens.length - 1; i >= 0 && count < 3; i--) {
      var name = pendingGens[i].creator.name;
      if (seen[name]) continue;
      seen[name] = true;
      count += 1;
      avas += window.BotoAvatar
        ? '<span class="npp-ava npp-ava-img">' + BotoAvatar.svg(pendingGens[i].creator.handle || name, 20) + "</span>"
        : '<span class="npp-ava">' + esc(name.charAt(0).toUpperCase()) + "</span>";
    }
    $("cmNppAvas").innerHTML = avas;
    $("cmNewPostsPill").hidden = false;
  }

  function initPill() {
    $("cmNewPostsPill").addEventListener("click", function () {
      renderFeed(); /* pinned arrivals land on top in this render */
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
    simulateIncoming: simulateIncoming,
    pendingCount: function () { return pendingGens.length; }
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
        if (kind === "remix") parent.counts.remix += 1;
        if (kind === "challenge") parent.counts.challenge += 1;
        replaceCard(parent);
      }
    }

    var gen = {
      id: uid(),
      own: true,
      creator: YOU,
      prompt: prompt,
      /* addressed: this post asked the agent for something. A plain post
         has no response block, is never streamed, and never reaches the
         demo engine or (in production) the provider layer. Stored on the
         object so a reload keeps the distinction. */
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
    /* An addressed post pins itself to the top while it streams. A plain
       post is complete the instant it is made, so without a pin it would
       sort on engagement it has not earned and vanish as you posted it.
       The pin is session scoped so it cannot survive a reload. */
    if (!toBot) pinForThisView(gen.id);
    persist();

    input.value = "";
    autogrow(input);
    paintHighlight();
    syncSendIntent();
    clearContext();
    renderFeed();
    /* The one place the agent is invoked. A plain post is already in its
       terminal state, so there is nothing to run and nothing to await. */
    if (toBot) streamGeneration(gen);
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

  function streamGeneration(gen) {
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
      if (gen.visibility === "public") {
        /* published state is implicit: it sits in the public feed now */
      }
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
      gen.saved = !gen.saved;
      gen.counts.save += gen.saved ? 1 : -1;
      persist();
      replaceCard(gen);
      return;
    }
    if (act === "delete") {
      deleteGeneration(gen.id);
      return;
    }
    if (act === "lock" && gen.own) {
      gen.locked = !gen.locked;
      persist();
      replaceCard(gen);
      return;
    }
    if (act === "remix" || act === "challenge") {
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
    var label = toBot ? "Ask @bot" : "Post to the feed";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    if (dock) dock.classList.toggle("to-bot", toBot);
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
    initPill();
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

  init();
})();
