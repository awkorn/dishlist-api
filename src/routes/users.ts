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
          orderBy: { createdAt: "desc" },
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

// Update current user's profile
router.put("/me", authToken, async (req: AuthRequest, res) => {
  try {
    const { username, firstName, lastName, bio, avatarUrl } = req.body;
    const userId = req.user!.uid;

    // Validate required fields if provided
    if (username !== undefined && !username?.trim()) {
      return res.status(400).json({ error: "Username cannot be empty" });
    }

    if (firstName !== undefined && !firstName?.trim()) {
      return res.status(400).json({ error: "First name cannot be empty" });
    }

    // If username is being changed, check if it's available
    if (username) {
      const existingUser = await prisma.user.findUnique({
        where: { username },
      });

      if (existingUser && existingUser.uid !== userId) {
        return res.status(400).json({ error: "Username already taken" });
      }
    }

    const updateData: Record<string, any> = {
      updatedAt: new Date(),
    };

    // Required fields - only update if provided and non-empty
    if (username !== undefined) {
      updateData.username = username.trim();
    }
    if (firstName !== undefined) {
      updateData.firstName = firstName.trim();
    }

    // Optional fields - can be set to null to clear
    if (lastName !== undefined) {
      updateData.lastName = lastName === null ? null : lastName.trim() || null;
    }
    if (bio !== undefined) {
      updateData.bio = bio === null ? null : bio.trim() || null;
    }
    if (avatarUrl !== undefined) {
      updateData.avatarUrl = avatarUrl === null ? null : avatarUrl;
    }

    const updatedUser = await prisma.user.update({
      where: { uid: userId },
      data: updateData,
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

// Get user's mutuals (users you follow who also follow you back)
router.get("/mutuals", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { search } = req.query;

    // Find users where:
    // 1. Current user follows them (they are in user's "following" list)
    // 2. They follow current user back (user is in their "following" list)
    const mutuals = await prisma.user.findMany({
      where: {
        AND: [
          // I follow them
          {
            followers: {
              some: {
                followerId: userId,
              },
            },
          },
          // They follow me
          {
            following: {
              some: {
                followingId: userId,
              },
            },
          },
          // Optional search filter
          ...(search
            ? [
                {
                  OR: [
                    {
                      username: {
                        contains: search as string,
                        mode: "insensitive" as const,
                      },
                    },
                    {
                      firstName: {
                        contains: search as string,
                        mode: "insensitive" as const,
                      },
                    },
                    {
                      lastName: {
                        contains: search as string,
                        mode: "insensitive" as const,
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      select: {
        uid: true,
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { username: "asc" }],
    });

    res.json({ mutuals });
  } catch (error) {
    console.error("Get mutuals error:", error);
    res.status(500).json({ error: "Failed to fetch mutuals" });
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

    // Get dishlists based on ownership
    let dishlists;
    if (userId === currentUserId) {
      // Own profile: Show ALL dishlists (public + private, owned + collaborated)
      dishlists = await prisma.dishList.findMany({
        where: {
          OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
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
          pins: {
            where: { userId: currentUserId },
            select: { userId: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    } else {
      // Other user's profile: Show only public dishlists (owned + collaborated)
      dishlists = await prisma.dishList.findMany({
        where: {
          visibility: "PUBLIC",
          OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
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
          pins: {
            where: { userId: currentUserId },
            select: { userId: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    }

    // Get recipes from user's dishlists (owned + collaborated)
    const dishlistIds = dishlists.map((d) => d.id);

    const recipes =
      dishlistIds.length > 0
        ? await prisma.recipe.findMany({
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
            orderBy: { createdAt: "desc" },
          })
        : [];

    // Check if current user is following this profile
    let followStatus: "NONE" | "PENDING" | "ACCEPTED" = "NONE";
    let isFollowing = false;

    if (userId !== currentUserId) {
      const followRelation = await prisma.userFollow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: userId,
          },
        },
      });

      if (followRelation) {
        followStatus = followRelation.status;
        isFollowing = followRelation.status === "ACCEPTED";
      }
    }
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
        isFollowing,
        isOwnProfile: userId === currentUserId,
        followStatus, 
      },
      dishlists: dishlists.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        visibility: d.visibility,
        isDefault: d.isDefault,
        isPinned: d.pins.length > 0,
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

// ============================================
// FOLLOW ROUTES
// ============================================

// POST /:id/follow - Send follow request (or cancel if pending)
router.post("/:id/follow", authToken, async (req: AuthRequest, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user!.uid;

    // Can't follow yourself
    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }

    // Check target user exists
    const targetUser = await prisma.user.findUnique({
      where: { uid: targetUserId },
    });

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check for existing follow/request
    const existingFollow = await prisma.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId: currentUserId,
          followingId: targetUserId,
        },
      },
    });

    if (existingFollow) {
      if (existingFollow.status === "ACCEPTED") {
        return res.status(400).json({ error: "Already following this user" });
      }
      // Already pending
      return res.status(400).json({
        error: "Follow request already sent",
        status: "PENDING",
      });
    }

    // Get current user for notification
    const currentUser = await prisma.user.findUnique({
      where: { uid: currentUserId },
      select: {
        username: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
      },
    });

    const followerName =
      currentUser?.firstName || currentUser?.username || "Someone";

    // Create pending follow request and notification in transaction
    await prisma.$transaction(async (tx) => {
      await tx.userFollow.create({
        data: {
          followerId: currentUserId,
          followingId: targetUserId,
          status: "PENDING",
        },
      });

      // Create notification for the target user (follow request)
      await tx.notification.create({
        data: {
          type: "FOLLOW_REQUEST",
          title: `${followerName} wants to follow you`,
          message: "Tap to accept or decline",
          senderId: currentUserId,
          receiverId: targetUserId,
          data: JSON.stringify({
            odUserId: currentUserId,
            followerName,
            avatarUrl: currentUser?.avatarUrl || null,
          }),
        },
      });
    });

    res.json({
      success: true,
      message: "Follow request sent",
      status: "PENDING",
    });
  } catch (error) {
    console.error("Follow user error:", error);
    res.status(500).json({ error: "Failed to send follow request" });
  }
});

// DELETE /:id/follow - Unfollow OR cancel pending request
router.delete("/:id/follow", authToken, async (req: AuthRequest, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user!.uid;

    // Can't unfollow yourself
    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "Cannot unfollow yourself" });
    }

    // Find existing follow/request
    const existingFollow = await prisma.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId: currentUserId,
          followingId: targetUserId,
        },
      },
    });

    if (!existingFollow) {
      return res.json({ success: true, message: "Not following this user" });
    }

    const wasPending = existingFollow.status === "PENDING";

    // Delete follow relationship and related notification
    await prisma.$transaction(async (tx) => {
      await tx.userFollow.delete({
        where: { id: existingFollow.id },
      });

      // If was pending, also delete the follow request notification
      if (wasPending) {
        await tx.notification.deleteMany({
          where: {
            type: "FOLLOW_REQUEST",
            senderId: currentUserId,
            receiverId: targetUserId,
          },
        });
      }
    });

    res.json({
      success: true,
      message: wasPending
        ? "Follow request cancelled"
        : "Successfully unfollowed user",
    });
  } catch (error) {
    console.error("Unfollow user error:", error);
    res.status(500).json({ error: "Failed to unfollow user" });
  }
});

// GET /:id - Get user profile (UPDATE to include follow status)
router.get("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;
    const currentUserId = req.user!.uid;
    const isOwnProfile = userId === currentUserId;

    const user = await prisma.user.findUnique({
      where: { uid: userId },
      include: {
        ownedDishLists: {
          where: { isDefault: false },
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: {
            followers: {
              where: { status: "ACCEPTED" }, // Only count accepted followers
            },
            following: {
              where: { status: "ACCEPTED" }, // Only count accepted following
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check follow relationship
    let isFollowing = false;
    let followStatus: "NONE" | "PENDING" | "ACCEPTED" = "NONE";

    if (!isOwnProfile) {
      const followRelation = await prisma.userFollow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: userId,
          },
        },
      });

      if (followRelation) {
        followStatus = followRelation.status;
        isFollowing = followRelation.status === "ACCEPTED";
      }
    }

    res.json({
      uid: user.uid,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      followerCount: user._count.followers,
      followingCount: user._count.following,
      dishLists: user.ownedDishLists,
      isOwnProfile,
      isFollowing,
      followStatus, // NEW: "NONE" | "PENDING" | "ACCEPTED"
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

export default router;
