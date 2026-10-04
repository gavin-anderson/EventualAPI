const REQUEST_TIMEOUT_MS = 10_000;

/** Hyperliquid's public info endpoint. No auth, no proxy. */
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

/**
 * Read from Hyperliquid's public `/info` endpoint directly.
 *
 * Previously this went through an EU proxy to work around a geo-block. That
 * block is gone — verified 2026-10-03 that api.hyperliquid.xyz answers directly,
 * including for the `xyz` builder dex — so the proxy hop, its key, and the
 * "not configured" gate it implied are all removed.
 */
async function hlPost<T>(type: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HL ${type} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/** Strip a dex prefix: HL names assets "xyz:TSLA"; we key on the bare coin. */
export function bareCoin(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

// ── Response types ────────────────────────────────────────────────────────────

export interface MarginSummary {
  accountValue: string;
  totalMarginUsed: string;
  totalNtlPos: string;
  totalRawUsd: string;
}

export interface PositionData {
  coin: string;
  szi: string;                 // signed size; positive = long
  entryPx: string | null;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  leverage: { type: string; value: number; rawUsd: string };
  maxLeverage: number;
  marginUsed: string;
  cumFunding: { allTime: string; sinceOpen: string };
  liquidationPx: string | null;
}

export interface AssetPosition {
  position: PositionData;
  type: string;
}

export interface ClearinghouseState {
  marginSummary: MarginSummary;
  assetPositions: AssetPosition[];
  withdrawable: string;
  time: number;
}

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";          // B = buy, A = sell/ask
  time: number;              // unix ms
  startPosition: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  feeToken: string;
  /**
   * What the fill did: "Open Long" | "Close Long" | "Open Short" |
   * "Close Short" | "Long > Short" | "Short > Long" | "Settlement".
   * Present on every fill observed; the "X > Y" forms are position flips.
   */
  dir: string;
  /**
   * Client order id, echoed back when the order carried one. ~80% of sampled
   * live fills have it. This is how we tie a fill to a trade the app told us
   * about, without replaying net size.
   */
  cloid?: string;
  /**
   * Builder fee, present only when a builder code was attached. Absent across
   * all 10k fills sampled 2026-10-03 — nothing populates it until we start
   * charging one (see tmp/systems-design/referrals.md).
   */
  builderFee?: string;
  /**
   * Present only on fills that were part of a liquidation.
   *
   * CAREFUL: its presence does NOT mean this wallet was liquidated. A fill on
   * your account carrying this usually means you were the counterparty who
   * absorbed someone else's position — `dir: "Open …"`, `closedPnl: 0`, and
   * `liquidatedUser` set to a different address.
   *
   * This wallet was liquidated only when `liquidatedUser` equals it. Verified
   * from both sides against live fills, 2026-10-04.
   */
  liquidation?: {
    liquidatedUser: string;
    markPx: string;
    method: string;
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * A user's perp account state.
 *
 * `dex` MUST be passed for HIP-3 builder dexes. Omitting it returns the DEFAULT
 * perp dex instead — so an app position on `xyz` simply isn't in the response,
 * and the caller silently sees an account with no positions.
 */
export function fetchClearinghouseState(
  wallet: string,
  dex?: string,
): Promise<ClearinghouseState> {
  return hlPost<ClearinghouseState>("clearinghouseState", {
    user: wallet,
    ...(dex ? { dex } : {}),
  });
}

export function fetchUserFills(
  wallet: string,
  startTime: number,
  endTime?: number,
): Promise<HlFill[]> {
  return hlPost<HlFill[]>("userFillsByTime", {
    user: wallet,
    startTime,
    ...(endTime !== undefined ? { endTime } : {}),
  });
}


// ── Market data ───────────────────────────────────────────────────────────────

// ── Market data ───────────────────────────────────────────────────────────────

interface RawAssetCtx {
  markPx: string | null;
  midPx: string | null;
  prevDayPx: string | null;
}

interface RawUniverseAsset {
  name: string;
  szDecimals: number;
  maxLeverage?: number;
}

export interface MarketQuote {
  coin: string;
  /** Mark price — what HL liquidates against. Never use mid; the two differ. */
  markPx: number;
  prevDayPx: number | null;
}

function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every market on a dex in ONE call, keyed on the bare coin.
 *
 * This is what makes liquidation evaluation cheap: liquidation prices barely
 * move, but marks move constantly — and the fast-changing half costs a single
 * request no matter how many users or positions exist.
 */
export async function fetchMarketQuotes(dex: string): Promise<Map<string, MarketQuote>> {
  const [meta, ctxs] = await hlPost<[{ universe: RawUniverseAsset[] }, RawAssetCtx[]]>(
    "metaAndAssetCtxs",
    dex ? { dex } : undefined,
  );
  const out = new Map<string, MarketQuote>();

  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx) return;
    const markPx = num(ctx.markPx) ?? num(ctx.midPx);
    if (markPx === null || markPx <= 0) return;
    const coin = bareCoin(asset.name);
    out.set(coin, { coin, markPx, prevDayPx: num(ctx.prevDayPx) });
  });
  return out;
}

/** One candle from `candleSnapshot`: `t` open ms, `c` close price. */
export interface Candle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
}

/**
 * Historical candles for a bare coin on `dex` over [startMs, endMs].
 *
 * Only covers the period since the perp listed — earlier dates come back empty,
 * which is what the Yahoo-based `backfill-earnings-reactions` job is for.
 */
export function fetchCandles(
  dex: string,
  coin: string,
  interval: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const fullName = dex ? `${dex}:${coin}` : coin;
  return hlPost<Candle[]>("candleSnapshot", {
    req: { coin: fullName, interval, startTime: startMs, endTime: endMs },
  });
}
