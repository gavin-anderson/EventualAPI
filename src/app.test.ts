import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "./app.js";

/**
 * Smoke tests that don't require live upstreams: liveness, input validation, and
 * that protected routes are actually protected.
 *
 * Note on the auth assertions: these must NOT depend on whether the local .env
 * happens to carry Privy credentials. Unconfigured, a protected route answers
 * 503 auth_not_configured; configured, it answers 401 for a missing bearer
 * token. Both are correct, and asserting either one specifically makes the suite
 * pass or fail based on a developer's .env — which it previously did. What
 * matters is the invariant: a protected route never succeeds without a token.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe("ops", () => {
  it("GET /healthz -> 200 ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /metrics -> prometheus text", async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("process_cpu_user_seconds_total");
  });
});

describe("public read tier", () => {
  it("GET /v1/profiles with no ids -> 400 (anonymous, validates before upstream)", async () => {
    const res = await fetch(`${base}/v1/profiles`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("GET /v1/earnings?limit=0 -> 400 bad_request (validation before upstream)", async () => {
    const res = await fetch(`${base}/v1/earnings?limit=0`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });
});

describe("protected routes reject unauthenticated callers", () => {
  /** 401 when the bridge is live, 503 when it isn't. Never a success. */
  const REFUSED = [401, 503];

  const protectedRoutes: Array<[string, string, unknown?]> = [
    ["GET", "/v1/profile"],
    ["POST", "/v1/auth/session"],
    ["POST", "/v1/auth/signup"],
    ["GET", "/v1/profile/username/check?name=someone"],
    ["POST", "/v1/profile/username", { username: "someone" }],
    ["GET", "/v1/portfolio"],
    ["GET", "/v1/positions/closed"],
    ["POST", "/v1/trades/open", { cloid: "0xdeadbeefdeadbeef" }],
    ["POST", "/v1/trades/close", { cloid: "0xdeadbeefdeadbeef" }],
    ["POST", "/v1/takes", { cloid: "0xdeadbeefdeadbeef", text: "a take" }],
  ];

  for (const [method, path, body] of protectedRoutes) {
    it(`${method} ${path} refuses a request with no token`, async () => {
      const res = await fetch(`${base}${path}`, {
        method,
        ...(body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      expect(REFUSED).toContain(res.status);
      expect((await res.json()).error).toBeTruthy();
    });
  }

  it("rejects a malformed bearer token", async () => {
    const res = await fetch(`${base}/v1/profile`, {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(REFUSED).toContain(res.status);
  });
});

describe("routing", () => {
  it("unknown route -> 404 not_found", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});
