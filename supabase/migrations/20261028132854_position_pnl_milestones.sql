-- Position PnL milestone pushes: "your NVDA long is up 50% on margin".
--
-- Milestones are up 25/50/100/200% (then each doubling) and down 25/50%, each
-- sent once per position. Only the furthest newly crossed one is pushed, but
-- every crossed one is recorded so a pullback doesn't announce a smaller one.

-- When the mirror first saw this position. hl-api's refresh upserts without
-- this column, so an update keeps it and only an insert sets it — and the row is
-- deleted when the position closes, so a reopen gets a fresh value. That makes
-- (wallet, coin, side, opened_at) one position, which is what milestones key on.
-- Existing rows get now(): their milestones start from this deploy.
alter table public.wallet_open_positions
  add column if not exists opened_at timestamptz not null default now();

create table if not exists public.position_pnl_alerts (
  wallet_address text        not null,
  coin           text        not null,
  side           text        not null check (side in ('long','short')),
  opened_at      timestamptz not null,
  -- Signed percent of margin: 25, 50, 100, 200, 400, ... or -25, -50.
  milestone      integer     not null,
  user_id        text        not null references public.profiles(id) on delete cascade,
  -- Return on margin when it was crossed, as a fraction. For checking a
  -- notification someone queries, not used to decide anything.
  roe            numeric,
  -- The row is the lock: inserted first, and only a newly inserted milestone is
  -- pushed. So there is no separate notified flag.
  created_at     timestamptz not null default now(),
  primary key (wallet_address, coin, side, opened_at, milestone)
);

comment on table public.position_pnl_alerts is
  'PnL milestones already crossed, one row per position per milestone. A position is (wallet, coin, side, opened_at), so a close-and-reopen starts fresh. Rows for closed positions are inert history.';

alter table public.position_pnl_alerts enable row level security;
revoke all on public.position_pnl_alerts from anon, authenticated;

alter table public.notification_preferences
  add column if not exists position_pnl boolean not null default true;
