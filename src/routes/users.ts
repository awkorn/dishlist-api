import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";

const router = Router();

// Register/Login - Create or update user in database
router.post("/register", authToken, async (req: AuthRequest, res) => {
  try {
    const { email, username, firstName, lastName, bio } = req.body;
    const firebaseUid = req.user!.uid;

    // Build update object conditionally
    const updateData: any = {
      email,
      updatedAt: new Date(),
    };

    // Only include fields if they're provided
    if (username !== undefined) updateData.username = username;
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (bio !== undefined) updateData.bio = bio;

    // Create object for new users
    const createData = {
      uid: firebaseUid,
      email,
      username: username || null,
      firstName: firstName || null,
      lastName: lastName || null,
      bio: bio || null,
    };

    // Create or update user in your database
    const user = await prisma.user.upsert({
      where: { uid: firebaseUid },
      update: updateData,
      create: createData,
    });

    // Create default "My Recipes" DishList for new users
    const defaultDishList = await prisma.dishList.findFirst({
      where: {
        ownerId: user.uid,
        isDefault: true,
      },
    });

    if (!defaultDishList) {
      await prisma.dishList.create({
        data: {
          title: "My Recipes",
          description: "Your personal recipe collection",
          ownerId: user.uid,
          isDefault: true,
          visibility: "PRIVATE",
        },
      });
    }

    res.json({ user });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(400).json({ error: "Failed to create/update user" });
  }
});

// Get current user profile
router.get("/me", authToken, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { uid: req.user!.uid },
      include: {
        ownedDishLists: {
          where: { isDefault: false },
          orderBy: { createdAt: 'desc' },
        },
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Get any user's profile by userId
router.get("/:userId", authToken, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user!.uid;

    const user = await prisma.user.findUnique({
      where: { uid: userId },
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get public dishlists (owned + collaborated)
    const dishlists = await prisma.dishList.findMany({
      where: {
        visibility: "PUBLIC",
        OR: [
          { ownerId: userId },
          { collaborators: { some: { userId } } },
        ],
      },
      include: {
        owner: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        _count: {
          select: {
            recipes: true,
            followers: true,
          },
        },
        collaborators: {
          where: { userId: currentUserId },
        },
        followers: {
          where: { userId: currentUserId },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get recipes from public dishlists
    const dishlistIds = dishlists.map(d => d.id);
    const recipes = await prisma.recipe.findMany({
      where: {
        dishLists: {
          some: {
            dishListId: { in: dishlistIds },
          },
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
      orderBy: { createdAt: 'desc' },
    });

    // Check if current user is following this profile
    const isFollowing = await prisma.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId: currentUserId,
          followingId: userId,
        },
      },
    });

    res.json({
      user: {
        uid: user.uid,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        followerCount: user._count.followers,
        followingCount: user._count.following,
        isFollowing: !!isFollowing,
        isOwnProfile: userId === currentUserId,
      },
      dishlists: dishlists.map(d => ({
        id: d.id,
        title: d.title,
        description: d.description,
        visibility: d.visibility,
        isDefault: d.isDefault,
        isPinned: d.isPinned,
        recipeCount: d._count.recipes,
        followerCount: d._count.followers,
        isOwner: d.ownerId === currentUserId,
        isCollaborator: d.collaborators.length > 0,
        isFollowing: d.followers.length > 0,
        owner: d.owner,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      recipes,
    });
  } catch (error) {
    console.error("Get user profile error:", error);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// Update current user's profile
router.put("/me", authToken, async (req: AuthRequest, res) => {
  try {
    const { username, firstName, lastName, bio, avatarUrl } = req.body;
    const userId = req.user!.uid;

    // If username is being changed, check if it's available
    if (username) {
      const existingUser = await prisma.user.findUnique({
        where: { username },
      });

      if (existingUser && existingUser.uid !== userId) {
        return res.status(400).json({ error: "Username already taken" });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { uid: userId },
      data: {
        username: username || undefined,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        bio: bio || undefined,
        avatarUrl: avatarUrl || undefined,
        updatedAt: new Date(),
      },
      include: {
        _count: {
          select: {
            followers: true,
            following: true,
          },
        },
      },
    });

    res.json({ user: updatedUser });
  } catch (error) {
    console.error("Update user profile error:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

export default router;