/**
 * Job: Backfill Earnings Reactions (one-time / on-demand)
 *
 * Fills `earnings_history.price_change_24h_pct` for rows that ClickHouse can't
 * compute — i.e. earnings that happened BEFORE the Hyperliquid perp market existed
 * (no candles). Historical daily closes come from a free, key-free source (Yahoo
 * chart API — see lib/dailyPrices), since the reaction is a property of the
 * underlying stock, not the perp.
 *
 * Reference / final price (per Malcolm), keyed on the ET session of `reported_at`:
 *   - pre-market / morning (or intraday): ref = prior trading day's close,
 *                                          final = the report day's close
 *   - post-market:                        ref = the report day's close,
 *                                          final = the next trading day's close
 * (earnings_history has no session column, so the session is derived from the ET
 * clock of reported_at; session-only historical rows default to 20:00 ET = post.)
 *
 * Stored as a PERCENT (e.g. -8.86), matching the ClickHouse-computed values.
 *
 * Usage: node dist/jobs/run.js backfill-earnings-reactions [TICKER ...]
 *   with no tickers → every row where price_change_24h_pct IS NULL.
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchDailyCloses, type DailyClose } from "../lib/dailyPrices.js";
import { etMinutesOfDay } from "../lib/datetime.js";
import { logger } from "../lib/logger.js";

const ET_CLOSE_MIN = 16 * 60; // 16:00 ET

interface TargetRow {
  asset_id: string;
  reported_at: string;
  ticker: string;
}

export async function backfillEarningsReactions(tickers?: string[]): Promise<void> {
  const log = logger.child({ job: "backfillEarningsReactions" });
  const wanted = tickers?.length ? tickers.map((t) => t.toUpperCase()) : undefined;
  log.info({ tickers: wanted ?? "all-null" }, "starting");

  const sb = supabaseAdmin();

  const { data, error } = await sb
    .from("earnings_history")
    .select("asset_id, reported_at, assets!inner ( ticker )")
    .is("price_change_24h_pct", null);

  if (error) {
    log.error({ error: error.message }, "load failed");
    return;
  }

  const rows: TargetRow[] = ((data as unknown as Array<Record<string, unknown>>) ?? [])
    .map((r) => {
      const a = r.assets as { ticker: string } | { ticker: string }[] | null;
      const ticker = (Array.isArray(a) ? a[0]?.ticker : a?.ticker)?.toUpperCase() ?? "";
      return { asset_id: r.asset_id as string, reported_at: r.reported_at as string, ticker };
    })
    .filter((r) => r.ticker && (!wanted || wanted.includes(r.ticker)));

  if (!rows.length) {
    log.info("no rows to backfill");
    return;
  }

  // One price fetch per ticker, covering all its earnings dates (± a few days for
  // weekends/holidays), then compute each reaction from that window.
  const byTicker = new Map<string, TargetRow[]>();
  for (const r of rows) {
    const arr = byTicker.get(r.ticker) ?? [];
    arr.push(r);
    byTicker.set(r.ticker, arr);
  }

  let updated = 0;
  let skipped = 0;
  for (const [ticker, group] of byTicker) {
    const dates = group.map((r) => r.reported_at.slice(0, 10)).sort();
    const from = addDays(dates[0]!, -6);
    const to = addDays(dates[dates.length - 1]!, 6);

    let closes: DailyClose[];
    try {
      closes = await fetchDailyCloses(ticker, from, to);
    } catch (err) {
      log.error({ ticker, err }, "price fetch failed — skipping ticker");
      skipped += group.length;
      continue;
    }
    if (!closes.length) {
      log.warn({ ticker }, "no price data — skipping ticker");
      skipped += group.length;
      continue;
    }

    for (const r of group) {
      const pct = computeReaction(closes, r.reported_at);
      if (pct === null) {
        log.warn({ ticker, reported_at: r.reported_at }, "no surrounding closes — skipped");
        skipped++;
        continue;
      }
      const { error: upErr } = await sb
        .from("earnings_history")
        .update({ price_change_24h_pct: pct })
        .eq("asset_id", r.asset_id)
        .eq("reported_at", r.reported_at);
      if (upErr) {
        log.error({ ticker, reported_at: r.reported_at, error: upErr.message }, "update failed");
        skipped++;
      } else {
        updated++;
      }
    }
  }

  log.info({ updated, skipped }, "done");
}

/**
 * Reaction as a percent, using close-to-close per the session rule. Returns null if
 * the surrounding trading-day closes aren't available in `closes`.
 */
function computeReaction(closes: DailyClose[], reportedAtISO: string): number | null {
  const reportDate = reportedAtISO.slice(0, 10); // ET date ≈ UTC date for market-hours times
  const postMarket = etMinutesOfDay(reportedAtISO) >= ET_CLOSE_MIN;

  const closeOn = (d: string) => closes.find((c) => c.date === d)?.close ?? null;
  const prevClose = (d: string) => {
    for (let i = closes.length - 1; i >= 0; i--) if (closes[i]!.date < d) return closes[i]!.close;
    return null;
  };
  const nextClose = (d: string) => {
    for (let i = 0; i < closes.length; i++) if (closes[i]!.date > d) return closes[i]!.close;
    return null;
  };

  let ref: number | null;
  let final: number | null;
  if (postMarket) {
    ref = closeOn(reportDate) ?? prevClose(reportDate);
    final = nextClose(reportDate);
  } else {
    ref = prevClose(reportDate);
    final = closeOn(reportDate) ?? nextClose(reportDate);
  }

  if (ref === null || final === null || ref === 0) return null;
  return Number((((final - ref) / ref) * 100).toFixed(4));
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
