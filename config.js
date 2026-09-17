/* Deployment configuration. Values here are safe to commit: the Supabase
   anon key is a public identifier gated by Row Level Security, not a
   secret. Access stays "open" (full local demo, no backend) until the
   Supabase project is wired; then flip ACCESS_MODE to "enforce". */
window.BotoConfig = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  /* Where the relay lives. One-time codes are issued and checked there,
     because the mail credential must never reach a browser. Empty means
     the app falls back to the relay address in Workspace settings, which
     is what local development uses. */
  RELAY_URL: "https://impose-relay.onrender.com",

  /* "open": Community and Workspace both available (development/demo).
     "enforce": Community open to everyone, Workspace behind the
     waitlist grant (production). */
  ACCESS_MODE: "open"
};
