import { describe, it, expect } from "vitest";
import { etToUtcIso } from "./datetime.js";

describe("etToUtcIso", () => {
  it("converts winter (EST, UTC-5)", () => {
    // 16:00 EST → 21:00 UTC
    expect(etToUtcIso("2026-01-15", "16:00:00")).toBe("2026-01-15T21:00:00.000Z");
  });

  it("converts summer (EDT, UTC-4)", () => {
    // 16:00 EDT → 20:00 UTC
    expect(etToUtcIso("2026-07-15", "16:00:00")).toBe("2026-07-15T20:00:00.000Z");
  });

  it("handles a session-default after-hours time", () => {
    // 20:00 EDT → 00:00 UTC next day
    expect(etToUtcIso("2026-07-15", "20:00:00")).toBe("2026-07-16T00:00:00.000Z");
  });

  it("throws on malformed input", () => {
    expect(() => etToUtcIso("not-a-date", "16:00:00")).toThrow();
  });
});
