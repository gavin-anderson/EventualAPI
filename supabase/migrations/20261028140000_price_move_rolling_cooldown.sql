-- NOT YET APPLIED to the live database. When it is, rename this file to the
-- version supabase_migrations.schema_migrations records and delete these lines.

-- Price-move pushes: replace the UTC-day dedupe with a rolling 24-hour cooldown.
--
-- Before, (user, coin, day, direction, threshold) was the key, so a move still
-- past 10% after midnight UTC alerted again minutes later. Now a row per
-- (user, coin, direction, threshold) remembers when it last alerted, and the
-- same alert can only fire again 24 hours after that. Threshold stays in the
-- key, so a 20% push can still follow a 10% one within the 24 hours.
--
-- The table is empty in production (the sending code was never deployed), but
-- this is written to keep the newest row per key if it isn't.

alter table public.price_move_alerts
  add column if not exists last_alerted_at timestamptz;

update public.price_move_alerts
  set last_alerted_at = created_at
  where last_alerted_at is null;

-- Several days' rows for one key collapse to the most recent.
delete from public.price_move_alerts a
  using public.price_move_alerts b
  where a.user_id = b.user_id
    and a.coin = b.coin
    and a.direction = b.direction
    and a.threshold = b.threshold
    and (a.last_alerted_at, a.ctid) < (b.last_alerted_at, b.ctid);

alter table public.price_move_alerts drop constraint if exists price_move_alerts_pkey;
drop index if exists public.price_move_alerts_day_coin_idx;
alter table public.price_move_alerts drop column if exists day;

alter table public.price_move_alerts
  alter column last_alerted_at set not null,
  alter column last_alerted_at set default now();

alter table public.price_move_alerts
  add primary key (user_id, coin, direction, threshold);

comment on table public.price_move_alerts is
  '10%/20% 24h price-move pushes, one row per user, market, direction and threshold. last_alerted_at starts a 24-hour cooldown; claim_price_move_alerts() is the only writer that should decide a send.';
comment on column public.price_move_alerts.created_at is
  'First time this alert fired for the user. last_alerted_at is the most recent.';

-- The job's pre-filter: which of today's moving markets are still cooling down.
create index if not exists price_move_alerts_coin_last_idx
  on public.price_move_alerts (coin, last_alerted_at);

-- The claim, in one statement: insert a new alert, or re-arm one whose cooldown
-- has passed. Only rows returned were claimed, and only those are pushed. A
-- read-then-write from the client can't be made atomic; this can, because the
-- conflict check and the cooldown condition are evaluated under the row lock.
--
-- Input: a JSON array of {user_id, coin, direction, threshold, change_pct}.
create or replace function public.claim_price_move_alerts(p_alerts jsonb)
returns table (user_id text, coin text, direction text, threshold integer)
language sql
set search_path = ''
as $$
  insert into public.price_move_alerts as a
    (user_id, coin, direction, threshold, change_pct, last_alerted_at)
  -- distinct on: ON CONFLICT DO UPDATE refuses to touch one row twice.
  select distinct on (r.user_id, r.coin, r.direction, r.threshold)
         r.user_id, r.coin, r.direction, r.threshold, r.change_pct, now()
    from jsonb_to_recordset(p_alerts)
      as r(user_id text, coin text, direction text, threshold integer, change_pct numeric)
  on conflict on constraint price_move_alerts_pkey do update
    set last_alerted_at = excluded.last_alerted_at,
        change_pct      = excluded.change_pct
    where a.last_alerted_at < now() - interval '24 hours'
  returning a.user_id, a.coin, a.direction, a.threshold;
$$;

revoke all on function public.claim_price_move_alerts(jsonb) from public, anon, authenticated;
grant execute on function public.claim_price_move_alerts(jsonb) to service_role;
