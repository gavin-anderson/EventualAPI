import type { SupabaseClient } from "@supabase/supabase-js";
import { isExactTime, toSession, type BenzingaEarning } from "./benzinga.js";
import { etToUtcIso } from "./datetime.js";

/**
 * Shared transform + upsert for earnings_events, used by BOTH the full daily
 * calendar sync and the higher-frequency imminent refresh, so the mapping from
 * a Benzinga record to a stored row lives in exactly one place.
 *
 * Rows are keyed on (asset_id, period, period_year) — the fiscal quarter — NOT
 * on earnings_at, so a revised time UPDATES the quarter's row instead of
 * inserting a duplicate.
 */

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
 * at least sensibly ordered when Benzinga doesn't give an exact time:
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

/** Calendar-quarter fallback (Q1..Q4) when Benzinga omits the fiscal period. */
export function deriveQuarter(date: string): string {
  const month = Number(date.slice(5, 7));
  return `Q${Math.floor((month - 1) / 3) + 1}`;
}

/** Map a Benzinga earnings record to a stored earnings_events row. */
export function buildEarningsEventRow(
  assetId: string,
  e: BenzingaEarning,
): EarningsEventRow {
  const exact = isExactTime(e.time);
  const session = toSession(e.time);
  const clock = exact ? e.time : sessionDefaultTime(session);
  return {
    asset_id: assetId,
    period: e.period || deriveQuarter(e.date),
    period_year: e.period_year || Number(e.date.slice(0, 4)),
    earnings_at: etToUtcIso(e.date, clock),
    time_precision: exact ? "exact" : "session",
    session: exact ? null : session,
    is_confirmed: e.date_confirmed === 1,
    expected_eps: e.eps_est ? Number(e.eps_est) : null,
    source: "benzinga",
    fetched_at: new Date().toISOString(),
  };
}

export interface UpsertResult {
  ok: boolean;
  /** Only meaningful when opts.detectChange is set: did the timing/precision/confirm state change? */
  changed: boolean;
  error?: string;
}

/**
 * Upsert one earnings event. With `detectChange`, first reads the existing row
 * for the same fiscal quarter and reports whether the earnings time, precision,
 * or confirmation state actually moved — the signal the imminent refresh uses
 * (and a natural hook for a future "earnings time confirmed" push notification).
 */
export async function upsertEarningsEvent(
  sb: SupabaseClient,
  assetId: string,
  e: BenzingaEarning,
  opts?: { detectChange?: boolean },
): Promise<UpsertResult> {
  const row = buildEarningsEventRow(assetId, e);

  let changed = false;
  if (opts?.detectChange) {
    const { data: existing } = await sb
      .from("earnings_events")
      .select("earnings_at, time_precision, is_confirmed")
      .eq("asset_id", assetId)
      .eq("period", row.period)
      .eq("period_year", row.period_year)
      .maybeSingle();

    if (existing) {
      const ex = existing as {
        earnings_at: string;
        time_precision: string;
        is_confirmed: boolean;
      };
      changed =
        new Date(ex.earnings_at).getTime() !== new Date(row.earnings_at).getTime() ||
        ex.time_precision !== row.time_precision ||
        ex.is_confirmed !== row.is_confirmed;
    }
  }

  const { error } = await sb
    .from("earnings_events")
    .upsert(row, { onConflict: "asset_id,period,period_year" });

  return { ok: !error, changed, error: error?.message };
}
