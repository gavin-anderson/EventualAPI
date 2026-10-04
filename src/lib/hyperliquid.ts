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
}

// ── API calls ─────────────────────────────────────────────────────────────────

export function fetchClearinghouseState(wallet: string): Promise<ClearinghouseState> {
  return hlPost<ClearinghouseState>("clearinghouseState", { user: wallet });
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

/** Per-asset context from `metaAndAssetCtxs`. Numeric fields are decimal strings. */
interface RawAssetCtx {
  markPx: string | null;
  midPx: string | null;
  oraclePx: string | null;
  prevDayPx: string | null;
  openInterest: string | null;
  funding: string | null;
  dayNtlVlm: string | null;
}

interface RawUniverseAsset {
  name: string;
  szDecimals: number;
  maxLeverage?: number;
}

/** One market's current state, keyed by bare coin (no dex prefix). */
export interface MarketQuote {
  coin: string;
  /** Mark price — what HL liquidates against. Prefer this over mid. */
  markPx: number;
  /** Previous day's price, for 24h change. Null when HL omits it. */
  prevDayPx: number | null;
  openInterest: number | null;
  dayNtlVlm: number | null;
  funding: number | null;
  szDecimals: number;
  maxLeverage: number | null;
}

function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every market on a dex in ONE call. Returns a map keyed on the BARE coin
 * ("TSLA", not "xyz:TSLA") so it lines up with `assets.hl_coin` and with what the
 * app subscribes by.
 *
 * `markPx` is the liquidation-relevant price and is what callers should use;
 * `midPx` differs slightly and is deliberately not exposed.
 */
export async function fetchMarketQuotes(dex: string): Promise<Map<string, MarketQuote>> {
  const raw = await hlPost<[{ universe: RawUniverseAsset[] }, RawAssetCtx[]]>(
    "metaAndAssetCtxs",
    dex ? { dex } : undefined,
  );
  const [meta, ctxs] = raw;
  const out = new Map<string, MarketQuote>();

  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx) return;
    const markPx = num(ctx.markPx) ?? num(ctx.midPx);
    if (markPx === null || markPx <= 0) return;
    const coin = bareCoin(asset.name);
    out.set(coin, {
      coin,
      markPx,
      prevDayPx: num(ctx.prevDayPx),
      openInterest: num(ctx.openInterest),
      dayNtlVlm: num(ctx.dayNtlVlm),
      funding: num(ctx.funding),
      szDecimals: asset.szDecimals,
      maxLeverage: asset.maxLeverage ?? null,
    });
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
