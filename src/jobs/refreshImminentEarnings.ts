/**
 * Job: Imminent Earnings Refresh
 *
 * Watches SEC EDGAR for the earnings release of events that are about to
 * happen, and pins each one to the exact second results were filed (8-K Item
 * 2.02). Until then an event carries only its pre/post-market slot from the
 * calendar. Targets ONLY the tickers with an imminent event and costs no Alpha
 * Vantage calls, so it can run every few minutes.
 *
 * Called by two self-gating tiers (see docs/JOBS.md and src/jobs/run.ts):
 *   - Approaching : fromHours=1,  toHours=24, hourly
 *   - Imminent    : fromHours=-3, toHours=1,  every 5 min
 * Both are unconfirmedOnly — once a release is stamped it won't move, so we stop
 * polling it. The imminent tier looks 3h back because a slot's stored time is a
 * default (16:00 for after-close) and the filing can land well after it.
 *
 * Each run ends by pushing any fresh release to every user (see
 * src/lib/earningsAlerts.ts) — after the refresh, and on every run rather than
 * only when this one stamped something, so a release stamped by a run that then
 * crashed is still announced.
 *
 * Scheduling: deferred — export the function for the scheduler to call.
 */
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchSubmissions, releaseOn } from "../lib/edgar.js";
import { etDateOf } from "../lib/datetime.js";
import { logger } from "../lib/logger.js";
import { notifyReleasedEarnings } from "../lib/earningsAlerts.js";

export interface RefreshImminentOptions {
  /**
   * Lower bound, hours from now. Negative includes the recent past as grace, so
   * an event isn't dropped the moment its stored time passes. Default -3.
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
  await pinReleases(opts);
  await notifyReleasedEarnings();
}

async function pinReleases(opts: RefreshImminentOptions): Promise<void> {
  const fromHours = opts.fromHours ?? -3;
  const toHours = opts.toHours ?? 12;
  const unconfirmedOnly = opts.unconfirmedOnly ?? true;
  const log = logger.child({ job: "refreshImminentEarnings", fromHours, toHours, unconfirmedOnly });
  log.info("starting");

  const sb = supabaseAdmin();

  // Window is [now + fromHours, now + toHours].
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
  log.info({ events: rows.length }, "imminent events found");

  let released = 0;
  for (const r of rows) {
    const asset = Array.isArray(r.assets) ? r.assets[0] : r.assets;
    if (!asset) continue;

    let subs;
    try {
      subs = await fetchSubmissions(asset.ticker);
    } catch (err) {
      log.error({ ticker: asset.ticker, err }, "EDGAR fetch failed");
      continue;
    }
    if (!subs) continue; // not an SEC filer — keeps its session slot

    const at = releaseOn(subs.earningsReleases, etDateOf(r.earnings_at));
    if (!at) continue;

    const { error: upErr } = await sb
      .from("earnings_events")
      .update({
        earnings_at: at,
        time_precision: "exact",
        session: null,
        is_confirmed: true,
        source: "edgar",
        fetched_at: new Date().toISOString(),
      })
      .eq("id", r.id);

    if (upErr) {
      log.error({ ticker: asset.ticker, error: upErr.message }, "update failed");
      continue;
    }
    released++;
    // Results just came out. The push goes from notifyReleasedEarnings() once
    // this loop is done.
    log.info({ ticker: asset.ticker, at }, "earnings released");
  }

  log.info({ checked: rows.length, released }, "done");
}
