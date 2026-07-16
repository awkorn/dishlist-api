import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the heavy collaborators; the orchestrator's sequencing and failure
// mapping are what's under test.
vi.mock("../prisma", () => {
  const recipeImport = {
    update: vi.fn(),
    findUnique: vi.fn(),
  };
  const notification = { create: vi.fn() };
  const dishList = { findFirst: vi.fn(), create: vi.fn() };
  const recipe = { create: vi.fn() };
  const dishListRecipe = { create: vi.fn() };
  const tx = { dishList, recipe, dishListRecipe };
  return {
    default: {
      recipeImport,
      notification,
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});
vi.mock("../moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../moderation")>();
  return { ...actual, moderateTextFields: vi.fn() };
});
vi.mock("../socialImport/captionExtraction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../socialImport/captionExtraction")>();
  return { ...actual, extractRecipeFromCaption: vi.fn() };
});
vi.mock("../socialImport/geminiVideoExtraction", () => ({
  extractRecipeFromVideo: vi.fn(),
}));
vi.mock("../socialImport/thumbnail", () => ({ ingestThumbnail: vi.fn() }));

import prisma from "../prisma";
import { moderateTextFields, ModerationError } from "../moderation";
import { extractRecipeFromCaption } from "../socialImport/captionExtraction";
import { extractRecipeFromVideo } from "../socialImport/geminiVideoExtraction";
import { ingestThumbnail } from "../socialImport/thumbnail";
import { processImport } from "../socialImport/processImport";
import {
  SocialImportError,
  type SocialPost,
  type SocialPostFetcher,
} from "../socialImport/types";

const mockPrisma = prisma as unknown as {
  recipeImport: { update: ReturnType<typeof vi.fn> };
  notification: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  __tx: {
    dishList: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    recipe: { create: ReturnType<typeof vi.fn> };
    dishListRecipe: { create: ReturnType<typeof vi.fn> };
  };
};

const importRow = {
  id: "imp_1",
  userId: "user_1",
  platform: "TIKTOK",
  sourceUrl: "https://vm.tiktok.com/ZM6/",
  canonicalUrl: "https://vm.tiktok.com/ZM6",
};

const post: SocialPost = {
  platform: "TIKTOK",
  resolvedUrl: "https://tiktok.com/@lynja/video/123",
  caption: "some caption",
  authorHandle: "@lynja",
  thumbnailUrl: "https://cdn.tiktok.com/thumb.jpg",
  videoUrl: "https://cdn.tiktok.com/video.mp4",
  durationSec: 90,
};

const extractedRecipe = {
  title: "Garlic Noodles",
  description: null,
  prepTime: 5,
  cookTime: 10,
  servings: 2,
  ingredients: [{ type: "item", text: "8oz spaghetti" }],
  instructions: [{ type: "item", text: "Boil pasta" }],
};

function fetcherReturning(result: SocialPost | Error): SocialPostFetcher {
  return {
    fetchPost: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.recipeImport.update.mockImplementation(
    async ({ where, data }: any) => ({ ...importRow, ...where, ...data })
  );
  mockPrisma.__tx.dishList.findFirst.mockResolvedValue({ id: "dl_1" });
  mockPrisma.__tx.recipe.create.mockResolvedValue({
    id: "rec_1",
    title: "Garlic Noodles",
  });
  mockPrisma.__tx.dishListRecipe.create.mockResolvedValue({});
  mockPrisma.notification.create.mockResolvedValue({ id: "n_1" });
  (ingestThumbnail as ReturnType<typeof vi.fn>).mockResolvedValue(
    "https://storage/recipes/user_1/social/t.jpg"
  );
});

describe("processImport — happy paths", () => {
  it("saves via the caption path without touching video extraction", async () => {
    (extractRecipeFromCaption as ReturnType<typeof vi.fn>).mockResolvedValue({
      sufficient: true,
      recipe: extractedRecipe,
    });

    await processImport("imp_1", fetcherReturning(post));

    expect(extractRecipeFromVideo).not.toHaveBeenCalled();
    expect(mockPrisma.__tx.recipe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Garlic Noodles",
          sourceUrl: post.resolvedUrl,
          sourcePlatform: "TIKTOK",
          sourceAuthor: "@lynja",
          creatorId: "user_1",
        }),
      })
    );
    expect(mockPrisma.__tx.dishListRecipe.create).toHaveBeenCalledWith({
      data: { dishListId: "dl_1", recipeId: "rec_1", addedById: "user_1" },
    });
    // Final status update marks COMPLETED with the recipe id.
    expect(mockPrisma.recipeImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "COMPLETED", recipeId: "rec_1" },
      })
    );
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RECIPE_IMPORT_COMPLETED",
          message:
            '"Garlic Noodles" was successfully added to My Recipes.',
        }),
      })
    );
  });

  it("falls back to video extraction when the caption is insufficient", async () => {
    (extractRecipeFromCaption as ReturnType<typeof vi.fn>).mockResolvedValue({
      sufficient: false,
    });
    (extractRecipeFromVideo as ReturnType<typeof vi.fn>).mockResolvedValue(
      extractedRecipe
    );

    await processImport("imp_1", fetcherReturning(post));

    expect(extractRecipeFromVideo).toHaveBeenCalledWith(post);
    expect(mockPrisma.recipeImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "COMPLETED", recipeId: "rec_1" },
      })
    );
  });

  it("creates My Recipes when the default dishlist is missing", async () => {
    (extractRecipeFromCaption as ReturnType<typeof vi.fn>).mockResolvedValue({
      sufficient: true,
      recipe: extractedRecipe,
    });
    mockPrisma.__tx.dishList.findFirst.mockResolvedValue(null);
    mockPrisma.__tx.dishList.create.mockResolvedValue({ id: "dl_new" });

    await processImport("imp_1", fetcherReturning(post));

    expect(mockPrisma.__tx.dishList.create).toHaveBeenCalledWith({
      data: {
        title: "My Recipes",
        ownerId: "user_1",
        isDefault: true,
        visibility: "PRIVATE",
      },
    });
    expect(mockPrisma.__tx.dishListRecipe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dishListId: "dl_new" }),
      })
    );
  });

  it("saves without an image when thumbnail ingestion fails", async () => {
    (extractRecipeFromCaption as ReturnType<typeof vi.fn>).mockResolvedValue({
      sufficient: true,
      recipe: extractedRecipe,
    });
    (ingestThumbnail as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await processImport("imp_1", fetcherReturning(post));

    expect(mockPrisma.__tx.recipe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ imageUrl: null, imageUrls: [] }),
      })
    );
    expect(mockPrisma.recipeImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "COMPLETED", recipeId: "rec_1" },
      })
    );
  });
});

describe("processImport — failure paths", () => {
  async function expectFailure(code: string) {
    const failureUpdate = mockPrisma.recipeImport.update.mock.calls.find(
      ([args]: any[]) => args?.data?.status === "FAILED"
    );
    expect(failureUpdate?.[0].data.errorCode).toBe(code);
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "RECIPE_IMPORT_FAILED" }),
      })
    );
  }

  it("uses the extracted recipe name in a later failure notification", async () => {
    (extractRecipeFromCaption as ReturnType<typeof vi.fn>).mockResolvedValue({
      sufficient: true,
      recipe: extractedRecipe,
    });
    (moderateTextFields as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ModerationError("blocked")
    );

    await processImport("imp_1", fetcherReturning(post));

    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "RECIPE_IMPORT_FAILED",
          message:
            '"Garlic Noodles" wasn\'t added to My Recipes. This content can\'t be imported.',
        }),
      })
    );
  });

  it("identifies My Recipes when a failure happens before extraction", async () => {
    await processImport(
      "imp_1",
      fetcherReturning(new SocialImportError("PRIVATE_POST"))
    );

    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          message:
            "The recipe wasn't added to My Recipes. That post appears to be private or unavailable.",
        }),
      })
    );
  });

  it("marks SCRAPE_FAILED when the fetcher fails", async () => {
    await processImport(
      "imp_1",
      fetcherReturning(new SocialImportError("SCRAPE_FAILED"))
    );
    await expectFailure("SCRAPE_FAILED");
  });

  it("marks PRIVATE_POST for private posts", async () => {
    await processImport(
      "imp_1",
      fetcherReturning(new SocialImportError("PRIVATE_POST"))
    );
    await expectFailure("PRIVATE_POST");
  });

  it("marks NO_RECIPE_FOUND when both extraction passes miss", async () => {
    (extractRecipeFromCaption as ReturnType<typeof vi.fn>).mockResolvedValue({
      sufficient: false,
    });
    (extractRecipeFromVideo as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SocialImportError("NO_RECIPE_FOUND")
    );

    await processImport("imp_1", fetcherReturning(post));
    await expectFailure("NO_RECIPE_FOUND");
    expect(mockPrisma.__tx.recipe.create).not.toHaveBeenCalled();
  });

  it("maps moderation rejections to MODERATION_BLOCKED", async () => {
    (extractRecipeFromCaption as ReturnType<typeof vi.fn>).mockResolvedValue({
      sufficient: true,
      recipe: extractedRecipe,
    });
    (moderateTextFields as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ModerationError("blocked")
    );

    await processImport("imp_1", fetcherReturning(post));
    await expectFailure("MODERATION_BLOCKED");
    expect(mockPrisma.__tx.recipe.create).not.toHaveBeenCalled();
  });

  it("maps unexpected crashes to INTERNAL", async () => {
    await processImport(
      "imp_1",
      fetcherReturning(new Error("vendor exploded"))
    );
    await expectFailure("INTERNAL");
  });

  it("survives a failure while marking failed", async () => {
    mockPrisma.recipeImport.update.mockRejectedValue(new Error("db down"));
    await expect(
      processImport("imp_1", fetcherReturning(post))
    ).resolves.toBeUndefined();
  });
});
