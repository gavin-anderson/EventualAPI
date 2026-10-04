import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { badRequest, conflict } from "../lib/httpError.js";
import { mintSupabaseSession } from "../lib/authBridge.js";
import {
  bootstrapProfile,
  checkUsername,
  claimUsername,
  publicProfiles,
  type Profile,
} from "../lib/profiles.js";

export const profileRouter = Router();

/**
 * Public view. Never the wallet: a Hyperliquid address is enough to pull a
 * user's full position history from the chain, which they never agreed to
 * attach to their name.
 */
function publicView(p: Profile) {
  return {
    id: p.id,
    username: p.username,
    imageRef: p.image_ref,
    createdAt: p.created_at,
  };
}

/**
 * The caller's own view. `referralCode` is the username — same identifier, but
 * surfaced under its own key so the client doesn't care where it comes from and
 * this can change without an app release.
 */
function privateView(p: Profile) {
  return {
    ...publicView(p),
    walletAddress: p.wallet_address,
    referralCode: p.username,
    region: p.region,
    eligibility: p.eligibility,
  };
}

// ── POST /v1/auth/signup ──────────────────────────────────────────────────────

/**
 * POST /v1/auth/signup — AUTHENTICATED. Sign-up and every-launch bootstrap:
 * idempotent, so the client can call it unconditionally on start.
 *
 * One round trip for the four things the client needs: verify the Privy token,
 * resolve and store the embedded wallet, create the profile, mint a Supabase
 * session JWT.
 *
 * Does NOT fail when the wallet is unresolvable — `walletStatus` says why and
 * the next call picks it up.
 */
profileRouter.post(
  "/auth/signup",
  requireAuth,
  rateLimit({ name: "signup", max: 20, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const identity = req.identity!;
    const { profile, created, walletStatus } = await bootstrapProfile(identity);
    const { token, expiresIn } = mintSupabaseSession({
      privyDid: identity.privyDid,
      ...(profile.wallet_address ? { wallet: profile.wallet_address } : {}),
    });

    res.status(created ? 201 : 200).json({
      created,
      walletStatus,
      // A profile with no username hasn't finished onboarding — the client uses
      // this to decide whether to show the username step.
      needsUsername: profile.username === null,
      supabaseAccessToken: token,
      tokenType: "bearer",
      expiresIn,
      profile: privateView(profile),
    });
  }),
);

// ── GET /v1/profile ───────────────────────────────────────────────────────────

/**
 * GET /v1/profile — AUTHENTICATED. Shares the bootstrap path so it self-heals a
 * profile whose wallet was unresolvable at sign-up.
 */
profileRouter.get(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const identity = req.identity!;
    const { profile, walletStatus } = await bootstrapProfile(identity);
    res.json({
      walletStatus,
      needsUsername: profile.username === null,
      profile: privateView(profile),
    });
  }),
);

// ── Usernames ─────────────────────────────────────────────────────────────────

const checkSchema = z.object({
  name: z.string().trim().min(1).max(64),
});

/**
 * GET /v1/profile/username/check — AUTHENTICATED. A hint for the form: racy, so
 * the client must still handle `taken` from the claim after a green check.
 */
profileRouter.get(
  "/profile/username/check",
  requireAuth,
  rateLimit({ name: "username-check", max: 60, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const parsed = checkSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const result = await checkUsername(parsed.data.name, req.identity!.privyDid);
    res.json(result);
  }),
);

const claimSchema = z.object({
  username: z.string().trim().min(1).max(64),
});

/**
 * POST /v1/profile/username — AUTHENTICATED. 409 `username_taken` is a normal
 * outcome: it's how a race resolves, decided by the unique index.
 */
profileRouter.post(
  "/profile/username",
  requireAuth,
  rateLimit({ name: "username-claim", max: 10, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const parsed = claimSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }

    const result = await claimUsername(req.identity!.privyDid, parsed.data.username);
    if (!result.ok) {
      if (result.code === "taken") throw conflict("username_taken", result.reason);
      throw badRequest(result.reason);
    }
    res.json({ profile: privateView(result.profile) });
  }),
);

// ── GET /v1/profiles ──────────────────────────────────────────────────────────

const batchSchema = z.object({
  ids: z.string().trim().min(1),
});

/**
 * GET /v1/profiles?ids=a,b,c — ANONYMOUS. Batch name/avatar resolution for the
 * feed, which stores `user_id` and resolves names client-side so renames
 * propagate. Public fields only.
 */
profileRouter.get(
  "/profiles",
  asyncHandler(async (req, res) => {
    const parsed = batchSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const ids = parsed.data.ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);

    const rows = await publicProfiles(ids);
    res.json({ count: rows.length, profiles: rows.map((r) => ({
      id: r.id,
      username: r.username,
      imageRef: r.image_ref,
    })) });
  }),
);
