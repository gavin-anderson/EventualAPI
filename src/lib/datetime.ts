/**
 * Timezone helpers. Benzinga earnings dates/times are given in US Eastern
 * (America/New_York) wall-clock; we store UTC. Eastern alternates between EST
 * (UTC-5) and EDT (UTC-4) across DST, so a fixed offset is wrong half the year.
 * These helpers resolve the correct offset per-instant via Intl — no TZ library.
 */

/**
 * Milliseconds that America/New_York is offset from UTC at a given instant.
 * Negative because Eastern is behind UTC (e.g. -5h in winter, -4h in summer).
 */
function etOffsetMs(instant: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(instant))) {
    if (p.type !== "literal") f[p.type] = Number(p.value);
  }
  // Reinterpret the ET wall-clock as if it were UTC, then diff against the true
  // instant to recover the offset.
  const asUTC = Date.UTC(f.year!, f.month! - 1, f.day!, f.hour!, f.minute!, f.second!);
  return asUTC - instant;
}

/**
 * Convert an Eastern wall-clock date+time to a UTC ISO-8601 string, DST-aware.
 *
 * @param date "YYYY-MM-DD" (ET)
 * @param time "HH:MM:SS"  (ET)
 * @returns e.g. "2026-01-15T21:00:00.000Z"  (16:00 EST → 21:00 UTC)
 *               "2026-07-15T20:00:00.000Z"  (16:00 EDT → 20:00 UTC)
 */
export function etToUtcIso(date: string, time: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  if ([y, mo, d, h, mi, s].some((n) => n === undefined || Number.isNaN(n))) {
    throw new Error(`invalid ET datetime: "${date}" "${time}"`);
  }
  // Wall-clock reinterpreted as UTC, then corrected by the ET offset. A second
  // pass settles the rare case where the guess and true instant straddle a DST
  // boundary (offset at the guess differs from offset at the real instant).
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  let utc = guess - etOffsetMs(guess);
  utc = guess - etOffsetMs(utc);
  return new Date(utc).toISOString();
}
