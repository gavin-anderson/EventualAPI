/**
 * Job: Earnings Calendar Sync
 *
 * Fetches upcoming earnings events from Benzinga for all tickers in the assets
 * table, then upserts earnings_events with datetime precision and EPS estimates.
 *
 * Benzinga time field can be "HH:MM:SS" (exact, preferred) or "amc"/"bmo"/"dmh"
 * (session only). We record both the timestamp and the precision so the UI can
 * display "June 21 at 4:00 PM ET" vs "June 21, after market close" appropriately.
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 * Run frequency: daily (events update slowly; run more often near major earnings).
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchUpcomingEarnings } from "../lib/benzinga.js";
import { upsertEarningsEvent } from "../lib/earningsEvents.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

export async function syncEarningsCalendar(): Promise<void> {
  const log = logger.child({ job: "syncEarningsCalendar" });
  log.info("starting");

  if (!config.benzinga.configured) {
    log.warn("BENZINGA_API_KEY not set — skipping");
    return;
  }

  const sb = supabaseAdmin();

  // 1. Load all assets to get tickers + their DB ids
  const { data: assets, error: assetsErr } = await sb
    .from("assets")
    .select("id, ticker");

  if (assetsErr || !assets?.length) {
    log.warn("no assets found — run syncAssets first");
    return;
  }

  const tickerToId = Object.fromEntries(
    (assets as Array<{ id: string; ticker: string }>).map((a) => [a.ticker, a.id]),
  );
  const tickers = Object.keys(tickerToId);

  // 2. Fetch upcoming earnings from Benzinga in batches of 50 tickers
  const BATCH = 50;
  let upserted = 0;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    try {
      const earnings = await fetchUpcomingEarnings(batch, 90);

      for (const e of earnings) {
        const assetId = tickerToId[e.ticker];
        if (!assetId) continue;

        const res = await upsertEarningsEvent(sb, assetId, e);
        if (!res.ok) {
          log.error({ ticker: e.ticker, error: res.error }, "upsert failed");
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
