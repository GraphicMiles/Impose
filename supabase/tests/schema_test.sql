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

-- ---------------------------------------------------------------- setup
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.com'),
  ('33333333-3333-3333-3333-333333333333', 'alice@other.com');

select test_ok('profiles are created for new users',
  (select count(*) from public.profiles) = 3);

select test_ok('handles are generated, never null',
  (select count(*) from public.profiles where handle is null) = 0);

select test_ok('colliding handles get a suffix rather than failing signup',
  (select count(distinct handle) from public.profiles) = 3);

-- ------------------------------------------------------- generations
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

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
select test_denied('deleting someone else''s comment is refused', $$
  select public.soft_delete_comment('c0000000-0000-0000-0000-000000000001')$$);

-- --------------------------------------------------------------- saves
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into public.saves (user_id, generation_id)
values ('22222222-2222-2222-2222-222222222222', 'a0000000-0000-0000-0000-000000000001');

select test_ok('saving bumps the public total',
  (select save_count from public.generations
    where id = 'a0000000-0000-0000-0000-000000000001') = 1);

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select test_ok('one reader''s save is private to them',
  (select count(*) from public.saves) = 0);

select test_denied('saving on behalf of another user is refused', $$
  insert into public.saves (user_id, generation_id)
  values ('22222222-2222-2222-2222-222222222222',
          'a0000000-0000-0000-0000-000000000002')$$);

-- ------------------------------------------------------------ waitlist
reset role;
-- Called twice on purpose: a retry or a double tap must not create a
-- second row or move the person down the queue.
select public.join_waitlist('someone@test.com');
select public.join_waitlist('someone@test.com');
select test_ok('the waitlist RPC is idempotent',
  (select count(*) from public.waitlist where email = 'someone@test.com') = 1);

select test_ok('waitlist addresses are case insensitive',
  (select count(*) from (select public.join_waitlist('SOMEONE@Test.com')) x) = 1
  and (select count(*) from public.waitlist where email = 'someone@test.com') = 1);

select test_denied('the waitlist RPC validates the address server side', $$
  select public.join_waitlist('not-an-email')$$);


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

\echo ''
\echo 'All schema assertions passed.'

-- ============ canonical db (0004) ============

reset role;
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'cara@test.com');

set role authenticated;
set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';

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
  (select comment_count = 0 and save_count = 0 from public.generations
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
select '55555555-5555-5555-5555-555555555555', 'p' || i, 'body',
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
create temp table probe_before as
  select public.feed_since((select at from probe_mark)) as n;

-- Ada posts one thing.
insert into public.generations (author_id, prompt, response)
values ('11111111-1111-1111-1111-111111111111', 'from-ada', 'x');

select test_ok('your own new post does not raise your own counter',
  public.feed_since((select at from probe_mark)) = (select n from probe_before));

set request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
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
  values (gen_random_uuid(), '55555555-5555-5555-5555-555555555555', 'x')$$);
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

insert into public.generations (id, author_id, prompt, response, locked)
values ('cccccccc-0000-0000-0000-00000000000a',
        '11111111-1111-1111-1111-111111111111', 'locked parent', 'x', true);
insert into public.generations (id, author_id, prompt, response)
values ('cccccccc-0000-0000-0000-00000000000b',
        '11111111-1111-1111-1111-111111111111', 'open parent', 'x');

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

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
select test_ok('the author can still build on their own locked post',
  (select id from public.create_generation(gen_random_uuid(), 'mine', 'x', false,
    'complete', 'public', 'remix', 'cccccccc-0000-0000-0000-00000000000a')) is not null);
reset role;
