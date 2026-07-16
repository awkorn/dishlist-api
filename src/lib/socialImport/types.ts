// Shared types for the social-media recipe import pipeline. The fetcher
// interface isolates the scraping vendor so it can be swapped without touching
// the pipeline (see scrapeCreatorsFetcher.ts for the current implementation).

import type { SocialPlatform } from "@prisma/client";

export interface SocialPost {
  platform: SocialPlatform;
  /** Final post URL after any short-link redirects (vm.tiktok.com etc.). */
  resolvedUrl: string;
  caption: string | null;
  authorHandle: string | null;
  thumbnailUrl: string | null;
  /** Direct downloadable video URL, when the post has a video. */
  videoUrl: string | null;
  durationSec: number | null;
}

export interface SocialPostFetcher {
  fetchPost(url: string, platform: SocialPlatform): Promise<SocialPost>;
}

export type ImportErrorCode =
  | "SCRAPE_FAILED"
  | "PRIVATE_POST"
  | "NO_RECIPE_FOUND"
  | "VIDEO_TOO_LONG"
  | "MODERATION_BLOCKED"
  | "TIMEOUT"
  | "INTERNAL";

/** User-displayable message per failure code (also used in the failure push). */
export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  SCRAPE_FAILED: "We couldn't read that post. Please try again later.",
  PRIVATE_POST: "That post appears to be private or unavailable.",
  NO_RECIPE_FOUND: "We couldn't find a recipe in that post.",
  VIDEO_TOO_LONG: "Videos over 10 minutes aren't supported.",
  MODERATION_BLOCKED: "This content can't be imported.",
  TIMEOUT: "The import took too long. Please try again.",
  INTERNAL: "Something went wrong importing that post. Please try again.",
};

export function getImportFailureMessage(
  code: ImportErrorCode,
  recipeTitle?: string
): string {
  const subject = recipeTitle ? `"${recipeTitle}"` : "The recipe";
  return `${subject} wasn't added to My Recipes. ${IMPORT_ERROR_MESSAGES[code]}`;
}

export class SocialImportError extends Error {
  constructor(
    public code: ImportErrorCode,
    message?: string
  ) {
    super(message ?? IMPORT_ERROR_MESSAGES[code]);
    this.name = "SocialImportError";
  }

  /** The message shown to the user (never internal detail). */
  get userMessage(): string {
    return IMPORT_ERROR_MESSAGES[this.code];
  }
}
