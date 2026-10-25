/**
 * Timezone helpers. Earnings dates/times are given in US Eastern
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
/**
 * Minutes-since-midnight in America/New_York for a UTC instant (DST-aware). Used
 * to classify an exact-time earnings slot into pre/regular/after market when
 * we have a precise time (and thus no session code).
 */
export function etMinutesOfDay(iso: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(iso))) {
    if (p.type !== "literal") f[p.type] = Number(p.value);
  }
  return (f.hour ?? 0) * 60 + (f.minute ?? 0);
}

/** The America/New_York calendar date ("YYYY-MM-DD") of a UTC instant. */
export function etDateOf(iso: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** The America/New_York wall-clock time ("HH:MM:SS") of a UTC instant. */
export function etClockOf(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

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
