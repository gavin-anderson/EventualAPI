import { config } from "../config/env.js";

const BASE = "https://www.alphavantage.co/query";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Alpha Vantage earnings data: the forward calendar (date + pre/post-market +
 * EPS estimate) and per-ticker quarterly history (EPS actual/estimate/surprise).
 *
 * The free key is 25 requests/day, so callers budget calls: the calendar is ONE
 * request for the whole US market, and history is one request per ticker.
 */

// ── Response types ────────────────────────────────────────────────────────────

/** One row of EARNINGS_CALENDAR (CSV). */
export interface AvCalendarRow {
  symbol: string;
  name: string;
  reportDate: string;        // YYYY-MM-DD (ET)
  fiscalDateEnding: string;  // YYYY-MM-DD, end of the quarter being reported
  estimate: number | null;   // consensus EPS
  currency: string;
  /** "pre-market" | "post-market" | "" (not yet known) */
  timeOfTheDay: string;
}

/** One entry of EARNINGS.quarterlyEarnings. */
export interface AvQuarter {
  fiscalDateEnding: string;
  reportedDate: string;
  reportedEPS: string;          // "None" when missing
  estimatedEPS: string;
  surprise: string;
  surprisePercentage: string;   // PERCENT, e.g. "2.4306"
  reportTime: string;           // "pre-market" | "post-market"
}

interface AvEarningsResponse {
  symbol?: string;
  quarterlyEarnings?: AvQuarter[];
}

/** Rate-limit / bad-key responses come back as 200 with one of these keys. */
export class AlphaVantageLimitError extends Error {}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Map Alpha Vantage's time-of-day to our session enum (null = unknown). */
export function toSession(timeOfDay: string): "bmo" | "amc" | null {
  if (timeOfDay === "pre-market") return "bmo";
  if (timeOfDay === "post-market") return "amc";
  return null;
}

/** Alpha Vantage writes missing numbers as "None" or "". */
export function toNumber(v: string | undefined): number | null {
  if (v === undefined || v === "" || v === "None") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Split one CSV line, honouring double-quoted fields (company names have commas). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCalendarCsv(csv: string): AvCalendarRow[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "");
  if (header[0] !== "symbol") {
    // Errors and limit notices come back as JSON instead of CSV.
    throw new AlphaVantageLimitError(`unexpected calendar response: ${csv.slice(0, 200)}`);
  }
  const col = (name: string) => header.indexOf(name);
  const idx = {
    symbol: col("symbol"), name: col("name"), reportDate: col("reportDate"),
    fiscalDateEnding: col("fiscalDateEnding"), estimate: col("estimate"),
    currency: col("currency"), timeOfTheDay: col("timeOfTheDay"),
  };
  return lines.slice(1).filter(Boolean).map((line) => {
    const f = parseCsvLine(line);
    return {
      symbol: f[idx.symbol] ?? "",
      name: f[idx.name] ?? "",
      reportDate: f[idx.reportDate] ?? "",
      fiscalDateEnding: f[idx.fiscalDateEnding] ?? "",
      estimate: toNumber(f[idx.estimate]),
      currency: f[idx.currency] ?? "",
      timeOfTheDay: idx.timeOfTheDay >= 0 ? (f[idx.timeOfTheDay] ?? "") : "",
    };
  });
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function get(params: Record<string, string>): Promise<string> {
  if (!config.alphaVantage.configured) {
    throw new Error("Alpha Vantage not configured (ALPHAVANTAGE_API_KEY missing)");
  }
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apikey", config.alphaVantage.apiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  return res.text();
}

/** The whole US market's upcoming earnings (one request). */
export async function fetchEarningsCalendar(
  horizon: "3month" | "6month" | "12month" = "3month",
): Promise<AvCalendarRow[]> {
  return parseCalendarCsv(await get({ function: "EARNINGS_CALENDAR", horizon }));
}

/** Quarterly earnings history for one ticker (one request), newest first. */
export async function fetchEarningsHistory(symbol: string): Promise<AvQuarter[]> {
  const body = await get({ function: "EARNINGS", symbol });
  const data = JSON.parse(body) as AvEarningsResponse & Record<string, unknown>;
  if (data.quarterlyEarnings) return data.quarterlyEarnings;
  // "Information"/"Note" = daily limit or demo key: stop spending calls.
  // Anything else (an unknown symbol returns {}) just means no coverage.
  const notice = data.Information ?? data.Note;
  if (notice) throw new AlphaVantageLimitError(`history for ${symbol}: ${String(notice)}`);
  return [];
}
