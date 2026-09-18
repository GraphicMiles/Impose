/* Deployment configuration. Values here are safe to commit: the Supabase
   anon key is a public identifier gated by Row Level Security, not a
   secret. Access stays "open" (full local demo, no backend) until the
   Supabase project is wired; then flip ACCESS_MODE to "enforce". */
window.BotoConfig = {
  SUPABASE_URL: "https://xgqcvuzkeaferjsnpjjw.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ErA2UAjkG2Wfw_T63dtbkA_sCe8wFp8",

  /* Where the relay lives. One-time codes are issued and checked there,
     because the mail credential must never reach a browser. Empty means
     the app falls back to the relay address in Workspace settings, which
     is what local development uses. */
  RELAY_URL: "https://impose-relay.onrender.com",

  /* "open": Community and Workspace both available (development/demo).
     "enforce": Community open to everyone, Workspace behind the
     waitlist grant (production).

     Flipped to enforce on 2026-09-18 (PLAN_V2_AUDIT TASK-00): the live
     project is wired (auth, grants RPC, waitlist), and the owner's
     intent from the v1.0 plan is "Community open now, Workspace
     waitlist-only." The owner account is granted directly in
     workspace_grants, so this lock-out is intentional. */
  ACCESS_MODE: "enforce"
};
