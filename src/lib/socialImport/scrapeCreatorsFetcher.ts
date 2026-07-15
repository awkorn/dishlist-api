// ScrapeCreators-backed SocialPostFetcher — the only vendor-specific file in
// the pipeline. Endpoint + response-shape mapping per platform (verified
// against docs.scrapecreators.com):
//   TIKTOK    GET /v2/tiktok/video?url=…    → aweme_detail.{desc, author.unique_id,
//             video.cover.url_list, video.play_addr.url_list, video.duration (ms)}
//   INSTAGRAM GET /v1/instagram/post?url=…  → data.xdt_shortcode_media.{edge_media_to_caption,
//             owner.username, thumbnail_src|display_url, video_url, video_duration (s)}
//   FACEBOOK  GET /v1/facebook/post?url=…   → {description, author.name,
//             video.{thumbnail, sd_url|hd_url, length_in_second}}
// Field access is defensive throughout: vendor schema drift should degrade to
// nulls (→ NO_RECIPE_FOUND downstream), not crash the pipeline.

import type { SocialPlatform } from "@prisma/client";
import {
  SocialImportError,
  type SocialPost,
  type SocialPostFetcher,
} from "./types";

const BASE_URL = "https://api.scrapecreators.com";
const FETCH_TIMEOUT_MS = 30_000;

const PLATFORM_PATHS: Record<SocialPlatform, string> = {
  TIKTOK: "/v2/tiktok/video",
  INSTAGRAM: "/v1/instagram/post",
  FACEBOOK: "/v1/facebook/post",
};

type Raw = Record<string, any>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstUrl(list: unknown): string | null {
  return Array.isArray(list) ? str(list[0]) : null;
}

function mapTikTok(raw: Raw, inputUrl: string): SocialPost {
  const detail = raw?.aweme_detail ?? {};
  const video = detail?.video ?? {};
  const authorHandle = str(detail?.author?.unique_id);
  const awemeId = str(detail?.aweme_id);
  const durationMs = num(video?.duration);

  return {
    platform: "TIKTOK",
    // Prefer a reconstructed full URL so short links (vm.tiktok.com) dedupe
    // against the same post shared via the full URL.
    resolvedUrl:
      authorHandle && awemeId
        ? `https://tiktok.com/@${authorHandle}/video/${awemeId}`
        : str(detail?.share_url) ?? inputUrl,
    caption: str(detail?.desc),
    authorHandle: authorHandle ? `@${authorHandle}` : null,
    thumbnailUrl:
      firstUrl(video?.cover?.url_list) ??
      firstUrl(video?.dynamic_cover?.url_list),
    videoUrl:
      firstUrl(video?.play_addr?.url_list) ??
      firstUrl(video?.download_no_watermark_addr?.url_list) ??
      firstUrl(video?.download_addr?.url_list),
    durationSec: durationMs !== null ? Math.round(durationMs / 1000) : null,
  };
}

function mapInstagram(raw: Raw, inputUrl: string): SocialPost {
  const media = raw?.data?.xdt_shortcode_media ?? {};
  const username = str(media?.owner?.username);
  const shortcode = str(media?.shortcode);

  return {
    platform: "INSTAGRAM",
    resolvedUrl: shortcode
      ? `https://instagram.com/p/${shortcode}`
      : inputUrl,
    caption: str(media?.edge_media_to_caption?.edges?.[0]?.node?.text),
    authorHandle: username ? `@${username}` : null,
    thumbnailUrl: str(media?.thumbnail_src) ?? str(media?.display_url),
    videoUrl: str(media?.video_url),
    durationSec:
      num(media?.video_duration) !== null
        ? Math.round(media.video_duration)
        : null,
  };
}

function mapFacebook(raw: Raw, inputUrl: string): SocialPost {
  const video = raw?.video ?? {};

  return {
    platform: "FACEBOOK",
    resolvedUrl: str(raw?.url) ?? inputUrl,
    caption: str(raw?.description),
    authorHandle: str(raw?.author?.name),
    thumbnailUrl: str(video?.thumbnail),
    videoUrl: str(video?.hd_url) ?? str(video?.sd_url),
    durationSec:
      num(video?.length_in_second) !== null
        ? Math.round(video.length_in_second)
        : null,
  };
}

const MAPPERS: Record<SocialPlatform, (raw: Raw, url: string) => SocialPost> = {
  TIKTOK: mapTikTok,
  INSTAGRAM: mapInstagram,
  FACEBOOK: mapFacebook,
};

/**
 * Map a vendor response into a SocialPost, exported separately so fixture
 * tests can exercise the mapping without network access.
 */
export function mapScrapeCreatorsResponse(
  platform: SocialPlatform,
  raw: unknown,
  inputUrl: string
): SocialPost {
  return MAPPERS[platform]((raw ?? {}) as Raw, inputUrl);
}

export class ScrapeCreatorsFetcher implements SocialPostFetcher {
  async fetchPost(url: string, platform: SocialPlatform): Promise<SocialPost> {
    const apiKey = process.env.SCRAPECREATORS_API_KEY;
    if (!apiKey) {
      console.error("SCRAPECREATORS_API_KEY is not configured");
      throw new SocialImportError("INTERNAL");
    }

    const endpoint = `${BASE_URL}${PLATFORM_PATHS[platform]}?url=${encodeURIComponent(url)}`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError") {
        throw new SocialImportError("TIMEOUT", "Scrape request timed out");
      }
      throw new SocialImportError(
        "SCRAPE_FAILED",
        `Scrape request failed: ${(error as Error)?.message}`
      );
    }

    if (response.status === 404) {
      throw new SocialImportError("PRIVATE_POST");
    }
    if (!response.ok) {
      throw new SocialImportError(
        "SCRAPE_FAILED",
        `Scrape API returned ${response.status}`
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new SocialImportError("SCRAPE_FAILED", "Scrape API returned non-JSON");
    }

    // Some vendor endpoints report success/not-found in the body.
    const body = raw as Raw;
    if (body?.success === false || body?.error) {
      const message = str(body?.error) ?? "unknown vendor error";
      if (/private|not found|unavailable|removed/i.test(message)) {
        throw new SocialImportError("PRIVATE_POST");
      }
      throw new SocialImportError("SCRAPE_FAILED", `Vendor error: ${message}`);
    }

    return mapScrapeCreatorsResponse(platform, raw, url);
  }
}
