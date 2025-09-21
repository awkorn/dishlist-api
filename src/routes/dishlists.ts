import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";

const router = Router();

// Get user's dishlists with proper filtering
router.get("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { tab = "all" } = req.query;

    let whereClause: any = {};

    switch (tab) {
      case "my":
        whereClause = { ownerId: userId };
        break;
      case "collaborations":
        whereClause = {
          collaborators: {
            some: { userId },
          },
        };
        break;
      case "following":
        whereClause = {
          followers: {
            some: { userId },
          },
        };
        break;
      default: // "all"
        whereClause = {
          OR: [
            { ownerId: userId },
            { collaborators: { some: { userId } } },
            { followers: { some: { userId } } },
          ],
        };
    }

    const dishLists = await prisma.dishList.findMany({
      where: whereClause,
      include: {
        _count: {
          select: { recipes: true },
        },
        owner: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        collaborators: {
          where: { userId },
          select: { userId: true },
        },
        followers: {
          where: { userId },
          select: { userId: true },
        },
      },
      orderBy: [
        { isDefault: "desc" },
        { isPinned: "desc" },
        { updatedAt: "desc" },
      ],
    });

    // Transform data for frontend
    const transformedLists = dishLists.map((list) => ({
      id: list.id,
      title: list.title,
      description: list.description,
      visibility: list.visibility,
      isDefault: list.isDefault,
      isPinned: list.isPinned,
      recipeCount: list._count.recipes,
      isOwner: list.ownerId === userId,
      isCollaborator: list.collaborators.length > 0,
      isFollowing: list.followers.length > 0,
      owner: list.owner,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
    }));

    res.json({ dishLists: transformedLists });
  } catch (error) {
    console.error("Get dishlists error:", error);
    res.status(500).json({ error: "Failed to fetch dishlists" });
  }
});

// Create new dishlist
router.post("/", authToken, async (req: AuthRequest, res) => {
  try {
    const { title, description, visibility = "PUBLIC" } = req.body;
    const userId = req.user!.uid;

    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const dishList = await prisma.dishList.create({
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        visibility,
        ownerId: userId,
        isDefault: false,
      },
      include: {
        _count: { select: { recipes: true } },
        owner: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    res.status(201).json({ dishList });
  } catch (error) {
    console.error("Create dishlist error:", error);
    res.status(500).json({ error: "Failed to create dishlist" });
  }
});

// Get single dishlist with recipes
router.get("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    const dishList = await prisma.dishList.findUnique({
      where: { id: dishListId },
      include: {
        _count: {
          select: {
            recipes: true,
            followers: true,
          },
        },
        owner: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        collaborators: {
          where: { userId },
          select: { userId: true },
        },
        followers: {
          where: { userId },
          select: { userId: true },
        },
        recipes: {
          include: {
            recipe: {
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
            },
          },
          orderBy: { addedAt: "desc" },
        },
      },
    });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    // Check if user has access to private dishlist
    if (dishList.visibility === "PRIVATE") {
      const hasAccess =
        dishList.ownerId === userId || dishList.collaborators.length > 0;

      if (!hasAccess) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    // Transform data for frontend
    const transformedDishList = {
      id: dishList.id,
      title: dishList.title,
      description: dishList.description,
      visibility: dishList.visibility,
      isDefault: dishList.isDefault,
      isPinned: dishList.isPinned,
      recipeCount: dishList._count.recipes,
      followerCount: dishList._count.followers,
      isOwner: dishList.ownerId === userId,
      isCollaborator: dishList.collaborators.length > 0,
      isFollowing: dishList.followers.length > 0,
      owner: dishList.owner,
      recipes: dishList.recipes.map((dr) => ({
        id: dr.recipe.id,
        title: dr.recipe.title,
        description: dr.recipe.description,
        instructions: dr.recipe.instructions,
        ingredients: dr.recipe.ingredients,
        prepTime: dr.recipe.prepTime,
        cookTime: dr.recipe.cookTime,
        servings: dr.recipe.servings,
        imageUrl: dr.recipe.imageUrl,
        creatorId: dr.recipe.creatorId,
        creator: dr.recipe.creator,
        createdAt: dr.recipe.createdAt,
        updatedAt: dr.recipe.updatedAt,
      })),
      createdAt: dishList.createdAt,
      updatedAt: dishList.updatedAt,
    };

    res.json({ dishList: transformedDishList });
  } catch (error) {
    console.error("Get dishlist detail error:", error);
    res.status(500).json({ error: "Failed to fetch dishlist" });
  }
});

// Follow a dishlist
router.post("/:id/follow", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Check if dishlist exists and is public or user has access
    const dishList = await prisma.dishList.findUnique({
      where: { id: dishListId },
      include: {
        collaborators: {
          where: { userId },
        },
      },
    });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    if (dishList.ownerId === userId) {
      return res.status(400).json({ error: "Cannot follow your own DishList" });
    }

    if (
      dishList.visibility === "PRIVATE" &&
      dishList.collaborators.length === 0
    ) {
      return res.status(403).json({ error: "Cannot follow private DishList" });
    }

    // Create follow relationship
    await prisma.dishListFollower.upsert({
      where: {
        dishListId_userId: {
          dishListId,
          userId,
        },
      },
      create: {
        dishListId,
        userId,
      },
      update: {}, // No update needed if already exists
    });

    res.json({ message: "Successfully followed DishList" });
  } catch (error) {
    console.error("Follow dishlist error:", error);
    res.status(500).json({ error: "Failed to follow DishList" });
  }
});

// Unfollow a dishlist
router.delete("/:id/follow", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    await prisma.dishListFollower.deleteMany({
      where: {
        dishListId,
        userId,
      },
    });

    res.json({ message: "Successfully unfollowed DishList" });
  } catch (error) {
    console.error("Unfollow dishlist error:", error);
    res.status(500).json({ error: "Failed to unfollow DishList" });
  }
});

// Pin/unpin endpoints
router.post("/:id/pin", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Check if user owns or collaborates on this dishlist
    const dishList = await prisma.dishList.findFirst({
      where: {
        id: dishListId,
        OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
      },
    });

    if (!dishList) {
      return res
        .status(404)
        .json({ error: "DishList not found or access denied" });
    }

    await prisma.dishList.update({
      where: { id: dishListId },
      data: { isPinned: true },
    });

    res.json({ message: "DishList pinned successfully" });
  } catch (error) {
    console.error("Pin dishlist error:", error);
    res.status(500).json({ error: "Failed to pin DishList" });
  }
});

router.delete("/:id/pin", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    const dishList = await prisma.dishList.findFirst({
      where: {
        id: dishListId,
        OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
      },
    });

    if (!dishList) {
      return res
        .status(404)
        .json({ error: "DishList not found or access denied" });
    }

    await prisma.dishList.update({
      where: { id: dishListId },
      data: { isPinned: false },
    });

    res.json({ message: "DishList unpinned successfully" });
  } catch (error) {
    console.error("Unpin dishlist error:", error);
    res.status(500).json({ error: "Failed to unpin DishList" });
  }
});

export default router;
