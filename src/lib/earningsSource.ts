import { toSession, type AvCalendarRow } from "./alphavantage.js";
import { fiscalPeriod, releaseOn, type Submissions } from "./edgar.js";
import { etClockOf } from "./datetime.js";
import type { EarningsRecord } from "./earningsEvents.js";

/**
 * Combine an Alpha Vantage calendar row with the company's EDGAR submissions
 * into one EarningsRecord. EDGAR contributes the fiscal year (for a correct
 * fiscal-quarter label) and, if results were already filed that day, the exact
 * release time. `subs` is null for non-SEC filers.
 */
export function calendarRowToRecord(
  row: AvCalendarRow,
  subs: Submissions | null,
): EarningsRecord {
  const { period, periodYear } = fiscalPeriod(row.fiscalDateEnding, subs?.fiscalYearEnd ?? null);
  const released = subs ? releaseOn(subs.earningsReleases, row.reportDate) : null;
  return {
    date: row.reportDate,
    exactTime: released ? etClockOf(released) : null,
    session: toSession(row.timeOfTheDay),
    confirmed: released !== null,
    period,
    periodYear,
    epsEstimate: row.estimate,
    source: released ? "edgar" : "alphavantage",
  };
}
