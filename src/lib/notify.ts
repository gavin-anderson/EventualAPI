import { supabaseAdmin } from "./supabase.js";
import { sendPush, type ApnsEnvironment } from "./apns.js";
import { logger } from "./logger.js";

/**
 * Sending a notification: the one path every trigger goes through.
 *
 * Order matters. The inbox row is written FIRST and the push is attempted
 * second, because the push is a delivery attempt and the row is the record. If
 * APNs is down, unconfigured, or the user has no device registered, the message
 * still appears next time they open the app rather than being lost.
 *
 * No triggers live here. What to send and when belongs to the systems that own
 * those events — and the liquidation alert model is still an open product
 * question.
 */

/**
 * Categories. `critical` ones ignore quiet hours: holding back "you are about
 * to be liquidated" until 8am is not a kindness.
 */
export const KINDS = {
  earnings_soon: { pref: "earnings_soon", critical: false },
  earnings_confirmed: { pref: "earnings_confirmed", critical: false },
  liquidation_warning: { pref: "liquidation_warning", critical: true },
  position_closed: { pref: "position_closed", critical: true },
  funds_received: { pref: "funds_received", critical: false },
  referral_earned: { pref: "referral_earned", critical: false },
} as const;

export type NotificationKind = keyof typeof KINDS;

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Deep link in the app's route scheme, e.g. "asset:NVDA". */
  route?: string;
  /** Replaces an earlier undelivered push with the same id. */
  collapseId?: string;
}

export type NotifyOutcome =
  | { delivered: true; devices: number }
  | { delivered: false; reason: "muted" | "quiet_hours" | "no_device" | "push_failed"; devices: number };

interface Prefs {
  earnings_soon: boolean;
  earnings_confirmed: boolean;
  liquidation_warning: boolean;
  position_closed: boolean;
  funds_received: boolean;
  referral_earned: boolean;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  timezone: string | null;
}

/**
 * Whether the user's local time falls inside their quiet hours. Handles a window
 * that wraps midnight (22 -> 7), which is the normal case.
 *
 * An unknown or invalid timezone means no quiet hours rather than guessing a
 * time and silently holding something back.
 */
function inQuietHours(prefs: Prefs, now = new Date()): boolean {
  const { quiet_hours_start: start, quiet_hours_end: end, timezone } = prefs;
  if (start === null || end === null || !timezone) return false;

  let localHour: number;
  try {
    localHour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(now),
    );
  } catch {
    return false;
  }
  if (!Number.isFinite(localHour)) return false;

  return start <= end
    ? localHour >= start && localHour < end
    : localHour >= start || localHour < end;
}

/**
 * Write a notification and try to push it.
 *
 * Returns why nothing was delivered rather than throwing: a muted category or a
 * user with no device is a normal outcome, not an error for the caller to
 * handle.
 */
export async function notify(input: NotifyInput): Promise<NotifyOutcome> {
  const db = supabaseAdmin();
  const meta = KINDS[input.kind];

  // Defaults-on: a user who has never touched settings gets everything.
  const { data: prefsRow } = await db
    .from("notification_preferences")
    .select("*")
    .eq("user_id", input.userId)
    .maybeSingle();
  const prefs = (prefsRow as Prefs | null) ?? null;

  // Muted and quiet-hours are treated differently on purpose.
  //
  // Muted means "I don't want this" — so nothing is pushed AND no inbox row is
  // written. Leaving a trail of messages someone opted out of would just be a
  // slower interruption.
  if (prefs && prefs[meta.pref] === false) {
    return { delivered: false, reason: "muted", devices: 0 };
  }
  // Quiet hours means "not now" — they do want it, so the record is kept and
  // only the interruption is suppressed.
  if (!meta.critical && prefs && inQuietHours(prefs)) {
    await insertRow(input, null, "held: quiet hours");
    return { delivered: false, reason: "quiet_hours", devices: 0 };
  }

  const { data: tokenRows } = await db
    .from("device_tokens")
    .select("token, environment")
    .eq("user_id", input.userId)
    .is("invalidated_at", null);
  const devices = (tokenRows as Array<{ token: string; environment: ApnsEnvironment }>) ?? [];

  if (devices.length === 0) {
    await insertRow(input, null, "no registered device");
    return { delivered: false, reason: "no_device", devices: 0 };
  }

  // Unread count after this one, so the badge is right.
  const { count: unread } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .is("read_at", null);

  let anyOk = false;
  const errors: string[] = [];

  for (const device of devices) {
    const outcome = await sendPush(device.token, device.environment, {
      title: input.title,
      body: input.body,
      route: input.route ?? null,
      badge: (unread ?? 0) + 1,
      ...(input.collapseId ? { collapseId: input.collapseId } : {}),
    });

    if (outcome.ok) {
      anyOk = true;
      continue;
    }
    errors.push(outcome.reason);
    if (outcome.invalidToken) {
      // The app was removed or the token is for the other environment. Stop
      // using it, but keep the row so a re-register is distinguishable.
      await db
        .from("device_tokens")
        .update({ invalidated_at: new Date().toISOString() })
        .eq("token", device.token);
      logger.info({ reason: outcome.reason }, "device token invalidated");
    }
  }

  await insertRow(input, anyOk ? new Date().toISOString() : null, errors.join("; ") || null);

  return anyOk
    ? { delivered: true, devices: devices.length }
    : { delivered: false, reason: "push_failed", devices: devices.length };
}

async function insertRow(
  input: NotifyInput,
  pushedAt: string | null,
  pushError: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin().from("notifications").insert({
    user_id: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    route: input.route ?? null,
    pushed_at: pushedAt,
    push_error: pushError,
  });
  if (error) logger.error({ err: error, kind: input.kind }, "could not write inbox row");
}

// ── Inbox reads ───────────────────────────────────────────────────────────────

export interface InboxItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  route: string | null;
  created_at: string;
  read_at: string | null;
}

export async function readInbox(
  userId: string,
  limit: number,
  offset: number,
): Promise<{ items: InboxItem[]; unread: number }> {
  const db = supabaseAdmin();
  const [list, unread] = await Promise.all([
    db
      .from("notifications")
      .select("id, kind, title, body, route, created_at, read_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
    db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null),
  ]);

  if (list.error) throw new Error(`inbox read failed: ${list.error.message}`);
  return { items: (list.data as InboxItem[]) ?? [], unread: unread.count ?? 0 };
}

/** Mark everything read — opening the inbox counts as viewing it. */
export async function markInboxRead(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null)
    .select("id");
  if (error) throw new Error(`marking read failed: ${error.message}`);
  return ((data as unknown[]) ?? []).length;
}
