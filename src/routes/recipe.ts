import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";

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
    } = req.body;

    const userId = req.user!.uid;

    // Validation
    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "At least one ingredient is required" });
    }

    if (!instructions || !Array.isArray(instructions) || instructions.length === 0) {
      return res.status(400).json({ error: "At least one instruction is required" });
    }

    if (dishListId) {
      // Verify user has access to the dishlist
      const dishList = await prisma.dishList.findFirst({
        where: {
          id: dishListId,
          OR: [
            { ownerId: userId },
            { collaborators: { some: { userId } } }
          ]
        }
      });

      if (!dishList) {
        return res.status(403).json({ error: "Access denied to this DishList" });
      }
    }

    // Create recipe
    const recipe = await prisma.recipe.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        instructions: instructions.filter(inst => inst.trim()),
        ingredients: ingredients.filter(ing => ing.trim()),
        prepTime: prepTime || null,
        cookTime: cookTime || null,
        servings: servings || null,
        imageUrl: imageUrl || null,
        nutrition: nutrition || null,
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
      return res.status(403).json({ error: "Only the recipe owner can edit this recipe" });
    }

    // Validation
    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: "At least one ingredient is required" });
    }

    if (!instructions || !Array.isArray(instructions) || instructions.length === 0) {
      return res.status(400).json({ error: "At least one instruction is required" });
    }

    // Check if ingredients changed - if so, clear nutrition
    const ingredientsChanged = JSON.stringify(existingRecipe.ingredients) !== JSON.stringify(ingredients);
    const nutritionData = ingredientsChanged ? null : (nutrition || existingRecipe.nutrition);

    // Update recipe
    const updatedRecipe = await prisma.recipe.update({
      where: { id: recipeId },
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        instructions: instructions.filter(inst => inst.trim()),
        ingredients: ingredients.filter(ing => ing.trim()),
        prepTime: prepTime || null,
        cookTime: cookTime || null,
        servings: servings || null,
        imageUrl: imageUrl || null,
        nutrition: nutritionData,
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
      select: { dishListId: true }
    });

    const dishListIds = dishListRecipes.map(dr => dr.dishListId);
    res.json({ dishListIds });
  } catch (error) {
    console.error("Get recipe dishlists error:", error);
    res.status(500).json({ error: "Failed to fetch dishlists" });
  }
});

export default router;