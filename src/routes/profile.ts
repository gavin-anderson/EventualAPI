import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { badRequest, conflict } from "../lib/httpError.js";
import {
  bootstrapProfile,
  checkUsername,
  claimUsername,
  type Profile,
} from "../lib/profiles.js";

export const profileRouter = Router();

/** Never the wallet — a HL address exposes a user's whole on-chain history. */
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
 * POST /v1/auth/signup — AUTHENTICATED. Sign-up and every-launch bootstrap, so
 * the client calls it unconditionally on start.
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

    res.status(created ? 201 : 200).json({
      created,
      walletStatus,
      // A profile with no username hasn't finished onboarding — the client uses
      // this to decide whether to show the username step.
      needsUsername: profile.username === null,
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
