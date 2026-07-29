/**
 * Free, key-free daily-close fetcher via Yahoo Finance's v8 chart API. Used only
 * for the ONE-TIME historical earnings-reaction backfill (dates that predate the
 * Hyperliquid perp market, so ClickHouse has no candles). Unofficial endpoint — do
 * NOT build product features on this; it's a bootstrap for backfilling.
 *
 * (Stooq's free CSV was the original choice but is now behind a JS proof-of-work
 * anti-bot wall, so it can't be fetched headlessly.)
 *
 *   https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>?period1=&period2=&interval=1d
 */

export interface DailyClose {
  date: string; // "YYYY-MM-DD" (UTC date of the trading session)
  close: number;
}

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: unknown;
  };
}

/** Fetch daily closes for a US ticker over [from, to] (inclusive), ascending. */
export async function fetchDailyCloses(
  ticker: string,
  from: string,
  to: string,
): Promise<DailyClose[]> {
  const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${period1}&period2=${period2}&interval=1d`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo http ${res.status}`);

  const json = (await res.json()) as YahooChart;
  const result = json.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  const out: DailyClose[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close)) continue;
    const date = new Date(timestamps[i]! * 1000).toISOString().slice(0, 10);
    out.push({ date, close });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
