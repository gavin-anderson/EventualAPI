# Earnings data & reaction backfill

Brief status note — we'll circle back to expand coverage.

## Sources (since 2026-10-25)

Benzinga was dropped: the trial key covered only AAPL/MSFT/IBM/INTC and the full
plan is too expensive. See `EARNINGS_SOURCE_OPTIONS.md` for the comparison.

- **Alpha Vantage** — calendar (date, pre/post-market, EPS estimate; one call for the
  whole market) and per-ticker history (EPS actual/estimate/surprise). Free key =
  25 calls/day, personal use; needs a commercial licence before public launch.
- **SEC EDGAR** — exact release second (8-K Item 2.02 `acceptanceDateTime`) and each
  company's fiscal year end (for correct quarter labels). Free, public domain.
- **Not covered:** HYUNDAI, IBIDEN, KIOXIA, SMSN, SOFTBANK, BMNR (enter manually).
  6-K filers (ARM, ASML, BABA, NBIS, TSM) get dates/sessions but no exact time.

## Reaction (`price_change_24h_pct`) — how it's filled

Two sources feed the single `earnings_history.price_change_24h_pct` column,
partitioned by date:

- **Post-perp dates** → Hyperliquid `candleSnapshot`, via `sync-earnings-history`.
- **Pre-perp dates** (before the HL equity perp existed, ~2026‑06‑15) → one-time
  backfill from a free, key-free source (Yahoo chart API, `src/lib/dailyPrices.ts`),
  via the **`backfill-earnings-reactions`** job. Yahoo covers *all* tickers, so
  reactions are NOT the blocker — earnings *rows* are.

Details:
- `backfill-earnings-reactions` fills every row where `price_change_24h_pct IS NULL`
  (optional ticker args). `node dist/jobs/run.js backfill-earnings-reactions [TICKER...]`.
- `sync-earnings-history` no longer clobbers a non-null reaction with null on re-run
  (HL wins where it has candles; the backfill value is preserved otherwise).
- **Reference/final price rule** (per Malcolm), keyed on the ET session of `reported_at`
  (there's no `session` column on `earnings_history`, so it's derived from the ET clock):
  - pre-market / morning (or intraday): ref = prior trading day close, final = report-day close
  - post-market: ref = report-day close, final = next trading day close
- **Field scales:** `price_change_24h_pct` is a PERCENT (e.g. -8.86); `eps_surprise_pct`
  is a FRACTION (0.0361 == 3.61%). The app divides the reaction by 100, not the surprise.

## Open

Also open: `impliedMovePct` (options-implied move) has no source wired — ships `nil`
in the app. Needs an options-data provider (ORATS / Polygon options / Tradier). See the
implied-move methodology notes discussed with the team (ATM straddle / spot).

## Related

- Reaction backfill job: `src/jobs/backfillEarningsReactions.ts`
- Price source: `src/lib/dailyPrices.ts` (Yahoo; Stooq abandoned — JS anti-bot wall)
- Earnings sync: `src/jobs/syncEarnings{Calendar,History,Odds}.ts`
