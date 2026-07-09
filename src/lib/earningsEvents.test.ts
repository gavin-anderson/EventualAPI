import { describe, it, expect } from "vitest";
import { buildEarningsEventRow, deriveQuarter } from "./earningsEvents.js";
import type { BenzingaEarning } from "./benzinga.js";

function make(over: Partial<BenzingaEarning>): BenzingaEarning {
  return {
    id: "1",
    date: "2026-07-15",
    date_confirmed: 1,
    time: "16:05:00",
    ticker: "AAPL",
    exchange: "NASDAQ",
    name: "Apple Inc",
    period: "Q3",
    period_year: 2026,
    eps: null,
    eps_est: "1.23",
    eps_prior: null,
    eps_surprise: null,
    eps_surprise_percent: null,
    revenue: null,
    revenue_est: null,
    revenue_surprise_percent: null,
    importance: 5,
    updated: 0,
    ...over,
  };
}

describe("buildEarningsEventRow", () => {
  it("exact time → precision 'exact', DST-correct UTC, null session", () => {
    const r = buildEarningsEventRow("A1", make({ time: "16:05:00" }));
    expect(r.time_precision).toBe("exact");
    expect(r.session).toBeNull();
    expect(r.earnings_at).toBe("2026-07-15T20:05:00.000Z"); // 16:05 EDT = 20:05 UTC
    expect(r.expected_eps).toBe(1.23);
    expect(r.period).toBe("Q3");
    expect(r.period_year).toBe(2026);
    expect(r.is_confirmed).toBe(true);
  });

  it("session time → precision 'session' with default clock", () => {
    const r = buildEarningsEventRow("A1", make({ time: "amc" }));
    expect(r.time_precision).toBe("session");
    expect(r.session).toBe("amc");
    expect(r.earnings_at).toBe("2026-07-15T20:00:00.000Z"); // 16:00 EDT default
  });

  it("falls back to a calendar quarter when Benzinga omits the fiscal period", () => {
    const r = buildEarningsEventRow(
      "A1",
      make({ time: "bmo", period: "", period_year: 0, date: "2026-02-10" }),
    );
    expect(r.period).toBe("Q1");
    expect(r.period_year).toBe(2026);
  });
});

describe("deriveQuarter", () => {
  it("maps months to quarters", () => {
    expect(deriveQuarter("2026-01-01")).toBe("Q1");
    expect(deriveQuarter("2026-04-30")).toBe("Q2");
    expect(deriveQuarter("2026-09-15")).toBe("Q3");
    expect(deriveQuarter("2026-12-31")).toBe("Q4");
  });
});
