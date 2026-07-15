import { describe, expect, it } from "vitest";
import {
  canonicalizeSocialUrl,
  detectPlatform,
  extractFirstUrl,
} from "../socialImport/urlUtils";

describe("detectPlatform", () => {
  it.each([
    ["https://www.tiktok.com/@user/video/7186537191194365227", "TIKTOK"],
    ["https://vm.tiktok.com/ZM6KEnDs7/", "TIKTOK"],
    ["https://vt.tiktok.com/ZS8abc123/", "TIKTOK"],
    ["https://m.tiktok.com/v/123.html", "TIKTOK"],
    ["https://www.instagram.com/reel/C0abc123/", "INSTAGRAM"],
    ["https://instagram.com/p/C0abc123/", "INSTAGRAM"],
    ["https://instagr.am/p/C0abc123/", "INSTAGRAM"],
    ["https://www.facebook.com/reel/1535656380759655", "FACEBOOK"],
    ["https://fb.watch/abc123/", "FACEBOOK"],
    ["https://m.facebook.com/watch/?v=123", "FACEBOOK"],
    ["https://fb.com/some/post", "FACEBOOK"],
  ])("detects %s as %s", (url, platform) => {
    expect(detectPlatform(url)).toBe(platform);
  });

  it.each([
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://pinterest.com/pin/123",
    "https://eviltiktok.com/@user/video/1",
    "https://tiktok.com.evil.io/x",
    "not a url",
    "ftp://tiktok.com/x",
  ])("rejects %s", (url) => {
    expect(detectPlatform(url)).toBeNull();
  });
});

describe("canonicalizeSocialUrl", () => {
  it("strips query params, hash, trailing slash, and www", () => {
    expect(
      canonicalizeSocialUrl(
        "https://www.tiktok.com/@user/video/123/?is_from_webapp=1&sender_device=pc#top"
      )
    ).toBe("https://tiktok.com/@user/video/123");
  });

  it("lowercases the host but preserves path case", () => {
    expect(canonicalizeSocialUrl("https://Instagram.com/reel/C0AbC/")).toBe(
      "https://instagram.com/reel/C0AbC"
    );
  });

  it("normalizes http to https", () => {
    expect(canonicalizeSocialUrl("http://fb.watch/xyz")).toBe(
      "https://fb.watch/xyz"
    );
  });

  it("produces the same key for tracking-param variants", () => {
    const a = canonicalizeSocialUrl(
      "https://www.instagram.com/reel/C0abc/?igsh=MzRlODBiNWFlZA=="
    );
    const b = canonicalizeSocialUrl("https://instagram.com/reel/C0abc");
    expect(a).toBe(b);
  });
});

describe("extractFirstUrl", () => {
  it("pulls a URL out of TikTok-style share text", () => {
    expect(
      extractFirstUrl("Check out this video! https://vm.tiktok.com/ZM6KEnDs7/")
    ).toBe("https://vm.tiktok.com/ZM6KEnDs7/");
  });

  it("returns a bare URL unchanged", () => {
    expect(extractFirstUrl("https://instagram.com/reel/C0abc/")).toBe(
      "https://instagram.com/reel/C0abc/"
    );
  });

  it("strips trailing punctuation", () => {
    expect(extractFirstUrl("Look: https://fb.watch/xyz.")).toBe(
      "https://fb.watch/xyz"
    );
  });

  it("returns null when there is no URL", () => {
    expect(extractFirstUrl("just some text")).toBeNull();
  });
});
