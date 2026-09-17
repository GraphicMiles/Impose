-- Server-side email verification.
--
-- The first cut of this flow was theatre. The browser called
-- supabase.auth.signUp() directly, Supabase returned a session
-- immediately, and only then did the page ask the relay for a code. The
-- verify endpoint answered {"ok": true} to the same browser that asked and
-- nothing consumed the answer, so an attacker skipped the code entirely and
-- still held a confirmed, authenticated account. Proven against the live
-- project before this migration was written.
--
-- The fix moves the decision to the server. Public signup is disabled in
-- the dashboard, the relay holds the service role key, and the only path to
-- an account runs through code verification inside the relay. This table is
-- where that code lives.
--
-- Only the service role reaches it. There is deliberately no policy for
-- anon or authenticated: RLS is on and no policy exists, so PostgREST
-- returns nothing to a browser even if the table name is guessed.

create table public.auth_codes (
  -- One live code per address per purpose. The primary key enforces that,
  -- so a resend replaces rather than accumulates and there is never a
  -- question of which of two codes is the real one.
  email       citext not null,
  purpose     text   not null check (purpose in ('signup','reset')),

  -- sha256(code + pepper). A dump of this table does not let the reader
  -- sign in as anybody, and the pepper lives only in the relay's
  -- environment so the database alone is not enough to brute force it.
  code_hash   text   not null,

  -- The pending account. Held here rather than in relay memory because
  -- Render's free tier sleeps: a restart mid-signup would otherwise strand
  -- someone holding a code for an account that no longer exists anywhere.
  -- Hashed by the relay with the same algorithm Supabase uses, never
  -- plaintext.
  password_hash text,

  attempts    integer not null default 0,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,

  primary key (email, purpose)
);

create index auth_codes_expiry_idx on public.auth_codes (expires_at);

alter table public.auth_codes enable row level security;
-- No policies. The service role bypasses RLS; everyone else sees nothing.

-- Expired rows are useless and are evidence of who signed up and when, so
-- they do not linger. Called by the relay on each issue, which is often
-- enough at this volume and avoids adding a scheduler for one statement.
create or replace function public.purge_expired_auth_codes()
returns void language sql security definer set search_path = public as $$
  delete from public.auth_codes where expires_at < now() - interval '1 hour';
$$;

revoke all on function public.purge_expired_auth_codes() from public;
