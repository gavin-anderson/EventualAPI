import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HlFill } from "./hyperliquid.js";

/**
 * A stand-in for the Supabase query builder: every chained call is recorded,
 * and awaiting the chain resolves with whatever `respond` returns for it.
 */
interface Call {
  table: string;
  op: string;
  columns?: string;
  payload?: unknown;
  filters: [string, ...unknown[]][];
}
let calls: Call[] = [];
let respond: (c: Call) => { data: unknown; error: null | { message: string } };

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "is", "lt", "lte", "gte", "or", "order", "limit"]) {
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
  chain.select = (columns?: string) => {
    if (call.op === "select") call.columns = columns;
    return chain;
  };
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

const {
  group,
  isSettled,
  liquidationMessage,
  checkLiquidation,
  planLiquidationCloses,
  detectLiquidations,
} = await import("./liquidationEvents.js");
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

describe("a liquidation taken in steps", () => {
  // Live fills, INTC long, 2026-10-29: a partial "market" step, then six seconds
  // later the "backstop" step for the rest. One position, so one event.
  const intc = (over: Partial<HlFill>) =>
    fill({ coin: "xyz:INTC", fee: "0", ...over });
  const steps = [
    intc({
      time: 1793304141720,
      px: "83.1405",
      sz: "0.74",
      startPosition: "0.74",
      closedPnl: "-5.86487",
      dir: "Liquidated Isolated Long",
      liquidation: { liquidatedUser: WALLET.toLowerCase(), markPx: "85.6", method: "backstop" },
    }),
    intc({
      time: 1793304135752,
      px: "79.846",
      sz: "0.36",
      startPosition: "1.1",
      closedPnl: "-4.0392",
      fee: "0.002587",
      liquidation: { liquidatedUser: WALLET.toLowerCase(), markPx: "86.03", method: "market" },
    }),
  ];

  it("joins the steps into one event at the last step's time and mark", () => {
    const events = group(steps, WALLET);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      coin: "INTC",
      side: "long",
      liquidatedAt: new Date(1793304141720),
      markPx: 85.6,
      method: "backstop",
      fillCount: 2,
      remaining: 0,
    });
    expect(events[0]!.size).toBeCloseTo(1.1);
    expect(events[0]!.realizedPnl).toBeCloseTo(-9.90407);
  });

  it("announces the whole loss once, as a full liquidation", () => {
    const [e] = group(steps, WALLET);
    expect(liquidationMessage(e!)).toEqual({
      title: "INTC long liquidated",
      body: "Your INTC long was liquidated at $85.60. Realized loss $9.90.",
    });
  });

  it("holds a fresh partial back so a next step can join it", () => {
    const [partial] = group([steps[1]!], WALLET);
    expect(partial!.remaining).toBeCloseTo(0.74);
    expect(isSettled(partial!, 1793304135752 + 10_000)).toBe(false);
    expect(isSettled(partial!, 1793304135752 + 2 * 60_000)).toBe(true);
    expect(liquidationMessage(partial!)).toEqual({
      title: "INTC long partly liquidated",
      body: "0.36 of your 1.1 INTC long was liquidated at $86.03. Realized loss $4.04. The other 0.74 is still open.",
    });
  });

  it("passes the sanity checks with the position's real margin", () => {
    const [e] = group(steps, WALLET);
    expect(e!.startSize).toBeCloseTo(1.1);
    // $9.91 of margin behind it; $9.90 lost.
    expect(checkLiquidation(e!, 9.910273)).toEqual([]);
    const [partial] = group([steps[1]!], WALLET);
    expect(checkLiquidation(partial!, 9.910273)).toEqual([]);
  });

  it("flags numbers that don't add up, and the push then leaves the loss out", () => {
    const [e] = group(steps, WALLET);
    expect(checkLiquidation(e!, 5.86)).toEqual([expect.stringMatching(/exceeds margin/)]);
    expect(checkLiquidation({ ...e!, realizedPnl: 3 }, null)).toEqual([
      expect.stringMatching(/gain/),
    ]);
    expect(checkLiquidation({ ...e!, size: 0.74 }, null)).toEqual([
      expect.stringMatching(/size/),
    ]);
    expect(liquidationMessage(e!, false).body).toBe("Your INTC long was liquidated at $85.60.");
  });

  it("keeps liquidations far apart as separate events", () => {
    const later = { ...steps[0]!, time: 1793304135752 + 5 * 60_000 };
    expect(group([steps[1]!, later], WALLET)).toHaveLength(2);
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

  it("adds the loss of earlier, separately announced partials to the close", () => {
    const [patch] = planLiquidationCloses([{ id: "a", size: 10 }], event, -12);
    expect(patch!.realized_pnl).toBe(-62);
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
  const positionLookup = () =>
    calls.find((c) => c.table === "positions" && c.op === "select" && c.columns?.startsWith("id"));

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

  it("closes with the loss of an earlier partial that was announced on its own", async () => {
    const base = respond;
    respond = (c) =>
      c.table === "liquidation_events" && c.op === "select"
        ? { data: [{ realized_pnl: -12 }], error: null }
        : base(c);
    openRows = [{ id: "pos-1", size: 10, opened_at: new Date(T - 3_600_000).toISOString() } as never];
    vi.mocked(fetchUserFills).mockResolvedValue([fill({ sz: "10", closedPnl: "-50" })]);

    await detectLiquidations();

    expect(positionUpdates()[0]!.payload).toMatchObject({ realized_pnl: -62 });
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
