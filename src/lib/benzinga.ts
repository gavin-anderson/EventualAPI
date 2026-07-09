import { config } from "../config/env.js";

const BASE = "https://api.benzinga.com/api/v2.1/calendar/earnings";
const REQUEST_TIMEOUT_MS = 15_000;

// ── Response types ────────────────────────────────────────────────────────────

/**
 * A single Benzinga earnings record.
 *
 * Key fields for this app:
 *   date          YYYY-MM-DD of the announcement
 *   time          "HH:MM:SS" (exact) or "amc"/"bmo"/"dmh" (session only)
 *   date_confirmed 1 = confirmed, 0 = projected
 *   eps_est       consensus EPS estimate
 *   eps           actual EPS (null if not yet reported)
 *   eps_surprise_percent  beat/miss %
 */
export interface BenzingaEarning {
  id: string;
  date: string;                  // YYYY-MM-DD
  date_confirmed: 0 | 1;
  time: string;                  // "HH:MM:SS" or "amc"|"bmo"|"dmh"
  ticker: string;
  exchange: string;
  name: string;
  period: string;                // e.g. "Q1"
  period_year: number;
  eps: string | null;            // actual (null before release)
  eps_est: string | null;        // consensus estimate
  eps_prior: string | null;
  eps_surprise: string | null;
  eps_surprise_percent: string | null;
  revenue: string | null;
  revenue_est: string | null;
  revenue_surprise_percent: string | null;
  importance: number;
  updated: number;               // unix timestamp
}

interface BenzingaResponse {
  earnings: BenzingaEarning[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determines whether a Benzinga `time` field is an exact clock time.
 * Benzinga returns either "HH:MM:SS" (exact) or "amc"/"bmo"/"dmh" (session).
 */
export function isExactTime(time: string): boolean {
  return /^\d{2}:\d{2}:\d{2}$/.test(time);
}

/**
 * Map a Benzinga session string to our schema's session enum.
 * Returns null when the time field is an exact HH:MM:SS (not a session string).
 */
export function toSession(time: string): "bmo" | "amc" | "dmh" | null {
  if (time === "bmo" || time === "amc" || time === "dmh") return time;
  return null;
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function fetchEarnings(params: Record<string, string>): Promise<BenzingaEarning[]> {
  if (!config.benzinga.configured) {
    throw new Error("Benzinga not configured (BENZINGA_API_KEY missing)");
  }
  const url = new URL(BASE);
  url.searchParams.set("token", config.benzinga.apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Benzinga API error: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as BenzingaResponse;
  return data.earnings ?? [];
}

/** Upcoming earnings (next `days` calendar days). */
export function fetchUpcomingEarnings(
  tickers: string[],
  days = 90,
): Promise<BenzingaEarning[]> {
  const from = new Date();
  const to = new Date(Date.now() + days * 86_400_000);
  return fetchEarnings({
    tickers: tickers.join(","),
    date_from: from.toISOString().slice(0, 10),
    date_to: to.toISOString().slice(0, 10),
    "parameters[importance]": "0",  // all importance levels
  });
}

/** Historical earnings (past `days` calendar days). */
export function fetchHistoricalEarnings(
  tickers: string[],
  days = 365 * 3,
): Promise<BenzingaEarning[]> {
  const to = new Date();
  const from = new Date(Date.now() - days * 86_400_000);
  return fetchEarnings({
    tickers: tickers.join(","),
    date_from: from.toISOString().slice(0, 10),
    date_to: to.toISOString().slice(0, 10),
    "parameters[importance]": "0",
  });
}
