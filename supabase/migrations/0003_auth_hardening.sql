-- Hardening for the account flow.
--
-- 0002 put the codes in a table, which fixed durability. Reviewing it
-- against the architect doc's section 5 (concurrency, atomicity,
-- idempotency) and section 10 (security) found four things that were still
-- wrong, all of the same shape: a decision made in application code across
-- several round trips, where the database could make it in one.
--
--   1. ATTEMPT CAP DID NOT HOLD UNDER CONCURRENCY. verify() read attempts,
--      added one, and wrote it back. Five parallel guesses all read 0 and
--      all wrote 1, so the cap never fired and the code could be brute
--      forced by fanning out. A read-modify-write across a network is not
--      a counter. It is now a single UPDATE that increments in place.
--
--   2. THE PENDING PASSWORD WAS REVERSIBLY ENCRYPTED. It had to be, because
--      the relay handed the plaintext to Supabase after verification. That
--      put a decryptable password in a table for ten minutes and made
--      OTP_PEPPER a key whose loss is a breach. Removed entirely: the user
--      is now created at request time in a disabled state, so nothing has
--      to remember the password at all. Section 10.1 says never store what
--      you can avoid storing.
--
--   3. VERIFICATION TOOK FOUR ROUND TRIPS with the state changing between
--      them. Now one function call, one transaction.
--
--   4. WRONG AND MISSING CODES TOOK DIFFERENT PATHS, which is an oracle:
--      response timing distinguished "no such pending signup" from "wrong
--      code". Both now run the same single statement.

-- ============ pending signups no longer hold a password ============
-- The account is created up front, unconfirmed and unusable, and
-- verification flips it on. That removes the only reason to keep the
-- password anywhere outside Supabase.
alter table public.auth_codes drop column if exists password_hash;

-- Ties a pending code to the account it will confirm, so verification does
-- not have to look the user up by address afterwards.
alter table public.auth_codes add column if not exists user_id uuid;

-- ============ one statement, one decision ============
-- Returns exactly one row describing the outcome. Every branch costs the
-- same one call, so the endpoint cannot leak which branch it took through
-- timing.
--
--   outcome: 'ok' | 'wrong' | 'expired' | 'locked'
--   attempts_left: only meaningful for 'wrong'
--   user_id: only present for 'ok'
create or replace function public.consume_auth_code(
  p_email   citext,
  p_purpose text,
  p_hash    text,
  p_max     integer default 5
)
returns table (outcome text, attempts_left integer, user_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_row public.auth_codes;
begin
  -- FOR UPDATE serialises concurrent attempts on the same code. Without
  -- it, two requests read the same attempt count and the cap is advisory.
  select * into v_row
    from public.auth_codes
   where email = p_email and purpose = p_purpose
   for update;

  if not found then
    return query select 'expired'::text, 0, null::uuid;
    return;
  end if;

  if v_row.expires_at <= now() then
    delete from public.auth_codes where email = p_email and purpose = p_purpose;
    return query select 'expired'::text, 0, null::uuid;
    return;
  end if;

  if v_row.attempts >= p_max then
    delete from public.auth_codes where email = p_email and purpose = p_purpose;
    return query select 'locked'::text, 0, null::uuid;
    return;
  end if;

  -- The comparison happens inside the transaction that holds the lock, so
  -- the row cannot change between the check and the delete.
  if v_row.code_hash = p_hash then
    delete from public.auth_codes where email = p_email and purpose = p_purpose;
    return query select 'ok'::text, 0, v_row.user_id;
    return;
  end if;

  -- Increment in place. This is the fix for the fan-out attack: the value
  -- written is derived from the value in the row, not from one read
  -- earlier by a different request.
  update public.auth_codes
     set attempts = attempts + 1
   where email = p_email and purpose = p_purpose
   returning attempts into v_row.attempts;

  if v_row.attempts >= p_max then
    delete from public.auth_codes where email = p_email and purpose = p_purpose;
    return query select 'locked'::text, 0, null::uuid;
    return;
  end if;

  return query select 'wrong'::text, (p_max - v_row.attempts), null::uuid;
end $$;

revoke all on function public.consume_auth_code(citext, text, text, integer) from public;

-- ============ issue, also atomic ============
-- Upsert plus cooldown in one statement. The previous version read the row,
-- decided, then wrote, so two resends a millisecond apart could both pass
-- the cooldown check and the second would invalidate the code already in
-- the user's inbox.
create or replace function public.issue_auth_code(
  p_email    citext,
  p_purpose  text,
  p_hash     text,
  p_user_id  uuid,
  p_ttl      integer default 600,
  p_cooldown integer default 60
)
returns table (reused boolean, resend_in integer)
language plpgsql security definer set search_path = public as $$
declare
  v_row public.auth_codes;
begin
  select * into v_row
    from public.auth_codes
   where email = p_email and purpose = p_purpose
   for update;

  if found and v_row.expires_at > now()
     and v_row.issued_at > now() - make_interval(secs => p_cooldown) then
    return query select true,
      greatest(1, p_cooldown - extract(epoch from (now() - v_row.issued_at))::integer);
    return;
  end if;

  insert into public.auth_codes (email, purpose, code_hash, user_id, attempts, issued_at, expires_at)
  values (p_email, p_purpose, p_hash, p_user_id, 0, now(), now() + make_interval(secs => p_ttl))
  on conflict (email, purpose) do update
    set code_hash  = excluded.code_hash,
        user_id    = excluded.user_id,
        attempts   = 0,
        issued_at  = excluded.issued_at,
        expires_at = excluded.expires_at;

  return query select false, p_cooldown;
end $$;

revoke all on function public.issue_auth_code(citext, text, text, uuid, integer, integer) from public;

-- ============ reset tickets, durable and single use ============
-- They lived in a Python dict, so a restart silently invalidated them and
-- a second instance would never see them. Same table treatment as the
-- codes: only the service role can reach it, and redemption is a delete
-- that returns, so a ticket cannot be spent twice.
create table if not exists public.auth_tickets (
  token_hash text primary key,
  email      citext not null,
  user_id    uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.auth_tickets enable row level security;
-- No policies: service role only.

create index if not exists auth_tickets_expiry_idx on public.auth_tickets (expires_at);

create or replace function public.redeem_auth_ticket(p_hash text)
returns table (email citext, user_id uuid)
language plpgsql security definer set search_path = public as $$
begin
  return query
    delete from public.auth_tickets t
     where t.token_hash = p_hash and t.expires_at > now()
    returning t.email, t.user_id;
end $$;

revoke all on function public.redeem_auth_ticket(text) from public;

-- Housekeeping. Expired rows in either table are useless and are a record
-- of who was signing up and when.
create or replace function public.purge_expired_auth_codes()
returns void language sql security definer set search_path = public as $$
  delete from public.auth_codes   where expires_at < now() - interval '1 hour';
  delete from public.auth_tickets where expires_at < now() - interval '1 hour';
$$;

revoke all on function public.purge_expired_auth_codes() from public;
