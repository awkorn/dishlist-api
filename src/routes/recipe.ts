import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";
import { normalizeTags, validateTags } from "../utils/tags";
import {
  areUsersBlocked,
  getBlockContext,
} from "../lib/blocks";
import {
  validateRecipeItems,
  cleanRecipeItems,
  RecipeItem,
} from "../types/recipe";
import {
  handleModerationError,
  moderateTextFields,
} from "../lib/moderation";
import {
  accessibleRecipeWhere,
  writableDishListWhere,
} from "../lib/recipeAccess";
import {
  validateOptionalText,
  validateRequiredText,
} from "../lib/requestValidation";
import {
  MAX_RECIPE_TITLE_LENGTH,
  MAX_RECIPE_DESCRIPTION_LENGTH,
  normalizeRecipeImages,
  normalizeRecipeNotes,
  validateRecipeItemLimits,
  validateRecipeNumericFields,
  validateNutritionField,
  validateImportImages,
  normalizeImportedRecipe,
  getImportWarnings,
} from "../lib/recipeValidation";
import { extractMessageContent } from "../lib/builderGeneration";
import { normalizeRecipientIds } from "../lib/inviteValidation";
import {
  recipeImportLimiter,
  recipeImportDailyLimiter,
  recipeShareLimiter,
} from "../middleware/rateLimit";

const router = Router();

function isAllowedRecipeImageUrl(url: string) {
  return url.startsWith(
    `${process.env.SUPABASE_URL}/storage/v1/object/public/recipes/`
  );
}

function recipeModerationFields(input: {
  title?: unknown;
  description?: unknown;
  ingredients?: unknown;
  instructions?: unknown;
  notes?: unknown;
  tags?: unknown;
}) {
  return [
    { label: "Recipe title", value: input.title },
    { label: "Recipe description", value: input.description },
    { label: "Recipe ingredients", value: input.ingredients },
    { label: "Recipe instructions", value: input.instructions },
    { label: "Recipe notes", value: input.notes },
    { label: "Recipe tags", value: input.tags },
  ];
}

function recipeWithImageUrls<T extends { imageUrl?: string | null }>(
  recipe: T
): T & { imageUrls: string[] } {
  const imageUrls = Array.isArray((recipe as any).imageUrls)
    ? (recipe as any).imageUrls
    : [];

  return {
    ...recipe,
    imageUrls:
      imageUrls.length > 0
        ? imageUrls
        : recipe.imageUrl
          ? [recipe.imageUrl]
          : [],
  };
}

function getShareableRecipeEntryWhere(recipeId: string) {
  return {
    recipeId,
    dishList: {
      visibility: "PUBLIC" as const,
    },
  };
}

// Create recipe and add to dishlist
router.post("/", authToken, async (req: AuthRequest, res) => {
  try {
    const {
      title,
      description,
      instructions,
      ingredients,
      prepTime,
      cookTime,
      servings,
      imageUrl,
      imageUrls,
      nutrition,
      notes,
      dishListId,
      tags,
    } = req.body;

    const userId = req.user!.uid;

    // Validation
    const validatedTitle = validateRequiredText(title, {
      field: "Title",
      maxLength: MAX_RECIPE_TITLE_LENGTH,
    });
    if ("error" in validatedTitle) {
      return res.status(400).json({ error: validatedTitle.error });
    }

    const validatedDescription = validateOptionalText(description, {
      field: "Description",
      maxLength: MAX_RECIPE_DESCRIPTION_LENGTH,
    });
    if ("error" in validatedDescription) {
      return res.status(400).json({ error: validatedDescription.error });
    }

    // Validate ingredients (new structured format)
    const ingredientsError = validateRecipeItems(ingredients, "ingredients");
    if (ingredientsError) {
      return res.status(400).json({ error: ingredientsError });
    }

    // Validate instructions (new structured format)
    const instructionsError = validateRecipeItems(instructions, "instructions");
    if (instructionsError) {
      return res.status(400).json({ error: instructionsError });
    }

    // Cap list sizes and per-item length (backstop against oversized payloads)
    const ingredientsLimitError = validateRecipeItemLimits(
      ingredients,
      "ingredients"
    );
    if (ingredientsLimitError) {
      return res.status(400).json({ error: ingredientsLimitError });
    }
    const instructionsLimitError = validateRecipeItemLimits(
      instructions,
      "instructions"
    );
    if (instructionsLimitError) {
      return res.status(400).json({ error: instructionsLimitError });
    }

    // Validate numeric fields (prep/cook/servings) and the nutrition blob
    const numericFields = validateRecipeNumericFields({
      prepTime,
      cookTime,
      servings,
    });
    if (!numericFields.ok) {
      return res.status(400).json({ error: numericFields.error });
    }

    const validatedNutrition = validateNutritionField(nutrition);
    if (!validatedNutrition.ok) {
      return res.status(400).json({ error: validatedNutrition.error });
    }

    if (dishListId) {
      // Verify user has access to the dishlist
      const dishList = await prisma.dishList.findFirst({
        where: {
          id: dishListId,
          OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
        },
      });

      if (!dishList) {
        return res
          .status(403)
          .json({ error: "Access denied to this DishList" });
      }
    }

    const tagsError = validateTags(tags);
    if (tagsError) {
      return res.status(400).json({ error: tagsError });
    }

    const normalizedImages = normalizeRecipeImages(imageUrls, imageUrl);
    if (normalizedImages.error) {
      return res.status(400).json({ error: normalizedImages.error });
    }

    if (
      (normalizedImages.urls || []).some(
        (url) => !isAllowedRecipeImageUrl(url)
      )
    ) {
      return res.status(400).json({
        error: "Recipe images must be uploaded through DishList.",
      });
    }

    const normalizedNotes = normalizeRecipeNotes(notes);
    if (normalizedNotes.error) {
      return res.status(400).json({ error: normalizedNotes.error });
    }

    // Clean items before saving
    const cleanedIngredients = cleanRecipeItems(ingredients as RecipeItem[]);
    const cleanedInstructions = cleanRecipeItems(instructions as RecipeItem[]);
    const recipeImageUrls = normalizedImages.urls || [];

    await moderateTextFields(
      recipeModerationFields({
        title: validatedTitle.value,
        description: validatedDescription.value,
        ingredients: cleanedIngredients,
        instructions: cleanedInstructions,
        notes: normalizedNotes.notes,
        tags,
      }),
      { targetType: "RECIPE", userId }
    );

    // Create recipe (and attach to the dishlist) atomically so a failed attach
    // can't leave an orphaned recipe that belongs to no list.
    const recipe = await prisma.$transaction(async (tx) => {
      const created = await tx.recipe.create({
        data: {
          title: validatedTitle.value,
          description: validatedDescription.value,
          instructions: cleanedInstructions as any,
          ingredients: cleanedIngredients as any,
          prepTime: numericFields.value.prepTime,
          cookTime: numericFields.value.cookTime,
          servings: numericFields.value.servings,
          imageUrl: recipeImageUrls[0] || null,
          imageUrls: recipeImageUrls,
          nutrition: validatedNutrition.value,
          notes: normalizedNotes.notes || [],
          tags: tags ? normalizeTags(tags) : [],
          creatorId: userId,
        } as any,
        include: {
          creator: {
            select: {
              uid: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      });

      if (dishListId) {
        await tx.dishListRecipe.create({
          data: {
            dishListId,
            recipeId: created.id,
            addedById: userId,
          },
        });
      }

      return created;
    });

    res.status(201).json({ recipe: recipeWithImageUrls(recipe) });
  } catch (error) {
    if (handleModerationError(error, res)) return;

    console.error("Create recipe error:", error);
    res.status(500).json({ error: "Failed to create recipe" });
  }
});

// Get recipe by ID
router.get("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const recipe = await prisma.recipe.findFirst({
      where: accessibleRecipeWhere(userId, req.params.id),
      include: {
        creator: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        originalRecipe: {
          select: {
            id: true,
            title: true,
            creator: {
              select: {
                uid: true,
                username: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    });

    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    if (await areUsersBlocked(userId, recipe.creatorId)) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    // Direct recipe shares must remain accessible to recipients without
    // granting access to private DishLists.
    const shareableDishListEntry = await prisma.dishListRecipe.findFirst({
      where: getShareableRecipeEntryWhere(recipe.id),
    });

    const isShareable =
      recipe.creatorId === userId || shareableDishListEntry !== null;

    res.json({
      recipe: {
        ...recipeWithImageUrls(recipe),
        isShareable,
      },
    });
  } catch (error) {
    console.error("Get recipe error:", error);
    res.status(500).json({ error: "Failed to fetch recipe" });
  }
});

// Share a Recipe
router.post(
  "/:id/share",
  authToken,
  recipeShareLimiter,
  async (req: AuthRequest, res) => {
  try {
    const recipeId = req.params.id;
    const userId = req.user!.uid;

    // Validate + normalize recipientIds (string check, trim, dedupe, drop self,
    // cap at MAX_SEND_RECIPIENTS) before any DB work.
    const normalizedRecipients = normalizeRecipientIds(
      req.body?.recipientIds,
      userId
    );
    if (!normalizedRecipients.ok) {
      return res.status(400).json({ error: normalizedRecipients.error });
    }
    const recipientIds = normalizedRecipients.recipientIds;

    const [recipe, blockContext] = await Promise.all([
      prisma.recipe.findUnique({
        where: { id: recipeId },
        include: {
          creator: {
            select: {
              uid: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      getBlockContext(userId),
    ]);

    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    if (blockContext.isBlocked(recipe.creatorId)) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    // Creators may explicitly share their own private recipe. Other users may
    // only redistribute a recipe that is already public.
    const shareableDishListEntry = await prisma.dishListRecipe.findFirst({
      where: getShareableRecipeEntryWhere(recipe.id),
    });

    if (recipe.creatorId !== userId && !shareableDishListEntry) {
      return res
        .status(403)
        .json({ error: "You cannot share this private recipe" });
    }

    // Get sender info
    const sender = await prisma.user.findUnique({
      where: { uid: userId },
      select: {
        uid: true,
        username: true,
        firstName: true,
        lastName: true,
      },
    });

    if (!sender) {
      return res.status(404).json({ error: "Sender not found" });
    }

    // Build sender display name
    const senderName = sender.firstName || sender.username || "Someone";

    // recipientIds is already deduped and self-excluded; drop blocked users.
    const allowedRecipientIds = recipientIds.filter(
      (recipientId: string) => !blockContext.isBlocked(recipientId)
    );
    if (allowedRecipientIds.length === 0) {
      return res.json({
        success: true,
        notificationsSent: 0,
        blocked: recipientIds.length,
      });
    }

    const [notifications] = await prisma.$transaction([
      prisma.notification.createMany({
        data: allowedRecipientIds.map((recipientId: string) => ({
          type: "RECIPE_SHARED" as const,
          title: `${senderName} shared a recipe with you`,
          message: recipe.title,
          senderId: userId,
          receiverId: recipientId,
          data: JSON.stringify({
            recipeId: recipe.id,
            recipeTitle: recipe.title,
            senderId: userId,
            senderName,
          }),
        })),
        skipDuplicates: true,
      }),
      prisma.recipeShare.createMany({
        data: allowedRecipientIds.map((recipientId: string) => ({
          recipeId: recipe.id,
          sharedById: userId,
          recipientId,
        })),
        skipDuplicates: true,
      }),
    ]);

    res.json({
      success: true,
      notificationsSent: notifications.count,
      blocked: recipientIds.length - allowedRecipientIds.length,
    });
  } catch (error) {
    console.error("Share recipe error:", error);
    res.status(500).json({ error: "Failed to share recipe" });
  }
});

// Update recipe
router.put("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const recipeId = req.params.id;
    const userId = req.user!.uid;
    const {
      title,
      description,
      instructions,
      ingredients,
      prepTime,
      cookTime,
      servings,
      imageUrl,
      imageUrls,
      nutrition,
      notes,
      tags,
    } = req.body;

    // Find existing recipe
    const existingRecipe = await prisma.recipe.findUnique({
      where: { id: recipeId },
    });

    if (!existingRecipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    // Check ownership
    if (existingRecipe.creatorId !== userId) {
      return res
        .status(403)
        .json({ error: "Only the recipe owner can edit this recipe" });
    }

    // Validation
    const validatedTitle = validateRequiredText(title, {
      field: "Title",
      maxLength: MAX_RECIPE_TITLE_LENGTH,
    });
    if ("error" in validatedTitle) {
      return res.status(400).json({ error: validatedTitle.error });
    }

    const validatedDescription = validateOptionalText(description, {
      field: "Description",
      maxLength: MAX_RECIPE_DESCRIPTION_LENGTH,
    });
    if ("error" in validatedDescription) {
      return res.status(400).json({ error: validatedDescription.error });
    }

    // Validate ingredients (new structured format)
    const ingredientsError = validateRecipeItems(ingredients, "ingredients");
    if (ingredientsError) {
      return res.status(400).json({ error: ingredientsError });
    }

    // Validate instructions (new structured format)
    const instructionsError = validateRecipeItems(instructions, "instructions");
    if (instructionsError) {
      return res.status(400).json({ error: instructionsError });
    }

    // Cap list sizes and per-item length (backstop against oversized payloads)
    const ingredientsLimitError = validateRecipeItemLimits(
      ingredients,
      "ingredients"
    );
    if (ingredientsLimitError) {
      return res.status(400).json({ error: ingredientsLimitError });
    }
    const instructionsLimitError = validateRecipeItemLimits(
      instructions,
      "instructions"
    );
    if (instructionsLimitError) {
      return res.status(400).json({ error: instructionsLimitError });
    }

    // Validate numeric fields (prep/cook/servings) and the nutrition blob
    const numericFields = validateRecipeNumericFields({
      prepTime,
      cookTime,
      servings,
    });
    if (!numericFields.ok) {
      return res.status(400).json({ error: numericFields.error });
    }

    const validatedNutrition = validateNutritionField(nutrition);
    if (!validatedNutrition.ok) {
      return res.status(400).json({ error: validatedNutrition.error });
    }

    const tagsError = validateTags(tags);
    if (tagsError) {
      return res.status(400).json({ error: tagsError });
    }

    const normalizedImages = normalizeRecipeImages(imageUrls, imageUrl);
    if (normalizedImages.error) {
      return res.status(400).json({ error: normalizedImages.error });
    }

    if (
      (normalizedImages.urls || []).some(
        (url) => !isAllowedRecipeImageUrl(url)
      )
    ) {
      return res.status(400).json({
        error: "Recipe images must be uploaded through DishList.",
      });
    }

    const normalizedNotes =
      notes === undefined
        ? {
            notes:
              ((existingRecipe as any).notes as string[] | undefined) || [],
          }
        : normalizeRecipeNotes(notes);
    if (normalizedNotes.error) {
      return res.status(400).json({ error: normalizedNotes.error });
    }

    // Clean items before saving
    const cleanedIngredients = cleanRecipeItems(ingredients as RecipeItem[]);
    const cleanedInstructions = cleanRecipeItems(instructions as RecipeItem[]);
    const recipeImageUrls = normalizedImages.urls || [];

    await moderateTextFields(
      recipeModerationFields({
        title: validatedTitle.value,
        description: validatedDescription.value,
        ingredients: cleanedIngredients,
        instructions: cleanedInstructions,
        notes: normalizedNotes.notes,
        tags,
      }),
      { targetType: "RECIPE", targetId: recipeId, userId }
    );

    // Check if ingredients changed - if so, clear nutrition
    const ingredientsChanged =
      JSON.stringify(existingRecipe.ingredients) !==
      JSON.stringify(cleanedIngredients);
    const nutritionData = ingredientsChanged
      ? null
      : (validatedNutrition.value ?? existingRecipe.nutrition);

    // Update recipe
    const updatedRecipe = await prisma.recipe.update({
      where: { id: recipeId },
      data: {
        title: validatedTitle.value,
        description: validatedDescription.value,
        instructions: cleanedInstructions as any,
        ingredients: cleanedIngredients as any,
        prepTime: numericFields.value.prepTime,
        cookTime: numericFields.value.cookTime,
        servings: numericFields.value.servings,
        imageUrl: recipeImageUrls[0] || null,
        imageUrls: recipeImageUrls,
        nutrition: nutritionData,
        notes: normalizedNotes.notes || [],
        tags: tags ? normalizeTags(tags) : [],
      } as any,
      include: {
        creator: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    res.json({ recipe: recipeWithImageUrls(updatedRecipe) });
  } catch (error) {
    if (handleModerationError(error, res)) return;

    console.error("Update recipe error:", error);
    res.status(500).json({ error: "Failed to update recipe" });
  }
});

// Get dishlists containing this recipe
router.get("/:id/dishlists", authToken, async (req: AuthRequest, res) => {
  try {
    const recipeId = req.params.id;
    const userId = req.user!.uid;

    const recipe = await prisma.recipe.findFirst({
      where: accessibleRecipeWhere(userId, recipeId),
      select: { id: true, creatorId: true },
    });

    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    const relevantRecipeIds = [recipeId];
    if (recipe.creatorId !== userId) {
      const fork = await prisma.recipe.findUnique({
        where: {
          creatorId_originalRecipeId: {
            creatorId: userId,
            originalRecipeId: recipeId,
          },
        },
        select: { id: true },
      });
      if (fork) relevantRecipeIds.push(fork.id);
    }

    const dishListRecipes = await prisma.dishListRecipe.findMany({
      where: {
        recipeId: { in: relevantRecipeIds },
        dishList: writableDishListWhere(userId),
      },
      select: { dishListId: true },
    });

    const dishListIds = Array.from(
      new Set(dishListRecipes.map((dr) => dr.dishListId))
    );
    res.json({ dishListIds });
  } catch (error) {
    console.error("Get recipe dishlists error:", error);
    res.status(500).json({ error: "Failed to fetch dishlists" });
  }
});

// Import recipe from images using GPT-4 Vision
router.post(
  "/import-from-images",
  authToken,
  recipeImportLimiter,
  recipeImportDailyLimiter,
  async (req: AuthRequest, res) => {
  try {
    // Validate images: array of 1-5, each with a string base64 (≤2MB) and an
    // allowlisted mimeType. Rejects oversized/malformed payloads before the
    // (expensive) model call.
    const validatedImages = validateImportImages(req.body?.images);
    if (!validatedImages.ok) {
      return res.status(400).json({ error: validatedImages.error });
    }
    const images = validatedImages.value;

    // Build content array for GPT-4 Vision
    const imageContent = images.map((img) => ({
      type: "image_url" as const,
      image_url: {
        url: `data:${img.mimeType};base64,${img.base64}`,
        detail: "high" as const,
      },
    }));

    const prompt = `You are a recipe extraction assistant. Analyze the provided image(s) of a recipe and extract all available information.

If multiple images are provided, they are different parts/pages of the SAME recipe - consolidate them into one complete recipe.

IMPORTANT: Ingredients and instructions may have subsections (e.g., "For the Sauce:", "For the Dough:"). 
- If you detect subsections, include them as separate items with type "header"
- Regular items should have type "item"

Return a JSON object with this exact structure:
{
  "title": "Recipe Name",
  "description": "Brief description if visible",
  "prepTime": number or null (in minutes),
  "cookTime": number or null (in minutes),
  "servings": number or null,
  "ingredients": [
    { "type": "item", "text": "2 cups flour" },
    { "type": "header", "text": "For the Sauce" },
    { "type": "item", "text": "1 can tomatoes" }
  ],
  "instructions": [
    { "type": "item", "text": "Preheat oven to 350°F" },
    { "type": "header", "text": "Making the Sauce" },
    { "type": "item", "text": "Heat oil in a pan" }
  ]
}

Rules:
- Each ingredient should be a complete item (e.g., "2 cups all-purpose flour")
- Each instruction should be a complete step
- Subsection headers should be concise (e.g., "For the Sauce", "Dough", "Assembly")
- If no clear subsections exist, just use type "item" for everything
- Return ONLY the JSON object, no additional text
- If information is not visible/available, use null for that field
- Do not include empty strings in arrays`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o", // GPT-4o has vision capabilities
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }, ...imageContent],
          },
        ],
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("OpenAI API error:", errorData);
      return res
        .status(502)
        .json({ error: "Failed to import recipe from images" });
    }

    const data = await response.json();
    const content = extractMessageContent(data);
    if (content === null) {
      console.error("OpenAI response missing message content:", data);
      return res
        .status(502)
        .json({ error: "Failed to import recipe from images" });
    }

    let extractedRecipe: unknown;
    try {
      extractedRecipe = JSON.parse(content);
    } catch {
      console.error("Invalid OpenAI JSON response:", content);
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Validate and normalize the response
    const recipe = normalizeImportedRecipe(extractedRecipe);
    const warnings = getImportWarnings(recipe);

    res.json({
      recipe,
      warnings: warnings.length > 0 ? warnings : undefined,
      success: warnings.length === 0,
    });
  } catch (error) {
    console.error("Import recipe from images error:", error);
    res.status(500).json({ error: "Failed to import recipe from images" });
  }
});

export default router;
