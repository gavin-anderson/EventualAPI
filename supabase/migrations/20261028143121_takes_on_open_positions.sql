-- Takes become comments on OPEN positions.
--
--   * One live take per user per coin: a position on Hyperliquid is one per
--     wallet and coin, so that is one per position.
--   * Postable and editable any time while the position is open — not tied to
--     the trade that opened it.
--   * Removed the moment the position closes or changes (size or side; leverage
--     and margin don't count). Removed is a soft delete: hidden everywhere, kept
--     here with when and why. The changed position can then take a fresh one.
--
-- A take carries a snapshot of the position it was written about (side, size,
-- entry, leverage), read from Hyperliquid when posted. That snapshot is what a
-- change is detected against, and what the feed shows.

create table if not exists public.takes (
  id             uuid        primary key default gen_random_uuid(),
  user_id        text        not null references public.profiles(id) on delete cascade,
  wallet_address text        not null,
  coin           text        not null,
  -- The app's record of the trade that opened the position, when there is one.
  -- A position opened outside the app has none and can still take a take.
  position_id    uuid        references public.positions(id) on delete set null,
  side           text        not null check (side in ('long','short')),
  size           numeric     not null check (size > 0),
  entry_px       numeric     not null,
  leverage       integer,
  text           text        not null,
  posted_at      timestamptz not null default now(),
  edited_at      timestamptz,
  removed_at     timestamptz,
  removed_reason text        check (removed_reason in ('closed','changed','liquidated')),
  -- Moderation, as on positions. Separate from removal: a hidden take is still
  -- the live one, so the user can't simply post another.
  hidden_at      timestamptz,
  constraint takes_removed_has_reason check ((removed_at is null) = (removed_reason is null))
);

comment on table public.takes is
  'Comments on open positions, one live per user and coin. Removed (soft) when the position closes or its size or side changes; side/size/entry are the position as it was when posted.';

-- The rule itself: at most one live take per position.
create unique index if not exists takes_one_live_idx
  on public.takes (user_id, coin)
  where removed_at is null;

-- The refresh job's check: live takes for a wallet.
create index if not exists takes_live_wallet_idx
  on public.takes (wallet_address)
  where removed_at is null;

-- The feed: live takes, newest first.
create index if not exists takes_feed_idx
  on public.takes (coin, posted_at desc)
  where removed_at is null and hidden_at is null;

alter table public.takes enable row level security;
revoke all on public.takes from anon, authenticated;

-- ── backfill ──────────────────────────────────────────────────────────────────
-- Open takes carry over: still live if their position is still open (the
-- newest one per user and coin, if several), removed otherwise. Close takes
-- stay where they are on positions and simply drop out of the feed.
insert into public.takes
  (user_id, wallet_address, coin, position_id, side, size, entry_px, leverage,
   text, posted_at, removed_at, removed_reason, hidden_at)
select p.user_id, p.wallet_address, p.coin, p.id, p.side, p.size, p.entry_px, p.leverage,
       p.open_take, coalesce(p.open_take_at, p.created_at),
       case when p.closed_at is not null then p.closed_at
            when p.newest > 1 then now() end,
       case when p.closed_at is not null then 'closed'
            when p.newest > 1 then 'changed' end,
       p.hidden_at
  from (
    select *, row_number() over (
             partition by user_id, coin, (closed_at is null)
             order by opened_at desc) as newest
      from public.positions
     where open_take is not null
  ) p
 where not exists (select 1 from public.takes t where t.position_id = p.id);

-- ── the feed ──────────────────────────────────────────────────────────────────
-- Same columns as before, so a deploy that still reads them keeps working;
-- edited_at and take_id are new at the end. Only live, unhidden takes.
-- Dropped and recreated rather than replaced: the column set changes meaning.
drop view if exists public.feed_items;

create view public.feed_items with (security_invoker = true) as
select t.id::text                          as id,
       t.position_id,
       'open'::text                        as kind,
       t.user_id,
       pr.username,
       pr.image_ref,
       t.coin,
       t.side,
       t.size,
       t.size * t.entry_px                 as notional,
       t.leverage,
       t.entry_px                          as price,
       t.text                              as take,
       coalesce(p.opened_at, t.posted_at)  as traded_at,
       t.posted_at,
       null::numeric                       as realized_pnl,
       false                               as is_closed,
       t.edited_at,
       t.id                                as take_id
  from public.takes t
  join public.profiles pr on pr.id = t.user_id
  left join public.positions p on p.id = t.position_id
 where t.removed_at is null
   and t.hidden_at is null;

comment on view public.feed_items is
  'Live takes on open positions, one row per take. Removed and hidden takes are excluded.';

-- A recreated view arrives fully granted (see docs/RLS.md).
revoke all on public.feed_items from anon, authenticated;
