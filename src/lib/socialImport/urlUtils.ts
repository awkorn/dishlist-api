// Pure URL helpers for social imports: platform detection, canonicalization
// (the idempotency key), and pulling a URL out of raw shared text. Dependency-
// free so they can be unit tested directly (see __tests__/socialImportUrl.test.ts).

import type { SocialPlatform } from "@prisma/client";

// Hostname allowlist per platform. Subdomains of each entry also match
// (www.tiktok.com, m.facebook.com, …). Share sheets hand us user-tapped links,
// so anything outside this list is rejected rather than fetched.
const PLATFORM_HOSTS: Record<SocialPlatform, string[]> = {
  TIKTOK: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  INSTAGRAM: ["instagram.com", "instagr.am"],
  FACEBOOK: ["facebook.com", "fb.com", "fb.watch"],
};

function hostMatches(hostname: string, allowed: string) {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

export function detectPlatform(url: string): SocialPlatform | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const hostname = parsed.hostname.toLowerCase();
  for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
    if (hosts.some((h) => hostMatches(hostname, h))) {
      return platform as SocialPlatform;
    }
  }
  return null;
}

/**
 * Normalize a social post URL into the idempotency key: https, lowercase host,
 * no query/hash/tracking params, no trailing slash. Short links (vm.tiktok.com)
 * canonicalize as-is here and are re-canonicalized once the fetcher resolves
 * the redirect to the full post URL.
 */
export function canonicalizeSocialUrl(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let path = parsed.pathname.replace(/\/+$/, "");
  return `https://${host}${path}`;
}

/**
 * Extract the first http(s) URL from raw shared text. TikTok's share sheet
 * often provides text like "Check out this video! https://vm.tiktok.com/XYZ/"
 * rather than a bare URL.
 */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return null;
  // Strip common trailing punctuation the regex may have swallowed.
  return match[0].replace(/[).,!?]+$/, "");
}
