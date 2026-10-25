/**
 * Job: Earnings Calendar Sync
 *
 * Pulls Alpha Vantage's 3-month earnings calendar for the whole US market (ONE
 * request — the free key allows 25/day) and upserts earnings_events for our
 * assets with the date, pre/post-market session and EPS estimate.
 *
 * EDGAR supplies each company's fiscal year end so the quarter label matches the
 * company's own (Apple's Sep quarter is Q4, not Q3), and, if results were
 * already filed on the report day, the exact release time.
 *
 * Run frequency: daily (events update slowly; the imminent refresh handles the
 * release itself).
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchEarningsCalendar } from "../lib/alphavantage.js";
import { fetchSubmissions, type Submissions } from "../lib/edgar.js";
import { calendarRowToRecord } from "../lib/earningsSource.js";
import { upsertEarningsEvent } from "../lib/earningsEvents.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

export async function syncEarningsCalendar(): Promise<void> {
  const log = logger.child({ job: "syncEarningsCalendar" });
  log.info("starting");

  if (!config.alphaVantage.configured) {
    log.warn("ALPHAVANTAGE_API_KEY not set — skipping");
    return;
  }

  const sb = supabaseAdmin();

  // 1. Load all assets to get tickers + their DB ids
  const { data: assets, error: assetsErr } = await sb
    .from("assets")
    .select("id, ticker");

  if (assetsErr || !assets?.length) {
    log.warn("no assets found — seed the assets table first");
    return;
  }

  const tickerToId = Object.fromEntries(
    (assets as Array<{ id: string; ticker: string }>).map((a) => [a.ticker, a.id]),
  );

  // 2. One calendar request covers every ticker
  let calendar;
  try {
    calendar = await fetchEarningsCalendar("3month");
  } catch (err) {
    log.error({ err }, "Alpha Vantage calendar fetch failed");
    return;
  }
  const ours = calendar.filter((r) => tickerToId[r.symbol]);

  // 3. Enrich with EDGAR (fiscal year + any same-day release), then upsert
  const subsCache = new Map<string, Submissions | null>();
  const subsFor = async (ticker: string): Promise<Submissions | null> => {
    if (!subsCache.has(ticker)) {
      const subs = await fetchSubmissions(ticker).catch((err) => {
        log.warn({ ticker, err }, "EDGAR lookup failed — using calendar quarters");
        return null;
      });
      subsCache.set(ticker, subs);
    }
    return subsCache.get(ticker) ?? null;
  };

  const touched = new Set<string>();
  let upserted = 0;

  for (const row of ours) {
    const assetId = tickerToId[row.symbol]!;
    const record = calendarRowToRecord(row, await subsFor(row.symbol));
    touched.add(`${assetId}|${record.period}|${record.periodYear}`);
    const res = await upsertEarningsEvent(sb, assetId, record);
    if (!res.ok) {
      log.error({ ticker: row.symbol, error: res.error }, "upsert failed");
    } else {
      upserted++;
    }
  }

  const settled = await settleStaleEvents(sb, touched, subsFor, log);

  const missing = Object.keys(tickerToId).filter((t) => !ours.some((r) => r.symbol === t));
  log.info({ upserted, settled, notInCalendar: missing.length }, "done");
}

/** How far back a release can be and still belong to a stale upcoming row. */
const STALE_LOOKBACK_DAYS = 45;

/**
 * Upcoming, unconfirmed rows the calendar no longer lists are usually quarters
 * that already reported earlier than projected (a stale row from an older
 * source, say, still showing META "next week" after it reported). When EDGAR
 * has a release in the weeks before the row's date, pin the row to it: that IS
 * the quarter's release. Rows with no such filing are left alone (manual
 * entries for non-SEC names, or a genuine date the calendar dropped).
 */
async function settleStaleEvents(
  sb: ReturnType<typeof supabaseAdmin>,
  touched: Set<string>,
  subsFor: (ticker: string) => Promise<Submissions | null>,
  log: typeof logger,
): Promise<number> {
  const { data, error } = await sb
    .from("earnings_events")
    .select("id, asset_id, period, period_year, earnings_at, assets ( ticker )")
    .gte("earnings_at", new Date().toISOString())
    .eq("is_confirmed", false);
  if (error) {
    log.error({ error: error.message }, "failed to query upcoming events");
    return 0;
  }

  type Row = {
    id: string; asset_id: string; period: string; period_year: number; earnings_at: string;
    assets: { ticker: string } | { ticker: string }[] | null;
  };
  let settled = 0;
  for (const r of (data ?? []) as unknown as Row[]) {
    if (touched.has(`${r.asset_id}|${r.period}|${r.period_year}`)) continue;
    const asset = Array.isArray(r.assets) ? r.assets[0] : r.assets;
    if (!asset) continue;
    const subs = await subsFor(asset.ticker);
    if (!subs) continue;

    const earliest = new Date(r.earnings_at).getTime() - STALE_LOOKBACK_DAYS * 86_400_000;
    const release = subs.earningsReleases.find((iso) => new Date(iso).getTime() >= earliest);
    if (!release) continue;

    const { error: upErr } = await sb
      .from("earnings_events")
      .update({
        earnings_at: release,
        time_precision: "exact",
        session: null,
        is_confirmed: true,
        source: "edgar",
        fetched_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    if (upErr) {
      log.error({ ticker: asset.ticker, error: upErr.message }, "settle failed");
    } else {
      settled++;
      log.info({ ticker: asset.ticker, was: r.earnings_at, released: release }, "stale event settled to its release");
    }
  }
  return settled;
}
