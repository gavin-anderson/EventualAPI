/**
 * Job: Imminent Earnings Refresh
 *
 * Re-syncs the timing of earnings events that are about to happen — the window
 * where Benzinga sharpens a session slot into a confirmed exact time. Targets
 * ONLY the tickers with an imminent event (not the whole 90-day calendar), so
 * it can run frequently and cheaply. Idempotent: upserts on the fiscal-period
 * key, so re-running just overwrites the one row.
 *
 * Called by two self-gating tiers (see docs/JOBS.md and src/jobs/run.ts):
 *   - Approaching : fromHours=1,     toHours=24, hourly
 *   - Imminent    : fromHours=-0.25, toHours=1,  every 5 min
 * Both are unconfirmedOnly — a confirmed exact time won't move, so once pinned
 * we stop polling it.
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchUpcomingEarnings } from "../lib/benzinga.js";
import { upsertEarningsEvent } from "../lib/earningsEvents.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";

export interface RefreshImminentOptions {
  /**
   * Lower bound, hours from now. Negative includes the recent past as grace, so
   * an event isn't dropped the moment its stored time passes. Default -0.25.
   */
  fromHours?: number;
  /** Upper bound, hours from now. Default 12. */
  toHours?: number;
  /** Only refresh events not yet confirmed to an exact time. Default true. */
  unconfirmedOnly?: boolean;
}

interface AssetRef {
  id: string;
  ticker: string;
}

interface ImminentRow {
  id: string;
  earnings_at: string;
  // PostgREST returns a to-one embed as an object at runtime, but supabase-js
  // types it as an array without generated schema types — accept both.
  assets: AssetRef | AssetRef[] | null;
}

export async function refreshImminentEarnings(
  opts: RefreshImminentOptions = {},
): Promise<void> {
  const fromHours = opts.fromHours ?? -0.25;
  const toHours = opts.toHours ?? 12;
  const unconfirmedOnly = opts.unconfirmedOnly ?? true;
  const log = logger.child({ job: "refreshImminentEarnings", fromHours, toHours, unconfirmedOnly });
  log.info("starting");

  if (!config.benzinga.configured) {
    log.warn("BENZINGA_API_KEY not set — skipping");
    return;
  }

  const sb = supabaseAdmin();

  // Window is [now + fromHours, now + toHours]. A slightly-negative fromHours
  // gives grace so an event isn't dropped the moment its stored time passes.
  const lowerBound = new Date(Date.now() + fromHours * 3_600_000).toISOString();
  const upperBound = new Date(Date.now() + toHours * 3_600_000).toISOString();

  let q = sb
    .from("earnings_events")
    .select("id, earnings_at, assets ( id, ticker )")
    .gte("earnings_at", lowerBound)
    .lte("earnings_at", upperBound);

  // Day-of mode: skip events already pinned to a confirmed exact time.
  if (unconfirmedOnly) {
    q = q.or("is_confirmed.eq.false,time_precision.eq.session");
  }

  const { data, error } = await q;
  if (error) {
    log.error({ error: error.message }, "failed to query imminent events");
    return;
  }

  const rows = ((data ?? []) as unknown as ImminentRow[]);
  if (rows.length === 0) {
    log.info("no imminent events — nothing to refresh");
    return;
  }

  // Unique tickers → asset id (an event without a joined asset is skipped).
  const tickerToId: Record<string, string> = {};
  for (const r of rows) {
    const asset = Array.isArray(r.assets) ? r.assets[0] : r.assets;
    if (asset) tickerToId[asset.ticker] = asset.id;
  }
  const tickers = Object.keys(tickerToId);
  log.info({ events: rows.length, tickers: tickers.length }, "imminent events found");

  // Fetch only these tickers, over just enough days to cover the window.
  const days = Math.max(1, Math.ceil(toHours / 24) + 1);
  let earnings;
  try {
    earnings = await fetchUpcomingEarnings(tickers, days);
  } catch (err) {
    log.error({ err }, "Benzinga fetch failed");
    return;
  }

  let refreshed = 0;
  let changed = 0;
  for (const e of earnings) {
    const assetId = tickerToId[e.ticker];
    if (!assetId) continue;

    const res = await upsertEarningsEvent(sb, assetId, e, { detectChange: true });
    if (!res.ok) {
      log.error({ ticker: e.ticker, error: res.error }, "upsert failed");
      continue;
    }
    refreshed++;
    if (res.changed) {
      changed++;
      // A change here = the earnings timing just moved/firmed up — the hook a
      // future push-notification pipeline would listen on.
      log.info({ ticker: e.ticker }, "earnings timing changed");
    }
  }

  log.info({ refreshed, changed }, "done");
}
