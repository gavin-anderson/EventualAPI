import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated configuration. Parsed once at startup so a bad env
 * fails fast and loudly rather than surfacing as a confusing runtime error.
 *
 * Supabase backs every read tier. Privy is OPTIONAL: when the Supabase/Privy
 * block is incomplete the auth bridge stays dormant (auth routes return 503) —
 * see `auth.configured`.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  HL_DEX: z.string().default("xyz"),

  // Supabase (optional until the auth bridge is wired)
  SUPABASE_URL: z.string().url().optional().or(z.literal("")),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal("")),

  // Privy (optional until the auth bridge is wired)
  PRIVY_APP_ID: z.string().optional().or(z.literal("")),
  // Public key for offline token verification.
  PRIVY_VERIFICATION_KEY: z.string().optional().or(z.literal("")),
  // Needed only to call Privy's API (getUser -> embedded wallet).
  PRIVY_APP_SECRET: z.string().optional().or(z.literal("")),

  // Alpha Vantage (earnings calendar + EPS history). Free key = 25 requests/day.
  ALPHAVANTAGE_API_KEY: z.string().optional().or(z.literal("")),
  // SEC EDGAR asks for a descriptive User-Agent with a contact email.
  SEC_USER_AGENT: z.string().optional().or(z.literal("")),

  // Short on purpose: a take is meant to be contemporaneous with its trade.
  TAKE_WINDOW_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
  TAKE_MAX_LENGTH: z.coerce.number().int().min(50).max(2_000).default(500),

  // APNs. Dormant until all three secrets are set; the service runs fine
  // without them. APNS_KEY is the .p8 contents (PKCS#8 PEM) rather than a path,
  // so it can come from a secret manager; escaped newlines are handled.
  APNS_KEY: z.string().optional().or(z.literal("")),
  APNS_KEY_ID: z.string().optional().or(z.literal("")),
  APNS_TEAM_ID: z.string().optional().or(z.literal("")),
  APNS_BUNDLE_ID: z.string().default("buzz.Earnings"),

  // Bearer secret for GET /metrics. Unset, the endpoint answers 404.
  METRICS_TOKEN: z.string().optional().or(z.literal("")),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    "Invalid environment configuration:",
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

const e = parsed.data;

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Authenticated routes need Supabase (to read and write the data) AND Privy (to
 * verify the incoming identity token). Until BOTH are fully configured, those
 * routes report not-configured instead of half-working.
 */
/** Service role only — nothing mints session JWTs, so no JWT secret. */
const supabaseConfigured =
  nonEmpty(e.SUPABASE_URL) && nonEmpty(e.SUPABASE_SERVICE_ROLE_KEY);

const privyConfigured =
  nonEmpty(e.PRIVY_APP_ID) && nonEmpty(e.PRIVY_VERIFICATION_KEY);

/** Separate flag so sign-in can work while wallet resolution is unconfigured. */
const privyWalletResolution =
  nonEmpty(e.PRIVY_APP_ID) && nonEmpty(e.PRIVY_APP_SECRET);

/**
 * The verification key is an ES256 public key, not the app id — easy to confuse,
 * both come from the same dashboard page. Getting it wrong 401s every request
 * silently, so fail at startup instead.
 */
if (nonEmpty(e.PRIVY_VERIFICATION_KEY)) {
  const key = e.PRIVY_VERIFICATION_KEY.trim();
  const looksLikeAppId = key === e.PRIVY_APP_ID || key.length < 80;
  if (looksLikeAppId && !key.includes("-----BEGIN")) {
    // eslint-disable-next-line no-console
    console.error(
      "Invalid PRIVY_VERIFICATION_KEY: expected an ES256 public key (base64 SPKI, " +
        "optionally PEM-armoured) from Privy Dashboard -> Configuration -> App settings. " +
        `Got a ${key.length}-character value, which looks like an app id. ` +
        "Every token verification would fail with a 401.",
    );
    process.exit(1);
  }
}

export const config = {
  env: e.NODE_ENV,
  isProd: e.NODE_ENV === "production",
  port: e.PORT,
  logLevel: e.LOG_LEVEL,

  hyperliquid: {
    /** The HIP-3 builder dex the app trades. "" means the default perp dex. */
    dex: e.HL_DEX,
  },

  supabase: {
    configured: supabaseConfigured,
    url: e.SUPABASE_URL || "",
    serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY || "",
  },

  privy: {
    configured: privyConfigured,
    /** True when we can call Privy's API to resolve embedded wallets. */
    canResolveWallet: privyWalletResolution,
    appId: e.PRIVY_APP_ID || "",
    verificationKey: e.PRIVY_VERIFICATION_KEY || "",
    appSecret: e.PRIVY_APP_SECRET || "",
  },

  /** The auth bridge is live only when both halves are present. */
  auth: {
    configured: supabaseConfigured && privyConfigured,
  },

  alphaVantage: {
    configured: nonEmpty(e.ALPHAVANTAGE_API_KEY),
    apiKey: e.ALPHAVANTAGE_API_KEY || "",
  },

  sec: {
    userAgent: e.SEC_USER_AGENT || "hl-api earnings sync",
  },

  takes: {
    windowSeconds: e.TAKE_WINDOW_SECONDS,
    maxLength: e.TAKE_MAX_LENGTH,
  },

  apns: {
    configured:
      nonEmpty(e.APNS_KEY) && nonEmpty(e.APNS_KEY_ID) && nonEmpty(e.APNS_TEAM_ID),
    key: e.APNS_KEY || "",
    keyId: e.APNS_KEY_ID || "",
    teamId: e.APNS_TEAM_ID || "",
    bundleId: e.APNS_BUNDLE_ID,
  },

  metrics: {
    token: e.METRICS_TOKEN || "",
  },
} as const;

export type Config = typeof config;
