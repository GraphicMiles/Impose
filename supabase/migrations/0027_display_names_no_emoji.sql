-- ============================================================
-- 0027 — profile display names are prose, not sticker sheets
-- ------------------------------------------------------------
-- Post and comment headers reserve a fixed place for the author name:
-- it truncates instead of wrapping. Truncation keeps the layout, but a
-- name made of emoji still buys nothing the reader can type, search, or
-- say aloud. The client rejects emoji at both edit points (profile modal
-- and workspace identity) with a message; this migration is the server's
-- word on it, so a direct API writer gets the same rule.
--
-- Two layers, same as the rest of the name contract:
--
-- 1. sanitize_display_name strips the pictographic blocks the way it
--    already strips control and bidi characters. Every write path runs
--    through it (customize_profile, the signup personalizers), so one
--    function edit covers them all. Stripping is honest here: a name
--    that is *only* emoji empties out and hits the existing
--    name_too_short / name_needs_letter_or_digit checks downstream.
--
-- 2. A NOT VALID column constraint pins the rule on profiles so no
--    future write path can sneak an emoji in. NOT VALID because existing
--    rows are user data: grandfathered until someone chooses to
--    reclassify and rewrite them deliberately, never silently inside a
--    schema migration. New inserts and updates are checked immediately.
-- ============================================================

create or replace function public.sanitize_display_name(p_name text)
returns text
language sql immutable set search_path = public as $$
  select left(
    regexp_replace(
      regexp_replace(
        coalesce(p_name, ''),
        -- control chars, zero-width and bidi marks (the 0013 set), plus the
        -- emoji blocks: misc symbols and dingbats (2600-27BF covers the
        -- heavy heart and the check marks), stars/arrows (2B00-2BFF), the
        -- whole first supplementary plane range emoji live in
        -- (1F000-1FAFF), the variation selector, and the keycap combiner.
        '[\u0001-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\ufe0f\u20e3]', '', 'g'),
      '\s+', ' ', 'g'),
    40);
$$;

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so the guard is explicit.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'profiles_display_name_no_emoji') then
    alter table public.profiles
      add constraint profiles_display_name_no_emoji
      check (display_name !~ '[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\ufe0f\u20e3]')
      not valid;
  end if;
end $$;
