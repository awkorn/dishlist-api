import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";
import { normalizeTags, validateTags } from "../utils/tags";

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

    if (
      !ingredients ||
      !Array.isArray(ingredients) ||
      ingredients.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "At least one ingredient is required" });
    }

    if (
      !instructions ||
      !Array.isArray(instructions) ||
      instructions.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "At least one instruction is required" });
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

    // Create recipe
    const recipe = await prisma.recipe.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        instructions: instructions.filter((inst) => inst.trim()),
        ingredients: ingredients.filter((ing) => ing.trim()),
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

    // Add to dishlist if specified
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

    res.json({ recipe });
  } catch (error) {
    console.error("Get recipe error:", error);
    res.status(500).json({ error: "Failed to fetch recipe" });
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

    if (
      !ingredients ||
      !Array.isArray(ingredients) ||
      ingredients.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "At least one ingredient is required" });
    }

    if (
      !instructions ||
      !Array.isArray(instructions) ||
      instructions.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "At least one instruction is required" });
    }

    const tagsError = validateTags(tags);
    if (tagsError) {
      return res.status(400).json({ error: tagsError });
    }

    // Check if ingredients changed - if so, clear nutrition
    const ingredientsChanged =
      JSON.stringify(existingRecipe.ingredients) !==
      JSON.stringify(ingredients);
    const nutritionData = ingredientsChanged
      ? null
      : nutrition || existingRecipe.nutrition;

    // Update recipe
    const updatedRecipe = await prisma.recipe.update({
      where: { id: recipeId },
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        instructions: instructions.filter((inst) => inst.trim()),
        ingredients: ingredients.filter((ing) => ing.trim()),
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

Extract and return a JSON object with these fields:
- title: string (recipe name)
- prepTime: number | null (preparation time in minutes)
- cookTime: number | null (cooking time in minutes)  
- servings: number | null (number of servings)
- ingredients: string[] (list of ingredients with quantities)
- instructions: string[] (step-by-step instructions)

Rules:
1. If a field cannot be determined from the image, use null (for numbers) or empty array (for arrays)
2. Keep ingredient quantities and units as shown in the image
3. Number each instruction step if not already numbered
4. Preserve the original wording as much as possible
5. If text is unclear or partially visible, make your best reasonable interpretation

Respond with ONLY valid JSON. No markdown, no code blocks, no explanation.

Example format:
{
  "title": "Chocolate Chip Cookies",
  "prepTime": 15,
  "cookTime": 12,
  "servings": 24,
  "ingredients": ["2 cups all-purpose flour", "1 cup butter, softened"],
  "instructions": ["Preheat oven to 375°F", "Mix flour and butter"]
}`;

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
