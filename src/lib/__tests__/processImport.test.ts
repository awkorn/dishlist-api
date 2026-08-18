import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => {
  const recipeImport = {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  };
  const notification = { create: vi.fn() };
  const tx = {
    recipeImport: { findFirst: vi.fn(), updateMany: vi.fn() },
    dishList: { findFirst: vi.fn(), create: vi.fn() },
    recipe: { create: vi.fn() },
    dishListRecipe: { create: vi.fn() },
  };
  return {
    default: {
      recipeImport,
      notification,
      $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});
vi.mock("../moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../moderation")>();
  return { ...actual, moderateTextFields: vi.fn() };
});
vi.mock("../socialImport/captionExtraction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../socialImport/captionExtraction")>();
  return { ...actual, extractRecipeFromCaption: vi.fn() };
});
vi.mock("../socialImport/geminiVideoExtraction", () => ({ extractRecipeFromVideo: vi.fn() }));
vi.mock("../socialImport/imageExtraction", () => ({ extractRecipeFromPostImages: vi.fn() }));
vi.mock("../socialImport/websiteExtraction", () => ({ extractRecipeFromWebsite: vi.fn() }));
vi.mock("../socialImport/thumbnail", () => ({ ingestThumbnail: vi.fn() }));

import prisma from "../prisma";
import { moderateTextFields } from "../moderation";
import { extractRecipeFromCaption } from "../socialImport/captionExtraction";
import { extractRecipeFromVideo } from "../socialImport/geminiVideoExtraction";
import { ingestThumbnail } from "../socialImport/thumbnail";
import { processImport } from "../socialImport/processImport";
import {
  SocialImportError,
  type SocialPost,
  type SocialPostFetcher,
} from "../socialImport/types";

const mockPrisma = prisma as any;
const importRow = {
  id: "imp_1",
  userId: "user_1",
  platform: "TIKTOK",
  sourceUrl: "https://vm.tiktok.com/ZM6/",
  canonicalUrl: "https://vm.tiktok.com/ZM6",
  status: "PROCESSING",
  leaseToken: "lease",
  attempt: 3,
};
const post: SocialPost = {
  platform: "TIKTOK",
  resolvedUrl: "https://tiktok.com/@lynja/video/123",
  caption: "some caption",
  authorHandle: "@lynja",
  thumbnailUrl: "https://cdn.tiktok.com/thumb.jpg",
  imageUrls: [],
  outboundUrls: [],
  videoUrl: "https://cdn.tiktok.com/video.mp4",
  durationSec: 90,
  language: null,
};
const completeRecipe = {
  title: "Garlic Noodles",
  description: null,
  prepTime: 5,
  cookTime: 10,
  servings: 2,
  ingredients: [{ type: "item", text: "8oz spaghetti" }],
  instructions: [{ type: "item", text: "Boil pasta" }],
};

function fetcherReturning(value: SocialPost | Error): SocialPostFetcher {
  return {
    fetchPost: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.recipeImport.findFirst.mockResolvedValue(importRow);
  mockPrisma.recipeImport.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.__tx.recipeImport.findFirst.mockResolvedValue(importRow);
  mockPrisma.__tx.recipeImport.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.__tx.dishList.findFirst.mockResolvedValue({ id: "dl_1" });
  mockPrisma.__tx.recipe.create.mockResolvedValue({ id: "rec_1", title: "Garlic Noodles" });
  mockPrisma.__tx.dishListRecipe.create.mockResolvedValue({});
  mockPrisma.notification.create.mockResolvedValue({ id: "n_1" });
  (ingestThumbnail as any).mockResolvedValue(null);
});

describe("processImport durable pipeline", () => {
  it("commits recipe and COMPLETED status and records it in notifications", async () => {
    (extractRecipeFromCaption as any).mockResolvedValue({
      sufficient: true,
      recipe: completeRecipe,
      multipleRecipesDetected: false,
      language: "en",
    });

    await processImport("imp_1", {
      leaseToken: "lease",
      fetcher: fetcherReturning(post),
    });

    expect(mockPrisma.__tx.recipe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Garlic Noodles",
          sourcePlatform: "TIKTOK",
          importNeedsReview: false,
          importSource: "caption",
        }),
      })
    );
    expect(mockPrisma.__tx.recipeImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED", recipeId: "rec_1" }),
      })
    );
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RECIPE_IMPORT_COMPLETED",
          title: "Recipe imported",
          message: "“Garlic Noodles” was added to My Recipes.",
        }),
      })
    );
  });

  it("falls back to video when caption extraction is insufficient", async () => {
    (extractRecipeFromCaption as any).mockResolvedValue({ sufficient: false });
    (extractRecipeFromVideo as any).mockResolvedValue(completeRecipe);

    await processImport("imp_1", {
      leaseToken: "lease",
      fetcher: fetcherReturning(post),
    });

    expect(extractRecipeFromVideo).toHaveBeenCalledWith(post, {
      signal: expect.any(AbortSignal),
    });
    expect(mockPrisma.__tx.recipe.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ importSource: "video" }) })
    );
  });

  it("marks incomplete extraction for review and sends an actionable notification", async () => {
    (extractRecipeFromCaption as any).mockResolvedValue({
      sufficient: true,
      recipe: { ...completeRecipe, instructions: [] },
      multipleRecipesDetected: false,
      language: null,
    });

    await processImport("imp_1", {
      leaseToken: "lease",
      fetcher: fetcherReturning(post),
    });

    expect(mockPrisma.__tx.recipeImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REVIEW_REQUIRED" }),
      })
    );
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: "Review imported recipe" }) })
    );
  });

  it("records a terminal known failure after retry budget is exhausted", async () => {
    await processImport("imp_1", {
      leaseToken: "lease",
      fetcher: fetcherReturning(new SocialImportError("PRIVATE_POST")),
    });

    expect(mockPrisma.recipeImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorCode: "PRIVATE_POST" }),
      })
    );
  });

  it("schedules retryable failures without notifying prematurely", async () => {
    mockPrisma.recipeImport.findFirst.mockResolvedValue({ ...importRow, attempt: 1 });
    await processImport("imp_1", {
      leaseToken: "lease",
      fetcher: fetcherReturning(new SocialImportError("SCRAPE_FAILED")),
    });

    expect(mockPrisma.recipeImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) })
    );
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it("does not change terminal status when notification delivery fails", async () => {
    (extractRecipeFromCaption as any).mockResolvedValue({
      sufficient: true,
      recipe: { ...completeRecipe, instructions: [] },
      multipleRecipesDetected: false,
      language: null,
    });
    mockPrisma.notification.create.mockRejectedValue(new Error("push down"));

    await expect(
      processImport("imp_1", {
        leaseToken: "lease",
        fetcher: fetcherReturning(post),
      })
    ).resolves.toBeUndefined();
    expect(mockPrisma.__tx.recipeImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REVIEW_REQUIRED" }) })
    );
  });

  it("revokes the lease on timeout so late work cannot write a recipe", async () => {
    vi.useFakeTimers();
    (extractRecipeFromCaption as any).mockResolvedValue({
      sufficient: true,
      recipe: completeRecipe,
      multipleRecipesDetected: false,
      language: null,
    });
    (moderateTextFields as any).mockImplementation(() => new Promise(() => {}));

    const processing = processImport("imp_1", {
      leaseToken: "lease",
      fetcher: fetcherReturning(post),
    });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1);
    await processing;

    expect(mockPrisma.recipeImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorCode: "TIMEOUT" }),
      })
    );
    expect(mockPrisma.__tx.recipe.create).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
