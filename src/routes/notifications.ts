import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { badRequest } from "../lib/httpError.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { readInbox, markInboxRead, type InboxItem } from "../lib/notify.js";
import { config } from "../config/env.js";

export const notificationsRouter = Router();

/**
 * Device registration, the inbox, and preferences.
 *
 * The inbox is served from the server rather than the app's UserDefaults, so it
 * survives a reinstall and matches across devices — and so a notification
 * whose push failed is still seen.
 */

function view(n: InboxItem) {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    route: n.route,
    date: n.created_at,
    read: n.read_at !== null,
  };
}

// ── Devices ───────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  // APNs device tokens are hex. Length has varied across iOS versions, so the
  // bound is loose rather than pinned to 64.
  environment: z.enum(["sandbox", "production"]),
  appVersion: z.string().trim().max(40).optional(),
});

/**
 * PUT /v1/devices/:token — AUTHENTICATED. Register this device for push.
 *
 * Idempotent, so the app calls it on every launch; that also refreshes
 * `last_seen_at` and clears a previous invalidation if the user reinstalled.
 *
 * `environment` is required and cannot be inferred server-side: a token from a
 * debug build only works against APNs sandbox, and a production server
 * legitimately serves TestFlight builds too.
 */
notificationsRouter.put(
  "/devices/:token",
  requireAuth,
  rateLimit({ name: "device-register", max: 30, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const token = (req.params["token"] ?? "").trim();
    if (!/^[A-Za-z0-9]{32,200}$/.test(token)) throw badRequest("invalid device token");

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }

    const { error } = await supabaseAdmin().from("device_tokens").upsert(
      {
        token,
        user_id: req.identity!.privyDid,
        environment: parsed.data.environment,
        app_version: parsed.data.appVersion ?? null,
        last_seen_at: new Date().toISOString(),
        // A re-register means the app is back; undo any earlier invalidation.
        invalidated_at: null,
      },
      { onConflict: "token" },
    );
    if (error) throw new Error(`device register failed: ${error.message}`);

    res.json({ registered: true, pushConfigured: config.apns.configured });
  }),
);

/**
 * DELETE /v1/devices/:token — AUTHENTICATED. Unregister, e.g. on sign-out.
 *
 * Deletes rather than invalidates: this is the user's own choice, not APNs
 * telling us the token is dead, and the distinction is worth keeping.
 */
notificationsRouter.delete(
  "/devices/:token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const token = (req.params["token"] ?? "").trim();
    const { error } = await supabaseAdmin()
      .from("device_tokens")
      .delete()
      .eq("token", token)
      // Scoped to the caller so one user can't unregister another's device.
      .eq("user_id", req.identity!.privyDid);
    if (error) throw new Error(`device unregister failed: ${error.message}`);
    res.json({ registered: false });
  }),
);

// ── Inbox ─────────────────────────────────────────────────────────────────────

const inboxSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /v1/notifications — AUTHENTICATED. The inbox, newest first. */
notificationsRouter.get(
  "/notifications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = inboxSchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { limit, offset } = parsed.data;
    const { items, unread } = await readInbox(req.identity!.privyDid, limit, offset);
    res.json({ count: items.length, unread, limit, offset, notifications: items.map(view) });
  }),
);

/**
 * POST /v1/notifications/read — AUTHENTICATED. Mark everything read.
 *
 * Matches the app's `InboxStore.markAllRead()`: opening the inbox counts as
 * viewing it, so there is no per-item read call.
 */
notificationsRouter.post(
  "/notifications/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const marked = await markInboxRead(req.identity!.privyDid);
    res.json({ marked, unread: 0 });
  }),
);

// ── Preferences ───────────────────────────────────────────────────────────────

const prefsSchema = z.object({
  earningsSoon: z.boolean().optional(),
  earningsConfirmed: z.boolean().optional(),
  liquidationWarning: z.boolean().optional(),
  positionClosed: z.boolean().optional(),
  fundsReceived: z.boolean().optional(),
  referralEarned: z.boolean().optional(),
  quietHoursStart: z.number().int().min(0).max(23).nullable().optional(),
  quietHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
  // IANA zone. Quiet hours mean nothing without it, so it is stored alongside.
  timezone: z.string().trim().max(64).nullable().optional(),
});

const DEFAULTS = {
  earningsSoon: true,
  earningsConfirmed: true,
  liquidationWarning: true,
  positionClosed: true,
  fundsReceived: true,
  referralEarned: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
};

/**
 * GET /v1/notifications/preferences — AUTHENTICATED.
 *
 * Returns defaults when no row exists, so the client never has to special-case
 * a user who has not opened settings.
 */
notificationsRouter.get(
  "/notifications/preferences",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin()
      .from("notification_preferences")
      .select("*")
      .eq("user_id", req.identity!.privyDid)
      .maybeSingle();
    if (error) throw new Error(`preferences read failed: ${error.message}`);

    const r = data as Record<string, unknown> | null;
    res.json({
      preferences: r
        ? {
            earningsSoon: r.earnings_soon,
            earningsConfirmed: r.earnings_confirmed,
            liquidationWarning: r.liquidation_warning,
            positionClosed: r.position_closed,
            fundsReceived: r.funds_received,
            referralEarned: r.referral_earned,
            quietHoursStart: r.quiet_hours_start,
            quietHoursEnd: r.quiet_hours_end,
            timezone: r.timezone,
          }
        : DEFAULTS,
      // Quiet hours never apply to these, whatever the user sets.
      alwaysDelivered: ["liquidation_warning", "position_closed"],
    });
  }),
);

/** PUT /v1/notifications/preferences — AUTHENTICATED. Partial update. */
notificationsRouter.put(
  "/notifications/preferences",
  requireAuth,
  rateLimit({ name: "prefs-update", max: 30, windowMs: 60_000 }),
  asyncHandler(async (req, res) => {
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const p = parsed.data;

    const patch: Record<string, unknown> = { user_id: req.identity!.privyDid };
    const map: Array<[keyof typeof p, string]> = [
      ["earningsSoon", "earnings_soon"],
      ["earningsConfirmed", "earnings_confirmed"],
      ["liquidationWarning", "liquidation_warning"],
      ["positionClosed", "position_closed"],
      ["fundsReceived", "funds_received"],
      ["referralEarned", "referral_earned"],
      ["quietHoursStart", "quiet_hours_start"],
      ["quietHoursEnd", "quiet_hours_end"],
      ["timezone", "timezone"],
    ];
    for (const [from, to] of map) {
      if (p[from] !== undefined) patch[to] = p[from];
    }

    const { error } = await supabaseAdmin()
      .from("notification_preferences")
      .upsert(patch, { onConflict: "user_id" });
    if (error) throw new Error(`preferences update failed: ${error.message}`);

    res.json({ updated: true });
  }),
);
