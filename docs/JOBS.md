# Scheduled jobs

The sync jobs run **out of process** from the API server. In production that is
the Heroku `worker` dyno running `src/jobs/scheduler.ts` (see
[On Heroku](#on-heroku)); on a self-hosted box the systemd timers in
`deploy/systemd/` do the same job. Either way each run is its own
`node dist/jobs/run.js <name>` process, so job work never touches the API's event
loop and a crashing job can't take the API down.

## Run one manually

```bash
npm run build
npm run job -- sync-earnings-calendar   # or job:dev for tsx (no build)
node dist/jobs/run.js refresh-imminent

heroku run npm run job -- sync-earnings-calendar   # one-off dyno on Heroku
```

Jobs (registry in `src/jobs/run.ts`):

| Name | Populates | Cadence |
|---|---|---|
| `sync-earnings-calendar` | `earnings_events` (3 months, Alpha Vantage + EDGAR; 1 AV call) | daily (+ on boot) |
| `sync-earnings-history` | `earnings_history` (≤20 AV calls/run, most-needed tickers first) | daily (+ on boot) |
| `refresh-approaching` | `earnings_events` in (1h, 24h], unconfirmed — EDGAR only | hourly |
| `refresh-imminent` | `earnings_events` in [-3h, 1h], unconfirmed — EDGAR only; then pushes "earnings are out" to every user for each fresh release (claimed once via `released_notified_at`) | every 5 min |
| `sync-earnings-odds` | `earnings_odds` (Polymarket) | hourly (systemd timer optional) |
| `refresh-positions` | `wallet_open_positions` for due wallets | every 30s (budget-capped) |
| `evaluate-risk` | nothing — logs liquidation proximity | every 30s, **shadow mode** |
| `detect-liquidations` | `liquidation_events` + a push; closes the `positions` row on a full liquidation | every minute |
| `backfill-earnings-reactions` | `earnings_history.price_change_24h_pct` for pre-perp dates (Yahoo) | by hand only — see [EARNINGS_DATA.md](EARNINGS_DATA.md) |

The calendar and history syncs need `ALPHAVANTAGE_API_KEY`; the EDGAR lookups
should have `SEC_USER_AGENT` set (SEC asks for a contact email in it). The free
Alpha Vantage key allows 25 requests a day, which the daily calendar call plus up
to 20 history calls is sized to fit.

## Liquidation tracking

Two jobs, split because liquidation proximity depends on two numbers that change
at very different rates:

| | changes when | cost |
|---|---|---|
| `liquidationPx` | the **position** changes | one HL call **per wallet** |
| mark price | the **market** moves | one HL call **for every market** |

So `refresh-positions` is slow and budget-capped, while `evaluate-risk` runs
often and costs the same at any scale. The fast-moving input is the cheap one,
which is what makes near-real-time detection affordable on top of slow refresh.

`detect-liquidations` is the one liquidation notification we actually send, and
it is **past tense**: "you were liquidated" is never a false positive. A
proximity warning has almost no useful lead time at high leverage — a 20x
position 90% of the way to liquidation has roughly 0.5% of price left, which
arrives as a death notice rather than a warning.

Detection requires `liquidation.liquidatedUser` to equal the wallet itself. The
field alone is not enough: on your account it usually means you were the
counterparty who absorbed someone else's position, so the naive check notifies
the wrong person. Idempotency comes from the `liquidation_events` primary key —
a duplicate "you were liquidated" would be alarming.

`evaluate-risk` is in **shadow mode**: it computes proximity, logs it, and sends
nothing. What to alert on is a separate product decision, and this pipeline does
not depend on the answer — running it silently produces the data that decision
needs. Watch `liqPriceStalenessP95` in its output: if liquidation prices barely
move between refreshes, `refresh-positions` can slow down.

Now that only the past-tense notification ships, shadow mode is no longer
blocking a decision — it is there to show whether proximity warnings would be
worth adding later.

Note `consumed` is only comparable across **isolated** positions, where runway
is roughly 1/leverage. Under cross margin the liquidation price depends on total
account health, so the log splits isolated from cross.

The earnings jobs join on the `assets` table, so it must be populated before they
can write anything. It is maintained by hand with the `intake` and `art` CLIs —
see [ASSET_CATALOGUE.md](ASSET_CATALOGUE.md). Calendar/history runs are staggered
at 08:15 / 08:30 UTC.

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
handful — then checks EDGAR for **just those tickers**. So the
EDGAR cost scales with **# of imminent events, not # of stocks**; the only
all-rows cost is one index seek per tick. On a day with nothing near, each tier is
a single query that returns zero rows and exits.

### No duplicate jobs per event

There are a **fixed number of timers regardless of event count** — the design
structurally can't spawn a job per event. Neither the scheduler nor systemd will
overlap-run the same job, and every upsert is idempotent on the fiscal-period key
`(asset_id, period, period_year)`, so even the tier overlap at a boundary just
overwrites one row.

### Restart / downtime behaviour (systemd)

On Heroku the daily syncs deliberately do not catch up after a restart; see
below.

- `Persistent=true` on the daily discovery timers **re-runs a missed daily on
  boot** (box was down at 08:00, comes up at 10:00 → runs at 10:00).
- `OnBootSec=1/2/3min` also runs the discovery chain shortly after **every** boot,
  so a box that comes back up re-establishes fresh state immediately.
- The refresh tiers are stateless: on reboot the timers simply resume ticking.
  Nothing to rebuild.

## On Heroku

The `worker` process in the Procfile runs `src/jobs/scheduler.ts`, which mirrors
the timers below (same names, same UTC times) and spawns each run as its own
`run.js` process. It skips a tick if that job's previous run is still going and
kills a run after 10 minutes.

- Scale it to **exactly one** dyno (`heroku ps:scale worker=1`): two would run
  every job twice and double the liquidation push.
- Use Basic or above. Eco dynos sleep, and the jobs would silently stop.
- The daily syncs do **not** run on boot here (unlike `OnBootSec`): Heroku
  restarts dynos daily and on deploy, and a run per restart would spend the
  Alpha Vantage quota. Run one by hand with `heroku run npm run job -- <name>`.
- Changing a cadence means changing both `scheduler.ts` and its timer.
- A failed or timed-out run is logged by the scheduler (`scheduler: job failed`)
  and the next tick runs normally. Nothing alerts on it yet.

```bash
heroku ps                                   # web=1, worker=1
heroku ps:scale worker=1
heroku logs --tail --dyno worker            # job logs (JSON, via pino)
heroku run npm run job -- refresh-imminent  # run one now
```

## Self-hosted alternative: systemd

The units in `deploy/systemd/` predate Heroku and are kept for running on a box.
They are not used in production. Same job names and the same UTC schedule as
`scheduler.ts`.

### Install on the box (as root)

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
  hl-api-refresh-imminent.timer \
  hl-api-refresh-positions.timer \
  hl-api-evaluate-risk.timer \
  hl-api-detect-liquidations.timer

# Optional — only if keeping Polymarket odds:
# systemctl enable --now hl-api-sync-earnings-odds.timer
```

### Ops

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
