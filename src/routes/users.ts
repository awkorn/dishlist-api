import { Prisma } from "@prisma/client";
import { Router } from "express";
import prisma from "../lib/prisma";
import { supabaseAdmin } from "../lib/supabase";
import { authToken, AuthRequest } from "../middleware/auth";
import {
  areUsersBlocked,
  getBlockContext,
  getBlockStatus,
} from "../lib/blocks";
import {
  handleModerationError,
  moderateTextFields,
} from "../lib/moderation";
import {
  ProfileValidationError,
  validateProfileInput,
} from "../lib/profileValidation";
import { parsePageLimit } from "../lib/pagination";

const router = Router();
const USER_STORAGE_BUCKETS = ["avatars", "recipes"] as const;

function isAllowedAvatarUrl(url: string) {
  return url.startsWith(
    `${process.env.SUPABASE_URL}/storage/v1/object/public/avatars/`
  );
}

async function listStorageObjectPaths(bucket: string, prefix: string) {
  const paths: string[] = [];
  const pageSize = 100;
  let offset = 0;

  while (true) {
    const { data, error } = await supabaseAdmin.storage
      .from(bucket)
      .list(prefix, {
        limit: pageSize,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

    if (error) {
      throw new Error(`Failed to list ${bucket} images: ${error.message}`);
    }

    const items = data || [];
    for (const item of items) {
      const path = `${prefix}/${item.name}`;

      if ((item as any).id === null) {
        paths.push(...(await listStorageObjectPaths(bucket, path)));
      } else {
        paths.push(path);
      }
    }

    if (items.length < pageSize) break;
    offset += pageSize;
  }

  return paths;
}

async function deleteStorageObjects(bucket: string, paths: string[]) {
  if (paths.length === 0) return;

  const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
  if (error) {
    throw new Error(`Failed to delete ${bucket} images: ${error.message}`);
  }
}

async function deleteUserStorageObjects(userId: string) {
  await Promise.all(
    USER_STORAGE_BUCKETS.map(async (bucket) => {
      const paths = await listStorageObjectPaths(bucket, userId);
      await deleteStorageObjects(bucket, paths);
    })
  );
}

async function deleteUserDatabaseRecords(userId: string) {
  const [dishLists, recipes] = await Promise.all([
    prisma.dishList.findMany({
      where: { ownerId: userId },
      select: { id: true },
    }),
    prisma.recipe.findMany({
      where: { creatorId: userId },
      select: { id: true },
    }),
  ]);

  const dishListIds = dishLists.map((dishList) => dishList.id);
  const recipeIds = recipes.map((recipe) => recipe.id);

  await prisma.$transaction([
    prisma.contentReport.deleteMany({
      where: {
        OR: [
          { reporterId: userId },
          { ownerId: userId },
          { targetType: "USER", targetId: userId },
          { targetType: "DISHLIST", targetId: { in: dishListIds } },
          { targetType: "RECIPE", targetId: { in: recipeIds } },
        ],
      },
    }),
    prisma.moderationReview.deleteMany({
      where: {
        OR: [
          { userId },
          { targetType: "USER", targetId: userId },
          { targetType: "DISHLIST", targetId: { in: dishListIds } },
          { targetType: "RECIPE", targetId: { in: recipeIds } },
        ],
      },
    }),
    prisma.user.deleteMany({
      where: { uid: userId },
    }),
  ]);
}

function isAuthUserNotFound(error: { message?: string; status?: number }) {
  return (
    error.status === 404 ||
    /user.*not found|not found.*user|does not exist/i.test(error.message || "")
  );
}

function isUniqueConstraintErrorForField(error: unknown, field: string) {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;
  return (
    (Array.isArray(target) && target.includes(field)) ||
    (typeof target === "string" && target.includes(field))
  );
}

async function deleteSupabaseAuthUser(userId: string) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);

  if (error && !isAuthUserNotFound(error)) {
    throw new Error(`Failed to delete Supabase Auth user: ${error.message}`);
  }
}

async function banSupabaseAuthUser(userId: string) {
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    ban_duration: "876000h",
  });

  if (error && !isAuthUserNotFound(error)) {
    throw new Error(`Failed to disable Supabase Auth user: ${error.message}`);
  }
}

// Register/Login - Create or update user in database
router.post("/register", authToken, async (req: AuthRequest, res) => {
  let shouldRollbackAuthUser = false;

  try {
    const userId = req.user!.uid;
    const email = req.user?.email?.trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Authenticated email is required" });
    }
    const existingUser = await prisma.user.findUnique({
      where: { uid: userId },
      select: { uid: true },
    });
    shouldRollbackAuthUser = !existingUser;
    const { username, firstName, lastName, bio } = validateProfileInput(
      req.body
    );

    await moderateTextFields(
      [
        { label: "Username", value: username },
        { label: "First name", value: firstName },
        { label: "Last name", value: lastName },
        { label: "Bio", value: bio },
      ],
      { targetType: "USER", targetId: userId, userId }
    );

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
      uid: userId,
      email,
      username: username || null,
      firstName: firstName || null,
      lastName: lastName || null,
      bio: bio || null,
    };

    // Keep profile and default-list creation atomic. If either fails for a
    // brand-new signup, the catch block also removes the Supabase auth user.
    const user = await prisma.$transaction(async (transaction) => {
      const registeredUser = await transaction.user.upsert({
        where: { uid: userId },
        update: updateData,
        create: createData,
      });

      const defaultDishList = await transaction.dishList.findFirst({
        where: {
          ownerId: registeredUser.uid,
          isDefault: true,
        },
      });

      if (!defaultDishList) {
        await transaction.dishList.create({
          data: {
            title: "My Recipes",
            ownerId: registeredUser.uid,
            isDefault: true,
            visibility: "PRIVATE",
          },
        });
      }

      return registeredUser;
    });

    res.json({ user });
  } catch (error) {
    if (shouldRollbackAuthUser && req.user?.uid) {
      try {
        await deleteSupabaseAuthUser(req.user.uid);
      } catch (rollbackError) {
        console.error("Registration rollback error:", rollbackError);
      }
    }

    if (handleModerationError(error, res)) return;

    if (error instanceof ProfileValidationError) {
      return res.status(400).json({
        error: error.message,
        code: "PROFILE_VALIDATION_ERROR",
        field: error.field,
      });
    }

    if (isUniqueConstraintErrorForField(error, "username")) {
      return res.status(409).json({
        error: "Username already taken",
        code: "USERNAME_TAKEN",
      });
    }

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
        _count: {
          select: {
            followers: {
              where: { status: "ACCEPTED", follower: { status: "ACTIVE" } },
            },
            following: {
              where: { status: "ACCEPTED", following: { status: "ACTIVE" } },
            },
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

// Sync the application profile after Supabase confirms an email change.
// The email comes from the verified JWT, never from the request body.
router.patch("/me", authToken, async (req: AuthRequest, res) => {
  try {
    const {
      data: { user: authUser },
      error: authError,
    } = await supabaseAdmin.auth.admin.getUserById(req.user!.uid);
    if (authError) throw authError;

    const email = authUser?.email?.trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Authenticated email is required" });
    }

    const user = await prisma.user.update({
      where: { uid: req.user!.uid },
      data: { email },
      include: {
        _count: {
          select: {
            followers: {
              where: { status: "ACCEPTED", follower: { status: "ACTIVE" } },
            },
            following: {
              where: { status: "ACCEPTED", following: { status: "ACTIVE" } },
            },
          },
        },
      },
    });

    res.json({ user });
  } catch (error) {
    console.error("Sync user email error:", error);
    res.status(500).json({ error: "Failed to sync email" });
  }
});

// Update current user's profile
router.put("/me", authToken, async (req: AuthRequest, res) => {
  try {
    const { username, firstName, lastName, bio, avatarUrl } =
      validateProfileInput(req.body, { allowAvatarUrl: true });
    const userId = req.user!.uid;

    await moderateTextFields(
      [
        { label: "Username", value: username },
        { label: "First name", value: firstName },
        { label: "Last name", value: lastName },
        { label: "Bio", value: bio },
      ],
      { targetType: "USER", targetId: userId, userId }
    );

    if (
      avatarUrl !== undefined &&
      avatarUrl !== null &&
      (!avatarUrl || !isAllowedAvatarUrl(avatarUrl))
    ) {
      return res.status(400).json({
        error: "Profile images must be uploaded through DishList.",
      });
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
      updateData.username = username;
    }
    if (firstName !== undefined) {
      updateData.firstName = firstName;
    }

    // Optional fields - can be set to null to clear
    if (lastName !== undefined) {
      updateData.lastName = lastName;
    }
    if (bio !== undefined) {
      updateData.bio = bio;
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
            followers: {
              where: { status: "ACCEPTED", follower: { status: "ACTIVE" } },
            },
            following: {
              where: { status: "ACCEPTED", following: { status: "ACTIVE" } },
            },
          },
        },
      },
    });

    res.json({ user: updatedUser });
  } catch (error) {
    if (handleModerationError(error, res)) return;

    if (error instanceof ProfileValidationError) {
      return res.status(400).json({
        error: error.message,
        code: "PROFILE_VALIDATION_ERROR",
        field: error.field,
      });
    }

    if (isUniqueConstraintErrorForField(error, "username")) {
      return res.status(409).json({
        error: "Username already taken",
        code: "USERNAME_TAKEN",
      });
    }

    console.error("Update user profile error:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// Delete current user's account and all associated data
router.delete("/me", authToken, async (req: AuthRequest, res) => {
  const userId = req.user!.uid;

  try {
    const deletion = await prisma.accountDeletion.upsert({
      where: { userId },
      create: { userId },
      update: { lastError: null },
    });

    if (deletion.completedAt) {
      return res.json({
        success: true,
        message: "Account deleted successfully",
      });
    }

    // The durable marker above immediately blocks every API route except this
    // idempotent retry. Banning the auth user also prevents new sessions while
    // storage, database, and Supabase cleanup complete.
    await banSupabaseAuthUser(userId);
    await deleteUserStorageObjects(userId);
    await deleteUserDatabaseRecords(userId);
    await deleteSupabaseAuthUser(userId);

    await prisma.accountDeletion.update({
      where: { userId },
      data: {
        completedAt: new Date(),
        lastError: null,
      },
    });

    res.json({ success: true, message: "Account deleted successfully" });
  } catch (error) {
    console.error("Delete account error:", error);
    await prisma.accountDeletion
      .upsert({
        where: { userId },
        create: {
          userId,
          lastError: error instanceof Error ? error.message : "Unknown error",
        },
        update: {
          lastError: error instanceof Error ? error.message : "Unknown error",
        },
      })
      .catch((markerError) =>
        console.error("Failed to record account deletion error:", markerError)
      );

    res.status(500).json({
      error:
        "Account deletion could not finish. Your account is locked; please retry.",
    });
  }
});

// Get user's mutuals (users you follow who also follow you back)
router.get("/mutuals", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { search } = req.query;
    const { blockedPeerIds } = await getBlockContext(userId);

    // Find users where:
    // 1. Current user follows them (they are in user's "following" list)
    // 2. They follow current user back (user is in their "following" list)
    const mutuals = await prisma.user.findMany({
      where: {
        AND: [
          {
            uid: { notIn: blockedPeerIds },
          },
          // I follow them
          {
            followers: {
              some: {
                followerId: userId,
                status: "ACCEPTED",
              },
            },
          },
          // They follow me
          {
            following: {
              some: {
                followingId: userId,
                status: "ACCEPTED",
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

// Block another user
router.post("/:id/block", authToken, async (req: AuthRequest, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user!.uid;

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    const targetUser = await prisma.user.findUnique({
      where: { uid: targetUserId },
      select: { uid: true },
    });

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.userBlock.upsert({
        where: {
          blockerId_blockedId: {
            blockerId: currentUserId,
            blockedId: targetUserId,
          },
        },
        update: {},
        create: {
          blockerId: currentUserId,
          blockedId: targetUserId,
        },
      });

      await tx.userFollow.deleteMany({
        where: {
          OR: [
            { followerId: currentUserId, followingId: targetUserId },
            { followerId: targetUserId, followingId: currentUserId },
          ],
        },
      });

      await tx.notification.deleteMany({
        where: {
          OR: [
            { senderId: currentUserId, receiverId: targetUserId },
            { senderId: targetUserId, receiverId: currentUserId },
          ],
          type: { in: ["FOLLOW_REQUEST", "DISHLIST_INVITATION"] },
        },
      });

      await tx.dishListInvite.deleteMany({
        where: {
          usedAt: null,
          OR: [
            { inviterId: currentUserId, inviteeId: targetUserId },
            { inviterId: targetUserId, inviteeId: currentUserId },
          ],
        },
      });
    });

    res.json({ success: true, blockStatus: "BLOCKED_BY_ME" });
  } catch (error) {
    console.error("Block user error:", error);
    res.status(500).json({ error: "Failed to block user" });
  }
});

// Unblock another user
router.delete("/:id/block", authToken, async (req: AuthRequest, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user!.uid;

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "Cannot unblock yourself" });
    }

    await prisma.userBlock.deleteMany({
      where: {
        blockerId: currentUserId,
        blockedId: targetUserId,
      },
    });

    res.json({ success: true, blockStatus: "NONE" });
  } catch (error) {
    console.error("Unblock user error:", error);
    res.status(500).json({ error: "Failed to unblock user" });
  }
});

// Get any user's profile by userId
router.get("/:userId", authToken, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user!.uid;
    const includeRecipes = req.query.includeRecipes === "true";
    const includeDishlists = req.query.includeDishlists !== "false";
    const recipesLimitRaw = Number(req.query.recipesLimit ?? 20);
    const recipesOffsetRaw = Number(req.query.recipesOffset ?? 0);
    const recipesLimit = Number.isFinite(recipesLimitRaw)
      ? Math.min(Math.max(recipesLimitRaw, 1), 100)
      : 20;
    const recipesOffset = Number.isFinite(recipesOffsetRaw)
      ? Math.max(recipesOffsetRaw, 0)
      : 0;

    const [user, blockStatus] = await Promise.all([
      prisma.user.findUnique({
        where: { uid: userId },
        include: {
          _count: {
            select: {
              followers: {
                where: { status: "ACCEPTED", follower: { status: "ACTIVE" } },
              },
              following: {
                where: { status: "ACCEPTED", following: { status: "ACTIVE" } },
              },
            },
          },
        },
      }),
      getBlockStatus(currentUserId, userId),
    ]);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (blockStatus !== "NONE") {
      return res.json({
        user: {
          uid: user.uid,
          followerCount: 0,
          followingCount: 0,
          isFollowing: false,
          isOwnProfile: false,
          followStatus: "NONE",
          blockStatus,
        },
        dishlists: [],
        recipes: [],
        recipesMeta: {
          included: includeRecipes,
          limit: recipesLimit,
          offset: recipesOffset,
          hasMore: false,
        },
        dishlistsMeta: {
          included: includeDishlists,
        },
      });
    }

    const dishListWhere =
      userId === currentUserId
        ? {
            OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
          }
        : {
            visibility: "PUBLIC" as const,
            OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
          };

    // Dishlists, recipes, and the follow relation are independent — fetch
    // them in one parallel wave. Recipes filter through the dishlist
    // relation directly, so no separate dishlist-ID lookup is needed.
    const [dishlists, recipes, followRelation] = await Promise.all([
      includeDishlists
        ? prisma.dishList.findMany({
            where: dishListWhere,
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
          })
        : [],
      includeRecipes
        ? prisma.recipe.findMany({
            where: {
              dishLists: {
                some: {
                  dishList: dishListWhere,
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
            skip: recipesOffset,
            take: recipesLimit,
          })
        : [],
      userId !== currentUserId
        ? prisma.userFollow.findUnique({
            where: {
              followerId_followingId: {
                followerId: currentUserId,
                followingId: userId,
              },
            },
          })
        : null,
    ]);

    // Check if current user is following this profile
    let followStatus: "NONE" | "PENDING" | "ACCEPTED" = "NONE";
    let isFollowing = false;

    if (followRelation) {
      followStatus = followRelation.status;
      isFollowing = followRelation.status === "ACCEPTED";
    }
    res.json({
      user: {
        uid: user.uid,
        ...(userId === currentUserId ? { email: user.email } : {}),
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
        blockStatus,
      },
      dishlists: includeDishlists
        ? dishlists.map((d) => ({
            id: d.id,
            title: d.title,
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
          }))
        : [],
      recipes,
      recipesMeta: {
        included: includeRecipes,
        limit: recipesLimit,
        offset: recipesOffset,
        hasMore: includeRecipes ? recipes.length === recipesLimit : false,
      },
      dishlistsMeta: {
        included: includeDishlists,
      },
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

    const [targetUser, isBlocked, existingFollow] = await Promise.all([
      prisma.user.findUnique({
        where: { uid: targetUserId },
      }),
      areUsersBlocked(currentUserId, targetUserId),
      prisma.userFollow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: targetUserId,
          },
        },
      }),
    ]);

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (isBlocked) {
      return res.status(403).json({ error: "Cannot follow this user" });
    }

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

    const [user, blockStatus] = await Promise.all([
      prisma.user.findUnique({
        where: { uid: userId },
        include: {
          ownedDishLists: {
            where: { isDefault: false },
            orderBy: { createdAt: "desc" },
          },
          _count: {
            select: {
              followers: {
                where: {
                  status: "ACCEPTED",
                  follower: { status: "ACTIVE" },
                },
              },
              following: {
                where: {
                  status: "ACCEPTED",
                  following: { status: "ACTIVE" },
                },
              },
            },
          },
        },
      }),
      getBlockStatus(currentUserId, userId),
    ]);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (blockStatus !== "NONE") {
      return res.json({
        uid: user.uid,
        followerCount: 0,
        followingCount: 0,
        isOwnProfile: false,
        isFollowing: false,
        followStatus: "NONE",
        blockStatus,
      });
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
      ...(isOwnProfile ? { email: user.email } : {}),
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
      blockStatus,
    });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// GET /:userId/followers - Get list of users who follow this user
router.get("/:userId/followers", authToken, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user!.uid;
    const limit = parsePageLimit(req.query.limit);
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor
        ? req.query.cursor
        : undefined;

    const [targetUser, blockContext] = await Promise.all([
      prisma.user.findUnique({
        where: { uid: userId },
      }),
      getBlockContext(currentUserId),
    ]);

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (blockContext.isBlocked(userId)) {
      return res.json({ users: [], nextCursor: null });
    }

    const followerPage = await prisma.userFollow.findMany({
      where: {
        followingId: userId,
        status: "ACCEPTED",
        followerId: { notIn: blockContext.blockedPeerIds },
        follower: { status: "ACTIVE" },
      },
      include: {
        follower: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = followerPage.length > limit;
    const followers = hasMore ? followerPage.slice(0, limit) : followerPage;

    // For each follower, check if current user follows them back
    const followerIds = followers.map((f) => f.followerId);

    // Get current user's follow relationships with these followers
    const currentUserFollows = await prisma.userFollow.findMany({
      where: {
        followerId: currentUserId,
        followingId: { in: followerIds },
      },
      select: {
        followingId: true,
        status: true,
      },
    });

    // Create a map for quick lookup
    const followStatusMap = new Map(
      currentUserFollows.map((f) => [f.followingId, f.status]),
    );

    // Transform data
    const result = followers.map((f) => ({
      uid: f.follower.uid,
      username: f.follower.username,
      firstName: f.follower.firstName,
      lastName: f.follower.lastName,
      avatarUrl: f.follower.avatarUrl,
      // What is current user's follow status toward this follower?
      followStatus: followStatusMap.get(f.followerId) || "NONE",
    }));

    res.json({
      users: result,
      nextCursor: hasMore ? followers[followers.length - 1]?.id ?? null : null,
    });
  } catch (error) {
    console.error("Get followers error:", error);
    res.status(500).json({ error: "Failed to fetch followers" });
  }
});

// GET /:userId/following - Get list of users this user follows
router.get("/:userId/following", authToken, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user!.uid;
    const limit = parsePageLimit(req.query.limit);
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor
        ? req.query.cursor
        : undefined;

    const [targetUser, blockContext] = await Promise.all([
      prisma.user.findUnique({
        where: { uid: userId },
      }),
      getBlockContext(currentUserId),
    ]);

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (blockContext.isBlocked(userId)) {
      return res.json({ users: [], nextCursor: null });
    }

    const followingPage = await prisma.userFollow.findMany({
      where: {
        followerId: userId,
        status: "ACCEPTED",
        followingId: { notIn: blockContext.blockedPeerIds },
        following: { status: "ACTIVE" },
      },
      include: {
        following: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [{ acceptedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = followingPage.length > limit;
    const following = hasMore ? followingPage.slice(0, limit) : followingPage;

    // Transform data
    const result = following.map((f) => ({
      uid: f.following.uid,
      username: f.following.username,
      firstName: f.following.firstName,
      lastName: f.following.lastName,
      avatarUrl: f.following.avatarUrl,
    }));

    res.json({
      users: result,
      nextCursor: hasMore ? following[following.length - 1]?.id ?? null : null,
    });
  } catch (error) {
    console.error("Get following error:", error);
    res.status(500).json({ error: "Failed to fetch following" });
  }
});

export default router;
