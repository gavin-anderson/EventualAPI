import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketQuote } from "./hyperliquid.js";

/** Query-builder stand-in: records each awaited chain, answers via `respond`. */
interface Call {
  table: string;
  op: string;
  payload?: unknown;
}
let calls: Call[] = [];
let respond: (c: Call) => { data: unknown; error: null | { message: string } };

function builder(table: string) {
  const call: Call = { table, op: "select" };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "in"]) chain[m] = () => chain;
  chain.upsert = (payload: unknown) => {
    call.op = "upsert";
    call.payload = payload;
    return chain;
  };
  chain.select = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    calls.push(call);
    return Promise.resolve(respond(call)).then(resolve, reject);
  };
  return chain;
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder }) }));
vi.mock("./notify.js", () => ({ notify: vi.fn(async () => ({ delivered: true, devices: 1 })) }));

const { returnOnMargin, crossedMilestones, milestoneMessage, notifyPnlMilestones } = await import(
  "./pnlMilestones.js"
);
const { notify } = await import("./notify.js");

const WALLET = "0xabc";
const OPENED = "2026-10-28T12:00:00.123456+00:00";

function quotes(markPx: number, isDelisted = false): Map<string, MarketQuote> {
  return new Map([["NVDA", { coin: "NVDA", markPx, prevDayPx: null, isDelisted }]]);
}

const position = {
  wallet_address: WALLET,
  coin: "NVDA",
  side: "long",
  entry_px: 100,
  leverage: 10,
  opened_at: OPENED,
};

/** Responds as the DB would, with `sent` already-recorded milestones. */
function db(sent: number[]) {
  respond = (c) => {
    if (c.table === "wallet_open_positions") return { data: [position], error: null };
    if (c.table === "tracked_wallets") {
      return { data: [{ wallet_address: WALLET, user_id: "did:privy:u1" }], error: null };
    }
    if (c.op === "upsert") {
      // Only rows not already present come back, like ignoreDuplicates.
      const rows = (c.payload as Array<{ milestone: number }>).filter((r) => !sent.includes(r.milestone));
      return { data: rows.map((r) => ({ milestone: r.milestone })), error: null };
    }
    return {
      // Same instant, formatted differently — must still match.
      data: sent.map((milestone) => ({ ...position, opened_at: "2026-10-28T12:00:00.123Z", milestone })),
      error: null,
    };
  };
}

beforeEach(() => {
  calls = [];
  vi.mocked(notify).mockClear();
});

describe("returnOnMargin", () => {
  it("scales the price move by leverage, signed by side", () => {
    expect(returnOnMargin("long", 100, 105, 10)).toBeCloseTo(0.5);
    expect(returnOnMargin("short", 100, 105, 10)).toBeCloseTo(-0.5);
    expect(returnOnMargin("short", 100, 90, 3)).toBeCloseTo(0.3);
  });
});

describe("crossedMilestones", () => {
  it("lists every milestone passed, doubling without a ceiling", () => {
    expect(crossedMilestones(0.2)).toEqual([]);
    expect(crossedMilestones(0.25)).toEqual([25]);
    expect(crossedMilestones(1.1)).toEqual([25, 50, 100]);
    expect(crossedMilestones(8.5)).toEqual([25, 50, 100, 200, 400, 800]);
  });

  it("stops the downside at -50", () => {
    expect(crossedMilestones(-0.24)).toEqual([]);
    expect(crossedMilestones(-0.3)).toEqual([-25]);
    expect(crossedMilestones(-0.9)).toEqual([-25, -50]);
  });
});

describe("milestoneMessage", () => {
  it("reports the actual return in the title and the body alike", () => {
    expect(milestoneMessage("NVDA", "long", 50, 0.523)).toEqual({
      title: "NVDA long up 52%",
      body: "Your NVDA long is up 52% on margin.",
    });
    // The INTC push of 2026-10-29 said "down 50%" over "down 60% on margin".
    expect(milestoneMessage("INTC", "long", -50, -0.6)).toEqual({
      title: "INTC long down 60%",
      body: "Your INTC long is down 60% on margin.",
    });
    // Rounding never reports less than the milestone crossed.
    expect(milestoneMessage("NVDA", "short", -25, -0.2496).title).toBe("NVDA short down 25%");
  });
});

describe("notifyPnlMilestones", () => {
  it("records every crossed milestone but announces only the furthest", async () => {
    db([]);
    // 10x long, +11% price = +110% on margin.
    const result = await notifyPnlMilestones(quotes(111));

    expect(result).toMatchObject({ positions: 1, crossing: 1, notified: 1 });
    const upsert = calls.find((c) => c.op === "upsert")!;
    expect((upsert.payload as Array<{ milestone: number }>).map((r) => r.milestone)).toEqual([25, 50, 100]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({
      userId: "did:privy:u1",
      kind: "position_pnl",
      title: "NVDA long up 110%",
      body: "Your NVDA long is up 110% on margin.",
      route: "asset:NVDA",
    });
  });

  it("announces only milestones not already sent for this position", async () => {
    db([25, 50]);
    await notifyPnlMilestones(quotes(111));

    const upsert = calls.find((c) => c.op === "upsert")!;
    expect((upsert.payload as Array<{ milestone: number }>).map((r) => r.milestone)).toEqual([100]);
    expect(vi.mocked(notify).mock.calls[0]![0].title).toBe("NVDA long up 110%");
  });

  it("sends nothing once every crossed milestone is recorded", async () => {
    db([25, 50, 100]);
    const result = await notifyPnlMilestones(quotes(108)); // +80%: 25 and 50

    expect(result.notified).toBe(0);
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("sends nothing when a concurrent run inserted first", async () => {
    db([]);
    const base = respond;
    respond = (c) => (c.op === "upsert" ? { data: [], error: null } : base(c));
    await notifyPnlMilestones(quotes(111));
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips delisted markets", async () => {
    db([]);
    const result = await notifyPnlMilestones(quotes(111, true));
    expect(result).toMatchObject({ crossing: 0, skippedNoMark: 1 });
    expect(notify).not.toHaveBeenCalled();
  });
});
