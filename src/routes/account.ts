import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { mintSupabaseSession } from "../lib/authBridge.js";
import { upsertProfile } from "../lib/profiles.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { fetchClearinghouseState, fetchUserFills } from "../lib/hyperliquid.js";
import { badRequest, serviceUnavailable, notFound } from "../lib/httpError.js";
import { TtlCache } from "../lib/cache.js";
import { config } from "../config/env.js";

export const accountRouter = Router();

// 5-second TTL for per-user live HL reads
const portfolioCache = new TtlCache<object>();
const PORTFOLIO_CACHE_TTL = 5_000;

// ── POST /v1/auth/session ─────────────────────────────────────────────────────

/**
 * POST /v1/auth/session — AUTHENTICATED (Privy bearer token).
 *
 * Verify the Privy token and mint a short-lived Supabase session JWT for
 * direct, RLS-scoped Supabase access from the mobile client.
 */
accountRouter.post(
  "/auth/session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const identity = req.identity!;
    const { token, expiresIn } = mintSupabaseSession(identity);
    res.json({
      supabaseAccessToken: token,
      tokenType: "bearer",
      expiresIn,
      user: { id: identity.privyDid, wallet: identity.wallet ?? null },
    });
  }),
);

// ── GET /v1/profile ────────────────────────────────────────────────────────────────

/**
 * GET /v1/profile — AUTHENTICATED.
 *
 * Returns the verified identity + lazily upserts the profile.
 */
accountRouter.get(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const identity = req.identity!;
    const profile = await upsertProfile(identity);
    res.json({
      user: { id: identity.privyDid, wallet: identity.wallet ?? null },
      profile,
    });
  }),
);

// ── GET /v1/portfolio ──────────────────────────────────────────────────────

/**
 * GET /v1/portfolio — AUTHENTICATED.
 *
 * Live HL clearinghouseState via the EU proxy, enriched with:
 *   - Asset metadata (name, symbol, logo) joined from Supabase assets table
 *   - 24h account-value change computed from account_value_snapshots
 *
 * Mapping:
 *   Account Value  = marginSummary.accountValue
 *   Position Value = Σ assetPositions[].position.positionValue
 *   Cash Value     = accountValue − positionValue  (≈ margin/withdrawable)
 */
accountRouter.get(
  "/portfolio",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!config.hyperliquid.configured) {
      throw serviceUnavailable("hl_not_configured", "Hyperliquid proxy not configured");
    }

    const identity = req.identity!;
    const db = supabaseAdmin();

    // Resolve wallet from profile (wallet may not yet be in req.identity — TODO)
    const wallet = await resolveWallet(identity.privyDid, identity.wallet ?? null);
    if (!wallet) {
      throw notFound("wallet_not_connected");
    }

    const cacheKey = `portfolio:${wallet}`;
    const result = await portfolioCache.getOrSet(cacheKey, PORTFOLIO_CACHE_TTL, async () => {
      const [state, assetMap, snapshot] = await Promise.all([
        fetchClearinghouseState(wallet),
        fetchAssetMap(db),
        fetchYesterdaySnapshot(db, identity.privyDid),
      ]);

      const { marginSummary, assetPositions } = state;
      const accountValue = Number(marginSummary.accountValue);
      const positionValue = assetPositions.reduce(
        (sum, ap) => sum + Number(ap.position.positionValue),
        0,
      );
      const cashValue = accountValue - positionValue;

      // 24h change vs yesterday's snapshot
      let change24h: { usd: number; pct: number } | null = null;
      if (snapshot) {
        const delta = accountValue - Number(snapshot.account_value);
        change24h = {
          usd: Number(delta.toFixed(2)),
          pct: Number(((delta / Number(snapshot.account_value)) * 100).toFixed(4)),
        };
      }

      const positions = assetPositions
        .filter((ap) => Number(ap.position.szi) !== 0)
        .map((ap) => {
          const p = ap.position;
          const size = Number(p.szi);
          const asset = assetMap[p.coin] ?? null;
          return {
            coin: p.coin,
            asset,
            side: size > 0 ? "long" : "short",
            size: Math.abs(size),
            entryPrice: p.entryPx ? Number(p.entryPx) : null,
            positionValue: Number(p.positionValue),
            unrealizedPnl: Number(p.unrealizedPnl),
            unrealizedPnlPct: Number((Number(p.returnOnEquity) * 100).toFixed(4)),
            margin: Number(p.marginUsed),
            leverage: p.leverage,
            liquidationPx: p.liquidationPx ? Number(p.liquidationPx) : null,
          };
        });

      return {
        accountValue,
        positionValue: Number(positionValue.toFixed(2)),
        cashValue: Number(cashValue.toFixed(2)),
        change24h,
        positions,
        asOf: new Date().toISOString(),
      };
    });

    res.json(result);
  }),
);

// ── GET /v1/positions/closed ───────────────────────────────────────────────

const closedSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

/**
 * GET /v1/positions/closed — AUTHENTICATED.
 *
 * Derives closed positions from HL userFillsByTime via the EU proxy.
 * Returns fills that include realized PnL (closedPnl != "0"), grouped and
 * summarised by coin. Covers the last ?days= calendar days (max 90).
 */
accountRouter.get(
  "/positions/closed",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!config.hyperliquid.configured) {
      throw serviceUnavailable("hl_not_configured", "Hyperliquid proxy not configured");
    }

    const parsed = closedSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }

    const identity = req.identity!;
    const wallet = await resolveWallet(identity.privyDid, identity.wallet ?? null);
    if (!wallet) throw notFound("wallet_not_connected");

    const { days } = parsed.data;
    const startTime = Date.now() - days * 86_400_000;
    const fills = await fetchUserFills(wallet, startTime);

    // Group closing fills (closedPnl != "0") by coin into position summaries
    const db = supabaseAdmin();
    const assetMap = await fetchAssetMap(db);

    const closingFills = fills.filter((f) => f.closedPnl !== "0");

    // Aggregate per coin: total realised PnL, first open time, last close time
    const byConn = new Map<
      string,
      { coin: string; totalPnl: number; firstTime: number; lastTime: number; fills: typeof fills }
    >();
    for (const f of closingFills) {
      let entry = byConn.get(f.coin);
      if (!entry) {
        entry = { coin: f.coin, totalPnl: 0, firstTime: f.time, lastTime: f.time, fills: [] };
        byConn.set(f.coin, entry);
      }
      entry.totalPnl += Number(f.closedPnl);
      entry.firstTime = Math.min(entry.firstTime, f.time);
      entry.lastTime = Math.max(entry.lastTime, f.time);
      entry.fills.push(f);
    }

    const positions = [...byConn.values()].map(({ coin, totalPnl, firstTime, lastTime }) => ({
      coin,
      asset: assetMap[coin] ?? null,
      realizedPnl: Number(totalPnl.toFixed(4)),
      openedAt: new Date(firstTime).toISOString(),
      closedAt: new Date(lastTime).toISOString(),
    }));

    // Sort most-recent close first
    positions.sort((a, b) => b.closedAt.localeCompare(a.closedAt));

    res.json({ days, count: positions.length, positions });
  }),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveWallet(
  privyDid: string,
  fromToken: string | null,
): Promise<string | null> {
  if (fromToken) return fromToken;
  const db = supabaseAdmin();
  const { data } = await db
    .from("profiles")
    .select("wallet_address")
    .eq("id", privyDid)
    .single();
  return (data as { wallet_address: string | null } | null)?.wallet_address ?? null;
}

interface AssetMeta {
  ticker: string;
  name: string | null;
  imageRef: string | null;
}

async function fetchAssetMap(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<Record<string, AssetMeta>> {
  const { data } = await db.from("assets").select("hl_coin, ticker, name, image_ref");
  const map: Record<string, AssetMeta> = {};
  for (const row of (data as Array<{ hl_coin: string; ticker: string; name: string | null; image_ref: string | null }>) ?? []) {
    map[row.hl_coin] = { ticker: row.ticker, name: row.name, imageRef: row.image_ref };
  }
  return map;
}

async function fetchYesterdaySnapshot(
  db: ReturnType<typeof supabaseAdmin>,
  userId: string,
): Promise<{ account_value: number } | null> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { data } = await db
    .from("account_value_snapshots")
    .select("account_value")
    .eq("user_id", userId)
    .eq("captured_on", yesterday)
    .single();
  return (data as { account_value: number } | null);
}
