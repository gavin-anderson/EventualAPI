/**
 * Where an earnings event is in its reporting lifecycle, as the app shows it:
 *
 *   upcoming         → before the scheduled slot (a countdown)
 *   reportingSoon    → the slot has passed but no 8-K Item 2.02 has been seen
 *   reported         → EDGAR stamped the filing; `reportedAt` is that instant
 *   presumedReported → the window closed with no filing. Non-SEC filers (they
 *                      never confirm) and filings that land after the imminent
 *                      tier stops looking end up here.
 *
 * The slot is the calendar's session default (09:00 / 16:00 / 12:00 / 20:00 ET,
 * see sessionDefaultTime), so "reporting soon" starts at the slot, not before.
 *
 * The app recomputes the state from `windowStart`/`windowEnd`/`reportedAt` on
 * its own clock, so a cached payload still moves upcoming → reportingSoon →
 * presumedReported on time. Only the flip to `reported` needs fresh data.
 */

/**
 * How long after the slot an unconfirmed event stays "reporting soon". Matches
 * the imminent tier's look-back (refresh-imminent, fromHours=-3): after this,
 * nothing is polling EDGAR for the event, so a confirmation won't come.
 */
export const REPORTING_WINDOW_MS = 3 * 3_600_000;

export type ReportStatus = "upcoming" | "reportingSoon" | "reported" | "presumedReported";

export interface ReportState {
  status: ReportStatus;
  /** The filing instant, once EDGAR has confirmed it. Null otherwise. */
  reportedAt: string | null;
  /** When "reporting soon" starts: the scheduled slot (or the filing, once stamped). */
  windowStart: string;
  /** When an unconfirmed event stops being "reporting soon". */
  windowEnd: string;
}

interface StatusInput {
  earnings_at: string;
  time_precision: "exact" | "session";
  is_confirmed: boolean;
}

export function reportState(row: StatusInput, now: Date = new Date()): ReportState {
  const start = new Date(row.earnings_at);
  const windowStart = start.toISOString();
  const windowEnd = new Date(start.getTime() + REPORTING_WINDOW_MS).toISOString();

  if (row.is_confirmed && row.time_precision === "exact") {
    return { status: "reported", reportedAt: windowStart, windowStart, windowEnd };
  }

  const t = now.getTime();
  const status: ReportStatus =
    t < start.getTime() ? "upcoming"
    : t < start.getTime() + REPORTING_WINDOW_MS ? "reportingSoon"
    : "presumedReported";
  return { status, reportedAt: null, windowStart, windowEnd };
}
