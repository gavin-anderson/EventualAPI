import { fetchUserFills, bareCoin, type HlFill } from "./hyperliquid.js";
import { logger } from "./logger.js";

/**
 * Verifying a trade the client reported.
 *
 * The app submits orders straight to Hyperliquid, so "I placed order X" is an
 * unverified claim. A position's side and size are the credibility signal behind
 * every take, so they come from the exchange, never the request body.
 *
 * The join key is the client order id: the app sets one, HL echoes it back on
 * the fills. Also makes the flow idempotent for free.
 */

/** How far back to look for a fill. Generous: clock skew plus HL's own lag. */
const LOOKBACK_MS = 30 * 60_000;

/**
 * A fill can land a moment after `/exchange` returns. Retry briefly rather than
 * telling the user their trade doesn't exist.
 */
const ATTEMPTS = 4;
const RETRY_DELAY_MS = 600;

export type TradeKind = "open" | "close";

export interface VerifiedTrade {
  cloid: string;
  coin: string;
  kind: TradeKind;
  side: "long" | "short";
  /** Size-weighted average fill price. */
  price: number;
  /** Total base-asset size filled. */
  size: number;
  /** Notional in USD — price x size. The number a take is judged on. */
  notional: number;
  /** Realized PnL, nonzero only on closing fills. */
  realizedPnl: number;
  feePaid: number;
  /** Earliest fill time for this cloid. */
  tradedAt: Date;
  /** How many fills the order was filled in. */
  fillCount: number;
}

export class TradeVerificationError extends Error {
  readonly code:
    | "fill_not_found"
    | "wrong_direction"
    | "flip_unsupported"
    | "settlement";
  constructor(code: TradeVerificationError["code"], message: string) {
    super(message);
    this.name = "TradeVerificationError";
    this.code = code;
  }
}

/** Parse a `dir` string into our open/close + side pair. */
function interpret(dir: string): { kind: TradeKind; side: "long" | "short" } | null {
  switch (dir) {
    case "Open Long": return { kind: "open", side: "long" };
    case "Open Short": return { kind: "open", side: "short" };
    case "Close Long": return { kind: "close", side: "long" };
    case "Close Short": return { kind: "close", side: "short" };
    default: return null;
  }
}

/**
 * Find and aggregate every fill for `cloid`. A market order routinely fills in
 * pieces sharing one cloid, so reporting the first would show a fragment.
 */
export async function verifyTrade(
  wallet: string,
  cloid: string,
  expected: TradeKind,
): Promise<VerifiedTrade> {
  const since = Date.now() - LOOKBACK_MS;
  let matches: HlFill[] = [];

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const fills = await fetchUserFills(wallet, since);
    matches = fills.filter((f) => f.cloid === cloid);
    if (matches.length > 0) break;
    if (attempt < ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  if (matches.length === 0) {
    throw new TradeVerificationError(
      "fill_not_found",
      "no Hyperliquid fill found for that order id — it may not have filled",
    );
  }

  // A flip closes and reopens in one fill. The app never produces one, so
  // rather than guess which half a take belongs to, refuse it loudly.
  const flip = matches.find((f) => f.dir.includes(">"));
  if (flip) {
    throw new TradeVerificationError(
      "flip_unsupported",
      `position flips are not supported yet (dir "${flip.dir}")`,
    );
  }

  const settlement = matches.find((f) => f.dir === "Settlement");
  if (settlement) {
    throw new TradeVerificationError(
      "settlement",
      "that fill is a settlement, not a user trade",
    );
  }

  const first = matches[0]!;
  const parsed = interpret(first.dir);
  if (!parsed) {
    throw new TradeVerificationError(
      "fill_not_found",
      `unrecognised fill direction "${first.dir}"`,
    );
  }

  if (parsed.kind !== expected) {
    throw new TradeVerificationError(
      "wrong_direction",
      `that order ${parsed.kind}ed a position; this endpoint handles ${expected}`,
    );
  }

  // Aggregating across mixed directions would produce a meaningless row.
  if (matches.some((f) => f.dir !== first.dir)) {
    logger.warn({ cloid, dirs: matches.map((f) => f.dir) }, "cloid spans mixed fill directions");
    throw new TradeVerificationError(
      "fill_not_found",
      "that order id spans fills in different directions",
    );
  }

  let size = 0;
  let notional = 0;
  let realizedPnl = 0;
  let feePaid = 0;
  let earliest = Number.POSITIVE_INFINITY;

  for (const f of matches) {
    const px = Number(f.px);
    const sz = Number(f.sz);
    if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) continue;
    size += sz;
    notional += px * sz;
    realizedPnl += Number(f.closedPnl) || 0;
    feePaid += Number(f.fee) || 0;
    earliest = Math.min(earliest, f.time);
  }

  if (size <= 0) {
    throw new TradeVerificationError("fill_not_found", "fills for that order id had no size");
  }

  return {
    cloid,
    coin: bareCoin(first.coin),
    kind: parsed.kind,
    side: parsed.side,
    price: notional / size,
    size,
    notional,
    realizedPnl,
    feePaid,
    tradedAt: new Date(earliest),
    fillCount: matches.length,
  };
}
