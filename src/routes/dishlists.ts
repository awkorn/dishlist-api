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
            some: { userId }
          }
        };
        break;
      case "following":
        whereClause = {
          followers: {
            some: { userId }
          }
        };
        break;
      default: // "all"
        whereClause = {
          OR: [
            { ownerId: userId },
            { collaborators: { some: { userId } } },
            { followers: { some: { userId } } }
          ]
        };
    }

    const dishLists = await prisma.dishList.findMany({
      where: whereClause,
      include: {
        _count: {
          select: { recipes: true }
        },
        owner: {
          select: { uid: true, username: true, firstName: true, lastName: true }
        },
        collaborators: {
          where: { userId },
          select: { userId: true }
        },
        followers: {
          where: { userId },
          select: { userId: true }
        }
      },
      orderBy: [
        { isDefault: 'desc' }, 
        { isPinned: 'desc' },
        { updatedAt: 'desc' }
      ]
    });

    // Transform data for frontend
    const transformedLists = dishLists.map(list => ({
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
      updatedAt: list.updatedAt
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
        isDefault: false
      },
      include: {
        _count: { select: { recipes: true } },
        owner: {
          select: { uid: true, username: true, firstName: true, lastName: true }
        }
      }
    });

    res.status(201).json({ dishList });
  } catch (error) {
    console.error("Create dishlist error:", error);
    res.status(500).json({ error: "Failed to create dishlist" });
  }
});

export default router;
