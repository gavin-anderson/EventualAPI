import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { config } from "../config/env.js";

export const healthRouter = Router();

/** Liveness: the process is up and serving. No dependency checks. */
healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Readiness: can we actually serve traffic? Every read tier now goes to Supabase,
 * so that is the dependency worth checking. Reports (but does not fail on) the
 * auth bridge state, since the service is intentionally usable anonymously.
 */
healthRouter.get(
  "/readyz",
  asyncHandler(async (_req, res) => {
    const supabase = await pingSupabase();
    res.status(supabase ? 200 : 503).json({
      status: supabase ? "ok" : "degraded",
      checks: {
        supabase: supabase ? "ok" : "unreachable",
        authBridge: config.auth.configured ? "configured" : "not_configured",
      },
    });
  }),
);

/** Cheapest possible round-trip that proves Supabase is reachable and granting. */
async function pingSupabase(): Promise<boolean> {
  if (!config.supabase.configured) return false;
  try {
    const { error } = await supabaseAdmin()
      .from("assets")
      .select("id", { head: true, count: "exact" })
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}
