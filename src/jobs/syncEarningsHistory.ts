/**
 * Job: Earnings History Sync
 *
 * Fetches past earnings releases from Alpha Vantage (EPS actual, estimate,
 * surprise, pre/post-market) and pins each to its exact release second from
 * SEC EDGAR where the 8-K is on file. Each row is enriched with
 * price_change_24h_pct computed from Hyperliquid candles around reported_at.
 *
 * Alpha Vantage history is one request per ticker and the free key allows 25 a
 * day (the calendar sync uses one), so each run spends at most `maxCalls`,
 * most-needed tickers first: never synced, then those with a release since
 * their last history row. A first backfill of every ticker spreads over a few
 * days; after that a run only touches tickers that just reported.
 *
 * Only SEC filers are attempted: Alpha Vantage has no data for the non-US
 * listings either, so skipping them saves calls.
 *
 * Run frequency: daily, or on demand with explicit tickers.
 */
import { fetchCandles } from "../lib/hyperliquid.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { AlphaVantageLimitError, fetchEarningsHistory, toNumber, toSession } from "../lib/alphavantage.js";
import { fetchSubmissions, releaseOn, tickerToCik } from "../lib/edgar.js";
import { sessionDefaultTime } from "../lib/earningsEvents.js";
import { etDateOf, etToUtcIso } from "../lib/datetime.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

const HISTORY_YEARS = 3;
/** Spacing between Alpha Vantage requests; the free tier rejects bursts. */
const CALL_SPACING_MS = 2_000;

export interface SyncHistoryOptions {
  /** Only these tickers (still subject to maxCalls). Empty = pick by need. */
  tickers?: string[];
  /** Alpha Vantage requests this run may spend. Default 20 of the 25/day. */
  maxCalls?: number;
}

type Asset = { id: string; hl_coin: string; ticker: string };

export async function syncEarningsHistory(opts: SyncHistoryOptions = {}): Promise<void> {
  const maxCalls = opts.maxCalls ?? 20;
  const log = logger.child({ job: "syncEarningsHistory", maxCalls });
  log.info("starting");

  if (!config.alphaVantage.configured) {
    log.warn("ALPHAVANTAGE_API_KEY not set — skipping");
    return;
  }

  const sb = supabaseAdmin();

  const { data: assets, error: assetsErr } = await sb
    .from("assets")
    .select("id, hl_coin, ticker");

  if (assetsErr || !assets?.length) {
    log.warn("no assets found — seed the assets table first");
    return;
  }

  const queue = await pickTickers(assets as Asset[], opts.tickers ?? []);
  log.info({ candidates: queue.length }, "tickers needing history");

  let calls = 0;
  let upserted = 0;

  for (const asset of queue) {
    if (calls >= maxCalls) break;
    if (calls > 0) await new Promise((r) => setTimeout(r, CALL_SPACING_MS));
    calls++;

    let quarters;
    try {
      quarters = await fetchEarningsHistory(asset.ticker);
    } catch (err) {
      if (err instanceof AlphaVantageLimitError) {
        log.warn({ ticker: asset.ticker, err: err.message }, "Alpha Vantage limit reached — stopping");
        break;
      }
      log.error({ ticker: asset.ticker, err }, "history fetch failed — continuing");
      continue;
    }

    const subs = await fetchSubmissions(asset.ticker).catch(() => null);
    const cutoff = new Date(Date.now() - HISTORY_YEARS * 365 * 86_400_000).toISOString().slice(0, 10);

    // Existing rows by ET report date, so a re-sync (or an EDGAR time a few
    // seconds off the old vendor's) updates the row instead of duplicating it.
    const { data: existing } = await sb
      .from("earnings_history")
      .select("id, reported_at")
      .eq("asset_id", asset.id);
    const existingByDate = new Map(
      ((existing ?? []) as Array<{ id: string; reported_at: string }>).map((r) => [etDateOf(r.reported_at), r.id]),
    );

    for (const q of quarters) {
      const epsActual = toNumber(q.reportedEPS);
      if (epsActual === null || q.reportedDate < cutoff) continue;

      const released = subs ? releaseOn(subs.earningsReleases, q.reportedDate) : null;
      const reportedAt = released ?? etToUtcIso(q.reportedDate, sessionDefaultTime(toSession(q.reportTime)));

      // Compute 24h price change from HL candles around reportedAt
      const priceChangePct = await compute24hPriceChange(asset.hl_coin, reportedAt).catch(
        () => null,
      );

      const surprisePct = toNumber(q.surprisePercentage);
      const row: Record<string, unknown> = {
        asset_id:         asset.id,
        reported_at:      reportedAt,
        eps_actual:       epsActual,
        eps_estimate:     toNumber(q.estimatedEPS),
        // Alpha Vantage gives a percent; the column is a fraction (0.0361 == 3.61%).
        eps_surprise_pct: surprisePct === null ? null : Number((surprisePct / 100).toFixed(6)),
        source:           released ? "alphavantage+edgar" : "alphavantage",
      };
      // Only write the reaction when HL actually had candles for it. Omitting the
      // column PRESERVES an existing value (e.g. a Yahoo backfill) instead of
      // clobbering it with null; HL wins for the dates it does cover.
      if (priceChangePct !== null) row.price_change_24h_pct = priceChangePct;

      const existingId = existingByDate.get(q.reportedDate);
      const { error } = existingId
        ? await sb.from("earnings_history").update(row).eq("id", existingId)
        : await sb.from("earnings_history").upsert(row, { onConflict: "asset_id,reported_at" });

      if (error) {
        log.error({ ticker: asset.ticker, error: error.message }, "upsert failed");
      } else {
        upserted++;
      }
    }
  }

  log.info({ calls, upserted, remaining: Math.max(0, queue.length - calls) }, "done");
}

/**
 * Order tickers by need: never synced first, then those whose latest past
 * earnings event is newer than their latest history row. Tickers already up to
 * date are left out. Non-SEC filers are skipped.
 */
async function pickTickers(assets: Asset[], only: string[]): Promise<Asset[]> {
  const ciks = await tickerToCik();
  const wanted = only.map((t) => t.toUpperCase());
  const pool = assets.filter((a) =>
    wanted.length ? wanted.includes(a.ticker.toUpperCase()) : ciks.has(a.ticker.toUpperCase()),
  );
  if (wanted.length) return pool;

  const sb = supabaseAdmin();
  const nowIso = new Date().toISOString();
  const [{ data: hist }, { data: events }] = await Promise.all([
    sb.from("earnings_history").select("asset_id, reported_at"),
    sb.from("earnings_events").select("asset_id, earnings_at").lt("earnings_at", nowIso),
  ]);

  const latest = (rows: Array<{ asset_id: string; at: string }>) => {
    const m = new Map<string, string>();
    for (const r of rows) if (!m.has(r.asset_id) || r.at > m.get(r.asset_id)!) m.set(r.asset_id, r.at);
    return m;
  };
  const lastHistory = latest(((hist ?? []) as Array<{ asset_id: string; reported_at: string }>)
    .map((r) => ({ asset_id: r.asset_id, at: r.reported_at })));
  const lastEvent = latest(((events ?? []) as Array<{ asset_id: string; earnings_at: string }>)
    .map((r) => ({ asset_id: r.asset_id, at: r.earnings_at })));

  const never = pool.filter((a) => !lastHistory.has(a.id));
  // A day's slack so a history row a few hours off the event's stored time still counts.
  const behind = pool.filter((a) => {
    const h = lastHistory.get(a.id);
    const e = lastEvent.get(a.id);
    return h && e && new Date(e).getTime() - new Date(h).getTime() > 86_400_000;
  });
  return [...never, ...behind];
}

/**
 * Compute the 24h price change around an earnings release by comparing the close
 * of the 1h candle just before the event to the close of the 1h candle 24h after.
 *
 * Reads Hyperliquid candles directly (mark price on the perp, not equity spot).
 * HL only has candles since the perp listed, so reports that predate the market
 * return null — those are filled by the `backfill-earnings-reactions` job from a
 * daily-close source instead.
 */
async function compute24hPriceChange(
  coin: string,
  reportedAt: string,
): Promise<number | null> {
  const reportedMs = new Date(reportedAt).getTime();
  if (isNaN(reportedMs)) return null;

  const preMs = reportedMs - 3_600_000;          // 1h before the release
  const postMs = reportedMs + 24 * 3_600_000;    // 24h after it

  // One request spans both sample points, padded 2h each side so a missing
  // candle at the boundary still has a neighbour to fall back on.
  const candles = await fetchCandles(
    config.hyperliquid.dex,
    coin,
    "1h",
    preMs - 2 * 3_600_000,
    postMs + 2 * 3_600_000,
  );
  if (candles.length === 0) return null;

  // Latest candle at or before each sample point — the equivalent of the old
  // argMax(close, open_ts) per bucket.
  const closeAtOrBefore = (atMs: number): number | null => {
    let best: number | null = null;
    let bestT = -Infinity;
    for (const c of candles) {
      if (c.t <= atMs && c.t > bestT) {
        const close = Number(c.c);
        if (Number.isFinite(close)) {
          best = close;
          bestT = c.t;
        }
      }
    }
    return best;
  };

  const pre = closeAtOrBefore(preMs);
  const post = closeAtOrBefore(postMs);

  if (!pre || !post || pre === 0) return null;
  return Number((((post - pre) / pre) * 100).toFixed(4));
}
