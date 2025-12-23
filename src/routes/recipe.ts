import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";
import { normalizeTags, validateTags } from "../utils/tags";
import {
  validateRecipeItems,
  cleanRecipeItems,
  RecipeItem,
} from "../types/recipe";

const router = Router();

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
      nutrition,
      dishListId,
      tags,
    } = req.body;

    const userId = req.user!.uid;

    // Validation
    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
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

    // Clean items before saving
    const cleanedIngredients = cleanRecipeItems(ingredients as RecipeItem[]);
    const cleanedInstructions = cleanRecipeItems(instructions as RecipeItem[]);

    // Create recipe
    const recipe = await prisma.recipe.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        instructions: cleanedInstructions as any,
        ingredients: cleanedIngredients as any,
        prepTime: prepTime || null,
        cookTime: cookTime || null,
        servings: servings || null,
        imageUrl: imageUrl || null,
        nutrition: nutrition || null,
        tags: tags ? normalizeTags(tags) : [],
        creatorId: userId,
      },
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

    // Add to dishlist if provided
    if (dishListId) {
      await prisma.dishListRecipe.create({
        data: {
          dishListId,
          recipeId: recipe.id,
          addedById: userId,
        },
      });
    }

    res.status(201).json({ recipe });
  } catch (error) {
    console.error("Create recipe error:", error);
    res.status(500).json({ error: "Failed to create recipe" });
  }
});

// Get recipe by ID
router.get("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const recipe = await prisma.recipe.findUnique({
      where: { id: req.params.id },
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

    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    // Check if recipe is on any public DishList (makes it shareable)
    const publicDishListEntry = await prisma.dishListRecipe.findFirst({
      where: {
        recipeId: recipe.id,
        dishList: {
          visibility: "PUBLIC",
        },
      },
    });

    const isShareable = publicDishListEntry !== null;

    res.json({
      recipe: {
        ...recipe,
        isShareable,
      },
    });
  } catch (error) {
    console.error("Get recipe error:", error);
    res.status(500).json({ error: "Failed to fetch recipe" });
  }
});

// Share a Recipe
router.post("/:id/share", authToken, async (req: AuthRequest, res) => {
  try {
    const recipeId = req.params.id;
    const userId = req.user!.uid;
    const { recipientIds } = req.body;

    // Validate recipientIds
    if (
      !recipientIds ||
      !Array.isArray(recipientIds) ||
      recipientIds.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "At least one recipient is required" });
    }

    // Get the Recipe to verify it exists
    const recipe = await prisma.recipe.findUnique({
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
    });

    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    // Verify recipe is on at least one public DishList (shareable)
    const publicDishListEntry = await prisma.dishListRecipe.findFirst({
      where: {
        recipeId: recipe.id,
        dishList: {
          visibility: "PUBLIC",
        },
      },
    });

    if (!publicDishListEntry) {
      return res
        .status(403)
        .json({ error: "Only recipes on public DishLists can be shared" });
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

    // Create notifications for all recipients
    const notifications = await prisma.notification.createMany({
      data: recipientIds.map((recipientId: string) => ({
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
    });

    res.json({
      success: true,
      notificationsSent: notifications.count,
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
      nutrition,
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
    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
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

    const tagsError = validateTags(tags);
    if (tagsError) {
      return res.status(400).json({ error: tagsError });
    }

    // Clean items before saving
    const cleanedIngredients = cleanRecipeItems(ingredients as RecipeItem[]);
    const cleanedInstructions = cleanRecipeItems(instructions as RecipeItem[]);

    // Check if ingredients changed - if so, clear nutrition
    const ingredientsChanged =
      JSON.stringify(existingRecipe.ingredients) !==
      JSON.stringify(cleanedIngredients);
    const nutritionData = ingredientsChanged
      ? null
      : nutrition || existingRecipe.nutrition;

    // Update recipe
    const updatedRecipe = await prisma.recipe.update({
      where: { id: recipeId },
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        instructions: cleanedInstructions as any,
        ingredients: cleanedIngredients as any,
        prepTime: prepTime || null,
        cookTime: cookTime || null,
        servings: servings || null,
        imageUrl: imageUrl || null,
        nutrition: nutritionData,
        tags: tags ? normalizeTags(tags) : [],
      },
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

    res.json({ recipe: updatedRecipe });
  } catch (error) {
    console.error("Update recipe error:", error);
    res.status(500).json({ error: "Failed to update recipe" });
  }
});

// Get dishlists containing this recipe
router.get("/:id/dishlists", authToken, async (req: AuthRequest, res) => {
  try {
    const recipeId = req.params.id;

    const dishListRecipes = await prisma.dishListRecipe.findMany({
      where: { recipeId },
      select: { dishListId: true },
    });

    const dishListIds = dishListRecipes.map((dr) => dr.dishListId);
    res.json({ dishListIds });
  } catch (error) {
    console.error("Get recipe dishlists error:", error);
    res.status(500).json({ error: "Failed to fetch dishlists" });
  }
});

// Import recipe from images using GPT-4 Vision
router.post("/import-from-images", authToken, async (req: AuthRequest, res) => {
  try {
    const { images } = req.body;

    // Validate images array
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "At least one image is required" });
    }

    if (images.length > 5) {
      return res.status(400).json({ error: "Maximum 5 images allowed" });
    }

    // Validate each image is base64
    for (const img of images) {
      if (!img.base64 || !img.mimeType) {
        return res.status(400).json({
          error: "Each image must have base64 and mimeType properties",
        });
      }
    }

    // Build content array for GPT-4 Vision
    const imageContent = images.map(
      (img: { base64: string; mimeType: string }) => ({
        type: "image_url" as const,
        image_url: {
          url: `data:${img.mimeType};base64,${img.base64}`,
          detail: "high" as const,
        },
      })
    );

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
      throw new Error("Failed to process images with AI");
    }

    const data = await response.json();
    const content = data.choices[0].message.content;

    let extractedRecipe;
    try {
      extractedRecipe = JSON.parse(content);
    } catch {
      console.error("Invalid OpenAI JSON response:", content);
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Validate and normalize the response
    const recipe = {
      title: extractedRecipe.title || "",
      prepTime:
        typeof extractedRecipe.prepTime === "number"
          ? extractedRecipe.prepTime
          : null,
      cookTime:
        typeof extractedRecipe.cookTime === "number"
          ? extractedRecipe.cookTime
          : null,
      servings:
        typeof extractedRecipe.servings === "number"
          ? extractedRecipe.servings
          : null,
      ingredients: Array.isArray(extractedRecipe.ingredients)
        ? extractedRecipe.ingredients
        : [],
      instructions: Array.isArray(extractedRecipe.instructions)
        ? extractedRecipe.instructions
        : [],
    };

    // Check what's missing for warnings
    const warnings: string[] = [];
    if (!recipe.title) warnings.push("Could not extract recipe title");
    if (recipe.ingredients.length === 0)
      warnings.push("Could not extract ingredients");
    if (recipe.instructions.length === 0)
      warnings.push("Could not extract instructions");
    if (recipe.prepTime === null && recipe.cookTime === null) {
      warnings.push("Could not extract cooking times");
    }
    if (recipe.servings === null)
      warnings.push("Could not extract serving size");

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
