import type { WebSocket } from "ws";
import { fetchMarketQuotes } from "../lib/hyperliquid.js";
import { config } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { resolveTickers } from "../lib/assetMap.js";

/**
 * The price hub: a single shared poll loop fanned out to all subscribed
 * WebSocket clients. State is per-process (see the multi-instance caveat in
 * ws/server.ts).
 *
 * - clients subscribe by TICKER; we resolve to `coin` and key everything on coin.
 * - one setInterval fetches EVERY market on the dex in a single Hyperliquid call
 *   (`metaAndAssetCtxs`), so the upstream cost is flat no matter how many coins
 *   or clients are subscribed.
 * - a quote is pushed only when the mark actually moves (push-on-change), and the
 *   current cached value is sent immediately on subscribe (current-on-subscribe).
 * - prices/changePct cross the wire as STRINGS (Decimal-safe on the client).
 *
 * `markPx` is used, never `midPx` — mark is the price HL liquidates against and
 * the two differ.
 */

const POLL_INTERVAL_MS = 2_000;

interface CoinState {
  mark: number;
  changePct: number;
  asOf: string;
}

// coin → the sockets subscribed to it
const coinSubs = new Map<string, Set<WebSocket>>();
// socket → the coins it is subscribed to (for O(1) cleanup on close)
const connCoins = new Map<WebSocket, Set<string>>();
// coin → the ticker a client used for it (echoed back on quote frames)
const coinTicker = new Map<string, string>();
// coin → last pushed state (also the current-on-subscribe cache)
const lastQuote = new Map<string, CoinState>();

let timer: NodeJS.Timeout | null = null;

function safeSend(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      logger.warn({ err }, "ws send failed");
    }
  }
}

function quoteFrame(coin: string, state: CoinState) {
  return {
    type: "quote",
    ticker: coinTicker.get(coin) ?? coin,
    coin,
    price: String(state.mark),
    changePct: state.changePct.toFixed(6),
    asOf: state.asOf,
  };
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    void pollOnce().catch((err) => logger.error({ err }, "ws price poll failed"));
  }, POLL_INTERVAL_MS);
  timer.unref?.();
}

function maybeStopTimer(): void {
  if (timer && coinSubs.size === 0) {
    clearInterval(timer);
    timer = null;
  }
}

/** Fetch the whole dex once and broadcast the subscribed coins that moved. */
async function pollOnce(): Promise<void> {
  if (coinSubs.size === 0) return;

  // One upstream call covers every market, so there is nothing to filter by
  // request — we just ignore coins nobody is watching.
  const quotes = await fetchMarketQuotes(config.hyperliquid.dex);
  const asOf = new Date().toISOString();

  for (const coin of coinSubs.keys()) {
    const q = quotes.get(coin);
    if (!q) continue;

    const mark = q.markPx;
    const prev = q.prevDayPx;
    const changePct = prev && prev > 0 ? (mark - prev) / prev : 0;

    // Push-on-change: skip when neither price nor 24h-change moved. asOf is
    // deliberately excluded — it advances every tick and would push every time.
    const previous = lastQuote.get(coin);
    if (previous && previous.mark === mark && previous.changePct === changePct) continue;

    const state: CoinState = { mark, changePct, asOf };
    lastQuote.set(coin, state);

    const frame = quoteFrame(coin, state);
    for (const ws of coinSubs.get(coin) ?? []) safeSend(ws, frame);
  }
}

/** Subscribe a socket to a set of tickers. Sends any cached quote immediately. */
export async function subscribe(ws: WebSocket, tickers: string[]): Promise<void> {
  const resolved = await resolveTickers(tickers);

  let conn = connCoins.get(ws);
  if (!conn) {
    conn = new Set();
    connCoins.set(ws, conn);
  }

  let added = false;
  for (const ticker of tickers) {
    const info = resolved.get(ticker.toUpperCase());
    if (!info) continue;
    const { coin } = info;

    let subs = coinSubs.get(coin);
    if (!subs) {
      subs = new Set();
      coinSubs.set(coin, subs);
    }
    subs.add(ws);
    conn.add(coin);
    coinTicker.set(coin, ticker.toUpperCase());
    added = true;

    const cached = lastQuote.get(coin);
    if (cached) safeSend(ws, quoteFrame(coin, cached));
  }

  if (added) {
    ensureTimer();
    // Fetch immediately so freshly-subscribed uncached coins get a value without
    // waiting a full poll interval.
    void pollOnce().catch((err) => logger.error({ err }, "ws price poll failed"));
  }
}

/** Unsubscribe a socket from a set of tickers. */
export async function unsubscribe(ws: WebSocket, tickers: string[]): Promise<void> {
  const resolved = await resolveTickers(tickers);
  const conn = connCoins.get(ws);

  for (const ticker of tickers) {
    const info = resolved.get(ticker.toUpperCase());
    if (!info) continue;
    const { coin } = info;

    const subs = coinSubs.get(coin);
    subs?.delete(ws);
    conn?.delete(coin);
    if (subs && subs.size === 0) coinSubs.delete(coin); // keep lastQuote as cache
  }

  maybeStopTimer();
}

/** Remove a socket entirely (on close/error). */
export function drop(ws: WebSocket): void {
  const conn = connCoins.get(ws);
  if (conn) {
    for (const coin of conn) {
      const subs = coinSubs.get(coin);
      subs?.delete(ws);
      if (subs && subs.size === 0) coinSubs.delete(coin);
    }
  }
  connCoins.delete(ws);
  maybeStopTimer();
}
