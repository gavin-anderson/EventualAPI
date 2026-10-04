import { describe, it, expect } from "vitest";
import { normalizeUsername, usernameProblem, isReserved } from "./usernames.js";

describe("usernames", () => {
  it("normalize to lowercase, stripping disallowed characters", () => {
    expect(normalizeUsername("  Gavin.Anderson! ")).toBe("gavinanderson");
    expect(normalizeUsername("A_b-9")).toBe("a_b9");
  });

  it("cap at the maximum length", () => {
    expect(normalizeUsername("a".repeat(50))).toHaveLength(20);
  });

  it("require 3+ chars, starting with a letter", () => {
    expect(usernameProblem("ab")).toMatch(/At least 3/);
    expect(usernameProblem("9abc")).toMatch(/Start with a letter/);
    expect(usernameProblem("_abc")).toMatch(/Start with a letter/);
    expect(usernameProblem("abc")).toBeNull();
    expect(usernameProblem("a_very_normal_name")).toBeNull();
  });

  it("reject reserved names", () => {
    for (const n of ["admin", "support", "earnings", "api", "me", "privy"]) {
      expect(usernameProblem(n)).not.toBeNull();
      expect(isReserved(n)).toBe(true);
    }
    expect(isReserved("ADMIN")).toBe(true);
  });

  it("agree with the iOS client's rules on the boundaries", () => {
    // UsernameRules: 3-20, lowercase letters/digits/underscore, starts with a letter.
    expect(usernameProblem(normalizeUsername("abc"))).toBeNull();
    expect(usernameProblem(normalizeUsername("a".repeat(20)))).toBeNull();
    expect(usernameProblem(normalizeUsername("a".repeat(21)))).toBeNull(); // normalized to 20
  });
});

describe("username as referral code", () => {
  it("accepts the shapes a referral link has to carry in a URL path", () => {
    // /r/<username> — must survive being typed, shared and lowercased.
    for (const n of ["gavin", "gavin_a", "trader99", "a_b_c"]) {
      expect(usernameProblem(normalizeUsername(n))).toBeNull();
    }
  });

  it("normalizes the way a pasted link would arrive", () => {
    expect(normalizeUsername("GAVIN")).toBe("gavin");
    expect(normalizeUsername("/r/gavin")).toBe("rgavin"); // callers strip the path first
  });

  it("still blocks reserved names from becoming referral codes", () => {
    // These would collide with routes if they ever became /r/<name>.
    for (const n of ["api", "admin", "signup", "profile"]) {
      expect(usernameProblem(n)).not.toBeNull();
    }
  });
});
