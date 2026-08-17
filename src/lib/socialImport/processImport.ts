import type { Prisma } from "@prisma/client";
import prisma from "../prisma";
import { ModerationError, moderateTextFields } from "../moderation";
import { cleanRecipeItems, type RecipeItem } from "../../types/recipe";
import { extractRecipeFromCaption } from "./captionExtraction";
import { extractRecipeFromVideo } from "./geminiVideoExtraction";
import { extractRecipeFromPostImages } from "./imageExtraction";
import { logSocialImportEvent } from "./metrics";
import { assessImportQuality } from "./quality";
import { ingestThumbnail } from "./thumbnail";
import {
  canonicalizeSocialUrl,
  extractPlatformPostId,
  extractUrls,
  detectPlatform,
} from "./urlUtils";
import { extractRecipeFromWebsite } from "./websiteExtraction";
import {
  getImportFailureMessage,
  SocialImportError,
  type SocialPostFetcher,
} from "./types";
import { ScrapeCreatorsFetcher } from "./scrapeCreatorsFetcher";

const OVERALL_TIMEOUT_MS = 4 * 60 * 1000;
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set(["SCRAPE_FAILED", "TIMEOUT", "INTERNAL"]);

const defaultFetcher: SocialPostFetcher = new ScrapeCreatorsFetcher();

export interface ProcessImportOptions {
  leaseToken: string;
  fetcher?: SocialPostFetcher;
}

function knownError(error: unknown): SocialImportError {
  return error instanceof SocialImportError
    ? error
    : new SocialImportError("INTERNAL");
}

export async function processImport(
  importId: string,
  options: ProcessImportOptions
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  let leaseLost = false;
  let recipeTitle: string | undefined;
  let timeout: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new SocialImportError("TIMEOUT"));
    }, OVERALL_TIMEOUT_MS);
  });
  const heartbeat = setInterval(() => {
    void prisma.recipeImport
      .updateMany({
        where: {
          id: importId,
          status: "PROCESSING",
          leaseToken: options.leaseToken,
          cancelRequestedAt: null,
        },
        data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
      })
      .then(({ count }) => {
        if (count === 0) {
          leaseLost = true;
          controller.abort();
        }
      })
      .catch((error) => console.error(`Import ${importId} heartbeat failed:`, error));
  }, HEARTBEAT_MS);

  try {
    const pipeline = runPipeline(
      importId,
      options.leaseToken,
      options.fetcher ?? defaultFetcher,
      controller.signal,
      (title) => {
        recipeTitle = title;
      }
    );
    recipeTitle = await Promise.race([pipeline, timeoutPromise]);
  } catch (error) {
    const normalized = timedOut
      ? new SocialImportError("TIMEOUT")
      : leaseLost
        ? new SocialImportError("CANCELLED")
        : knownError(error);
    await markFailed(importId, options.leaseToken, normalized, recipeTitle);
  } finally {
    clearTimeout(timeout!);
    clearInterval(heartbeat);
  }
}

async function setPhase(importId: string, leaseToken: string, phase: string) {
  const result = await prisma.recipeImport.updateMany({
    where: {
      id: importId,
      status: "PROCESSING",
      leaseToken,
      cancelRequestedAt: null,
    },
    data: { phase, leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
  if (result.count !== 1) throw new SocialImportError("CANCELLED");
  logSocialImportEvent("phase", { importId, phase });
}

async function runPipeline(
  importId: string,
  leaseToken: string,
  fetcher: SocialPostFetcher,
  signal: AbortSignal,
  onRecipeTitle: (title: string) => void
): Promise<string | undefined> {
  const importRecord = await prisma.recipeImport.findFirst({
    where: { id: importId, status: "PROCESSING", leaseToken },
  });
  if (!importRecord) throw new SocialImportError("CANCELLED");
  const { userId, platform, sourceUrl } = importRecord;

  await setPhase(importId, leaseToken, "FETCHING_POST");
  const post = await fetcher.fetchPost(sourceUrl, platform, { signal });
  if (detectPlatform(post.resolvedUrl) !== platform) {
    console.warn(`Import ${importId} vendor returned a mismatched resolved URL`);
    post.resolvedUrl = sourceUrl;
  }

  const resolvedCanonical = canonicalizeSocialUrl(post.resolvedUrl);
  const platformPostId = extractPlatformPostId(post.resolvedUrl, platform);
  try {
    await prisma.recipeImport.updateMany({
      where: { id: importId, status: "PROCESSING", leaseToken },
      data: { canonicalUrl: resolvedCanonical, platformPostId },
    });
  } catch (error) {
    if ((error as { code?: string })?.code !== "P2002" || !platformPostId) throw error;
    const duplicate = await prisma.recipeImport.findFirst({
      where: { userId, platform, platformPostId, id: { not: importId } },
    });
    if (duplicate) {
      await prisma.recipeImport.updateMany({
        where: { id: importId, status: "PROCESSING", leaseToken },
        data: {
          status:
            duplicate.status === "COMPLETED" || duplicate.status === "REVIEW_REQUIRED"
              ? duplicate.status
              : "CANCELLED",
          phase: "DUPLICATE",
          recipeId: duplicate.recipeId,
          warnings: duplicate.warnings,
          confidence: duplicate.confidence,
          finishedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      logSocialImportEvent("deduplicated_after_resolution", { importId, platform });
      return undefined;
    }
  }

  await setPhase(importId, leaseToken, "EXTRACTING_CAPTION");
  const caption = await extractRecipeFromCaption(post.caption, { signal });
  let recipe = caption.sufficient ? caption.recipe : null;
  let extractionSource = caption.sufficient
    ? platform === "YOUTUBE" && post.caption?.includes("Transcript:")
      ? "transcript"
      : "caption"
    : null;
  const multipleRecipesDetected = caption.sufficient
    ? caption.multipleRecipesDetected
    : false;
  const language = caption.sufficient ? caption.language : post.language;

  if (!recipe) {
    await setPhase(importId, leaseToken, "CHECKING_RECIPE_LINK");
    const candidateUrls = [
      ...post.outboundUrls,
      ...extractUrls(post.caption ?? "").filter((url) => url !== post.resolvedUrl),
    ];
    recipe = await extractRecipeFromWebsite(candidateUrls, signal);
    if (recipe) extractionSource = "linked_website";
  }

  if (!recipe && post.imageUrls.length > 0) {
    await setPhase(importId, leaseToken, "READING_POST_IMAGES");
    recipe = await extractRecipeFromPostImages(post.imageUrls, signal);
    if (recipe) extractionSource = "carousel_images";
  }

  if (!recipe) {
    await setPhase(importId, leaseToken, "ANALYZING_VIDEO");
    recipe = await extractRecipeFromVideo(post, { signal });
    extractionSource = "video";
  }

  const title = recipe.title.slice(0, 100) || "Imported Recipe";
  onRecipeTitle(title);
  const quality = assessImportQuality(recipe, { multipleRecipesDetected });

  await setPhase(importId, leaseToken, "MODERATING");
  try {
    await moderateTextFields(
      [
        { label: "Recipe title", value: recipe.title },
        { label: "Recipe ingredients", value: recipe.ingredients },
        { label: "Recipe instructions", value: recipe.instructions },
      ],
      { targetType: "RECIPE", userId }
    );
  } catch (error) {
    if (error instanceof ModerationError) {
      throw new SocialImportError("MODERATION_BLOCKED");
    }
    throw error;
  }

  await setPhase(importId, leaseToken, "SAVING");
  const thumbnailUrl = await ingestThumbnail(userId, post.thumbnailUrl, { signal });
  const cleanedIngredients = cleanRecipeItems(recipe.ingredients as RecipeItem[]);
  const cleanedInstructions = cleanRecipeItems(recipe.instructions as RecipeItem[]);
  const terminalStatus = quality.needsReview ? "REVIEW_REQUIRED" : "COMPLETED";

  const savedRecipe = await prisma.$transaction(
    async (tx) => {
      const active = await tx.recipeImport.findFirst({
        where: {
          id: importId,
          status: "PROCESSING",
          leaseToken,
          cancelRequestedAt: null,
        },
      });
      if (!active || signal.aborted) throw new SocialImportError("CANCELLED");

      let dishList = await tx.dishList.findFirst({
        where: { ownerId: userId, isDefault: true },
      });
      if (!dishList) {
        dishList = await tx.dishList.create({
          data: {
            title: "My Recipes",
            ownerId: userId,
            isDefault: true,
            visibility: "PRIVATE",
          },
        });
      }

      if (signal.aborted) throw new SocialImportError("CANCELLED");

      const created = await tx.recipe.create({
        data: {
          title,
          description: null,
          ingredients: cleanedIngredients as unknown as Prisma.InputJsonValue,
          instructions: cleanedInstructions as unknown as Prisma.InputJsonValue,
          prepTime: recipe.prepTime,
          cookTime: recipe.cookTime,
          servings: recipe.servings,
          imageUrl: thumbnailUrl,
          imageUrls: thumbnailUrl ? [thumbnailUrl] : [],
          sourceUrl: post.resolvedUrl,
          sourcePlatform: platform,
          sourceAuthor: post.authorHandle,
          sourceLanguage: language,
          importWarnings: quality.warnings,
          importConfidence: quality.confidence,
          importNeedsReview: quality.needsReview,
          importSource: extractionSource,
          creatorId: userId,
        },
      });

      await tx.dishListRecipe.create({
        data: { dishListId: dishList.id, recipeId: created.id, addedById: userId },
      });

      if (signal.aborted) throw new SocialImportError("CANCELLED");

      const completed = await tx.recipeImport.updateMany({
        where: { id: importId, status: "PROCESSING", leaseToken },
        data: {
          status: terminalStatus,
          phase: quality.needsReview ? "NEEDS_REVIEW" : "COMPLETED",
          recipeId: created.id,
          extractionSource,
          warnings: quality.warnings,
          confidence: quality.confidence,
          errorCode: null,
          errorMessage: null,
          finishedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (completed.count !== 1) throw new SocialImportError("CANCELLED");
      return created;
    },
    { isolationLevel: "Serializable" }
  );

  logSocialImportEvent("completed", {
    importId,
    platform,
    extractionSource,
    confidence: quality.confidence,
    needsReview: quality.needsReview,
  });

  if (quality.needsReview) {
    await prisma.notification
      .create({
        data: {
          type: "RECIPE_IMPORT_COMPLETED",
          title: "Review imported recipe",
          message: `“${savedRecipe.title}” was added with details to review.`,
          receiverId: userId,
          data: JSON.stringify({ recipeId: savedRecipe.id, importId, warnings: quality.warnings }),
        },
      })
      .catch((error) => console.error(`Review notification ${importId} failed:`, error));
  }

  return title;
}

async function markFailed(
  importId: string,
  leaseToken: string,
  error: SocialImportError,
  recipeTitle?: string
) {
  if (error.code === "CANCELLED") {
    await prisma.recipeImport.updateMany({
      where: { id: importId, status: "PROCESSING", leaseToken },
      data: {
        status: "CANCELLED",
        phase: "CANCELLED",
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    return;
  }

  const record = await prisma.recipeImport.findFirst({
    where: { id: importId, status: "PROCESSING", leaseToken },
  });
  if (!record) return;

  if (RETRYABLE_CODES.has(error.code) && record.attempt < MAX_ATTEMPTS) {
    const delayMs = 15_000 * 2 ** Math.max(0, record.attempt - 1);
    await prisma.recipeImport.updateMany({
      where: { id: importId, status: "PROCESSING", leaseToken },
      data: {
        status: "PENDING",
        phase: "RETRY_SCHEDULED",
        nextAttemptAt: new Date(Date.now() + delayMs),
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: error.code,
        errorMessage: "Retrying automatically…",
      },
    });
    logSocialImportEvent("retry_scheduled", {
      importId,
      attempt: record.attempt,
      errorCode: error.code,
    });
    return;
  }

  const failureMessage = getImportFailureMessage(error.code, recipeTitle);
  const failed = await prisma.recipeImport.updateMany({
    where: { id: importId, status: "PROCESSING", leaseToken },
    data: {
      status: "FAILED",
      phase: "FAILED",
      errorCode: error.code,
      errorMessage: failureMessage,
      finishedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (failed.count !== 1) return;

  logSocialImportEvent("failed", {
    importId,
    platform: record.platform,
    attempt: record.attempt,
    errorCode: error.code,
  });
  await prisma.notification
    .create({
      data: {
        type: "RECIPE_IMPORT_FAILED",
        title: "Recipe not added",
        message: failureMessage,
        receiverId: record.userId,
        data: JSON.stringify({ importId, errorCode: error.code, recipeTitle }),
      },
    })
    .catch((notificationError) =>
      console.error(`Failure notification ${importId} failed:`, notificationError)
    );
}

export const socialImportLeaseMs = LEASE_MS;
