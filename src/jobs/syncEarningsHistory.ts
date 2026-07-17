/**
 * Job: Earnings History Sync
 *
 * Fetches past earnings releases from Benzinga (EPS actual, estimate, surprise)
 * and enriches each row with price_change_24h_pct computed from ClickHouse
 * candles centred around the reported_at timestamp.
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 * Run frequency: daily or after any known earnings release.
 */
import { query } from "../lib/clickhouse.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchHistoricalEarnings, isExactTime } from "../lib/benzinga.js";
import { etToUtcIso } from "../lib/datetime.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

interface CandlePriceRow {
  close: number;
}

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

        // Compute 24h price change from ClickHouse candles around reportedAt
        const priceChangePct = await compute24hPriceChange(asset.hl_coin, reportedAt).catch(
          () => null,
        );

        const { error } = await sb.from("earnings_history").upsert(
          {
            asset_id:             asset.id,
            reported_at:          reportedAt,
            eps_actual:           Number(e.eps),
            eps_estimate:         e.eps_est ? Number(e.eps_est) : null,
            eps_surprise_pct:     e.eps_surprise_percent ? Number(e.eps_surprise_percent) : null,
            price_change_24h_pct: priceChangePct,
            source:               "benzinga",
          },
          { onConflict: "asset_id,reported_at" },
        );

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
 * Compute the 24h price change around an earnings release by comparing
 * the close price of the 1h candle just before the event to the close price
 * of the 1h candle 24h after the event.
 *
 * Uses mark_px via candles (HL perp price, not equity spot price).
 */
async function compute24hPriceChange(
  coin: string,
  reportedAt: string,
): Promise<number | null> {
  const reportedMs = new Date(reportedAt).getTime();
  if (isNaN(reportedMs)) return null;

  const db = config.clickhouse.database;
  const dex = config.clickhouse.dex || undefined;
  const dexFilter = dex ? "AND dex = {dex:String}" : "";
  const params: Record<string, unknown> = {
    coin,
    before: Math.floor((reportedMs - 3_600_000) / 1000),        // 1h before
    after:  Math.floor((reportedMs + 24 * 3_600_000) / 1000),   // 24h after
  };
  if (dex) params.dex = dex;

  const [rows] = await Promise.all([
    query<CandlePriceRow & { label: string }>(
      "earnings_price_change",
      `SELECT
         multiIf(open_ts <= fromUnixTimestamp({before:Int64}), 'pre', 'post') AS label,
         argMax(close_px, open_ts) AS close
       FROM ${db}.candles
       WHERE coin = {coin:String}
         AND interval = '1h'
         AND open_ts BETWEEN fromUnixTimestamp({before:Int64}) - INTERVAL 2 HOUR
               AND fromUnixTimestamp({after:Int64}) + INTERVAL 2 HOUR
         ${dexFilter}
       GROUP BY label`,
      params,
    ),
  ]);

  const pre  = rows.find((r) => r.label === "pre")?.close;
  const post = rows.find((r) => r.label === "post")?.close;

  if (!pre || !post || pre === 0) return null;
  return Number(((post - pre) / pre * 100).toFixed(4));
}
