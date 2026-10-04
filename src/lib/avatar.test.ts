import { describe, it, expect } from "vitest";
import { avatarPath, avatarUrl, AVATAR_CACHE_CONTROL, AVATAR_BUCKET } from "./avatar.js";

describe("avatarPath", () => {
  it("sanitises the DID, which contains colons", () => {
    expect(avatarPath("did:privy:abc123", "deadbeef")).toBe("did-privy-abc123/deadbeef.webp");
  });

  it("namespaces by user, so one delete can't orphan another's image", () => {
    const a = avatarPath("did:privy:aaa", "samehash");
    const b = avatarPath("did:privy:bbb", "samehash");
    expect(a.split("/")[0]).not.toBe(b.split("/")[0]);
  });

  it("puts the content hash in the filename, so a replacement is a new path", () => {
    expect(avatarPath("did:privy:a", "1111")).not.toBe(avatarPath("did:privy:a", "2222"));
  });
});

describe("AVATAR_CACHE_CONTROL", () => {
  /** Supabase interpolates this into `public, max-age=${value}`. */
  it("is a max-age value, not a complete header", () => {
    expect(AVATAR_CACHE_CONTROL).not.toMatch(/max-age=/);
  });

  /**
   * The bucket is public and CDN-fronted, so a deleted object keeps being
   * served until its TTL expires. `immutable` or a long max-age would mean
   * deleting a photo doesn't make it unreachable for up to that long.
   */
  it("is short and not immutable, so a deleted photo stops being served", () => {
    expect(AVATAR_CACHE_CONTROL).not.toMatch(/immutable/);
    expect(Number(AVATAR_CACHE_CONTROL)).toBeLessThanOrEqual(3600);
  });
});

describe("avatarUrl", () => {
  it("returns null when the user has no photo — not an error", () => {
    expect(avatarUrl(null)).toBeNull();
    expect(avatarUrl(undefined)).toBeNull();
    expect(avatarUrl("")).toBeNull();
  });

  it("leaves an absolute URL alone", () => {
    expect(avatarUrl("https://cdn.example.com/a.webp")).toBe("https://cdn.example.com/a.webp");
  });

  it("never returns a bare storage path the client would have to resolve", () => {
    const out = avatarUrl("did-privy-a/deadbeef.webp");
    if (out !== null) {
      expect(out).toContain(`/storage/v1/object/public/${AVATAR_BUCKET}/`);
      expect(out).toMatch(/^https?:\/\//);
    }
  });
});
