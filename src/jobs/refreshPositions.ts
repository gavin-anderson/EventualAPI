/**
 * Job: refresh mirrored Hyperliquid positions.
 *
 * The slow half of liquidation tracking — one HL call per due wallet. Positions
 * and their liquidation prices barely change, so this runs on a loose cadence;
 * the fast-moving mark price is handled by `evaluate-risk`, which costs one call
 * regardless of scale.
 *
 * Budget-capped per run so a growing user base degrades the long tail's
 * freshness rather than blowing a rate limit.
 */
import { refreshDuePositions } from "../lib/liquidation.js";
import { logger } from "../lib/logger.js";

export async function refreshPositions(): Promise<void> {
  const log = logger.child({ job: "refreshPositions" });
  const result = await refreshDuePositions();

  if (result.walletsClaimed === 0) {
    log.info("no wallets due");
    return;
  }
  log.info(result, "done");

  // Errors are already backed off per wallet; surface the rate so a systemic
  // failure (HL down, credentials wrong) isn't buried in per-wallet warnings.
  if (result.errors > 0 && result.errors === result.walletsClaimed) {
    log.error(result, "every wallet refresh failed — likely systemic");
  }
}
