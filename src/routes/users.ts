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

export default router;