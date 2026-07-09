import { config } from "../config/env.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * All Hyperliquid reads go through the EU proxy (proxy.buzzresearch.org) to
 * work around geo-blocks. The proxy forwards to api.hyperliquid.xyz with the
 * same body shape; we authenticate to the proxy via X-Proxy-Key.
 */
async function hlPost<T>(type: string, body?: Record<string, unknown>): Promise<T> {
  if (!config.hyperliquid.configured) {
    throw new Error("Hyperliquid proxy not configured (HL_PROXY_URL / HL_PROXY_KEY missing)");
  }
  const url = `${config.hyperliquid.proxyUrl}/info`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Key": config.hyperliquid.proxyKey,
    },
    body: JSON.stringify({ type, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HL proxy ${type} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
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
  builderFee: string;
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
