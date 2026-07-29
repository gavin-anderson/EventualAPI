# Earnings data & reaction backfill

Brief status note — we'll circle back to expand coverage.

## The blocker: Benzinga key is a limited/trial plan

The current `BENZINGA_API_KEY` only returns earnings for **AAPL, MSFT, IBM, INTC**
(~4–5 quarters each). Every other ticker returns an empty array. Verified 2026‑07‑26:

```
AAPL: 4   MSFT: 4   IBM: 5   INTC: 5     ← entitled
TSLA, META, MU, AMD, GOOGL, AMZN: []     ← not entitled
```

**Impact:** only 4 of the 52 `equity`-kind assets have any `earnings_events` /
`earnings_history` rows. This is a data-entitlement limit, not a code bug. The sync
jobs (`sync-earnings-calendar`, `sync-earnings-history`) work correctly; they just
get nothing back for un-entitled tickers.

## Reaction (`price_change_24h_pct`) — how it's filled

Two sources feed the single `earnings_history.price_change_24h_pct` column,
partitioned by date:

- **Post-perp dates** → ClickHouse candles, computed by `sync-earnings-history`.
- **Pre-perp dates** (before the HL equity perp existed, ~2026‑06‑15) → one-time
  backfill from a free, key-free source (Yahoo chart API, `src/lib/dailyPrices.ts`),
  via the **`backfill-earnings-reactions`** job. Yahoo covers *all* tickers, so
  reactions are NOT the blocker — earnings *rows* are.

Details:
- `backfill-earnings-reactions` fills every row where `price_change_24h_pct IS NULL`
  (optional ticker args). `node dist/jobs/run.js backfill-earnings-reactions [TICKER...]`.
- `sync-earnings-history` no longer clobbers a non-null reaction with null on re-run
  (ClickHouse wins where it has data; backfill is preserved otherwise).
- **Reference/final price rule** (per Malcolm), keyed on the ET session of `reported_at`
  (there's no `session` column on `earnings_history`, so it's derived from the ET clock):
  - pre-market / morning (or intraday): ref = prior trading day close, final = report-day close
  - post-market: ref = report-day close, final = next trading day close
- **Field scales:** `price_change_24h_pct` is a PERCENT (e.g. -8.86); `eps_surprise_pct`
  is a FRACTION (0.0361 == 3.61%). The app divides the reaction by 100, not the surprise.

## To get earnings + reactions for ALL assets (next pass)

Reactions require earnings rows, which require broader earnings coverage. Options:

- **A — Upgrade Benzinga** to full ticker coverage + deeper history. Smallest change:
  just re-run `sync-earnings-history`, then `backfill-earnings-reactions`.
- **B — FMP (Financial Modeling Prep)** free/cheap tier has historical earnings
  (dates + EPS actual/estimate/surprise) AND historical daily prices for all tickers —
  could replace both Benzinga-history and the Yahoo backfill in one source.
- **C — Hybrid:** earnings dates/EPS from FMP (or similar) for all tickers; keep the
  existing Yahoo reaction backfill.

Also open: `impliedMovePct` (options-implied move) has no source wired — ships `nil`
in the app. Needs an options-data provider (ORATS / Polygon options / Tradier). See the
implied-move methodology notes discussed with the team (ATM straddle / spot).

## Related

- Reaction backfill job: `src/jobs/backfillEarningsReactions.ts`
- Price source: `src/lib/dailyPrices.ts` (Yahoo; Stooq abandoned — JS anti-bot wall)
- Earnings sync: `src/jobs/syncEarnings{Calendar,History,Odds}.ts`
