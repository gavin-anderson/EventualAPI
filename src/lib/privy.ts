import { PrivyClient } from "@privy-io/server-auth";
import { config } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Privy API access — the only place we talk to Privy over the network. Token
 * verification stays offline (see `authBridge.ts`).
 *
 * This exists for the one thing the token can't do: the access token carries no
 * wallet, so the address has to come from `getUser`, which needs the app secret.
 */

let client: PrivyClient | null = null;

function getClient(): PrivyClient | null {
  if (!config.privy.canResolveWallet) return null;
  client ??= new PrivyClient(config.privy.appId, config.privy.appSecret);
  return client;
}

const HIT_TTL_MS = 60 * 60_000; // the address is immutable
const MISS_TTL_MS = 15_000; // retry soon while the wallet provisions

const cache = new Map<string, { address: string | null; expiresAt: number }>();

/**
 * A user's embedded (Privy-managed) EVM wallet address, lowercased.
 *
 * Deliberately not `user.wallet`, which is the *most recently linked* wallet and
 * can be an external one. The embedded wallet is what the app funds and signs
 * Hyperliquid actions with, so it is the only address that joins our records to
 * on-chain activity.
 *
 * Returns null on failure rather than throwing: a Privy outage must not block
 * sign-in, and the next call retries.
 */
export async function fetchEmbeddedWallet(privyDid: string): Promise<string | null> {
  const privy = getClient();
  if (!privy) return null;

  const cached = cache.get(privyDid);
  if (cached && Date.now() < cached.expiresAt) return cached.address;

  let address: string | null = null;
  try {
    const user = await privy.getUser(privyDid);
    const embedded = user.linkedAccounts.find(
      (a) =>
        a.type === "wallet" &&
        a.walletClientType === "privy" &&
        a.chainType === "ethereum",
    );
    address =
      embedded && "address" in embedded && typeof embedded.address === "string"
        ? embedded.address.toLowerCase()
        : null;
  } catch (err) {
    logger.warn({ err, privyDid }, "privy getUser failed; wallet unresolved");
    return null;
  }

  cache.set(privyDid, {
    address,
    expiresAt: Date.now() + (address ? HIT_TTL_MS : MISS_TTL_MS),
  });
  return address;
}

/** Test seam. */
export function clearWalletCache(): void {
  cache.clear();
}
