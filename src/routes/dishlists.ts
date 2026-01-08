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
        pins: {
          where: { userId },
          select: { userId: true },
        },
      },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });

    // Transform data for frontend
    const transformedLists = dishLists.map((list) => ({
      id: list.id,
      title: list.title,
      description: list.description,
      visibility: list.visibility,
      isDefault: list.isDefault,
      isPinned: list.pins.length > 0,
      recipeCount: list._count.recipes,
      isOwner: list.ownerId === userId,
      isCollaborator: list.collaborators.length > 0,
      isFollowing: list.followers.length > 0,
      owner: list.owner,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
    }));

    // Sort: default first, then pinned, then by updatedAt
    transformedLists.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return b.isDefault ? 1 : -1;
      if (a.isPinned !== b.isPinned) return b.isPinned ? 1 : -1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

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

// Update dishlist
router.put("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;
    const { title, description, visibility } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: "Title is required" });
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
    if (existingDishList.isDefault && title.trim() !== existingDishList.title) {
      return res
        .status(400)
        .json({ error: "Cannot change default DishList title" });
    }

    // Update
    const updatedDishList = await prisma.dishList.update({
      where: { id: dishListId },
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        visibility: visibility || existingDishList.visibility,
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

    res.json({ dishList: updatedDishList });
  } catch (error) {
    console.error("Update dishlist error:", error);
    res.status(500).json({ error: "Failed to update dishlist" });
  }
});

// Get dishlist details
router.get("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Build visibility condition
    const visibilityCondition = {
      OR: [
        { visibility: "PUBLIC" as const },
        { ownerId: userId },
        { collaborators: { some: { userId } } },
      ],
    };

    const dishList = await prisma.dishList.findFirst({
      where: {
        id: dishListId,
        ...visibilityCondition,
      },
      include: {
        _count: {
          select: {
            recipes: true,
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
        pins: {
          where: { userId },
          select: { userId: true },
        },
      },
    });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    // Transform response
    const transformedDishList = {
      id: dishList.id,
      title: dishList.title,
      description: dishList.description,
      visibility: dishList.visibility,
      isDefault: dishList.isDefault,
      isPinned: dishList.pins.length > 0,
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
        instructions: dr.recipe.instructions,
        ingredients: dr.recipe.ingredients,
        tags: dr.recipe.tags,
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

    // Verify user has access to this dishlist
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

    // Get all recipes that are ONLY in this DishList
    const dishListRecipes = await prisma.dishListRecipe.findMany({
      where: { dishListId },
      include: {
        recipe: {
          include: {
            dishLists: true,
          },
        },
      },
    });

    // Delete recipes that are only in this DishList
    const recipesToDelete = dishListRecipes
      .filter((dr) => dr.recipe.dishLists.length === 1)
      .map((dr) => dr.recipe.id);

    if (recipesToDelete.length > 0) {
      await prisma.recipe.deleteMany({
        where: {
          id: { in: recipesToDelete },
        },
      });
    }

    // Delete the DishList (cascade will handle DishListRecipe, collaborators, followers)
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

    // Verify dishlist exists and user has access
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

    // Verify recipe exists
    const recipe = await prisma.recipe.findUnique({
      where: { id: recipeId },
    });

    if (!recipe) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    // Check if recipe already in dishlist
    const existing = await prisma.dishListRecipe.findUnique({
      where: {
        dishListId_recipeId: {
          dishListId,
          recipeId,
        },
      },
    });

    if (existing) {
      return res.status(400).json({ error: "Recipe already in this DishList" });
    }

    // Add recipe to dishlist
    await prisma.dishListRecipe.create({
      data: {
        dishListId,
        recipeId,
        addedById: userId,
      },
    });

    res.json({ message: "Recipe added successfully" });
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
router.post("/:id/share", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
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

    // Get the DishList to verify it exists and is public
    const dishList = await prisma.dishList.findUnique({
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
    });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    // Only allow sharing public DishLists
    if (dishList.visibility !== "PUBLIC") {
      return res
        .status(403)
        .json({ error: "Only public DishLists can be shared" });
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
    });
  } catch (error) {
    console.error("Share dishlist error:", error);
    res.status(500).json({ error: "Failed to share DishList" });
  }
});

// ============================================
// GET /:id/collaborators
// Get collaborators and pending invites for a DishList
// Owner sees all; collaborators see confirmed only
// ============================================
router.get("/:id/collaborators", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Verify DishList exists and user has access
    const dishList = await prisma.dishList.findFirst({
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
    });

    if (!dishList) {
      return res
        .status(404)
        .json({ error: "DishList not found or access denied" });
    }

    const isOwner = dishList.ownerId === userId;

    // Get confirmed collaborators
    const collaborators = await prisma.dishListCollaborator.findMany({
      where: { dishListId },
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
    });

    // Only owner can see pending invites
    let pendingInvites: any[] = [];
    if (isOwner) {
      pendingInvites = await prisma.dishListInvite.findMany({
        where: {
          dishListId,
          usedAt: null,
          expiresAt: { gt: new Date() },
          inviteeId: { not: null }, // Only show direct invites, not link invites
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
      });
    }

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
          .json({ error: "Only the owner can revoke invites" });
      }

      // Get invite to find the invitee for notification cleanup
      const invite = await prisma.dishListInvite.findFirst({
        where: {
          id: inviteId,
          dishListId,
        },
      });

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
          .json({ error: "Only the owner can resend invites" });
      }

      // Get invite
      const invite = await prisma.dishListInvite.findFirst({
        where: {
          id: inviteId,
          dishListId,
          usedAt: null,
          inviteeId: { not: null },
        },
      });

      if (!invite) {
        return res.status(404).json({ error: "Pending invite not found" });
      }

      if (!invite.inviteeId) {
        return res.status(400).json({ error: "Cannot resend link invites" });
      }

      // Get sender info
      const sender = await prisma.user.findUnique({
        where: { uid: userId },
        select: { firstName: true, username: true },
      });

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
