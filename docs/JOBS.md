# Scheduled jobs

The sync jobs run **out of process** from the API server: systemd timers invoke
`node dist/jobs/run.js <name>`, so job work never touches the API's event loop and
a crashing job can't take the API down.

## Run one manually

```bash
npm run build
npm run job -- sync-assets          # or job:dev for tsx (no build)
node dist/jobs/run.js refresh-imminent
```

Jobs (registry in `src/jobs/run.ts`):

| Name | Populates | Cadence |
|---|---|---|
| `sync-assets` | `assets` + logos | daily (+ on boot) |
| `sync-earnings-calendar` | `earnings_events` (90d) | daily (+ on boot) |
| `sync-earnings-history` | `earnings_history` | daily (+ on boot) |
| `snapshot-account-values` | `account_value_snapshots` | daily |
| `refresh-approaching` | `earnings_events` in (1h, 24h], unconfirmed | hourly |
| `refresh-imminent` | `earnings_events` in [~now, 1h], unconfirmed | every 5 min |
| `sync-earnings-odds` | `earnings_odds` (Polymarket) | hourly — *optional* |

Ordering: `sync-assets` must run before the earnings jobs (they join on
`assets`). The daily timers are staggered (08:00 / 08:15 / 08:30 UTC, and
1/2/3 min after boot) for this.

## The earnings-timing cadence (Approach A: static self-gating)

The product promise is earnings times **to the hour**, so timing must be fresh as
an event nears. That's handled by a three-tier ladder — not by a scheduler that
spins per-event jobs up and down, but by **fixed timers whose jobs self-gate on
the data**:

- **Discovery — daily** (`sync-earnings-calendar`): full 90-day sweep. Finds new
  events and sets baseline timing for everything.
- **Approaching — hourly** (`refresh-approaching`): events in **(1h, 24h]** that
  are still unconfirmed/session-only.
- **Imminent — every 5 min** (`refresh-imminent`): events in **[~now, 1h]** still
  unconfirmed — the escalated cadence for the final approach.

The windows are disjoint at the 1h boundary, so an event sits in exactly one tier
and escalates itself: daily → hourly (inside 24h) → every-5-min (inside 1h) →
drops out once its time is confirmed or has passed.

### Why this scales (it does not "check all stocks")

Each refresh tier first runs an **indexed range query** on
`earnings_events.earnings_at` that returns *only the events in its window* — a
handful — then fetches Benzinga for **just those tickers** (batched). So the
Benzinga cost scales with **# of imminent events, not # of stocks**; the only
all-rows cost is one index seek per tick. On a day with nothing near, each tier is
a single query that returns zero rows and exits.

### No duplicate jobs per event

There are a **fixed number of timers regardless of event count** — the design
structurally can't spawn a job per event. systemd won't overlap-run the same unit
instance, and every upsert is idempotent on the fiscal-period key
`(asset_id, period, period_year)`, so even the tier overlap at a boundary just
overwrites one row.

### Restart / downtime behaviour

- `Persistent=true` on the daily discovery timers **re-runs a missed daily on
  boot** (box was down at 08:00, comes up at 10:00 → runs at 10:00).
- `OnBootSec=1/2/3min` also runs the discovery chain shortly after **every** boot,
  so a box that comes back up re-establishes fresh state immediately.
- The refresh tiers are stateless: on reboot the timers simply resume ticking.
  Nothing to rebuild.

## Install on the box (as root)

Assumes: app at `/opt/hl-api` (built with `npm ci && npm run build`), env at
`/etc/hl-api/.env`, service user `hl-api`.

```bash
cp deploy/systemd/hl-api-job@.service /etc/systemd/system/
cp deploy/systemd/*.timer            /etc/systemd/system/
systemctl daemon-reload

systemctl enable --now \
  hl-api-sync-assets.timer \
  hl-api-sync-earnings-calendar.timer \
  hl-api-sync-earnings-history.timer \
  hl-api-refresh-approaching.timer \
  hl-api-refresh-imminent.timer \
  hl-api-snapshot-account-values.timer

# Optional — only if keeping Polymarket odds:
# systemctl enable --now hl-api-sync-earnings-odds.timer
```

## Ops

```bash
systemctl list-timers 'hl-api-*'                       # next/last run times
systemctl start hl-api-job@sync-assets.service         # run one now
journalctl -u 'hl-api-job@refresh-imminent.service' -n 100   # logs (JSON)
```

---

## Approach B (planned): DB-backed per-event schedule

Approach A polls on wall-clock ticks. That's ideal for "to the hour," but it
can't (a) poll at exact per-event offsets (T-30, T-10, T-2…), or (b) act the
*instant* a time is confirmed (e.g. fire a push notification). When those become
requirements — or the imminent-event count per tick strains Benzinga rate limits
— evolve to a **schedule table** instead of fixed windows:

```
earnings_refresh_schedule(
  earnings_event_id  uuid primary key references earnings_events(id),
  next_run_at        timestamptz not null,
  cadence_seconds    int not null,        -- shrinks as the event nears
  ...
)
```

The daily discovery seeds/updates one row per upcoming event; a worker processes
rows where `next_run_at <= now()`, refreshes them, and reschedules `next_run_at`.
State lives in Postgres, so it's restart-safe and dedup is a unique key — the same
properties Approach A gets for free, now with per-event precision.

### Should the Approach-B worker be its own process, outside the API?

**Yes — and preferably it shouldn't be a long-running daemon at all.** Two ways to
build it:

1. **Long-running scheduler daemon.** If it holds a poll loop / in-memory timers,
   it **must** be its own process, never embedded in the API:
   - **Main-thread isolation** — a continuous loop + refresh work would share the
     API's single event loop; even I/O-bound, that couples lifecycles and adds
     latency jitter. Separate process = the API's loop is never touched. (Same
     reasoning as the job runner today.)
   - **Independent lifecycle** — deploy/restart the scheduler without bouncing the
     API, and vice versa.
   - **Crash isolation** — a scheduler bug can't take the API down.
   - **Must be a singleton** — one scheduler, or you double-schedule. Running it in
     the API (which you'll want to scale to N replicas) would fan out to N
     schedulers. A separate single-instance service sidesteps that; multi-box
     needs a Postgres advisory lock / `FOR UPDATE SKIP LOCKED`.

2. **Frequent oneshot (recommended).** Skip the daemon: a **1-minute systemd
   timer** runs `node dist/jobs/run.js process-earnings-schedule`, which claims
   due rows (`… where next_run_at <= now() FOR UPDATE SKIP LOCKED`), refreshes,
   and reschedules. This keeps *exactly* the properties we like about Approach A —
   its own short-lived process (zero main-thread impact), stateless between runs,
   restart-safe, and naturally singleton per box — while adding per-event
   scheduling. It's a strict evolution of the current runner, not a rewrite.

**Recommendation:** if/when we adopt Approach B, do it as the **oneshot
schedule-processor (option 2)**, not a long-running daemon. It answers the
main-thread concern by construction: like every job today, it runs in its own
process and exits.
