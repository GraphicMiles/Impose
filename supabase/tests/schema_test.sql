-- Schema behaviour tests. Run against a scratch Postgres with the Supabase
-- stubs loaded (see supabase/tests/run.sh), not against a real project.
--
-- These assert the properties the application depends on, and the ones an
-- attacker would try to break. Every check raises on failure, so the script
-- exits non-zero the moment something regresses.

\set ON_ERROR_STOP on

create or replace function test_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  if cond then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  %', label;
  end if;
end $$;

-- A helper that asserts an expression is rejected by the database.
create or replace function test_denied(label text, stmt text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'PASS  % (%).', label, split_part(sqlerrm, E'\n', 1);
    return;
  end;
  raise exception 'FAIL  % : the statement was allowed', label;
end $$;

/* 0024 gave destructive admin RPCs a step-up: admin_remove,
   admin_revoke_cap and delete_my_account refuse any session that cannot
   prove it was minted recently (require_recent_auth reads
   request.jwt.claims.iat, the stand-in only ever sets .sub). A signed-in
   harness mints the claim pair fresh for the block the way a real OTP
   sign-in would. Without this the step-up either blocks the suite's own
   admin work, or worse, the denial it raises passes a test_denied that
   was written to prove a different check. */
create or replace function test_fresh_claims(p_sub uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'iat', extract(epoch from now())::bigint)::text,
    false);
end $$;

-- ---------------------------------------------------------------- setup
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.com'),
  ('33333333-3333-3333-3333-333333333333', 'alice@other.com');

/* Since 0023, save_workspace answers workspace_not_granted unless a grant
   row exists. Production grants through the admin RPCs; the harness seeds
   the two accounts the workspace section writes as, so the section keeps
   testing the blob semantics. The gate itself is asserted separately. */
insert into public.workspace_grants (user_id, granted_by, note) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-4000-8000-0000000000aa', 'harness: workspace section user');

/* The replay of production history seeds the canonical owner (0022), so
   the suite counts the rows the trigger made for ITS users, never global
   totals: a global count would break for any history that seeds a row. */
select test_ok('profiles are created for new users',
  (select count(*) from public.profiles
    where id in ('11111111-1111-1111-1111-111111111111',
                 '22222222-2222-2222-2222-222222222222',
                 '33333333-3333-3333-3333-333333333333')) = 3);

select test_ok('handles are generated, never null',
  (select count(*) from public.profiles
    where id in ('11111111-1111-1111-1111-111111111111',
                 '22222222-2222-2222-2222-222222222222',
                 '33333333-3333-3333-3333-333333333333')
      and handle is null) = 0);

select test_ok('colliding handles get a suffix rather than failing signup',
  (select count(distinct handle) from public.profiles
    where id in ('11111111-1111-1111-1111-111111111111',
                 '22222222-2222-2222-2222-222222222222',
                 '33333333-3333-3333-3333-333333333333')) = 3);

-- ------------------------------------------------------- generations
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

-- A post that does not address @bot never gets a response. The original
-- schema required one and would have rejected every plain post.
insert into public.generations (id, author_id, prompt, response, addressed, status)
values ('a0000000-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'plain post', '', false, 'complete');
select test_ok('a plain post with an empty response is accepted', true);

insert into public.generations (id, author_id, prompt, response, addressed, status)
values ('a0000000-0000-0000-0000-000000000002',
        '11111111-1111-1111-1111-111111111111', 'streaming post', '', true, 'streaming');
select test_ok('a streaming post starts empty and is accepted', true);

select test_ok('an original post is its own lineage root',
  (select root_id from public.generations where id = 'a0000000-0000-0000-0000-000000000001')
    = 'a0000000-0000-0000-0000-000000000001');

insert into public.generations (id, author_id, prompt, response, locked)
values ('a0000000-0000-0000-0000-000000000003',
        '11111111-1111-1111-1111-111111111111', 'locked post', 'body', true);
insert into public.generations (id, author_id, prompt, response, visibility)
values ('a0000000-0000-0000-0000-000000000004',
        '11111111-1111-1111-1111-111111111111', 'private post', 'body', 'private');

-- ------------------------------------------------- as a different user
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');

select test_ok('a private post is invisible to everyone else',
  (select count(*) from public.generations
    where id = 'a0000000-0000-0000-0000-000000000004') = 0);

select test_denied('posting as another user is refused', $$
  insert into public.generations (author_id, prompt, response)
  values ('11111111-1111-1111-1111-111111111111', 'forged', 'x')$$);

select test_denied('remixing a locked post is refused', $$
  insert into public.generations (author_id, prompt, response, kind, remix_of)
  values ('22222222-2222-2222-2222-222222222222', 'steal', 'x', 'remix',
          'a0000000-0000-0000-0000-000000000003')$$);

select test_denied('remixing a post you cannot see is refused', $$
  insert into public.generations (author_id, prompt, response, kind, remix_of)
  values ('22222222-2222-2222-2222-222222222222', 'peek', 'x', 'remix',
          'a0000000-0000-0000-0000-000000000004')$$);

select test_denied('an original may not carry a lineage parent', $$
  insert into public.generations (author_id, prompt, response, kind, remix_of)
  values ('22222222-2222-2222-2222-222222222222', 'bad', 'x', 'original',
          'a0000000-0000-0000-0000-000000000001')$$);

select test_denied('a remix must carry a lineage parent', $$
  insert into public.generations (author_id, prompt, response, kind)
  values ('22222222-2222-2222-2222-222222222222', 'bad', 'x', 'remix')$$);

-- The legitimate case has to work. This is the one that a bare `remix_of`
-- in the policy silently broke: the subquery compared a row to itself.
insert into public.generations (id, author_id, prompt, response, kind, remix_of)
values ('b0000000-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'fair remix', 'x', 'remix',
        'a0000000-0000-0000-0000-000000000001');
select test_ok('remixing an open post is allowed', true);

select test_ok('a remix inherits its parent lineage root',
  (select root_id from public.generations where id = 'b0000000-0000-0000-0000-000000000001')
    = 'a0000000-0000-0000-0000-000000000001');

insert into public.generations (id, author_id, prompt, response, kind, remix_of)
values ('b0000000-0000-0000-0000-000000000002',
        '22222222-2222-2222-2222-222222222222', 'fair challenge', 'x', 'challenge',
        'a0000000-0000-0000-0000-000000000001');

select test_ok('remix and challenge are counted separately',
  (select remix_count = 1 and challenge_count = 1 from public.generations
    where id = 'a0000000-0000-0000-0000-000000000001'));

-- ------------------------------------------------------------ comments
insert into public.comments (id, generation_id, author_id, body)
values ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'top level');
insert into public.comments (id, generation_id, author_id, parent_id, body)
values ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'c0000000-0000-0000-0000-000000000001', 'a reply');

select test_ok('comment count tracks live comments',
  (select comment_count from public.generations
    where id = 'a0000000-0000-0000-0000-000000000001') = 2);

select test_denied('an empty comment is refused', $$
  insert into public.comments (generation_id, author_id, body)
  values ('a0000000-0000-0000-0000-000000000001',
          '22222222-2222-2222-2222-222222222222', '   ')$$);

select test_denied('a reply cannot be grafted onto another post''s thread', $$
  insert into public.comments (generation_id, author_id, parent_id, body)
  values ('a0000000-0000-0000-0000-000000000002',
          '22222222-2222-2222-2222-222222222222',
          'c0000000-0000-0000-0000-000000000001', 'wrong thread')$$);

select test_denied('commenting as another user is refused', $$
  insert into public.comments (generation_id, author_id, body)
  values ('a0000000-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111', 'forged')$$);

-- -------------------------------------------------- soft delete + undo
select public.soft_delete_comment('c0000000-0000-0000-0000-000000000001');

select test_ok('a soft deleted comment keeps its row so replies survive',
  (select count(*) from public.comments
    where id = 'c0000000-0000-0000-0000-000000000001') = 1);

select test_ok('the reply outlives the comment it answered',
  (select count(*) from public.comments
    where id = 'c0000000-0000-0000-0000-000000000002' and parent_id is not null) = 1);

select test_ok('the deleted body is actually gone, not just hidden',
  (select body from public.comments
    where id = 'c0000000-0000-0000-0000-000000000001') = '');

-- The original trigger only fired on hard DELETE, so a soft deleted
-- comment stayed counted forever and the chip drifted from the thread.
select test_ok('soft delete decrements the count',
  (select comment_count from public.generations
    where id = 'a0000000-0000-0000-0000-000000000001') = 1);

select public.restore_comment('c0000000-0000-0000-0000-000000000001', 'top level');
select test_ok('undo restores the comment and its count',
  (select comment_count from public.generations
    where id = 'a0000000-0000-0000-0000-000000000001') = 2);

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_denied('deleting someone else''s comment is refused', $$
  select public.soft_delete_comment('c0000000-0000-0000-0000-000000000001')$$);

-- Community bookmarks were removed in migration 0021.
-- ------------------------------------------------------------ waitlist
reset role;
-- Called twice on purpose: a retry or a double tap must not create a
-- second row or move the person down the queue. The domain must not be
-- one the disposable list refuses: test.com is on it, deliberately.
select public.join_waitlist('someone@company.com');
select public.join_waitlist('someone@company.com');
select test_ok('the waitlist RPC is idempotent',
  (select count(*) from public.waitlist where email = 'someone@company.com') = 1);

select test_ok('waitlist addresses are case insensitive',
  (select count(*) from (select public.join_waitlist('SOMEONE@Company.com')) x) = 1
  and (select count(*) from public.waitlist where email = 'someone@company.com') = 1);

select test_denied('the waitlist RPC validates the address server side', $$
  select public.join_waitlist('not-an-email')$$);

-- 0019: the queue actually numbers people. Positions are assigned at
-- join, sequential, and stable across the idempotent re-join.
select test_ok('joining assigns a real queue position',
  (select position from public.waitlist where email = 'someone@company.com') = 1);
select public.join_waitlist('second@company.com');
select test_ok('the next joiner stands behind the first',
  (select position from public.waitlist where email = 'second@company.com') = 2);
/* Positions are still assigned and stored; the API stopped disclosing
   them in 0023 (anti-enumeration): every caller hears the same
   null-position 'received', so the assertions look at the table, and at
   what the RPC deliberately refuses to say. A re-join must not move the
   stored row. */
select public.join_waitlist('someone@company.com');
select test_ok('re-joining keeps the same place in line',
  (select position from public.waitlist where email = 'someone@company.com') = 1);
select public.join_waitlist('third@company.com');
select test_ok('the third joiner stands behind the second',
  (select position from public.waitlist where email = 'third@company.com') = 3);
select test_ok('the join RPC discloses neither position nor membership',
  (select w.waitlist_position is null and w.status = 'received'
     from public.join_waitlist('someone@company.com') w));


-- ============ auth hardening (0003) ============
-- The attempt cap used to be enforced by reading the count, adding one and
-- writing it back. Measured against real Postgres, ten concurrent wrong
-- guesses recorded as one attempt and the code stayed live. These pin the
-- single-statement replacement.

reset role;

select public.issue_auth_code('cap@test.com', 'signup', 'GOODHASH', null, 600, 60);

select test_ok('a wrong code is counted, not ignored',
  (select outcome from public.consume_auth_code('cap@test.com','signup','BADHASH')) = 'wrong');

select test_ok('the remaining attempts are reported',
  (select attempts_left from public.consume_auth_code('cap@test.com','signup','BADHASH')) = 3);

-- Burn the rest of the budget.
select public.consume_auth_code('cap@test.com','signup','BADHASH');
select public.consume_auth_code('cap@test.com','signup','BADHASH');

select test_ok('the fifth wrong guess locks the code',
  (select outcome from public.consume_auth_code('cap@test.com','signup','BADHASH')) = 'locked');

select test_ok('a locked code is destroyed, so the real value is dead too',
  (select outcome from public.consume_auth_code('cap@test.com','signup','GOODHASH')) = 'expired');

-- The correct code, on a fresh issue, consumes in one shot.
select public.issue_auth_code('good@test.com', 'signup', 'GOODHASH',
  '11111111-1111-1111-1111-111111111111', 600, 60);

select test_ok('the right code returns the staged user',
  (select user_id from public.consume_auth_code('good@test.com','signup','GOODHASH'))
    = '11111111-1111-1111-1111-111111111111');

select test_ok('and consuming it removes the row, so it cannot be replayed',
  (select outcome from public.consume_auth_code('good@test.com','signup','GOODHASH')) = 'expired');

-- Cooldown is decided in the same statement that writes, so two resends
-- cannot both believe they are the first.
select public.issue_auth_code('cool@test.com','signup','H1',null,600,60);
select test_ok('a resend inside the cooldown reuses the live code',
  (select reused from public.issue_auth_code('cool@test.com','signup','H2',null,600,60)) = true);
select test_ok('and the original code still works, not the rival',
  (select outcome from public.consume_auth_code('cool@test.com','signup','H1')) = 'ok');

-- Tickets.
insert into public.auth_tickets (token_hash, email, user_id, expires_at)
values ('THASH', 'r@test.com', '11111111-1111-1111-1111-111111111111', now() + interval '10 minutes');

select test_ok('a ticket redeems once',
  (select count(*) from (select public.redeem_auth_ticket('THASH')) x) = 1);
select test_ok('and cannot be redeemed twice',
  (select count(*) from public.redeem_auth_ticket('THASH')) = 0);

insert into public.auth_tickets (token_hash, email, expires_at)
values ('EXPIRED', 'r@test.com', now() - interval '1 minute');
select test_ok('an expired ticket is refused',
  (select count(*) from public.redeem_auth_ticket('EXPIRED')) = 0);

-- The codes table must be unreachable from the browser roles.
set role anon;
select test_denied('anon cannot read pending codes', $$select * from public.auth_codes$$);
select test_denied('anon cannot read reset tickets', $$select * from public.auth_tickets$$);
reset role;

-- ============ canonical db (0004) ============

reset role;
insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'cara@test.com');

set role authenticated;
set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
select test_fresh_claims('66666666-6666-6666-6666-666666666666');

-- Idempotency. The same key replayed must not produce a second post.
select test_ok('a post is created through the RPC',
  (select id from public.create_generation(
     'aaaaaaaa-1111-1111-1111-111111111111','hello','world',false,
     'complete','public','original',null)) is not null);

select test_ok('replaying the key returns the same row, not a new one',
  (select count(*) from public.generations where prompt = 'hello') = 1);

select public.create_generation('aaaaaaaa-1111-1111-1111-111111111111',
  'hello','world',false,'complete','public','original',null);

select test_ok('and still only one after the replay',
  (select count(*) from public.generations where prompt = 'hello') = 1);

select test_denied('the same key with a different body is refused', $$
  select public.create_generation('aaaaaaaa-1111-1111-1111-111111111111',
    'DIFFERENT','world',false,'complete','public','original',null)$$);

-- Counts stay derived. The client cannot send one.
select test_ok('a new post starts with zero derived counts',
  (select comment_count = 0 from public.generations
    where prompt = 'hello'));

-- Comment RPC, and the reply-target rule enforced server side.
select test_ok('a comment is created through the RPC',
  (select id from public.create_comment('bbbbbbbb-1111-1111-1111-111111111111',
     (select id from public.generations where prompt='hello'), 'first')) is not null);

select test_ok('the trigger counted it',
  (select comment_count from public.generations where prompt='hello') = 1);

select test_denied('a reply to a comment on another post is refused', $$
  select public.create_comment('bbbbbbbb-2222-2222-2222-222222222222',
    (select id from public.generations where prompt='hello'), 'orphan',
    'cccccccc-9999-9999-9999-999999999999')$$);

-- updated_at moves on write, so a stale client can be detected.
select test_ok('updated_at is set on insert',
  (select updated_at is not null from public.generations where prompt='hello'));

-- Keyset pagination. Insert enough to page, then walk it.
insert into public.generations (author_id, prompt, response, created_at)
select '66666666-6666-6666-6666-666666666666', 'p' || i, 'body',
       now() - (i || ' minutes')::interval
  from generate_series(1, 12) i;

select test_ok('a feed page is capped at the requested size',
  (select count(*) from public.feed_page(null, null, 5)) = 5);

select test_ok('the page carries the author handle, no second query needed',
  (select handle from public.feed_page(null, null, 1) limit 1) is not null);

-- Walking the cursor must not repeat or skip.
create temp table walked as
  select id from public.feed_page(null, null, 5);
insert into walked
  select f.id from public.feed_page(
    (select created_at from public.generations g
      join walked w on w.id = g.id order by g.created_at asc limit 1),
    (select w.id from walked w join public.generations g on g.id = w.id
      order by g.created_at asc limit 1), 5) f;

select test_ok('paging twice returns no duplicate rows',
  (select count(*) = count(distinct id) from walked));

select test_ok('the limit is capped server side, not by the caller',
  (select count(*) from public.feed_page(null, null, 9999)) <= 50);

-- Polling counts other people's posts only: your own arriving is not news.
-- Measured as a difference rather than an absolute, because earlier tests
-- in this file have already put rows in any recent window. Asserting "= 1"
-- was asserting an empty database, which is a property of the suite and
-- not of the function.
create temp table probe_mark as select now() as at;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
create temp table probe_before as
  select public.feed_since((select at from probe_mark)) as n;

-- Ada posts one thing.
insert into public.generations (author_id, prompt, response)
values ('11111111-1111-1111-1111-111111111111', 'from-ada', 'x');

select test_ok('your own new post does not raise your own counter',
  public.feed_since((select at from probe_mark)) = (select n from probe_before));

set request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
select test_fresh_claims('66666666-6666-6666-6666-666666666666');
select test_ok('but another reader is told about it',
  public.feed_since((select at from probe_mark)) > 0);

-- Soft-deleted posts leave the feed.
update public.generations set deleted_at = now() where prompt = 'p1';
select test_ok('a deleted post is not in the feed',
  (select count(*) from public.feed_page(null, null, 50) where prompt = 'p1') = 0);

-- Rate limiting, shared and atomic.
reset role;
select test_ok('the rate limiter allows traffic under the limit',
  public.rate_hit('t:ip', 3, 60) = false);
select public.rate_hit('t:ip', 3, 60);
select public.rate_hit('t:ip', 3, 60);
select test_ok('and reports over the limit once it is exceeded',
  public.rate_hit('t:ip', 3, 60) = true);

set role anon;
select test_denied('anon cannot read the rate counters', $$select * from public.rate_counters$$);
select test_denied('anon cannot read idempotency keys of others', $$
  insert into public.idempotency_keys (key, user_id, request_hash)
  values (gen_random_uuid(), '66666666-6666-6666-6666-666666666666', 'x')$$);
reset role;

-- ============ the relay's own grants (0008) ============
-- These run as service_role, not as the owner. An owner is not subject to
-- its own EXECUTE grants, so testing as the owner proved nothing: signup
-- answered 502 in production with "permission denied for function
-- issue_auth_code" while every assertion here was green.

reset role;
set role service_role;

select test_ok('the relay can issue a code',
  (select reused from public.issue_auth_code('grant@test.com','signup','H1',null,600,60)) = false);

select test_ok('the relay can consume a code',
  (select outcome from public.consume_auth_code('grant@test.com','signup','H1')) = 'ok');

select test_ok('the relay can redeem a ticket',
  (select count(*) from public.redeem_auth_ticket('nothing-here')) = 0);

select test_ok('the relay can check a rate limit',
  public.rate_hit('grant:probe', 5, 60) = false);

select test_ok('and it can write the tables those functions own',
  (select count(*) from public.auth_codes) >= 0);

-- The browser roles must still be refused. A grant that fixed the relay
-- and opened these to anon would be a worse bug than the one it fixed.
reset role;
set role anon;
select test_denied('anon cannot issue codes', $$
  select public.issue_auth_code('x@test.com','signup','H',null,600,60)$$);
select test_denied('anon cannot consume codes', $$
  select public.consume_auth_code('x@test.com','signup','H')$$);
select test_denied('anon cannot redeem tickets', $$
  select public.redeem_auth_ticket('H')$$);
select test_denied('anon cannot touch the rate limiter', $$
  select public.rate_hit('x', 1, 60)$$);

set role authenticated;
select test_denied('a signed-in user cannot issue codes either', $$
  select public.issue_auth_code('x@test.com','signup','H',null,600,60)$$);
select test_denied('nor consume them', $$
  select public.consume_auth_code('x@test.com','signup','H')$$);
reset role;

-- ============ realtime publication (0009) ============
-- Publishing the wrong table streams privileged rows to every connected
-- browser. This is the assertion that makes that a build failure rather
-- than a discovery.

reset role;

select test_ok('the feed and threads are published',
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename in ('generations','comments')) = 2);

select test_ok('and nothing privileged is',
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename in ('auth_codes','auth_tickets','rate_counters',
                        'idempotency_keys','waitlist','workspace_grants')) = 0);

-- Without FULL, an UPDATE or DELETE payload carries only the primary key,
-- so RLS cannot evaluate visibility and the row is either dropped or
-- leaked depending on the path.
select test_ok('published tables carry enough of the row for RLS to filter it',
  (select count(*) from pg_class
    where relname in ('generations','comments') and relreplident = 'f') = 2);

-- ============ lock enforced in the RPC, not only the policy (0012) ============
-- The lock rules were written into the INSERT policy in 0001 and were
-- correct there. 0004 moved writes to create_generation, which is SECURITY
-- DEFINER and therefore not subject to RLS, so the policy silently stopped
-- being consulted. A locked post could be remixed by anyone. The old
-- assertions passed throughout because they inserted directly into the
-- table, testing a path the product no longer uses.

reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

insert into public.generations (id, author_id, prompt, response, locked)
values ('cccccccc-0000-0000-0000-00000000000a',
        '11111111-1111-1111-1111-111111111111', 'locked parent', 'x', true);
insert into public.generations (id, author_id, prompt, response)
values ('cccccccc-0000-0000-0000-00000000000b',
        '11111111-1111-1111-1111-111111111111', 'open parent', 'x');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');

select test_denied('the RPC refuses a remix of a locked post', $$
  select public.create_generation(gen_random_uuid(), 'steal', 'x', false, 'complete',
    'public', 'remix', 'cccccccc-0000-0000-0000-00000000000a')$$);

select test_ok('but allows one on an open post',
  (select id from public.create_generation(gen_random_uuid(), 'fair', 'x', false,
    'complete', 'public', 'remix', 'cccccccc-0000-0000-0000-00000000000b')) is not null);

select test_denied('an original may not carry a parent, through the RPC', $$
  select public.create_generation(gen_random_uuid(), 'bad', 'x', false, 'complete',
    'public', 'original', 'cccccccc-0000-0000-0000-00000000000b')$$);

select test_denied('a remix must carry a parent, through the RPC', $$
  select public.create_generation(gen_random_uuid(), 'bad', 'x', false, 'complete',
    'public', 'remix', null)$$);

-- The author locked it against others, not against themselves.
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_ok('the author can still build on their own locked post',
  (select id from public.create_generation(gen_random_uuid(), 'mine', 'x', false,
    'complete', 'public', 'remix', 'cccccccc-0000-0000-0000-00000000000a')) is not null);
reset role;

-- ============ adversarial hardening (0013) ============
-- Confirmed against the live project before this migration existed: anon
-- and authenticated held TRUNCATE on almost every table (which does not
-- consult RLS), update_my_profile accepted any string of any length, and
-- join_waitlist validated shape only. These pin the fixes.

reset role;

-- ---------------------------------------------------------- privileges
select test_ok('anon cannot truncate any table',
  (select count(*) from (values ('auth_codes'),('auth_tickets'),('comments'),
     ('generations'),('idempotency_keys'),('notifications'),('profiles'),
     ('rate_counters'),('waitlist'),('workspace_grants')) as t(name)
   where has_table_privilege('anon', 'public.' || t.name, 'TRUNCATE')) = 0);

select test_ok('authenticated cannot truncate any table either',
  (select count(*) from (values ('auth_codes'),('auth_tickets'),('comments'),
     ('generations'),('idempotency_keys'),('notifications'),('profiles'),
     ('rate_counters'),('waitlist'),('workspace_grants')) as t(name)
   where has_table_privilege('authenticated', 'public.' || t.name, 'TRUNCATE')) = 0);

select test_ok('no trigger or references privileges survive on anon',
  (select count(*) from (values ('auth_codes'),('auth_tickets'),('comments'),
     ('generations'),('idempotency_keys'),('profiles'),
     ('waitlist'),('workspace_grants')) as t(name)
   where has_table_privilege('anon', 'public.' || t.name, 'TRIGGER')
      or has_table_privilege('anon', 'public.' || t.name, 'REFERENCES')) = 0);

-- The intended grants must survive the sweep: public reads and the
-- column-limited writes.
select test_ok('public reads still work for anon',
  has_table_privilege('anon', 'public.profiles', 'SELECT')
  and has_table_privilege('anon', 'public.generations', 'SELECT')
  and has_table_privilege('anon', 'public.comments', 'SELECT'));

select test_ok('the lock/visibility/delete columns stay writable by authors',
  has_column_privilege('authenticated', 'public.generations', 'locked', 'UPDATE')
  and has_column_privilege('authenticated', 'public.generations', 'visibility', 'UPDATE')
  and has_column_privilege('authenticated', 'public.generations', 'deleted_at', 'UPDATE'));

-- ------------------------------------------------------ spammy shapes
select test_ok('text_is_spammy flags the reported shapes',
  public.text_is_spammy('skskdjdjdjdh')
  and public.text_is_spammy('18w8e7shshsysysy')
  and public.text_is_spammy('aaaaa')
  and public.text_is_spammy('abcabcabc')
  and public.text_is_spammy('brktwzx'));

select test_ok('text_is_spammy passes ordinary names and addresses',
  not public.text_is_spammy('Ada Lovelace')
  and not public.text_is_spammy('mike.jones')
  and not public.text_is_spammy('mississippi')
  and not public.text_is_spammy('bookkeeper')
  and not public.text_is_spammy('08031234567'));

-- --------------------------------------------------------- profile rules
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

select public.update_my_profile('Alice A.', 'hello');
select test_ok('an ordinary name and bio are kept',
  (select display_name = 'Alice A.' and bio = 'hello'
     from public.profiles where id = '11111111-1111-1111-1111-111111111111'));

select test_denied('a keyboard-mash name is refused', $$
  select public.update_my_profile('skskdjdjdjdh', null)$$);

select test_denied('a repeated-block name is refused', $$
  select public.update_my_profile('18w8e7shshsysysy', null)$$);

select test_denied('one letter nine times is refused', $$
  select public.update_my_profile('aaaaaaaaa', null)$$);

select test_denied('a 44-character name is refused', $$
  select public.update_my_profile(repeat('abcd', 11), null)$$);

select test_denied('a symbol-only name is refused', $$
  select public.update_my_profile('!!!!', null)$$);

select test_denied('a one-character name is refused', $$
  select public.update_my_profile('A', null)$$);

select test_denied('a control character in the name is refused', $$
  select public.update_my_profile(E'bad\u0007name', null)$$);

select test_denied('an over-long bio is refused', $$
  select public.update_my_profile(null, repeat('x', 301))$$);

-- Zero-width marks are how one name impersonates another; they are
-- stripped, not stored. (A null bio clears the bio by design, so these
-- pass the bio explicitly.)
select public.update_my_profile(E'A\u200blic\u2060e', 'hello');
select test_ok('zero-width characters are stripped from names',
  (select display_name from public.profiles
    where id = '11111111-1111-1111-1111-111111111111') = 'Alice');

-- Blank keeps the current name rather than erroring.
select public.update_my_profile('   ', 'hello');
select test_ok('a blank name keeps the current one',
  (select display_name from public.profiles
    where id = '11111111-1111-1111-1111-111111111111') = 'Alice');

-- The rejected attempts above must not have touched the row.
select test_ok('refused names changed nothing',
  (select display_name = 'Alice' and bio = 'hello'
     from public.profiles where id = '11111111-1111-1111-1111-111111111111'));

-- No direct write path exists around the RPC.
select test_denied('profiles cannot be written directly', $$
  update public.profiles set display_name = 'forged'
   where id = '11111111-1111-1111-1111-111111111111'$$);

-- ------------------------------------------- signup-derived display names
reset role;
insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444',
   'a.really.long.local.part.over.forty.characters@realmail.com');
select test_ok('signup-derived names are capped at 40 characters',
  (select char_length(display_name) <= 40 from public.profiles
    where id = '44444444-4444-4444-4444-444444444444'));

-- ---------------------------------------------------------- waitlist
select test_denied('disposable domains are refused at the waitlist', $$
  select public.join_waitlist('x@mailinator.com')$$);

select test_denied('keyboard-mash local parts are refused at the waitlist', $$
  select public.join_waitlist('skskdjdjdjdh@gmail.com')$$);

select test_denied('over-long addresses are refused at the waitlist', $$
  select public.join_waitlist(repeat('b', 250) || '@x.com')$$);

select public.join_waitlist('fresh.person@gmail.com');
select test_ok('an ordinary address still joins',
  (select status from public.waitlist where email = 'fresh.person@gmail.com') = 'pending');

-- --------------------------------------------------- write-size guards
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');

select test_denied('the RPC names an oversized prompt', $$
  select public.create_generation(gen_random_uuid(), repeat('x', 4001), 'r')$$);

select test_denied('the RPC names an empty prompt', $$
  select public.create_generation(gen_random_uuid(), '   ', 'r')$$);

select test_denied('the RPC names an oversized comment', $$
  select public.create_comment(gen_random_uuid(),
    'a0000000-0000-0000-0000-000000000001', repeat('x', 1001))$$);

reset role;

-- ============ write rate limits (0014) ============
-- The budgets are fixed one-minute windows. Force the suite into a fresh
-- window so nothing an earlier section wrote counts against them: the
-- assertions below name exact counts, and a boundary in the middle of the
-- section would reset the counters underfoot.
do $$
begin
  perform pg_sleep(60 - (extract(epoch from now())::bigint % 60) + 1);
end $$;

reset role;

select test_ok('rate_hit counts inside one statement',
  not public.rate_hit('unit:test', 2, 60)
  and not public.rate_hit('unit:test', 2, 60)
  and public.rate_hit('unit:test', 2, 60));

-- ------------------------------------------------ the @bot cooldown
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

select test_ok('three addressed posts in a minute are fine',
  (select count(*) from (
    select public.create_generation(gen_random_uuid(), 'bot ask ' || i, '', true)
      from generate_series(1, 3) i
  ) x) = 3);

select test_denied('the fourth @bot call inside the minute is cooled down', $$
  select public.create_generation(gen_random_uuid(), 'bot ask 4', '', true)$$);

-- ------------------------------------------------- the per-user post cap
select test_ok('plain posts up to the budget still land',
  (select count(*) from (
    select public.create_generation(gen_random_uuid(), 'rate post ' || i, 'x')
      from generate_series(1, 4) i
  ) x) = 4);

select public.create_generation('dddddddd-0000-0000-0000-0000000000e8',
  'rate post five', 'x');

select test_denied('the ninth write in the minute is refused', $$
  select public.create_generation(gen_random_uuid(), 'one too many', 'x')$$);

select test_ok('and the refusal created nothing',
  (select count(*) from public.generations
    where author_id = '11111111-1111-1111-1111-111111111111'
      and (prompt like 'rate post%' or prompt like 'bot ask%')) = 8);

-- A retry of an already-landed key is a replay, not a new write: it must
-- return the stored row even though the budget is spent.
select test_ok('an idempotent replay spends no budget',
  (select id from public.create_generation('dddddddd-0000-0000-0000-0000000000e8',
     'rate post five', 'x')) =
  (select id from public.generations where prompt = 'rate post five'));

-- ------------------------------------------------- comment caps
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');

select test_ok('five comments on one thread are fine',
  (select count(*) from (
    select public.create_comment(gen_random_uuid(),
      'a0000000-0000-0000-0000-000000000001', 'thread comment ' || i)
      from generate_series(1, 5) i
  ) x) = 5);

select test_denied('the sixth comment on the same thread is cooled down', $$
  select public.create_comment(gen_random_uuid(),
    'a0000000-0000-0000-0000-000000000001', 'one too many')$$);

select test_ok('the user budget still has room across other threads',
  (select count(*) from (
    select public.create_comment(gen_random_uuid(),
      'a0000000-0000-0000-0000-000000000002', 'second thread ' || i)
      from generate_series(1, 5) i
    union all
    select public.create_comment(gen_random_uuid(),
      'b0000000-0000-0000-0000-000000000001', 'third thread ' || i)
      from generate_series(1, 4) i
  ) x) = 9);

-- The refusal above raised inside its own statement, so its counter
-- increment went back with it: the user bucket sits at fourteen. One more
-- comment lands, and the one after that is the refusal.
select public.create_comment(gen_random_uuid(),
  'b0000000-0000-0000-0000-000000000001', 'under the wire');

select test_denied('the sixteenth comment in the minute is refused outright', $$
  select public.create_comment(gen_random_uuid(),
    'b0000000-0000-0000-0000-000000000001', 'over the user budget')$$);

-- --------------------------- deleted posts keep no readable discussion
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

insert into public.generations (id, author_id, prompt, response)
values ('eeeeeeee-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111', 'soon deleted', 'x');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');
insert into public.comments (id, generation_id, author_id, body)
values ('eeeeeeee-0000-0000-0000-000000000002',
        'eeeeeeee-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'comment on a doomed post');

select test_ok('the comment is readable while the post lives',
  (select count(*) from public.comments
    where generation_id = 'eeeeeeee-0000-0000-0000-000000000001') = 1);

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
update public.generations set deleted_at = now()
 where id = 'eeeeeeee-0000-0000-0000-000000000001';

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');
select test_ok('a soft-deleted post hides its comments from the API',
  (select count(*) from public.comments
    where generation_id = 'eeeeeeee-0000-0000-0000-000000000001') = 0);

select test_ok('and the thread RPC serves nothing for it either',
  (select count(*) from public.thread_for('eeeeeeee-0000-0000-0000-000000000001')) = 0);

reset role;

-- ============ content reports (0015) ============
-- A report is an action against someone, so it gets the same discipline as
-- any other write: authenticated, rate limited, idempotent by schema, and
-- unable to confirm the existence of content the reporter cannot see.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');

select test_ok('a visible post can be reported',
  public.report_content('post', 'a0000000-0000-0000-0000-000000000001')
    ->>'status' = 'reported');

select test_ok('reporting it again is idempotent, not a second report',
  public.report_content('post', 'a0000000-0000-0000-0000-000000000001')
    ->>'status' = 'already');

select test_denied('a private post cannot be reported by someone who cannot see it', $$
  select public.report_content('post', 'a0000000-0000-0000-0000-000000000004')$$);

select test_denied('nor can a target that never existed', $$
  select public.report_content('post', 'ffffffff-0000-0000-0000-000000000099')$$);

select test_denied('a deleted comment cannot be reported', $$
  select public.report_content('comment', 'eeeeeeee-0000-0000-0000-000000000002')$$);

set role anon;
select test_denied('anon cannot read the reports table', $$select * from public.reports$$);

set role authenticated;
select test_denied('nor can a signed-in reader', $$select * from public.reports$$);

-- The rate limit: twenty flags an hour, and the budget counts repeated
-- reports too, because a retry loop against one target is itself the
-- abuse the limit exists to stop. (A refused probe rolls its own counter
-- back, so the probe below does not spend budget.)
select count(*) from (
  select public.report_content('post', 'a0000000-0000-0000-0000-000000000001')
    from generate_series(1, 18)
) x \gset

select test_denied('the twenty-first flag in the hour is refused', $$
  select public.report_content('post', 'a0000000-0000-0000-0000-000000000001')$$);

reset role;

-- ============ per-account workspace state (0016) ============
-- Workspace data belongs to the account: one row per user, owner-only
-- access, size-capped and rate-limited writes. The blob is opaque to the
-- server (provider keys arrive as client-side ciphertext), so the tests
-- only assert who can touch it, never what is inside.

-- Anonymous: no session, no workspace, not even a footprint.
set role anon;
select test_denied('anon cannot save workspace state', $$
  select public.save_workspace('{"chats":[]}'::jsonb)$$);
select test_denied('anon cannot read the workspace table', $$
  select * from public.workspace_state$$);

-- Owner writes: first save creates the row, the next one bumps rev.
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

-- \gset forces ordering: the save runs first, the assertions read its
-- result. An AND across a function call and a subquery would not
-- guarantee that order inside a single expression.
select public.save_workspace('{"chats":[{"id":"c1"}]}'::jsonb) ->> 'rev' as rev_a \gset
select test_ok('the first save creates the row at rev 1', :'rev_a' = '1');

select public.save_workspace('{"chats":[{"id":"c1"},{"id":"c2"}]}'::jsonb) ->> 'rev' as rev_b \gset
select test_ok('the next save bumps rev, not the row count',
  :'rev_b' = '2' and (select count(*) from public.workspace_state) = 1);
select test_ok('the owner reads back exactly what was saved',
  (select data -> 'chats' -> 1 ->> 'id' from public.workspace_state) = 'c2');

-- 0019: compare-and-set. A save claiming an old rev is refused rather
-- than silently destroying the other device's write; the matching claim
-- and the legacy null claim both land.
select test_denied('a save against a stale rev is refused (stale_workspace)', $$
  select public.save_workspace('{"chats":[]}'::jsonb, 1)$$);
select test_ok('the refused save changed nothing',
  (select data -> 'chats' -> 1 ->> 'id' from public.workspace_state) = 'c2');
select test_ok('a save claiming the current rev lands',
  (public.save_workspace('{"chats":[{"id":"c3"}]}'::jsonb, 2)) ->> 'rev' = '3');
select test_ok('a legacy save with no claim still lands (old clients degrade, not break)',
  (public.save_workspace('{"chats":[{"id":"c4"}]}'::jsonb)) ->> 'rev' = '4');

-- A second account cannot see, overwrite or delete it.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');

select test_ok('another account sees no foreign workspace rows',
  (select count(*) from public.workspace_state) = 0);
with u as (
  update public.workspace_state set data = '{}'::jsonb
   where user_id = '11111111-1111-1111-1111-111111111111'
  returning 1
) select count(*) as foreign_updates from u \gset

select test_ok('a foreign update matches nothing', :foreign_updates = 0);

with d as (
  delete from public.workspace_state
   where user_id = '11111111-1111-1111-1111-111111111111'
  returning 1
) select count(*) as foreign_deletes from d \gset

select test_ok('a foreign delete matches nothing', :foreign_deletes = 0);
select test_denied('inserting a row under a foreign id is refused', $$
  insert into public.workspace_state (user_id, data)
  values ('11111111-1111-1111-1111-111111111111', '{}'::jsonb)$$);

-- The second account writes its own workspace, so it needs the same
-- entitlement seed alice got (0023 makes save_workspace grant-gated).
-- Clients hold no grant on workspace_grants by design, so the seed must
-- run as owner, not as the authenticated role this section plays in.
reset role;
insert into public.workspace_grants (user_id, granted_by, note) values
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-4000-8000-0000000000aa', 'harness: second workspace account');
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

-- Under RLS the second account still sees exactly one row: its own.
select public.save_workspace('{"chats":[]}'::jsonb) ->> 'rev' as rev_c \gset
select test_ok('the second account saves into its own row',
  :'rev_c' = '1' and (select count(*) from public.workspace_state) = 1);

-- Size cap: a 4 MB blob is refused, and the refusal leaves no trace.
select test_denied('an oversized payload is refused', $$
  select public.save_workspace(jsonb_build_object('x', repeat('a', 4000000)))$$);

-- Rate limit: thirty saves a minute, thirty-first refused. Align to a
-- fresh fixed window first; refused probes roll their own increment back,
-- so the final probe spends no budget.
do $$ begin
  perform pg_sleep(60 - (extract(epoch from now())::bigint % 60) + 1);
end $$;

select count(*) from (
  select public.save_workspace(jsonb_build_object('n', g))
    from generate_series(1, 30) g
) x \gset

select test_denied('the thirty-first save in the minute is refused', $$
  select public.save_workspace('{"chats":[]}'::jsonb)$$);

reset role;

-- ============ the admin role (0017) ============
-- Privilege lives in the database: membership is a row, every action is
-- a SECURITY DEFINER RPC that re-checks the caller, and no client can
-- grant itself in. The owner admin is irremovable so the role can never
-- be emptied. alice is seeded the admin, bob starts ordinary.
reset role;
insert into public.admins (user_id, email, owner)
values ('11111111-1111-1111-1111-111111111111', 'alice@test.com', true);
insert into public.waitlist (email) values ('waiter@company.com');

set role anon;
select test_denied('anon cannot even ask whether it is an admin', $$
  select public.is_admin()$$);
select test_denied('anon cannot read the admins table', $$
  select * from public.admins$$);

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');

select test_ok('an ordinary account is not an admin',
  public.is_admin() = false);
select test_denied('a non-admin cannot read the queue', $$
  select * from public.admin_waitlist()$$);
select test_denied('nor the roster', $$
  select * from public.admin_roster()$$);
select test_denied('nor the reports', $$
  select public.admin_reports()$$);
select test_denied('a non-admin cannot add admins', $$
  select public.admin_add('bob@test.com')$$);
select test_denied('a non-admin cannot grant workspace access', $$
  select public.admin_grant('bob@test.com')$$);
select test_denied('a non-admin cannot read the admins table', $$
  select * from public.admins$$);

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

select test_ok('the seeded admin is an admin', public.is_admin());
select test_ok('the queue shows who is waiting and whether they signed up',
  (select count(*) from public.admin_waitlist() w
    where w.email = 'waiter@company.com' and w.has_account = false) = 1);
/* History seeds the canonical owner (0022) and the harness seeds alice,
   so the roster carries two owners; the assertion names them rather than
   counting to one. */
select test_ok('the roster lists the owner',
  (select count(*) from public.admin_roster() r
    where r.owner and r.email in ('rfarouq69@gmail.com', 'alice@test.com')) = 2);

select test_ok('an admin can be added by email',
  public.admin_add('bob@test.com') ->> 'status' = 'added');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');
select test_ok('the new admin takes effect immediately',
  public.is_admin() and (select count(*) from public.admin_waitlist() w
    where w.email = 'waiter@company.com') = 1);

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_ok('adding the same admin again is idempotent',
  public.admin_add('bob@test.com') ->> 'status' = 'already');
select test_denied('adding an address with no account is refused', $$
  select public.admin_add('ghost@test.com')$$);
select test_denied('adding a malformed address is refused', $$
  select public.admin_add('not-an-email')$$);

select test_ok('a co-admin can be removed',
  public.admin_remove('22222222-2222-2222-2222-222222222222') ->> 'status' = 'removed');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');
select test_ok('removal strips the role immediately', public.is_admin() = false);

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_denied('the owner cannot be removed', $$
  select public.admin_remove('11111111-1111-1111-1111-111111111111')$$);

select test_denied('granting an address with no account is refused', $$
  select public.admin_grant('waiter@company.com')$$);

select test_ok('granting a real account records the grant',
  public.admin_grant('bob@test.com') ->> 'status' = 'granted');
select test_ok('regranting is idempotent',
  public.admin_grant('bob@test.com') ->> 'status' = 'already');

reset role;
select test_ok('the grant row exists and the waitlist row is untouched',
  (select count(*) from public.workspace_grants
    where user_id = '22222222-2222-2222-2222-222222222222') = 1
  and (select status from public.waitlist where email = 'waiter@company.com') = 'pending');

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_ok('reports are readable in-product, newest first, reporter embedded',
  jsonb_array_length(public.admin_reports()) >= 1
  and (public.admin_reports() -> 0) ? 'reporter');
select test_denied('an unknown report status is refused', $$
  select public.admin_reports('odd')$$);

-- 0019: reports reach a terminal state. The admin closes a pending
-- report; a second close reads 'already'; an unknown id reads 'gone';
-- a non-admin cannot touch it at all. The fixture id is read as the
-- table owner because clients have no direct grant on reports, which is
-- itself one of the assertions above.
reset role;
select r.id as report_id from public.reports r where r.status = 'pending' limit 1 \gset
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_ok('an admin closes a pending report',
  public.admin_resolve_report(:'report_id', 'dismissed') ->> 'status' = 'dismissed');
select test_ok('closing it again reports it already settled',
  public.admin_resolve_report(:'report_id', 'actioned') ->> 'status' = 'already');
reset role;
select test_ok('the first decision stands',
  (select status from public.reports where id = :'report_id') = 'dismissed');
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_ok('a vanished report reads gone',
  public.admin_resolve_report('99999999-9999-9999-9999-999999999999', 'dismissed') ->> 'status' = 'gone');
select test_denied('a made-up terminal status is refused', $$
  select public.admin_resolve_report('99999999-9999-9999-9999-999999999999', 'vaporized')$$);

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');
select test_denied('a non-admin cannot resolve a report', $$
  select public.admin_resolve_report('99999999-9999-9999-9999-999999999999', 'dismissed')$$);
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

reset role;

-- ============ capabilities and bootstrap (0018) ============
-- The blunt is_admin() switch became a (user, capability) grant with the
-- action -> capability contract declared in the database itself. These
-- tests prove the parts a client cannot fake: revocations bite at once,
-- the unknown action fails closed, the bootstrap is exactly one claim,
-- and an outsider learns nothing about the admin system's shape.
reset role;
insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'carol@company.com');

set role anon;
select test_denied('anon cannot ask the bootstrap status', $$
  select public.admin_bootstrap_status()$$);
select test_denied('anon cannot claim the bootstrap', $$
  select public.admin_bootstrap_claim()$$);

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test_fresh_claims('22222222-2222-2222-2222-222222222222');
select test_ok('bob is still nobody''s admin after the anon block', public.is_admin() = false);

select test_ok('an ordinary account may ask the status, and learns four facts and nothing else',
  (select count(*) from jsonb_object_keys(public.admin_bootstrap_status())) = 4
  and (public.admin_bootstrap_status() ->> 'claimed')::boolean
  and not (public.admin_bootstrap_status() ->> 'pending')::boolean
  and public.admin_bootstrap_status() -> 'caps' = '[]'::jsonb);
select test_denied('an ordinary account cannot claim the bootstrap', $$
  select public.admin_bootstrap_claim()$$);

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

-- Counted through admin_caps_for rather than the raw table: authenticated
-- has no grant on admin_caps, and adding one to peek would weaken the
-- design the test exists to protect.
-- Separate statements, deliberately: expression order inside one SELECT
-- is not guaranteed, so add-check-remove-check chained with AND could
-- evaluate the counts on the wrong side of the mutation.
select test_ok('the pair of default capabilities is on the record',
  public.admin_add('bob@test.com') ->> 'status' = 'added');
select test_ok('and they read back before removal',
  jsonb_array_length(public.admin_caps_for(
    '22222222-2222-2222-2222-222222222222') -> 'granted') = 2);
select test_ok('removal revokes every capability they held',
  public.admin_remove('22222222-2222-2222-2222-222222222222') ->> 'status' = 'removed');
select test_ok('and the record is empty again',
  jsonb_array_length(public.admin_caps_for(
    '22222222-2222-2222-2222-222222222222') -> 'granted') = 0);
select test_ok('the owner holds the whole catalog implicitly, no rows needed',
  jsonb_array_length(public.admin_bootstrap_status() -> 'caps') = 8
  and public.has_cap('system.configure') and public.has_cap('billing.refund'));
select test_denied('an action nobody declared a capability for is refused, even for the owner', $$
  select public.require_cap('not_a_real_action')$$);

/* The replayed history claims the bootstrap in 0022, before this suite
   runs; what remains provable here is the one-time guarantee itself:
   nobody, not even an owner, can claim it again. */
select test_denied('a claimed bootstrap cannot be claimed again, even by an owner', $$
  select public.admin_bootstrap_claim('first login')$$);
select test_denied('the bootstrap cannot be replayed, even by its claimer', $$
  select public.admin_bootstrap_claim('again')$$);
select test_ok('the ledger flips and keeps no identity of its own',
  (public.admin_bootstrap_status() ->> 'claimed')::boolean
  and not (public.admin_bootstrap_status() ->> 'pending')::boolean);

select test_ok('the owner adds a co-admin',
  public.admin_add('carol@company.com') ->> 'status' = 'added');

set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
select test_fresh_claims('77777777-7777-7777-7777-777777777777');

select test_ok('the co-admin starts with the queue rights and nothing sensitive',
  public.has_cap('waitlist.manage') and public.has_cap('moderation.manage')
  and not public.has_cap('users.read') and not public.has_cap('admins.manage'));
select test_ok('the co-admin can run the queue',
  (select count(*) from public.admin_waitlist()) >= 0);
select test_denied('the co-admin cannot manage admins', $$
  select * from public.admin_roster()$$);
select test_denied('the co-admin cannot mint capabilities', $$
  select public.admin_grant_cap('77777777-7777-7777-7777-777777777777', 'users.read')$$);
select test_denied('the co-admin cannot read the capability structures', $$
  select public.admin_caps_for(null)$$);
select test_ok('the co-admin can still read reports',
  jsonb_typeof(public.admin_reports()) = 'array');

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');

select test_denied('a capability not in the catalog cannot be granted', $$
  select public.admin_grant_cap('77777777-7777-7777-7777-777777777777', 'billing.secret')$$);
select test_denied('capabilities cannot be granted to non-admins', $$
  select public.admin_grant_cap('22222222-2222-2222-2222-222222222222', 'users.read')$$);
select test_ok('the owner grants a capability',
  public.admin_grant_cap('77777777-7777-7777-7777-777777777777', 'users.read') ->> 'status' = 'granted');

set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
select test_fresh_claims('77777777-7777-7777-7777-777777777777');
select test_ok('the grant takes effect on the next call', public.has_cap('users.read'));

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_ok('a revocation is reported with what remains',
  public.admin_revoke_cap('77777777-7777-7777-7777-777777777777', 'users.read') ->> 'remaining' = '2');
select test_ok('down to one is still allowed, it is zero that is guarded',
  public.admin_revoke_cap('77777777-7777-7777-7777-777777777777', 'waitlist.manage') ->> 'remaining' = '1');
select test_denied('an admin cannot be stripped of every capability (they would be invisible dead weight)', $$
  select public.admin_revoke_cap('77777777-7777-7777-7777-777777777777', 'moderation.manage')$$);
reset role;
select test_ok('the refused revocation changed nothing: the one grant stands',
  (select count(*) from public.admin_caps
    where user_id = '77777777-7777-7777-7777-777777777777') = 1
  and (select cap from public.admin_caps
    where user_id = '77777777-7777-7777-7777-777777777777') = 'moderation.manage');
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_fresh_claims('11111111-1111-1111-1111-111111111111');
select test_denied('the owner cannot be stripped of anything', $$
  select public.admin_revoke_cap('11111111-1111-1111-1111-111111111111', 'waitlist.manage')$$);
select test_ok('the catalog and one admin grants come back for the roster editor',
  jsonb_array_length((public.admin_caps_for('77777777-7777-7777-7777-777777777777')) -> 'catalog') = 8
  and (public.admin_caps_for('77777777-7777-7777-7777-777777777777') ->> 'granted')
      = '["moderation.manage"]');
select test_ok('the roster carries caps per row: eight for the owner, one for the co-admin',
  (select jsonb_array_length(r.caps) = 8 from public.admin_roster() r
    where r.user_id = '11111111-1111-1111-1111-111111111111')
  and (select jsonb_array_length(r.caps) = 1 from public.admin_roster() r
    where r.user_id = '77777777-7777-7777-7777-777777777777'));

set request.jwt.claim.sub = '77777777-7777-7777-7777-777777777777';
select test_fresh_claims('77777777-7777-7777-7777-777777777777');
select test_denied('the co-admin lost the right to grant seats at the moment the cap was revoked', $$
  select public.admin_grant('waiter@company.com')$$);
select test_ok('a revoked capability reads false rather than raising',
  public.has_cap('waitlist.manage') = false);
select test_ok('the capability the co-admin still holds still works',
  jsonb_typeof(public.admin_reports()) = 'array');
select test_denied('authenticated cannot read the grants table directly', $$
  select * from public.admin_caps$$);
select test_denied('nor the bootstrap ledger', $$
  select * from public.admin_bootstrap$$);
select test_denied('nor the action contract', $$
  select * from public.admin_action_caps$$);
select test_denied('nor write the catalog', $$
  insert into public.admin_capabilities (cap, label, description)
  values ('anything.at.all', 'x', 'y')$$);

\echo ''
\echo 'All schema assertions passed.'
