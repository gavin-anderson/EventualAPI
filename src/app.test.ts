import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { createApp } from "./app.js";
import { createMetricsRouter } from "./routes/metrics.js";

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

  it("GET /metrics refuses a request with no token", async () => {
    // 404 with METRICS_TOKEN unset, 401 with it set. Never the metrics.
    const res = await fetch(`${base}/metrics`);
    expect([401, 404]).toContain(res.status);
  });

  it("unmatched paths share one route label", async () => {
    await fetch(`${base}/no-such-route-${Date.now()}`);
    const { registry } = await import("./lib/metrics.js");
    const text = await registry.metrics();
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain("no-such-route");
  });
});

describe("metrics token", () => {
  let metricsServer: Server;
  let metricsBase: string;

  beforeAll(async () => {
    const app = express().use(createMetricsRouter("s3cret"));
    await new Promise<void>((resolve) => {
      metricsServer = app.listen(0, () => {
        const addr = metricsServer.address();
        metricsBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    metricsServer?.close();
  });

  it("401s a wrong token", async () => {
    const res = await fetch(`${metricsBase}/metrics`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("serves prometheus text for the right token", async () => {
    const res = await fetch(`${metricsBase}/metrics`, {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("process_cpu_user_seconds_total");
  });
});

describe("public read tier", () => {
  it("GET /v1/earnings/:ticker rejects a junk ticker", async () => {
    const res = await fetch(`${base}/v1/earnings/not%20a%20ticker`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("GET /v1/earnings/:ticker accepts numeric tickers", async () => {
    // XYZ100/SP500/JP225/KR200/H100 are real markets the old alpha-only regex
    // rejected. 404 is fine here (sparse catalogue); 400 would be the bug.
    const res = await fetch(`${base}/v1/earnings/XYZ100`);
    expect(res.status).not.toBe(400);
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
    ["POST", "/v1/auth/signup"],
    ["GET", "/v1/profile/username/check?name=someone"],
    ["POST", "/v1/profile/username", { username: "someone" }],
    ["POST", "/v1/trades/open", { cloid: "0xdeadbeefdeadbeefdeadbeefdeadbeef" }],
    ["POST", "/v1/trades/close", { cloid: "0xdeadbeefdeadbeefdeadbeefdeadbeef" }],
    ["POST", "/v1/takes", { cloid: "0xdeadbeefdeadbeefdeadbeefdeadbeef", text: "a take" }],
    ["GET", "/v1/takes/mine"],
    ["POST", "/v1/takes/NVDA", { text: "a take" }],
    ["PATCH", "/v1/takes/NVDA", { text: "an edited take" }],
    ["GET", "/v1/watchlist"],
    ["PUT", "/v1/watchlist/NVDA"],
    ["DELETE", "/v1/watchlist/NVDA"],
    ["GET", "/v1/feed"],
    ["GET", "/v1/feed/sentiment?coin=NVDA"],
    ["GET", "/v1/notifications"],
    ["POST", "/v1/notifications/read"],
    ["GET", "/v1/notifications/preferences"],
    ["PUT", "/v1/notifications/preferences", { earningsSoon: false }],
    ["PUT", "/v1/devices/abcdef0123456789abcdef0123456789", { environment: "sandbox" }],
    ["DELETE", "/v1/devices/abcdef0123456789abcdef0123456789"],
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
