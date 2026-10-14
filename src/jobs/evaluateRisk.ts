/**
 * Job: evaluate liquidation proximity. SHADOW MODE — sends nothing.
 *
 * It computes how close every mirrored position is to liquidation and logs it.
 * No notifications, no thresholds, no decisions: what to alert on is a separate
 * product question, and this pipeline doesn't depend on the answer.
 *
 * Running it silently is the point. It produces exactly the data that decision
 * needs — how often real positions approach liquidation, at what leverage, how
 * fast, and with how much warning — which is currently being argued from
 * intuition.
 *
 * It also answers an open design question empirically: how often does a
 * liquidation price actually change between refreshes? If it essentially never
 * does, the refresh cadence can slow right down. `liqPriceStalenessP95` is the
 * number to watch.
 */
import { evaluateRisk } from "../lib/liquidation.js";
import { logger } from "../lib/logger.js";

/** Buckets for the shadow data, not thresholds for alerting. */
const BANDS = [0.5, 0.75, 0.9];

export async function evaluateRiskJob(): Promise<void> {
  const log = logger.child({ job: "evaluateRisk" });
  const result = await evaluateRisk();

  if (result.positions === 0) {
    log.info("no mirrored positions");
    return;
  }

  const consumed = result.readings.map((r) => r.consumed);
  const staleness = result.readings.map((r) => r.stalenessSeconds).sort((a, b) => a - b);
  const p95 = staleness.length
    ? staleness[Math.min(staleness.length - 1, Math.floor(staleness.length * 0.95))]
    : null;

  log.info(
    {
      positions: result.positions,
      evaluated: result.evaluated,
      skippedNoLiqPrice: result.skippedNoLiqPrice,
      skippedNoMark: result.skippedNoMark,
      // How many sit past each band. Observation only.
      past50: consumed.filter((c) => c >= BANDS[0]!).length,
      past75: consumed.filter((c) => c >= BANDS[1]!).length,
      past90: consumed.filter((c) => c >= BANDS[2]!).length,
      worstConsumed: consumed.length ? Math.max(...consumed) : null,
      // Split because `consumed` is only comparable across isolated positions.
      // Our app forces isolated; anything cross came from elsewhere.
      isolated: result.readings.filter((r) => r.marginType === "isolated").length,
      cross: result.readings.filter((r) => r.marginType === "cross").length,
      liqPriceStalenessP95: p95,
      mode: "shadow",
    },
    "risk evaluated (shadow — nothing sent)",
  );

  // Log the riskiest few individually so the shape of a real approach is
  // visible in the data, not just a count.
  for (const r of result.readings.slice(0, 5)) {
    if (r.consumed < BANDS[0]!) break;
    log.info(
      {
        coin: r.coin,
        side: r.side,
        leverage: r.leverage,
        marginType: r.marginType,
        consumed: r.consumed,
        remainingPct: r.remainingPct,
        liqStalenessSeconds: r.stalenessSeconds,
        mode: "shadow",
      },
      "position approaching liquidation",
    );
  }
}
