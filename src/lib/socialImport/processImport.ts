// Orchestrator for a social-media recipe import. Runs in-process,
// fire-and-forget (no queue): the route creates a PENDING RecipeImport row,
// returns 202, then calls processImport(importId) without awaiting. Every exit
// path — success, known failure, crash, watchdog timeout — lands the row in
// COMPLETED or FAILED and notifies the user (the notification-push Prisma
// extension turns notification.create into an Expo push automatically).

import type { Prisma } from "@prisma/client";
import prisma from "../prisma";
import { ModerationError, moderateTextFields } from "../moderation";
import { cleanRecipeItems, type RecipeItem } from "../../types/recipe";
import { getImportWarnings } from "../recipeValidation";
import { extractRecipeFromCaption } from "./captionExtraction";
import { extractRecipeFromVideo } from "./geminiVideoExtraction";
import { ingestThumbnail } from "./thumbnail";
import { canonicalizeSocialUrl } from "./urlUtils";
import {
  IMPORT_ERROR_MESSAGES,
  SocialImportError,
  type SocialPostFetcher,
} from "./types";
import { ScrapeCreatorsFetcher } from "./scrapeCreatorsFetcher";

// Bounds the whole pipeline (scrape + model calls + video download). The
// status GET applies a 10-minute staleness backstop on top of this for rows
// stranded by a server restart.
const OVERALL_TIMEOUT_MS = 4 * 60 * 1000;

const defaultFetcher: SocialPostFetcher = new ScrapeCreatorsFetcher();

export async function processImport(
  importId: string,
  fetcher: SocialPostFetcher = defaultFetcher
): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new SocialImportError("TIMEOUT")),
      OVERALL_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([runPipeline(importId, fetcher), watchdog]);
  } catch (error) {
    await markFailed(importId, error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function runPipeline(importId: string, fetcher: SocialPostFetcher) {
  const importRecord = await prisma.recipeImport.update({
    where: { id: importId },
    data: { status: "PROCESSING" },
  });
  const { userId, platform, sourceUrl } = importRecord;

  // 1. Fetch the post via the scraping vendor.
  const post = await fetcher.fetchPost(sourceUrl, platform);

  // Re-canonicalize now that short links are resolved, so future re-shares of
  // the full URL dedupe against this row. A unique-constraint hit means the
  // user already imported this post through the other URL form — keep the
  // original canonicalUrl and let this import proceed independently.
  try {
    const resolvedCanonical = canonicalizeSocialUrl(post.resolvedUrl);
    if (resolvedCanonical !== importRecord.canonicalUrl) {
      await prisma.recipeImport.update({
        where: { id: importId },
        data: { canonicalUrl: resolvedCanonical },
      });
    }
  } catch {
    // Canonicalization is best-effort; never fail the import over it.
  }

  // 2. Caption-first extraction; fall back to full-video understanding.
  let recipe;
  const captionResult = await extractRecipeFromCaption(post.caption);
  if (captionResult.sufficient) {
    recipe = captionResult.recipe;
  } else {
    recipe = await extractRecipeFromVideo(post);
  }

  // 3. Moderate the extracted text exactly like a user-created recipe.
  try {
    await moderateTextFields(
      [
        { label: "Recipe title", value: recipe.title },
        { label: "Recipe description", value: recipe.description },
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

  // 4. Thumbnail (best-effort — null on any failure).
  const thumbnailUrl = await ingestThumbnail(userId, post.thumbnailUrl);

  // 5. Save into the user's default "My Recipes" dishlist.
  const cleanedIngredients = cleanRecipeItems(
    recipe.ingredients as RecipeItem[]
  );
  const cleanedInstructions = cleanRecipeItems(
    recipe.instructions as RecipeItem[]
  );

  const savedRecipe = await prisma.$transaction(async (tx) => {
    let dishList = await tx.dishList.findFirst({
      where: { ownerId: userId, isDefault: true },
    });
    // Registration always creates it, but self-heal if it's ever missing
    // (mirrors routes/users.ts).
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

    const created = await tx.recipe.create({
      data: {
        title: recipe.title.slice(0, 100) || "Imported Recipe",
        description: recipe.description,
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
        creatorId: userId,
      },
    });

    await tx.dishListRecipe.create({
      data: {
        dishListId: dishList.id,
        recipeId: created.id,
        addedById: userId,
      },
    });

    return created;
  });

  // 6. Mark complete + notify (notification.create fires the push).
  await prisma.recipeImport.update({
    where: { id: importId },
    data: { status: "COMPLETED", recipeId: savedRecipe.id },
  });

  const warnings = getImportWarnings(recipe);
  await prisma.notification.create({
    data: {
      type: "RECIPE_IMPORT_COMPLETED",
      title: "Recipe saved",
      message: `"${savedRecipe.title}" was added to My Recipes`,
      receiverId: userId,
      data: JSON.stringify({
        recipeId: savedRecipe.id,
        importId,
        warnings: warnings.length > 0 ? warnings : undefined,
      }),
    },
  });
}

async function markFailed(importId: string, error: unknown) {
  const known =
    error instanceof SocialImportError
      ? error
      : new SocialImportError("INTERNAL");
  if (!(error instanceof SocialImportError)) {
    console.error(`Social import ${importId} crashed:`, error);
  } else {
    console.warn(`Social import ${importId} failed [${known.code}]:`, known.message);
  }

  try {
    const record = await prisma.recipeImport.update({
      where: { id: importId },
      data: {
        status: "FAILED",
        errorCode: known.code,
        errorMessage: IMPORT_ERROR_MESSAGES[known.code],
      },
    });

    await prisma.notification.create({
      data: {
        type: "RECIPE_IMPORT_FAILED",
        title: "Couldn't save recipe",
        message: IMPORT_ERROR_MESSAGES[known.code],
        receiverId: record.userId,
        data: JSON.stringify({ importId, errorCode: known.code }),
      },
    });
  } catch (updateError) {
    // Nothing left to do — the staleness backstop in the status GET will
    // surface the failure to the client.
    console.error(`Failed to mark import ${importId} as failed:`, updateError);
  }
}
