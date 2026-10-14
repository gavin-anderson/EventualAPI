import { Router, raw } from "express";
import sharp from "sharp";
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
import { supabaseAdmin } from "../lib/supabase.js";
import {
  AVATAR_BUCKET,
  AVATAR_CACHE_CONTROL,
  AVATAR_SIZE,
  avatarPath,
  avatarUrl,
} from "../lib/avatar.js";
import { createHash } from "node:crypto";

export const profileRouter = Router();

/** Never the wallet — a HL address exposes a user's whole on-chain history. */
function publicView(p: Profile) {
  return {
    id: p.id,
    username: p.username,
    // A URL, not a storage path: the client should not have to know a bucket
    // name. Null means no photo — the app draws its own default.
    imageUrl: avatarUrl(p.image_ref),
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

// ── Avatar ────────────────────────────────────────────────────────────────────

/**
 * Formats accepted on upload. Decoding is what actually validates the bytes —
 * the Content-Type only decides whether we bother trying.
 */
const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** Generous for a phone photo; the stored result is a few tens of KB. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Refuse absurd dimensions before decoding. sharp's own default allows ~268
 * megapixels, which is plenty of room for a decompression bomb to exhaust
 * memory on a small box.
 */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * PUT /v1/profile/avatar — AUTHENTICATED. Replace the caller's avatar.
 *
 * Takes raw image bytes, not multipart: there is exactly one file and no other
 * fields, so multipart would add a dependency to parse a envelope we don't need.
 *
 * Everything is re-encoded to a square WebP. That is not only for size — it
 * drops EXIF, and phone photos routinely carry GPS coordinates. Re-encoding
 * means we cannot publish location data to a public bucket by accident.
 */
profileRouter.put(
  "/profile/avatar",
  requireAuth,
  rateLimit({ name: "avatar-upload", max: 10, windowMs: 60_000 }),
  raw({ type: AVATAR_TYPES, limit: MAX_UPLOAD_BYTES }),
  asyncHandler(async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw badRequest(
        `send raw image bytes with a Content-Type of ${AVATAR_TYPES.join(", ")}`,
      );
    }

    let webp: Buffer;
    try {
      webp = await sharp(body, { limitInputPixels: MAX_INPUT_PIXELS })
        // `cover` crops rather than distorting; every call site renders a circle.
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" })
        .webp({ quality: 85 })
        .toBuffer();
    } catch {
      // A decode failure here means the bytes were not a usable image, whatever
      // the Content-Type claimed.
      throw badRequest("could not read that image");
    }

    const did = req.identity!.privyDid;
    const hash = createHash("sha256").update(webp).digest("hex").slice(0, 16);
    const path = avatarPath(did, hash);
    const db = supabaseAdmin();

    const { error: upErr } = await db.storage.from(AVATAR_BUCKET).upload(path, webp, {
      contentType: "image/webp",
      cacheControl: AVATAR_CACHE_CONTROL,
      upsert: true,
    });
    if (upErr) throw new Error(`avatar upload failed: ${upErr.message}`);

    const { data, error } = await db
      .from("profiles")
      .update({ image_ref: path, updated_at: new Date().toISOString() })
      .eq("id", did)
      .select("id, wallet_address, username, image_ref, created_at")
      .maybeSingle();
    if (error) throw new Error(`avatar update failed: ${error.message}`);
    if (!data) throw badRequest("no profile yet — call /v1/auth/signup first");

    // Best-effort cleanup of the user's older avatars. Their paths are
    // content-hashed, so a previous image is now unreferenced; failing to
    // remove it must not fail the upload the user just made.
    void pruneOldAvatars(did, path);

    res.json({ profile: publicView(data as Profile) });
  }),
);

/**
 * DELETE /v1/profile/avatar — AUTHENTICATED. Drop the photo and fall back to
 * the wallet-derived default. Idempotent.
 */
profileRouter.delete(
  "/profile/avatar",
  requireAuth,
  asyncHandler(async (req, res) => {
    const did = req.identity!.privyDid;
    const { data, error } = await supabaseAdmin()
      .from("profiles")
      .update({ image_ref: null, updated_at: new Date().toISOString() })
      .eq("id", did)
      .select("id, wallet_address, username, image_ref, created_at")
      .maybeSingle();
    if (error) throw new Error(`avatar reset failed: ${error.message}`);
    if (!data) throw badRequest("no profile yet — call /v1/auth/signup first");

    void pruneOldAvatars(did, null);
    res.json({ profile: publicView(data as Profile) });
  }),
);

/** Remove every stored avatar for this user except `keep`. */
async function pruneOldAvatars(privyDid: string, keep: string | null): Promise<void> {
  try {
    const db = supabaseAdmin();
    const folder = avatarPath(privyDid, "x").split("/")[0]!;
    const { data } = await db.storage.from(AVATAR_BUCKET).list(folder);
    const stale = (data ?? [])
      .map((o) => `${folder}/${o.name}`)
      .filter((p) => p !== keep);
    if (stale.length > 0) await db.storage.from(AVATAR_BUCKET).remove(stale);
  } catch {
    // Orphaned bytes are cheap; a failed cleanup is not worth surfacing.
  }
}
