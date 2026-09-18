-- Realtime for the Community feed and threads.
--
-- Until now a reader learned about other people's activity by polling
-- feed_since every 25 seconds, which is a reasonable floor but means a
-- comment can sit unseen for most of a minute while two people are looking
-- at the same thread.
--
-- Only the two tables a reader watches. Publishing auth_codes,
-- auth_tickets, rate_counters or idempotency_keys would stream privileged
-- rows to every connected client; they stay off the publication
-- deliberately, and there is a test that fails if that changes.
--
-- RLS still applies. Supabase evaluates the same policies on realtime
-- payloads that it does on a query, so a private post is not broadcast to
-- someone who could not have read it. That only holds when the table has
-- REPLICA IDENTITY set such that the policy can be evaluated against the
-- row, which is what the ALTER below is for: without it a DELETE or an
-- UPDATE arrives with only the primary key and the filter cannot run.

alter publication supabase_realtime add table public.generations;
alter publication supabase_realtime add table public.comments;

-- FULL rather than DEFAULT so an UPDATE payload carries the columns the
-- policy needs (visibility, author_id, deleted_at) instead of just the id.
-- The cost is a larger WAL record per write, which is acceptable at this
-- size and is the price of the filtering being correct.
alter table public.generations replica identity full;
alter table public.comments replica identity full;
