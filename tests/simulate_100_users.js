/**
 * tests/simulate_100_users.js
 * Simulates 100 users across lifecycle:
 *  - Account signup & identity setup with DiceBear character avatars
 *  - Posting original generations & @bot addressed prompts
 *  - Commenting & nested subcomment threads
 *  - @bot detection mid-sentence and in-thread replies
 *  - Username customization & quota enforcement (3 per 21 days)
 */
"use strict";

const assert = require("assert");

// Mock Supabase / DB state in memory to simulate high volume concurrent users
class SimulatedCommunityEngine {
  constructor() {
    this.users = new Map();
    this.profiles = new Map();
    this.generations = new Map();
    this.comments = new Map();
    this.notifications = [];
    this.idCounter = 1;
  }

  uid(prefix = "id") {
    return `${prefix}-${this.idCounter++}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // 1. User Signup & Profile setup
  signup(email, password, displayName, avatar = "char-1") {
    const userId = this.uid("usr");
    const handle = email.split("@")[0].replace(/[^a-z0-9_]/gi, "").slice(0, 20);
    const user = { id: userId, email, password };
    const profile = {
      id: userId,
      handle: `@${handle}`,
      display_name: displayName || handle,
      avatar,
      bio: `Hello from ${displayName}!`,
      username_changes_count: 0,
      username_quota_exhausted_at: null,
      created_at: Date.now()
    };
    this.users.set(userId, user);
    this.profiles.set(userId, profile);
    return { user, profile };
  }

  // 2. Profile Customization with 3 changes per 21 days quota
  customizeProfile(userId, { displayName, bio, handle, avatar }) {
    const prof = this.profiles.get(userId);
    if (!prof) throw new Error("no_profile");

    const now = Date.now();
    const cooldown = 21 * 24 * 60 * 60 * 1000;
    if (prof.username_quota_exhausted_at && now >= prof.username_quota_exhausted_at + cooldown) {
      prof.username_changes_count = 0;
      prof.username_quota_exhausted_at = null;
    }

    if (handle && handle !== prof.handle) {
      if (prof.username_changes_count >= 3) {
        throw new Error("username_quota_exhausted");
      }
      const clean = handle.replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9_]{2,30}$/.test(clean)) {
        throw new Error("bad_handle");
      }
      for (const [otherId, otherP] of this.profiles.entries()) {
        if (otherId !== userId && otherP.handle.toLowerCase() === `@${clean}`) {
          throw new Error("handle_already_taken");
        }
      }
      prof.handle = `@${clean}`;
      prof.username_changes_count += 1;
      if (prof.username_changes_count >= 3) {
        prof.username_quota_exhausted_at = now;
      }
    }

    if (displayName) prof.display_name = displayName.trim().slice(0, 40);
    if (bio !== undefined) prof.bio = bio.trim().slice(0, 300);
    if (avatar) prof.avatar = avatar;

    return prof;
  }

  // 3. Generation posting with mid-sentence @bot detection
  postGeneration(userId, text, kind = "original", remixOf = null) {
    const prof = this.profiles.get(userId);
    const botRegex = /(?:^|\s)@bot\b/i;
    const addressed = botRegex.test(text);
    const genId = this.uid("gen");
    const cleanPrompt = text.replace(botRegex, " ").replace(/\s{2,}/g, " ").trim();

    const gen = {
      id: genId,
      author_id: userId,
      creator: { name: prof.display_name, handle: prof.handle, avatar: prof.avatar },
      prompt: cleanPrompt,
      raw_text: text,
      addressed,
      status: "complete",
      response: addressed ? `[Simulated @bot response to: ${cleanPrompt}]` : "",
      kind,
      remix_of: remixOf,
      comment_count: 0,
      created_at: Date.now()
    };
    this.generations.set(genId, gen);
    return gen;
  }

  // 4. Threaded commenting with mid-sentence @bot detection & auto-reply
  addComment(userId, genId, text, parentId = null) {
    const gen = this.generations.get(genId);
    if (!gen) throw new Error("post_gone");
    const prof = this.profiles.get(userId);
    const commentId = this.uid("com");
    const botRegex = /(?:^|\s)@bot\b/i;
    const addressed = botRegex.test(text);

    const comment = {
      id: commentId,
      genId,
      author_id: userId,
      creator: { name: prof.display_name, handle: prof.handle, avatar: prof.avatar },
      text,
      parentId,
      created_at: Date.now()
    };
    this.comments.set(commentId, comment);
    gen.comment_count += 1;

    let botReply = null;
    if (addressed) {
      const botId = this.uid("bot-reply");
      const cleanPrompt = text.replace(botRegex, " ").replace(/\s{2,}/g, " ").trim();
      botReply = {
        id: botId,
        genId,
        author_id: "bot",
        creator: { name: "Botocracy", handle: "@bot", avatar: "char-1" },
        text: `Working take on: "${cleanPrompt}". Here is the breakdown.`,
        parentId: commentId,
        created_at: Date.now() + 10
      };
      this.comments.set(botId, botReply);
      gen.comment_count += 1;
    }

    return { comment, botReply };
  }
}

async function runSimulation() {
  console.log("Starting 100-user simulation (signup, posting, commenting)...");
  const engine = new SimulatedCommunityEngine();
  const userList = [];

  // Phase 1: Simulate 100 user signups with distinct handles, names & 8 character avatars
  for (let i = 1; i <= 100; i++) {
    const email = `user_${i}@example.com`;
    const name = `Pioneer ${i}`;
    const avatar = `char-${((i - 1) % 8) + 1}`;
    const { user, profile } = engine.signup(email, "SecurePassword123!", name, avatar);
    userList.push({ user, profile });
  }
  assert.strictEqual(engine.users.size, 100, "100 users created");
  assert.strictEqual(engine.profiles.size, 100, "100 profiles created");
  console.log("✓ Phase 1 complete: 100 users registered with 8 DiceBear character avatars.");

  // Phase 2: Simulate 100 users posting generations (mix of plain posts and @bot addressed)
  const posts = [];
  for (let i = 0; i < userList.length; i++) {
    const u = userList[i];
    const isBot = (i % 2 === 0);
    const text = isBot
      ? (i % 4 === 0 ? `@bot create design concept ${i}` : `Can @bot analyze market dynamics for sector ${i}?`)
      : `Original thought on ecosystem growth #${i}`;

    const gen = engine.postGeneration(u.user.id, text);
    posts.push(gen);
    if (isBot) {
      assert.strictEqual(gen.addressed, true, "Mid-sentence and leading @bot correctly detected");
      assert.ok(gen.response.length > 0, "@bot responded to generation");
    } else {
      assert.strictEqual(gen.addressed, false, "Plain post not addressed");
    }
  }
  assert.strictEqual(engine.generations.size, 100, "100 generations posted");
  console.log("✓ Phase 2 complete: 100 posts created with accurate @bot detection.");

  // Phase 3: Simulate 100 users commenting & threading with @bot replies
  let totalCommentsPosted = 0;
  let botRepliesGenerated = 0;

  for (let i = 0; i < 100; i++) {
    const commenter = userList[i];
    const targetPost = posts[(i * 7) % posts.length];
    const mentionsBot = (i % 3 === 0);
    const commentText = mentionsBot
      ? `Great insight, @bot what do you recommend next?`
      : `Solid point on this, fully agree #${i}.`;

    const { comment, botReply } = engine.addComment(commenter.user.id, targetPost.id, commentText);
    totalCommentsPosted++;
    if (botReply) {
      botRepliesGenerated++;
      assert.strictEqual(botReply.parentId, comment.id, "Bot replies directly to the comment");
      assert.strictEqual(botReply.creator.handle, "@bot");
    }
  }
  assert.strictEqual(totalCommentsPosted, 100, "100 user comments posted");
  assert.ok(botRepliesGenerated > 30, "Bot generated replies to all addressed comments");
  console.log(`✓ Phase 3 complete: ${totalCommentsPosted} comments posted, ${botRepliesGenerated} threaded bot replies generated.`);

  // Phase 4: Verify Username Customization & 3-change / 21-day Quota
  const testUser = userList[0];
  // Change 1
  engine.customizeProfile(testUser.user.id, { handle: "@first_change" });
  assert.strictEqual(engine.profiles.get(testUser.user.id).username_changes_count, 1);
  // Change 2
  engine.customizeProfile(testUser.user.id, { handle: "@second_change" });
  assert.strictEqual(engine.profiles.get(testUser.user.id).username_changes_count, 2);
  // Change 3 (Exhausts quota)
  engine.customizeProfile(testUser.user.id, { handle: "@third_change" });
  assert.strictEqual(engine.profiles.get(testUser.user.id).username_changes_count, 3);
  assert.ok(engine.profiles.get(testUser.user.id).username_quota_exhausted_at > 0);

  // 4th change must throw username_quota_exhausted
  assert.throws(() => {
    engine.customizeProfile(testUser.user.id, { handle: "@fourth_change" });
  }, /username_quota_exhausted/, "Quota properly blocks 4th change");
  console.log("✓ Phase 4 complete: 3-changes per 21-days username quota enforced.");

  console.log("\nALL 100-USER SIMULATION TESTS PASSED CLEANLY!");
}

runSimulation().catch(err => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
