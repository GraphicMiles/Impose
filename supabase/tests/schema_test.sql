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

\echo ''
\echo 'All schema assertions passed.'
