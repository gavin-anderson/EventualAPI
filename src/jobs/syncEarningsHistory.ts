/**
 * Job: Earnings History Sync
 *
 * Fetches past earnings releases from Benzinga (EPS actual, estimate, surprise)
 * and enriches each row with price_change_24h_pct computed from Hyperliquid
 * candles centred around the reported_at timestamp.
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 * Run frequency: daily or after any known earnings release.
 */
import { fetchCandles } from "../lib/hyperliquid.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchHistoricalEarnings, isExactTime } from "../lib/benzinga.js";
import { etToUtcIso } from "../lib/datetime.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

export async function syncEarningsHistory(): Promise<void> {
  const log = logger.child({ job: "syncEarningsHistory" });
  log.info("starting");

  if (!config.benzinga.configured) {
    log.warn("BENZINGA_API_KEY not set — skipping");
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

  type Asset = { id: string; hl_coin: string; ticker: string };
  const tickerToAsset = Object.fromEntries(
    (assets as Asset[]).map((a) => [a.ticker, a]),
  );
  const tickers = Object.keys(tickerToAsset);

  const BATCH = 50;
  let upserted = 0;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    try {
      const earnings = await fetchHistoricalEarnings(batch);

      for (const e of earnings) {
        // Only process past releases (eps actual is set)
        if (!e.eps) continue;

        const asset = tickerToAsset[e.ticker];
        if (!asset) continue;

        const exact = isExactTime(e.time);
        const reportedAt = etToUtcIso(e.date, exact ? e.time : "20:00:00");

        // Compute 24h price change from HL candles around reportedAt
        const priceChangePct = await compute24hPriceChange(asset.hl_coin, reportedAt).catch(
          () => null,
        );

        const row: Record<string, unknown> = {
          asset_id:         asset.id,
          reported_at:      reportedAt,
          eps_actual:       Number(e.eps),
          eps_estimate:     e.eps_est ? Number(e.eps_est) : null,
          eps_surprise_pct: e.eps_surprise_percent ? Number(e.eps_surprise_percent) : null,
          source:           "benzinga",
        };
        // Only write the reaction when HL actually had candles for it. Omitting the
        // column on conflict PRESERVES an existing value (e.g. a Stooq backfill) instead
        // of clobbering it with null; HL wins for the dates it does cover.
        if (priceChangePct !== null) row.price_change_24h_pct = priceChangePct;

        const { error } = await sb.from("earnings_history").upsert(row, {
          onConflict: "asset_id,reported_at",
        });

        if (error) {
          log.error({ ticker: e.ticker, error: error.message }, "upsert failed");
        } else {
          upserted++;
        }
      }
    } catch (err) {
      log.error({ batch, err }, "batch failed — continuing");
    }
  }

  log.info({ upserted }, "done");
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
