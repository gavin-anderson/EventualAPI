import type { SupabaseClient } from "@supabase/supabase-js";
import { etDateOf, etToUtcIso } from "./datetime.js";

/**
 * Shared transform + upsert for earnings_events, used by BOTH the full daily
 * calendar sync and the higher-frequency imminent refresh, so the mapping from
 * a source record to a stored row lives in exactly one place.
 *
 * Rows are keyed on (asset_id, period, period_year) — the fiscal quarter — NOT
 * on earnings_at, so a revised time UPDATES the quarter's row instead of
 * inserting a duplicate.
 */

/**
 * A vendor-neutral scheduled earnings release. Alpha Vantage supplies the date,
 * session and estimate; EDGAR later supplies `exactTime` once results are filed.
 */
export interface EarningsRecord {
  date: string;                          // YYYY-MM-DD (ET)
  /** "HH:MM:SS" ET when known to the second, else null (session only). */
  exactTime: string | null;
  session: "bmo" | "amc" | "dmh" | null;
  confirmed: boolean;
  period: string;                        // fiscal quarter, e.g. "Q4"
  periodYear: number;                    // fiscal year
  epsEstimate: number | null;
  source: string;
}

export interface EarningsEventRow {
  asset_id: string;
  period: string;
  period_year: number;
  earnings_at: string;
  time_precision: "exact" | "session";
  session: "bmo" | "amc" | "dmh" | null;
  is_confirmed: boolean;
  expected_eps: number | null;
  source: string;
  fetched_at: string;
}

/**
 * Default clock time (ET) for a session-only earnings slot, so timestamps are
 * at least sensibly ordered when the exact time isn't known yet:
 *   bmo → 09:00, amc → 16:00, dmh → 12:00, unknown → 20:00 (after-hours).
 * time_precision='session' is recorded alongside so the UI can show "after
 * market close" rather than a fake precise time.
 */
export function sessionDefaultTime(session: "bmo" | "amc" | "dmh" | null): string {
  switch (session) {
    case "bmo": return "09:00:00";
    case "amc": return "16:00:00";
    case "dmh": return "12:00:00";
    default:    return "20:00:00";
  }
}

/** Map an earnings record to a stored earnings_events row. */
export function buildEarningsEventRow(
  assetId: string,
  e: EarningsRecord,
): EarningsEventRow {
  const exact = e.exactTime !== null;
  return {
    asset_id: assetId,
    period: e.period,
    period_year: e.periodYear,
    earnings_at: etToUtcIso(e.date, e.exactTime ?? sessionDefaultTime(e.session)),
    time_precision: exact ? "exact" : "session",
    session: exact ? null : e.session,
    is_confirmed: e.confirmed,
    expected_eps: e.epsEstimate,
    source: e.source,
    fetched_at: new Date().toISOString(),
  };
}

export interface UpsertResult {
  ok: boolean;
  /** Only meaningful when opts.detectChange is set: did the timing/precision/confirm state change? */
  changed: boolean;
  error?: string;
}

interface ExistingRow {
  earnings_at: string;
  time_precision: string;
  session: "bmo" | "amc" | "dmh" | null;
  is_confirmed: boolean;
  source: string;
}

/**
 * Upsert one earnings event. With `detectChange`, reports whether the earnings
 * time, precision, or confirmation state actually moved — the signal the
 * imminent refresh uses (and a natural hook for an "earnings time confirmed"
 * push notification).
 *
 * A confirmed exact time is never downgraded: once EDGAR has stamped a release,
 * a later calendar sync for the same day only refreshes the estimate.
 */
export async function upsertEarningsEvent(
  sb: SupabaseClient,
  assetId: string,
  e: EarningsRecord,
  opts?: { detectChange?: boolean },
): Promise<UpsertResult> {
  let row = buildEarningsEventRow(assetId, e);

  const { data } = await sb
    .from("earnings_events")
    .select("earnings_at, time_precision, session, is_confirmed, source")
    .eq("asset_id", assetId)
    .eq("period", row.period)
    .eq("period_year", row.period_year)
    .maybeSingle();
  const existing = data as ExistingRow | null;

  if (
    existing &&
    existing.time_precision === "exact" &&
    existing.is_confirmed &&
    row.time_precision !== "exact" &&
    etDateOf(existing.earnings_at) === e.date
  ) {
    row = {
      ...row,
      earnings_at: existing.earnings_at,
      time_precision: "exact",
      session: existing.session,
      is_confirmed: true,
      source: existing.source,
    };
  }

  const changed =
    !!opts?.detectChange &&
    !!existing &&
    (new Date(existing.earnings_at).getTime() !== new Date(row.earnings_at).getTime() ||
      existing.time_precision !== row.time_precision ||
      existing.is_confirmed !== row.is_confirmed);

  const { error } = await sb
    .from("earnings_events")
    .upsert(row, { onConflict: "asset_id,period,period_year" });

  return { ok: !error, changed, error: error?.message };
}
