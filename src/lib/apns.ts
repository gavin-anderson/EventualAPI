import http2 from "node:http2";
import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * APNs client over HTTP/2, which is the only transport Apple accepts.
 *
 * No SDK: auth is an ES256 JWT signed with the .p8 key, and the request is one
 * POST. `jsonwebtoken` and `node:http2` are both already here, so the
 * alternative would be a dependency for about forty lines.
 *
 * Sandbox and production are different hosts AND different token namespaces — a
 * token from a debug build is rejected by production with BadDeviceToken. The
 * environment is stored per device token rather than inferred from NODE_ENV,
 * because a production server legitimately serves TestFlight builds too.
 */

const HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

export type ApnsEnvironment = keyof typeof HOSTS;

/** Apple accepts provider tokens for an hour; refresh well inside that. */
const TOKEN_TTL_MS = 45 * 60_000;
let cached: { token: string; expiresAt: number } | null = null;

/** Accept the .p8 with escaped newlines, which is how it survives an env var. */
function keyPem(): string {
  return config.apns.key.includes("-----BEGIN")
    ? config.apns.key.replace(/\\n/g, "\n")
    : `-----BEGIN PRIVATE KEY-----\n${config.apns.key.replace(/\s+/g, "")}\n-----END PRIVATE KEY-----`;
}

function providerToken(): string {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const token = jwt.sign({ iss: config.apns.teamId, iat: Math.floor(Date.now() / 1000) }, keyPem(), {
    algorithm: "ES256",
    header: { alg: "ES256", kid: config.apns.keyId },
  });
  cached = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Deep link using the app's own route scheme, e.g. "asset:NVDA". */
  route?: string | null;
  /** Unread count for the app icon. */
  badge?: number;
  /**
   * The notification kind (e.g. "earnings_confirmed"), so an open app can react
   * to the push itself — refetching the calendar on a release, say.
   */
  kind?: string;
  /**
   * Collapse id. APNs replaces an undelivered notification carrying the same
   * one — so a position's second warning supersedes its first rather than
   * stacking on the lock screen.
   */
  collapseId?: string;
}

export type PushOutcome =
  | { ok: true }
  | { ok: false; reason: string; invalidToken: boolean };

/**
 * Deliver one notification to one device.
 *
 * `invalidToken` is the caller's signal to stop using the token: a 410, or a
 * 400 with BadDeviceToken, means the app was removed or the token belongs to
 * the other environment. Anything else is transient and worth retrying later.
 */
export async function sendPush(
  deviceToken: string,
  environment: ApnsEnvironment,
  payload: PushPayload,
): Promise<PushOutcome> {
  if (!config.apns.configured) {
    return { ok: false, reason: "apns_not_configured", invalidToken: false };
  }

  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
    },
    // Custom keys ride alongside `aps`; the app reads `route` to deep-link and
    // `kind` to refresh whatever the push is about.
    ...(payload.route ? { route: payload.route } : {}),
    ...(payload.kind ? { kind: payload.kind } : {}),
  });

  const client = http2.connect(HOSTS[environment]);
  try {
    return await new Promise<PushOutcome>((resolve) => {
      const headers: Record<string, string | number> = {
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken()}`,
        "apns-topic": config.apns.bundleId,
        "apns-push-type": "alert",
        // 5 = respect the user's power state. 10 would be immediate, which Apple
        // reserves for genuinely time-critical alerts.
        "apns-priority": 5,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      };
      if (payload.collapseId) headers["apns-collapse-id"] = payload.collapseId.slice(0, 64);

      const req = client.request(headers);
      let status = 0;
      let responseBody = "";

      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
      });
      req.on("data", (chunk) => {
        responseBody += chunk;
      });
      req.on("end", () => {
        if (status === 200) {
          resolve({ ok: true });
          return;
        }
        let reason = responseBody.slice(0, 200);
        try {
          reason = (JSON.parse(responseBody) as { reason?: string }).reason ?? reason;
        } catch {
          /* keep the raw body */
        }
        resolve({
          ok: false,
          reason: `${status} ${reason}`,
          invalidToken: status === 410 || reason === "BadDeviceToken" || reason === "Unregistered",
        });
      });
      req.on("error", (err) => {
        resolve({ ok: false, reason: `transport: ${err.message}`, invalidToken: false });
      });

      req.setTimeout(10_000, () => {
        req.close();
        resolve({ ok: false, reason: "timeout", invalidToken: false });
      });

      req.end(body);
    });
  } catch (err) {
    logger.warn({ err, environment }, "apns connect failed");
    return { ok: false, reason: "connect_failed", invalidToken: false };
  } finally {
    client.close();
  }
}

/** Test seam: drop the cached provider token. */
export function clearProviderToken(): void {
  cached = null;
}
