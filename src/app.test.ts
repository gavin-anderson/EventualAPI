import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "./app.js";

/**
 * Smoke tests that don't require live upstreams. They cover the wiring that must
 * hold regardless of ClickHouse/Supabase/Privy: liveness, input validation, and
 * the auth bridge being dormant (503) until configured.
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
  it("GET /v1/market/sample?limit=0 -> 400 bad_request (validation before upstream)", async () => {
    const res = await fetch(`${base}/v1/market/sample?limit=0`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });
});

describe("auth bridge (dormant without Privy/Supabase env)", () => {
  it("GET /v1/profile -> 503 auth_not_configured", async () => {
    const res = await fetch(`${base}/v1/profile`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("auth_not_configured");
  });

  it("POST /v1/auth/session -> 503 auth_not_configured", async () => {
    const res = await fetch(`${base}/v1/auth/session`, { method: "POST" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("auth_not_configured");
  });

  it("unknown route -> 404 not_found", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});
