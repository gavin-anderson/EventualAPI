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
  SUPABASE_JWT_SECRET: z.string().optional().or(z.literal("")),
  SESSION_JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // Privy (optional until the auth bridge is wired)
  PRIVY_APP_ID: z.string().optional().or(z.literal("")),
  PRIVY_VERIFICATION_KEY: z.string().optional().or(z.literal("")),

  // Benzinga (earnings calendar + EPS data)
  BENZINGA_API_KEY: z.string().optional().or(z.literal("")),
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
 * The auth bridge needs Supabase (to mint sessions) AND Privy (to verify the
 * incoming identity token). Until BOTH are fully configured, auth routes report
 * not-configured instead of half-working.
 */
const supabaseConfigured =
  nonEmpty(e.SUPABASE_URL) &&
  nonEmpty(e.SUPABASE_SERVICE_ROLE_KEY) &&
  nonEmpty(e.SUPABASE_JWT_SECRET);

const privyConfigured =
  nonEmpty(e.PRIVY_APP_ID) && nonEmpty(e.PRIVY_VERIFICATION_KEY);

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
    jwtSecret: e.SUPABASE_JWT_SECRET || "",
    sessionTtlSeconds: e.SESSION_JWT_TTL_SECONDS,
  },

  privy: {
    configured: privyConfigured,
    appId: e.PRIVY_APP_ID || "",
    verificationKey: e.PRIVY_VERIFICATION_KEY || "",
  },

  /** The auth bridge is live only when both halves are present. */
  auth: {
    configured: supabaseConfigured && privyConfigured,
  },

  benzinga: {
    configured: nonEmpty(e.BENZINGA_API_KEY),
    apiKey: e.BENZINGA_API_KEY || "",
  },
} as const;

export type Config = typeof config;
