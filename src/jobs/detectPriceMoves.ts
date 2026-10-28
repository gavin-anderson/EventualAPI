/**
 * Job: push big 24h moves (10%, then 20%) to everyone watching the market.
 *
 * One Hyperliquid call covers every market, so the cost is flat; on a quiet
 * day it is that call and nothing else. Dedupe and the rules for who hears what
 * live in src/lib/priceMoves.ts.
 */
import { detectPriceMoves } from "../lib/priceMoves.js";
import { logger } from "../lib/logger.js";

export async function detectPriceMovesJob(): Promise<void> {
  const log = logger.child({ job: "detectPriceMoves" });
  const result = await detectPriceMoves();
  log.info(result, result.moves === 0 ? "no big moves" : "done");
}
