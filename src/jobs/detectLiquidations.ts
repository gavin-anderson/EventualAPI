/**
 * Job: detect liquidations and notify the user.
 *
 * The first liquidation notification we ship, and deliberately the only one:
 * "you were liquidated" is past tense, so it is never a false positive. A
 * proximity warning has almost no useful lead time at high leverage — a 20x
 * position 90% of the way to liquidation has roughly 0.5% of price left, which
 * arrives as a death notice rather than a warning.
 *
 * Idempotency lives in the `liquidation_events` primary key, so a re-scan tells
 * nobody twice. That matters more than usual here: a duplicate "you were
 * liquidated" would be alarming.
 */
import { detectLiquidations } from "../lib/liquidationEvents.js";
import { logger } from "../lib/logger.js";

export async function detectLiquidationsJob(): Promise<void> {
  const log = logger.child({ job: "detectLiquidations" });
  const result = await detectLiquidations();

  if (result.walletsScanned === 0) {
    log.info("no wallets to scan");
    return;
  }
  log.info(result, "done");

  if (result.errors > 0 && result.errors === result.walletsScanned) {
    log.error(result, "every liquidation scan failed — likely systemic");
  }
}
