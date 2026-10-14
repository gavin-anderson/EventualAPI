import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HlFill } from "./hyperliquid.js";

/**
 * A stand-in for the Supabase query builder: every chained call is recorded,
 * and awaiting the chain resolves with whatever `respond` returns for it.
 */
interface Call {
  table: string;
  op: string;
  payload?: unknown;
  filters: [string, ...unknown[]][];
}
let calls: Call[] = [];
let respond: (c: Call) => { data: unknown; error: null | { message: string } };

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "is", "lt", "lte", "or", "order", "limit"]) {
    chain[m] = (...args: unknown[]) => {
      call.filters.push([m, ...args]);
      return chain;
    };
  }
  for (const op of ["update", "upsert"]) {
    chain[op] = (payload: unknown) => {
      call.op = op;
      call.payload = payload;
      return chain;
    };
  }
  chain.select = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    calls.push(call);
    return Promise.resolve(respond(call)).then(resolve, reject);
  };
  return chain;
}

vi.mock("./supabase.js", () => ({ supabaseAdmin: () => ({ from: builder }) }));
vi.mock("./notify.js", () => ({ notify: vi.fn(async () => ({ delivered: 1 })) }));
vi.mock("./hyperliquid.js", async (importActual) => ({
  ...(await importActual<typeof import("./hyperliquid.js")>()),
  fetchUserFills: vi.fn(),
}));

const { group, planLiquidationCloses, detectLiquidations } = await import("./liquidationEvents.js");
const { fetchUserFills } = await import("./hyperliquid.js");

const WALLET = "0xAbC0000000000000000000000000000000000001";
const OTHER = "0x9990000000000000000000000000000000000002";
const T = Date.parse("2026-10-10T14:00:00Z");

function fill(over: Partial<HlFill>): HlFill {
  return {
    coin: "xyz:NVDA",
    px: "100",
    sz: "4",
    side: "A",
    time: T,
    startPosition: "10",
    closedPnl: "-20",
    hash: "0x",
    oid: 1,
    crossed: true,
    fee: "0.5",
    feeToken: "USDC",
    dir: "Close Long",
    liquidation: { liquidatedUser: WALLET.toLowerCase(), markPx: "99.5", method: "market" },
    ...over,
  };
}

describe("group", () => {
  it("ignores fills where another wallet was the one liquidated", () => {
    const counterparty = fill({
      dir: "Open Long",
      side: "B",
      closedPnl: "0",
      liquidation: { liquidatedUser: OTHER, markPx: "99.5", method: "market" },
    });
    expect(group([counterparty], WALLET)).toEqual([]);
  });

  it("folds one event's fills together and sees the position is gone", () => {
    // Out of order on purpose: 10 -> 6 -> 0, with the last fill listed first.
    const [e] = group(
      [fill({ startPosition: "6", sz: "6", closedPnl: "-30" }), fill({})],
      WALLET,
    );
    expect(e).toMatchObject({
      coin: "NVDA",
      side: "long",
      size: 10,
      realizedPnl: -50,
      fee: 1,
      markPx: 99.5,
      fillCount: 2,
      remaining: 0,
    });
  });

  it("reads a short's remainder from a negative start position", () => {
    const [e] = group([fill({ side: "B", startPosition: "-10", sz: "4", dir: "Close Short" })], WALLET);
    expect(e).toMatchObject({ side: "short", remaining: 6 });
  });
});

describe("planLiquidationCloses", () => {
  const [event] = group([fill({ sz: "10", closedPnl: "-50", fee: "2" })], WALLET);

  it("closes a single row with the whole loss, at mark", () => {
    expect(planLiquidationCloses([{ id: "a", size: 10 }], event)).toEqual([
      {
        id: "a",
        closed_at: new Date(T).toISOString(),
        exit_px: 99.5,
        realized_pnl: -50,
        close_fee_paid: 2,
      },
    ]);
  });

  it("splits loss and fees by size across rows left by adding to a position", () => {
    const patches = planLiquidationCloses(
      [
        { id: "a", size: 6 },
        { id: "b", size: 4 },
      ],
      event,
    );
    expect(patches.map((p) => [p.id, p.realized_pnl, p.close_fee_paid])).toEqual([
      ["a", -30, 1.2],
      ["b", -20, 0.8],
    ]);
  });
});

describe("detectLiquidations", () => {
  let openRows: { id: string; size: number }[];
  let eventIsNew: boolean;

  beforeEach(() => {
    calls = [];
    openRows = [{ id: "pos-1", size: 10 }];
    eventIsNew = true;
    respond = (c) => {
      if (c.table === "tracked_wallets" && c.op === "select") {
        return {
          data: [{ wallet_address: WALLET, user_id: "user-1", fills_checked_at: null }],
          error: null,
        };
      }
      if (c.table === "liquidation_events" && c.op === "upsert") {
        return { data: eventIsNew ? [{ coin: "NVDA" }] : [], error: null };
      }
      if (c.table === "positions" && c.op === "select") return { data: openRows, error: null };
      if (c.table === "positions" && c.op === "update") return { data: [{ id: "x" }], error: null };
      return { data: null, error: null };
    };
  });

  const positionUpdates = () => calls.filter((c) => c.table === "positions" && c.op === "update");
  const positionLookup = () => calls.find((c) => c.table === "positions" && c.op === "select");

  it("closes the matching open row on a full liquidation", async () => {
    vi.mocked(fetchUserFills).mockResolvedValue([fill({ sz: "10", closedPnl: "-50" })]);

    const result = await detectLiquidations();

    expect(result).toMatchObject({ notified: 1, positionsClosed: 1, errors: 0 });
    expect(positionLookup()?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "user_id", "user-1"],
        ["eq", "coin", "NVDA"],
        ["eq", "side", "long"],
        ["is", "closed_at", null],
        ["lte", "opened_at", new Date(T).toISOString()],
      ]),
    );
    const [update] = positionUpdates();
    expect(update.payload).toMatchObject({ exit_px: 99.5, realized_pnl: -50 });
    expect(update.filters).toEqual([
      ["eq", "id", "pos-1"],
      ["is", "closed_at", null],
    ]);
  });

  it("leaves the row open after a partial liquidation", async () => {
    vi.mocked(fetchUserFills).mockResolvedValue([fill({ sz: "4" })]);

    const result = await detectLiquidations();

    expect(result).toMatchObject({ notified: 1, positionsClosed: 0 });
    expect(positionLookup()).toBeUndefined();
  });

  it("does not touch positions when someone else was liquidated", async () => {
    vi.mocked(fetchUserFills).mockResolvedValue([
      fill({ liquidation: { liquidatedUser: OTHER, markPx: "99.5", method: "market" } }),
    ]);

    const result = await detectLiquidations();

    expect(result).toMatchObject({ eventsFound: 0, positionsClosed: 0 });
    expect(calls.some((c) => c.table === "positions")).toBe(false);
  });

  it("still closes on a re-scan of an already-recorded event, without notifying again", async () => {
    eventIsNew = false;
    vi.mocked(fetchUserFills).mockResolvedValue([fill({ sz: "10" })]);

    const result = await detectLiquidations();

    expect(result).toMatchObject({ notified: 0, positionsClosed: 1 });
  });
});
