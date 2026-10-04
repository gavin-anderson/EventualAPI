import { describe, it, expect } from "vitest";
import { artHash, iconPath, cardPath, artUrl, assetArt, ART_CACHE_CONTROL } from "./assetArt.js";

/**
 * These are the rules two endpoints now depend on, and one of them (the
 * cache-control format) has already been got wrong once in a way that a type
 * checker cannot catch.
 */

describe("artHash", () => {
  it("is stable for identical content and differs for changed content", () => {
    const a = artHash(new Uint8Array([1, 2, 3]));
    expect(artHash(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(artHash(new Uint8Array([1, 2, 4]))).not.toBe(a);
  });

  it("is short enough to sit in a path", () => {
    expect(artHash(new Uint8Array([0]))).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("paths", () => {
  it("upper-cases the ticker so a lookup can't miss on case", () => {
    expect(iconPath("nvda", "abc12345", "svg")).toBe("icons/NVDA-abc12345.svg");
    expect(cardPath("nvda", "abc12345")).toBe("cards/NVDA-abc12345.webp");
  });

  it("puts the hash in the path, which is what lets the object be immutable", () => {
    expect(cardPath("NVDA", "11111111")).not.toBe(cardPath("NVDA", "22222222"));
  });
});

describe("ART_CACHE_CONTROL", () => {
  /**
   * Supabase interpolates this into `public, max-age=${value}`. A full header
   * here produced `max-age=public, max-age=...`, which is invalid and silently
   * made every object uncacheable.
   */
  it("is a max-age value, not a complete header", () => {
    expect(ART_CACHE_CONTROL).not.toMatch(/max-age=/);
    expect(`public, max-age=${ART_CACHE_CONTROL}`).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});

describe("artUrl", () => {
  it("passes null through — missing art is normal, not an error", () => {
    expect(artUrl(null)).toBeNull();
    expect(artUrl(undefined)).toBeNull();
    expect(artUrl("")).toBeNull();
  });

  it("leaves an absolute URL alone, so art can be hosted elsewhere", () => {
    const external = "https://cdn.example.com/NVDA.webp";
    expect(artUrl(external)).toBe(external);
  });

  it("returns a public object URL or null, never a bare storage path", () => {
    // Depends on whether this environment has Supabase configured, so assert
    // the invariant rather than a literal: a caller must never receive a path
    // it would have to know the bucket to resolve.
    const out = artUrl("cards/NVDA-abc12345.webp");
    if (out !== null) {
      expect(out).toMatch(
        /^https?:\/\/.+\/storage\/v1\/object\/public\/asset-logos\/cards\/NVDA-abc12345\.webp$/,
      );
    }
  });
});

describe("assetArt", () => {
  it("resolves the two variants independently", () => {
    const art = assetArt({ icon_ref: null, card_ref: null });
    expect(art).toEqual({ iconUrl: null, cardUrl: null });
  });
});
