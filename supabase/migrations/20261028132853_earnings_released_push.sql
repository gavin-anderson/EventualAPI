-- "Earnings are out" push: sent to every user once per release.
--
-- The claim that makes it once. hl-api sets this with a conditional update
-- (where released_notified_at is null) BEFORE fanning out, so a re-run or a
-- crash-retry finds it set and sends nothing. Null means not yet announced.
alter table public.earnings_events
  add column if not exists released_notified_at timestamptz;

-- Releases confirmed before this column existed are history, not news. Without
-- this, applying the migration would announce any release from the last few
-- hours a second time.
update public.earnings_events
  set released_notified_at = now()
  where is_confirmed and released_notified_at is null;

-- The sweep asks for confirmed, unannounced events near now.
create index if not exists earnings_events_release_unnotified_idx
  on public.earnings_events (earnings_at)
  where is_confirmed and released_notified_at is null;
