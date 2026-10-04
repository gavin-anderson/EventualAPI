# Scheduled jobs

The sync jobs run **out of process** from the API server: systemd timers invoke
`node dist/jobs/run.js <name>`, so job work never touches the API's event loop and
a crashing job can't take the API down.

## Run one manually

```bash
npm run build
npm run job -- sync-earnings-calendar   # or job:dev for tsx (no build)
node dist/jobs/run.js refresh-imminent
```

Jobs (registry in `src/jobs/run.ts`):

| Name | Populates | Cadence |
|---|---|---|
| `sync-earnings-calendar` | `earnings_events` (90d) | daily (+ on boot) |
| `sync-earnings-history` | `earnings_history` | daily (+ on boot) |
| `refresh-approaching` | `earnings_events` in (1h, 24h], unconfirmed | hourly |
| `refresh-imminent` | `earnings_events` in [~now, 1h], unconfirmed | every 5 min |
| `sync-earnings-odds` | `earnings_odds` (Polymarket) | hourly — *optional* |

The `assets` table is maintained **manually** (ticker → name → logo; logos
uploaded once to the `asset-logos` bucket). The earnings jobs join on it, so it
must be seeded before they can populate anything. Calendar/history timers are
staggered (08:15 / 08:30 UTC, +2/3 min after boot).

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
  hl-api-sync-earnings-calendar.timer \
  hl-api-sync-earnings-history.timer \
  hl-api-refresh-approaching.timer \
  hl-api-refresh-imminent.timer

# Optional — only if keeping Polymarket odds:
# systemctl enable --now hl-api-sync-earnings-odds.timer
```

## Ops

```bash
systemctl list-timers 'hl-api-*'                       # next/last run times
systemctl start hl-api-job@sync-earnings-calendar.service   # run one now
journalctl -u 'hl-api-job@refresh-imminent.service' -n 100   # logs (JSON)
```

---

## Approach B (planned): DB-backed per-event schedule

Approach A polls on wall-clock ticks, which is right for "to the hour" but can't
poll at per-event offsets or react the instant a time is confirmed. When those
become requirements, the evolution is a `earnings_refresh_schedule` table with a
`next_run_at`, processed by a **frequent oneshot** (`... where next_run_at <=
now() FOR UPDATE SKIP LOCKED`) rather than a long-running daemon — same process
model as today, with per-event precision.

The full reasoning, and why the oneshot beats a daemon, is in
`tmp/systems-design/liquidation-tracking.md`, which reuses the same pattern for
position refresh.
