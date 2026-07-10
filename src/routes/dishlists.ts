import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";
import {
  areUsersBlocked,
  getBlockContext,
  getBlockedPeerIds,
} from "../lib/blocks";
import {
  handleModerationError,
  moderateTextFields,
} from "../lib/moderation";
import {
  accessibleRecipeWhere,
  writableDishListWhere,
} from "../lib/recipeAccess";
import { copyRecipeImagesForFork } from "../lib/recipeImages";
import {
  validateOptionalEnum,
  validateRequiredText,
} from "../lib/requestValidation";
import { parsePageLimit } from "../lib/pagination";
import { normalizeRecipientIds } from "../lib/inviteValidation";
import { dishlistShareLimiter } from "../middleware/rateLimit";

const router = Router();
const DISHLISTS_DEFAULT_PAGE_SIZE = 30;
const DISHLISTS_MAX_PAGE_SIZE = 100;
const DISHLIST_TITLE_MIN_LENGTH = 2;

function parsePageOffset(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return parsed;
}
const DISHLIST_TITLE_MAX_LENGTH = 50;
const DISHLIST_VISIBILITIES = ["PUBLIC", "PRIVATE"] as const;

type DishListSummarySource = {
  id: string;
  title: string;
  visibility: "PUBLIC" | "PRIVATE";
  isDefault: boolean;
  ownerId: string;
  owner: {
    uid: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
  _count: {
    recipes: number;
  };
  collaborators: Array<{ userId: string }>;
  followers: Array<{ userId: string }>;
  pins: Array<{ userId: string }>;
};

function toDishListSummary(list: DishListSummarySource, userId: string) {
  return {
    id: list.id,
    title: list.title,
    visibility: list.visibility,
    isDefault: list.isDefault,
    // The default "My Recipes" list is permanently pinned by definition.
    isPinned: list.isDefault || list.pins.length > 0,
    recipeCount: list._count.recipes,
    isOwner: list.ownerId === userId,
    isCollaborator: list.collaborators.length > 0,
    isFollowing: list.followers.length > 0,
    owner: list.owner,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
  };
}

// Get user's dishlists with proper filtering (offset-paginated)
router.get("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { tab = "all" } = req.query;
    const limit = parsePageLimit(
      req.query.limit,
      DISHLISTS_DEFAULT_PAGE_SIZE,
      DISHLISTS_MAX_PAGE_SIZE,
    );
    const offset = parsePageOffset(req.query.offset);
    const blockedPeerIds = await getBlockedPeerIds(userId);

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

    whereClause = {
      AND: [
        whereClause,
        { ownerId: { notIn: blockedPeerIds } },
        {
          OR: [
            { visibility: "PUBLIC" },
            { ownerId: userId },
            { collaborators: { some: { userId } } },
          ],
        },
      ],
    };

    // The response order is default first, then pinned, then the rest by
    // recency. Offset pagination preserves that by walking two ordered
    // segments: the "priority" segment (default or pinned by this user)
    // and then everything else.
    const priorityWhere = {
      AND: [
        whereClause,
        { OR: [{ isDefault: true }, { pins: { some: { userId } } }] },
      ],
    };
    const restWhere = {
      AND: [
        whereClause,
        { isDefault: false },
        { pins: { none: { userId } } },
      ],
    };

    const listInclude = {
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
      pins: {
        where: { userId },
        select: { userId: true },
      },
    };

    const [priorityCount, restCount] = await Promise.all([
      prisma.dishList.count({ where: priorityWhere }),
      prisma.dishList.count({ where: restWhere }),
    ]);
    const total = priorityCount + restCount;

    let dishLists: DishListSummarySource[] = [];
    if (offset < priorityCount) {
      dishLists = await prisma.dishList.findMany({
        where: priorityWhere,
        include: listInclude,
        orderBy: [
          { isDefault: "desc" },
          { updatedAt: "desc" },
          { id: "asc" },
        ],
        skip: offset,
        take: limit,
      });
      const remaining = limit - dishLists.length;
      if (remaining > 0 && restCount > 0) {
        dishLists = dishLists.concat(
          await prisma.dishList.findMany({
            where: restWhere,
            include: listInclude,
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
            take: remaining,
          }),
        );
      }
    } else {
      dishLists = await prisma.dishList.findMany({
        where: restWhere,
        include: listInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: offset - priorityCount,
        take: limit,
      });
    }

    res.json({
      dishLists: dishLists.map((list) => toDishListSummary(list, userId)),
      meta: {
        limit,
        offset,
        total,
        hasMore: offset + dishLists.length < total,
      },
    });
  } catch (error) {
    console.error("Get dishlists error:", error);
    res.status(500).json({ error: "Failed to fetch dishlists" });
  }
});

// Create new dishlist
router.post("/", authToken, async (req: AuthRequest, res) => {
  try {
    const { title, visibility } = req.body;
    const userId = req.user!.uid;

    const validatedTitle = validateRequiredText(title, {
      field: "Title",
      minLength: DISHLIST_TITLE_MIN_LENGTH,
      maxLength: DISHLIST_TITLE_MAX_LENGTH,
    });
    if ("error" in validatedTitle) {
      return res.status(400).json({ error: validatedTitle.error });
    }

    const validatedVisibility = validateOptionalEnum(visibility, {
      field: "Visibility",
      allowedValues: DISHLIST_VISIBILITIES,
      defaultValue: "PUBLIC",
    });
    if ("error" in validatedVisibility) {
      return res.status(400).json({ error: validatedVisibility.error });
    }

    await moderateTextFields(
      [{ label: "DishList title", value: validatedTitle.value }],
      {
        targetType: "DISHLIST",
        userId,
      },
    );

    const dishList = await prisma.dishList.create({
      data: {
        title: validatedTitle.value,
        visibility: validatedVisibility.value,
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
        pins: {
          where: { userId },
          select: { userId: true },
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
    });

    res.status(201).json({
      dishList: toDishListSummary(dishList, userId),
    });
  } catch (error) {
    if (handleModerationError(error, res)) return;

    console.error("Create dishlist error:", error);
    res.status(500).json({ error: "Failed to create dishlist" });
  }
});

// Update dishlist
router.put("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;
    const { title, visibility } = req.body;

    const validatedTitle = validateRequiredText(title, {
      field: "Title",
      minLength: DISHLIST_TITLE_MIN_LENGTH,
      maxLength: DISHLIST_TITLE_MAX_LENGTH,
    });
    if ("error" in validatedTitle) {
      return res.status(400).json({ error: validatedTitle.error });
    }

    // Find existing dishlist
    const existingDishList = await prisma.dishList.findUnique({
      where: { id: dishListId },
    });

    if (!existingDishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    // Check ownership
    if (existingDishList.ownerId !== userId) {
      return res
        .status(403)
        .json({ error: "Only the owner can edit this DishList" });
    }

    // Prevent editing default DishList title
    if (
      existingDishList.isDefault &&
      validatedTitle.value !== existingDishList.title
    ) {
      return res
        .status(400)
        .json({ error: "Cannot change default DishList title" });
    }

    const validatedVisibility = validateOptionalEnum(visibility, {
      field: "Visibility",
      allowedValues: DISHLIST_VISIBILITIES,
      defaultValue: existingDishList.visibility,
    });
    if ("error" in validatedVisibility) {
      return res.status(400).json({ error: validatedVisibility.error });
    }

    await moderateTextFields(
      [{ label: "DishList title", value: validatedTitle.value }],
      {
        targetType: "DISHLIST",
        targetId: dishListId,
        userId,
      },
    );

    const nextVisibility = validatedVisibility.value;

    const updatedDishList = await prisma.$transaction(async (tx) => {
      const updated = await tx.dishList.update({
        where: { id: dishListId },
        data: {
          title: validatedTitle.value,
          visibility: nextVisibility,
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
          pins: {
            where: { userId },
            select: { userId: true },
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
      });

      if (nextVisibility === "PRIVATE") {
        await tx.dishListFollower.deleteMany({
          where: { dishListId },
        });
      }

      return updated;
    });

    res.json({
      dishList: toDishListSummary(updatedDishList, userId),
    });
  } catch (error) {
    if (handleModerationError(error, res)) return;

    console.error("Update dishlist error:", error);
    res.status(500).json({ error: "Failed to update dishlist" });
  }
});

// Get dishlist details
router.get("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Bound the recipe payload; clients can page with recipesLimit/recipesOffset
    // and use recipeCount to tell whether more exist.
    const recipesLimitRaw = Number(req.query.recipesLimit ?? 60);
    const recipesOffsetRaw = Number(req.query.recipesOffset ?? 0);
    const recipesLimit = Number.isFinite(recipesLimitRaw)
      ? Math.min(Math.max(recipesLimitRaw, 1), 200)
      : 60;
    const recipesOffset = Number.isFinite(recipesOffsetRaw)
      ? Math.max(recipesOffsetRaw, 0)
      : 0;

    // Build visibility condition
    const visibilityCondition = {
      OR: [
        { visibility: "PUBLIC" as const },
        { ownerId: userId },
        { collaborators: { some: { userId } } },
      ],
    };

    // Resolved first so the recipe filter (and its count) can exclude
    // blocked creators in the query itself — keeps recipesMeta.hasMore
    // consistent with the rows actually returned.
    const blockContext = await getBlockContext(userId);
    const visibleRecipeWhere = {
      recipe: {
        moderationState: "VISIBLE" as const,
        creatorId: { notIn: blockContext.blockedPeerIds },
        creator: { status: "ACTIVE" as const },
      },
    };

    const dishList = await prisma.dishList.findFirst({
        where: {
          id: dishListId,
          ...visibilityCondition,
        },
        include: {
          _count: {
            select: {
              recipes: { where: visibleRecipeWhere },
              followers: true,
              collaborators: true,
            },
          },
          owner: {
            select: {
              uid: true,
              username: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
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
            where: visibleRecipeWhere,
            select: {
              recipe: {
                // Explicit select keeps the payload lean — notably omits
                // `instructions` and `nutrition`, which the recipe detail
                // screen fetches for itself via GET /recipes/:id.
                select: {
                  id: true,
                  title: true,
                  description: true,
                  ingredients: true,
                  tags: true,
                  prepTime: true,
                  cookTime: true,
                  servings: true,
                  imageUrl: true,
                  imageUrls: true,
                  creatorId: true,
                  createdAt: true,
                  updatedAt: true,
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
            skip: recipesOffset,
            take: recipesLimit,
          },
          pins: {
            where: { userId },
            select: { userId: true },
          },
        },
      });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    if (blockContext.isBlocked(dishList.ownerId)) {
      return res.status(404).json({ error: "DishList not found" });
    }

    // Transform response
    const transformedDishList = {
      id: dishList.id,
      title: dishList.title,
      visibility: dishList.visibility,
      isDefault: dishList.isDefault,
      isPinned: dishList.isDefault || dishList.pins.length > 0,
      recipeCount: dishList._count.recipes,
      followerCount: dishList._count.followers,
      collaboratorCount: dishList._count.collaborators,
      isOwner: dishList.ownerId === userId,
      isCollaborator: dishList.collaborators.length > 0,
      isFollowing: dishList.followers.length > 0,
      owner: dishList.owner,
      recipes: dishList.recipes.map((dr) => ({
        id: dr.recipe.id,
        title: dr.recipe.title,
        description: dr.recipe.description,
        ingredients: dr.recipe.ingredients,
        tags: dr.recipe.tags,
        prepTime: dr.recipe.prepTime,
        cookTime: dr.recipe.cookTime,
        servings: dr.recipe.servings,
        imageUrl: dr.recipe.imageUrl,
        imageUrls: dr.recipe.imageUrls?.length
          ? dr.recipe.imageUrls
          : dr.recipe.imageUrl
            ? [dr.recipe.imageUrl]
            : [],
        creatorId: dr.recipe.creatorId,
        creator: dr.recipe.creator,
        createdAt: dr.recipe.createdAt,
        updatedAt: dr.recipe.updatedAt,
      })),
      recipesMeta: {
        limit: recipesLimit,
        offset: recipesOffset,
        hasMore:
          recipesOffset + dishList.recipes.length < dishList._count.recipes,
      },
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

    const [dishList, blockContext] = await Promise.all([
      prisma.dishList.findUnique({
        where: { id: dishListId },
        include: {
          collaborators: {
            where: { userId },
          },
        },
      }),
      getBlockContext(userId),
    ]);

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    if (blockContext.isBlocked(dishList.ownerId)) {
      return res.status(403).json({ error: "Cannot follow this DishList" });
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

    // Pinning is available for dishlists in the user's library.
    const dishList = await prisma.dishList.findFirst({
      where: {
        id: dishListId,
        OR: [
          { ownerId: userId },
          { collaborators: { some: { userId } } },
          { followers: { some: { userId } } },
        ],
      },
    });

    if (!dishList) {
      return res
        .status(404)
        .json({ error: "DishList not found or access denied" });
    }

    // Upsert the pin record for this user
    await prisma.userDishListPin.upsert({
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

    res.json({ message: "DishList pinned successfully" });
  } catch (error) {
    console.error("Pin dishlist error:", error);
    res.status(500).json({ error: "Failed to pin DishList" });
  }
});

// Unpin dishlist
router.delete("/:id/pin", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Verify the dishlist is still in the user's library.
    const dishList = await prisma.dishList.findFirst({
      where: {
        id: dishListId,
        OR: [
          { ownerId: userId },
          { collaborators: { some: { userId } } },
          { followers: { some: { userId } } },
        ],
      },
    });

    if (!dishList) {
      return res
        .status(404)
        .json({ error: "DishList not found or access denied" });
    }

    // Delete the pin record for this user
    await prisma.userDishListPin.deleteMany({
      where: {
        dishListId,
        userId,
      },
    });

    res.json({ message: "DishList unpinned successfully" });
  } catch (error) {
    console.error("Unpin dishlist error:", error);
    res.status(500).json({ error: "Failed to unpin DishList" });
  }
});

// Delete dishlist
router.delete("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Find the dishlist
    const dishList = await prisma.dishList.findUnique({
      where: { id: dishListId },
    });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    // Check ownership
    if (dishList.ownerId !== userId) {
      return res
        .status(403)
        .json({ error: "Only the owner can delete this DishList" });
    }

    // Prevent deletion of default DishList
    if (dishList.isDefault) {
      return res
        .status(400)
        .json({ error: "Cannot delete your default DishList" });
    }

    // Delete only the DishList. Cascading relations remove list membership,
    // collaborators, followers, invites, and pins while preserving every
    // Recipe record, including recipes created by collaborators.
    await prisma.dishList.delete({
      where: { id: dishListId },
    });

    res.json({ message: "DishList deleted successfully" });
  } catch (error) {
    console.error("Delete dishlist error:", error);
    res.status(500).json({ error: "Failed to delete DishList" });
  }
});

// Add recipe to dishlist
router.post("/:id/recipes", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;
    const { recipeId } = req.body;

    if (!recipeId) {
      return res.status(400).json({ error: "Recipe ID is required" });
    }

    const [dishList, recipe] = await Promise.all([
      prisma.dishList.findFirst({
        where: writableDishListWhere(userId, dishListId),
      }),
      prisma.recipe.findFirst({
        where: accessibleRecipeWhere(userId, recipeId),
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
    ]);

    if (!dishList) {
      return res
        .status(403)
        .json({ error: "Access denied or DishList not found" });
    }

    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    if (await areUsersBlocked(userId, recipe.creatorId)) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    if (recipe.creatorId === userId) {
      await prisma.dishListRecipe.upsert({
        where: {
          dishListId_recipeId: {
            dishListId,
            recipeId,
          },
        },
        create: {
          dishListId,
          recipeId,
          addedById: userId,
        },
        update: {},
      });

      return res.json({
        message: "Recipe added successfully",
        mode: "LINKED",
        recipe,
      });
    }

    const existingFork = await prisma.recipe.findUnique({
      where: {
        creatorId_originalRecipeId: {
          creatorId: userId,
          originalRecipeId: recipeId,
        },
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

    const sourceImageUrls =
      recipe.imageUrls.length > 0
        ? recipe.imageUrls
        : recipe.imageUrl
          ? [recipe.imageUrl]
          : [];
    const copiedImageUrls = existingFork
      ? existingFork.imageUrls
      : await copyRecipeImagesForFork(recipe.id, userId, sourceImageUrls);

    const fork = await prisma.$transaction(async (tx) => {
      const savedRecipe = existingFork
        ? existingFork
        : await tx.recipe.upsert({
            where: {
              creatorId_originalRecipeId: {
                creatorId: userId,
                originalRecipeId: recipeId,
              },
            },
            create: {
              title: recipe.title,
              description: recipe.description,
              instructions: recipe.instructions as any,
              ingredients: recipe.ingredients as any,
              prepTime: recipe.prepTime,
              cookTime: recipe.cookTime,
              servings: recipe.servings,
              imageUrl: copiedImageUrls[0] || null,
              imageUrls: copiedImageUrls,
              nutrition: recipe.nutrition as any,
              notes: recipe.notes,
              tags: recipe.tags,
              creatorId: userId,
              originalRecipeId: recipeId,
            },
            update: {},
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

      // Convert any legacy direct attachment of an external recipe into the
      // user's independent fork.
      await tx.dishListRecipe.deleteMany({
        where: { dishListId, recipeId },
      });

      await tx.dishListRecipe.upsert({
        where: {
          dishListId_recipeId: {
            dishListId,
            recipeId: savedRecipe.id,
          },
        },
        create: {
          dishListId,
          recipeId: savedRecipe.id,
          addedById: userId,
        },
        update: {},
      });

      return savedRecipe;
    });

    res.json({
      message: "Recipe saved successfully",
      mode: existingFork ? "REUSED_FORK" : "FORKED",
      recipe: fork,
    });
  } catch (error) {
    console.error("Add recipe to dishlist error:", error);
    res.status(500).json({ error: "Failed to add recipe" });
  }
});

// Remove recipe from dishlist
router.delete(
  "/:id/recipes/:recipeId",
  authToken,
  async (req: AuthRequest, res) => {
    try {
      const dishListId = req.params.id;
      const recipeId = req.params.recipeId;
      const userId = req.user!.uid;

      // Verify user has access (owner or collaborator)
      const dishList = await prisma.dishList.findFirst({
        where: {
          id: dishListId,
          OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
        },
      });

      if (!dishList) {
        return res
          .status(403)
          .json({ error: "Access denied or DishList not found" });
      }

      // Remove the recipe from this dishlist
      await prisma.dishListRecipe.deleteMany({
        where: {
          dishListId,
          recipeId,
        },
      });

      res.json({ message: "Recipe removed from DishList successfully" });
    } catch (error) {
      console.error("Remove recipe from dishlist error:", error);
      res.status(500).json({ error: "Failed to remove recipe" });
    }
  }
);

// Share a DishList with multiple users (creates notifications)
router.post(
  "/:id/share",
  authToken,
  dishlistShareLimiter,
  async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
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

    const [dishList, sender, blockContext] = await Promise.all([
      prisma.dishList.findUnique({
        where: { id: dishListId },
        include: {
          owner: {
            select: {
              uid: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      prisma.user.findUnique({
        where: { uid: userId },
        select: {
          uid: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      }),
      getBlockContext(userId),
    ]);

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    if (blockContext.isBlocked(dishList.ownerId)) {
      return res.status(404).json({ error: "DishList not found" });
    }

    // Only allow sharing public DishLists
    if (dishList.visibility !== "PUBLIC") {
      return res
        .status(403)
        .json({ error: "Only public DishLists can be shared" });
    }

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

    // Create notifications for all recipients
    const notifications = await prisma.notification.createMany({
      data: allowedRecipientIds.map((recipientId: string) => ({
        type: "DISHLIST_SHARED" as const,
        title: `${senderName} shared a DishList with you`,
        message: dishList.title,
        senderId: userId,
        receiverId: recipientId,
        data: JSON.stringify({
          dishListId: dishList.id,
          dishListTitle: dishList.title,
          senderId: userId,
          senderName,
        }),
      })),
      skipDuplicates: true,
    });

    res.json({
      success: true,
      notificationsSent: notifications.count,
      blocked: recipientIds.length - allowedRecipientIds.length,
    });
  } catch (error) {
    console.error("Share dishlist error:", error);
    res.status(500).json({ error: "Failed to share DishList" });
  }
  }
);

// ============================================
// GET /:id/collaborators
// Get collaborators and pending invites for a DishList
// Owner sees all; collaborators see confirmed only
// ============================================
router.get("/:id/collaborators", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    const [dishList, blockContext] = await Promise.all([
      prisma.dishList.findFirst({
        where: {
          id: dishListId,
          OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
        },
        include: {
          owner: {
            select: {
              uid: true,
              username: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
      }),
      getBlockContext(userId),
    ]);

    if (!dishList) {
      return res
        .status(404)
        .json({ error: "DishList not found or access denied" });
    }

    const isOwner = dishList.ownerId === userId;

    if (blockContext.isBlocked(dishList.ownerId)) {
      return res.status(404).json({ error: "DishList not found or access denied" });
    }

    const [collaborators, pendingInvites] = await Promise.all([
      prisma.dishListCollaborator.findMany({
        where: {
          dishListId,
          userId: { notIn: blockContext.blockedPeerIds },
        },
        include: {
          user: {
            select: {
              uid: true,
              username: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: { invitedAt: "asc" },
      }),
      isOwner
        ? prisma.dishListInvite.findMany({
            where: {
              dishListId,
              usedAt: null,
              expiresAt: { gt: new Date() },
              inviteeId: { not: null }, // Only show direct invites, not link invites
              NOT: { inviteeId: { in: blockContext.blockedPeerIds } },
            },
            include: {
              invitee: {
                select: {
                  uid: true,
                  username: true,
                  firstName: true,
                  lastName: true,
                  avatarUrl: true,
                },
              },
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
    ]);

    res.json({
      owner: dishList.owner,
      collaborators: collaborators.map((c) => ({
        id: c.id,
        joinedAt: c.invitedAt,
        user: c.user,
      })),
      pendingInvites: pendingInvites.map((i) => ({
        id: i.id,
        token: i.token,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        user: i.invitee,
      })),
      isOwner,
      totalCount: collaborators.length + 1, // +1 for owner
    });
  } catch (error) {
    console.error("Get collaborators error:", error);
    res.status(500).json({ error: "Failed to fetch collaborators" });
  }
});

// ============================================
// DELETE /:id/collaborators/:collaboratorUserId
// Remove a collaborator (owner only)
// ============================================
router.delete(
  "/:id/collaborators/:collaboratorUserId",
  authToken,
  async (req: AuthRequest, res) => {
    try {
      const dishListId = req.params.id;
      const collaboratorUserId = req.params.collaboratorUserId;
      const userId = req.user!.uid;

      // Verify ownership
      const dishList = await prisma.dishList.findUnique({
        where: { id: dishListId },
      });

      if (!dishList) {
        return res.status(404).json({ error: "DishList not found" });
      }

      if (dishList.ownerId !== userId) {
        return res
          .status(403)
          .json({ error: "Only the owner can remove collaborators" });
      }

      // Delete the collaborator
      const deleted = await prisma.dishListCollaborator.deleteMany({
        where: {
          dishListId,
          userId: collaboratorUserId,
        },
      });

      if (deleted.count === 0) {
        return res.status(404).json({ error: "Collaborator not found" });
      }

      res.json({ success: true, message: "Collaborator removed" });
    } catch (error) {
      console.error("Remove collaborator error:", error);
      res.status(500).json({ error: "Failed to remove collaborator" });
    }
  }
);

// ============================================
// DELETE /:id/invites/:inviteId
// Revoke a pending invite (owner only)
// ============================================
router.delete(
  "/:id/invites/:inviteId",
  authToken,
  async (req: AuthRequest, res) => {
    try {
      const dishListId = req.params.id;
      const inviteId = req.params.inviteId;
      const userId = req.user!.uid;

      const [dishList, invite] = await Promise.all([
        prisma.dishList.findUnique({
          where: { id: dishListId },
        }),
        prisma.dishListInvite.findFirst({
          where: {
            id: inviteId,
            dishListId,
          },
        }),
      ]);

      if (!dishList) {
        return res.status(404).json({ error: "DishList not found" });
      }

      if (dishList.ownerId !== userId) {
        return res
          .status(403)
          .json({ error: "Only the owner can revoke invites" });
      }

      if (!invite) {
        return res.status(404).json({ error: "Invite not found" });
      }

      // Delete invite and related notification
      await prisma.$transaction(async (tx) => {
        await tx.dishListInvite.delete({
          where: { id: inviteId },
        });

        // Delete notification if it was a direct invite
        if (invite.inviteeId) {
          await tx.notification.deleteMany({
            where: {
              type: "DISHLIST_INVITATION",
              receiverId: invite.inviteeId,
              data: { contains: dishListId },
            },
          });
        }
      });

      res.json({ success: true, message: "Invite revoked" });
    } catch (error) {
      console.error("Revoke invite error:", error);
      res.status(500).json({ error: "Failed to revoke invite" });
    }
  }
);

// ============================================
// POST /:id/invites/:inviteId/resend
// Resend notification for a pending invite (owner only)
// ============================================
router.post(
  "/:id/invites/:inviteId/resend",
  authToken,
  async (req: AuthRequest, res) => {
    try {
      const dishListId = req.params.id;
      const inviteId = req.params.inviteId;
      const userId = req.user!.uid;

      const [dishList, invite, sender, blockContext] = await Promise.all([
        prisma.dishList.findUnique({
          where: { id: dishListId },
        }),
        prisma.dishListInvite.findFirst({
          where: {
            id: inviteId,
            dishListId,
            usedAt: null,
            inviteeId: { not: null },
          },
        }),
        prisma.user.findUnique({
          where: { uid: userId },
          select: { firstName: true, username: true },
        }),
        getBlockContext(userId),
      ]);

      if (!dishList) {
        return res.status(404).json({ error: "DishList not found" });
      }

      if (dishList.ownerId !== userId) {
        return res
          .status(403)
          .json({ error: "Only the owner can resend invites" });
      }

      if (!invite) {
        return res.status(404).json({ error: "Pending invite not found" });
      }

      if (!invite.inviteeId) {
        return res.status(400).json({ error: "Cannot resend link invites" });
      }

      if (blockContext.isBlocked(invite.inviteeId)) {
        await prisma.dishListInvite.delete({ where: { id: invite.id } });
        return res.status(403).json({ error: "Cannot resend invite to this user" });
      }

      const senderName = sender?.firstName || sender?.username || "Someone";

      // Extend expiry and resend notification
      const newExpiresAt = new Date();
      newExpiresAt.setDate(newExpiresAt.getDate() + 7);

      await prisma.$transaction(async (tx) => {
        // Update invite expiry
        await tx.dishListInvite.update({
          where: { id: inviteId },
          data: { expiresAt: newExpiresAt },
        });

        // Delete old notification
        await tx.notification.deleteMany({
          where: {
            type: "DISHLIST_INVITATION",
            receiverId: invite.inviteeId!,
            senderId: userId,
            data: { contains: dishListId },
          },
        });

        // Create fresh notification
        await tx.notification.create({
          data: {
            type: "DISHLIST_INVITATION",
            title: `${senderName} invited you to collaborate`,
            message: dishList.title,
            senderId: userId,
            receiverId: invite.inviteeId!,
            data: JSON.stringify({
              dishListId: dishList.id,
              dishListTitle: dishList.title,
              inviteId: invite.id,
              senderId: userId,
              senderName,
            }),
          },
        });
      });

      res.json({
        success: true,
        message: "Invite resent",
        expiresAt: newExpiresAt,
      });
    } catch (error) {
      console.error("Resend invite error:", error);
      res.status(500).json({ error: "Failed to resend invite" });
    }
  }
);

export default router;
