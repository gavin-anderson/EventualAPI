-- Big-move pushes: "NVDA up 11.2% today", to users watching the market.
--
-- The move is measured against Hyperliquid's prevDayPx (rolling 24h). One push
-- per user, market, UTC day and direction at 10%, and one more at 20%. Both
-- thresholds are recorded when a market gaps straight to 20%, so the 10% push
-- never follows it.
create table if not exists public.price_move_alerts (
  user_id    text        not null references public.profiles(id) on delete cascade,
  coin       text        not null,
  -- UTC date the push was sent. The move itself is rolling, so this is the
  -- dedupe window, not the period the move happened in.
  day        date        not null,
  direction  text        not null check (direction in ('up','down')),
  threshold  integer     not null check (threshold in (10, 20)),
  -- The 24h change when it was recorded, in percent. Audit only.
  change_pct numeric,
  -- The row is the lock: inserted first, and only a newly inserted one is
  -- pushed. So there is no separate notified flag.
  created_at timestamptz not null default now(),
  primary key (user_id, coin, day, direction, threshold)
);

comment on table public.price_move_alerts is
  '10%/20% 24h price-move pushes already sent, one row per user, market, UTC day, direction and threshold. Old days are inert and can be pruned.';

-- The job reads one day's rows for the markets that are moving.
create index if not exists price_move_alerts_day_coin_idx
  on public.price_move_alerts (day, coin);

alter table public.price_move_alerts enable row level security;
revoke all on public.price_move_alerts from anon, authenticated;

alter table public.notification_preferences
  add column if not exists price_move boolean not null default true;
