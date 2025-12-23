import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, optionalAuthToken, AuthRequest } from "../middleware/auth";

const router = Router();

// Constants
const INVITE_EXPIRY_DAYS = 7;
const MAX_COLLABORATORS = 100;

// Helper: Calculate expiry date
const getExpiryDate = () => {
  const date = new Date();
  date.setDate(date.getDate() + INVITE_EXPIRY_DAYS);
  return date;
};

// Helper: Get display name
const getDisplayName = (user: { firstName?: string | null; username?: string | null }) => {
  return user.firstName || user.username || "Someone";
};

// ============================================
// POST /invites/dishlist/:id/send
// Send invite to mutual(s) - creates notification + invite record
// ============================================
router.post("/dishlist/:id/send", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;
    const { recipientIds } = req.body;

    // Validate recipientIds
    if (!recipientIds || !Array.isArray(recipientIds) || recipientIds.length === 0) {
      return res.status(400).json({ error: "At least one recipient is required" });
    }

    // Get the DishList and verify ownership
    const dishList = await prisma.dishList.findUnique({
      where: { id: dishListId },
      include: {
        _count: {
          select: { collaborators: true },
        },
      },
    });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    if (dishList.ownerId !== userId) {
      return res.status(403).json({ error: "Only the owner can invite collaborators" });
    }

    // Check collaborator limit
    if (dishList._count.collaborators + recipientIds.length > MAX_COLLABORATORS) {
      return res.status(400).json({
        error: `Cannot exceed ${MAX_COLLABORATORS} collaborators per DishList`,
      });
    }

    // Get sender info
    const sender = await prisma.user.findUnique({
      where: { uid: userId },
      select: { uid: true, username: true, firstName: true, lastName: true },
    });

    if (!sender) {
      return res.status(404).json({ error: "Sender not found" });
    }

    const senderName = getDisplayName(sender);
    const expiresAt = getExpiryDate();

    // Process each recipient
    const results = {
      invited: 0,
      alreadyCollaborator: 0,
      resent: 0,
    };

    for (const recipientId of recipientIds) {
      // Skip if trying to invite yourself
      if (recipientId === userId) continue;

      // Check if already a collaborator
      const existingCollab = await prisma.dishListCollaborator.findUnique({
        where: {
          dishListId_userId: { dishListId, userId: recipientId },
        },
      });

      if (existingCollab) {
        results.alreadyCollaborator++;
        continue;
      }

      // Check for existing pending invite
      const existingInvite = await prisma.dishListInvite.findFirst({
        where: {
          dishListId,
          inviteeId: recipientId,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      if (existingInvite) {
        // Resend: Delete old notification and create new one
        await prisma.notification.deleteMany({
          where: {
            type: "DISHLIST_INVITATION",
            receiverId: recipientId,
            senderId: userId,
            data: { contains: dishListId },
          },
        });

        // Update invite expiry
        await prisma.dishListInvite.update({
          where: { id: existingInvite.id },
          data: { expiresAt },
        });

        // Create fresh notification
        await prisma.notification.create({
          data: {
            type: "DISHLIST_INVITATION",
            title: `${senderName} invited you to collaborate`,
            message: dishList.title,
            senderId: userId,
            receiverId: recipientId,
            data: JSON.stringify({
              dishListId: dishList.id,
              dishListTitle: dishList.title,
              inviteId: existingInvite.id,
              senderId: userId,
              senderName,
            }),
          },
        });

        results.resent++;
      } else {
        // Create new invite + notification in transaction
        await prisma.$transaction(async (tx) => {
          const invite = await tx.dishListInvite.create({
            data: {
              dishListId,
              inviterId: userId,
              inviteeId: recipientId,
              expiresAt,
            },
          });

          await tx.notification.create({
            data: {
              type: "DISHLIST_INVITATION",
              title: `${senderName} invited you to collaborate`,
              message: dishList.title,
              senderId: userId,
              receiverId: recipientId,
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

        results.invited++;
      }
    }

    res.json({
      success: true,
      invited: results.invited,
      resent: results.resent,
      alreadyCollaborator: results.alreadyCollaborator,
    });
  } catch (error) {
    console.error("Send invite error:", error);
    res.status(500).json({ error: "Failed to send invite" });
  }
});

// ============================================
// POST /invites/dishlist/:id/link
// Generate a shareable invite link (owner only)
// ============================================
router.post("/dishlist/:id/link", authToken, async (req: AuthRequest, res) => {
  try {
    const dishListId = req.params.id;
    const userId = req.user!.uid;

    // Verify ownership
    const dishList = await prisma.dishList.findUnique({
      where: { id: dishListId },
    });

    if (!dishList) {
      return res.status(404).json({ error: "DishList not found" });
    }

    if (dishList.ownerId !== userId) {
      return res.status(403).json({ error: "Only the owner can generate invite links" });
    }

    // Create a link invite (no inviteeId - anyone can use)
    const invite = await prisma.dishListInvite.create({
      data: {
        dishListId,
        inviterId: userId,
        inviteeId: null, // Open invite
        expiresAt: getExpiryDate(),
      },
    });

    res.json({
      success: true,
      token: invite.token,
      link: `dishlist://invite/${invite.token}`,
      expiresAt: invite.expiresAt,
    });
  } catch (error) {
    console.error("Generate invite link error:", error);
    res.status(500).json({ error: "Failed to generate invite link" });
  }
});

// ============================================
// POST /invites/:token/validate
// Validate invite token (for landing screen)
// Returns invite details without accepting
// ============================================
router.post("/:token/validate", optionalAuthToken, async (req: AuthRequest, res) => {
  try {
    const { token } = req.params;
    const userId = req.user?.uid; // May be undefined if not logged in

    const invite = await prisma.dishListInvite.findUnique({
      where: { token },
      include: {
        dishList: {
          select: {
            id: true,
            title: true,
            description: true,
            visibility: true,
          },
        },
        inviter: {
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

    if (!invite) {
      return res.status(404).json({ error: "Invite not found", code: "NOT_FOUND" });
    }

    // Check if expired
    if (invite.expiresAt < new Date()) {
      return res.status(410).json({ error: "Invite has expired", code: "EXPIRED" });
    }

    // Check if already used
    if (invite.usedAt) {
      return res.status(410).json({ error: "Invite has already been used", code: "ALREADY_USED" });
    }

    // Check if invite is for specific user
    if (invite.inviteeId && invite.inviteeId !== userId) {
      return res.status(403).json({
        error: "This invite is for another user",
        code: "WRONG_USER",
      });
    }

    // Check if user is already a collaborator
    let isAlreadyCollaborator = false;
    let isOwner = false;

    if (userId) {
      isOwner = invite.dishList.id === userId;

      const existingCollab = await prisma.dishListCollaborator.findUnique({
        where: {
          dishListId_userId: {
            dishListId: invite.dishListId,
            userId,
          },
        },
      });
      isAlreadyCollaborator = !!existingCollab;
    }

    res.json({
      valid: true,
      requiresAuth: !userId,
      isAlreadyCollaborator,
      isOwner,
      invite: {
        token: invite.token,
        expiresAt: invite.expiresAt,
        dishList: invite.dishList,
        inviter: {
          ...invite.inviter,
          displayName: getDisplayName(invite.inviter),
        },
      },
    });
  } catch (error) {
    console.error("Validate invite error:", error);
    res.status(500).json({ error: "Failed to validate invite" });
  }
});

// ============================================
// POST /invites/:token/accept
// Accept invite via token (requires auth)
// ============================================
router.post("/:token/accept", authToken, async (req: AuthRequest, res) => {
  try {
    const { token } = req.params;
    const userId = req.user!.uid;

    const invite = await prisma.dishListInvite.findUnique({
      where: { token },
      include: {
        dishList: true,
        inviter: {
          select: { uid: true, username: true, firstName: true },
        },
      },
    });

    if (!invite) {
      return res.status(404).json({ error: "Invite not found", code: "NOT_FOUND" });
    }

    // Validations
    if (invite.expiresAt < new Date()) {
      return res.status(410).json({ error: "Invite has expired", code: "EXPIRED" });
    }

    if (invite.usedAt) {
      return res.status(410).json({ error: "Invite has already been used", code: "ALREADY_USED" });
    }

    if (invite.inviteeId && invite.inviteeId !== userId) {
      return res.status(403).json({ error: "This invite is for another user", code: "WRONG_USER" });
    }

    if (invite.dishList.ownerId === userId) {
      return res.status(400).json({ error: "You cannot collaborate on your own DishList", code: "IS_OWNER" });
    }

    // Check if already collaborator
    const existingCollab = await prisma.dishListCollaborator.findUnique({
      where: {
        dishListId_userId: {
          dishListId: invite.dishListId,
          userId,
        },
      },
    });

    if (existingCollab) {
      // Mark invite as used anyway
      await prisma.dishListInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date() },
      });
      return res.json({
        success: true,
        message: "Already a collaborator",
        dishListId: invite.dishListId,
      });
    }

    // Check collaborator limit
    const collabCount = await prisma.dishListCollaborator.count({
      where: { dishListId: invite.dishListId },
    });

    if (collabCount >= MAX_COLLABORATORS) {
      return res.status(400).json({
        error: "This DishList has reached its collaborator limit",
        code: "LIMIT_REACHED",
      });
    }

    // Accept invite in transaction
    const acceptingUser = await prisma.user.findUnique({
      where: { uid: userId },
      select: { username: true, firstName: true },
    });

    const accepterName = getDisplayName(acceptingUser || {});

    await prisma.$transaction(async (tx) => {
      // Add as collaborator
      await tx.dishListCollaborator.create({
        data: {
          dishListId: invite.dishListId,
          userId,
        },
      });

      // Mark invite as used
      await tx.dishListInvite.update({
        where: { id: invite.id },
        data: { usedAt: new Date() },
      });

      // Delete any pending notification for this user
      await tx.notification.deleteMany({
        where: {
          type: "DISHLIST_INVITATION",
          receiverId: userId,
          data: { contains: invite.dishListId },
        },
      });

      // Notify the inviter
      await tx.notification.create({
        data: {
          type: "COLLABORATION_ACCEPTED",
          title: `${accepterName} accepted your invitation`,
          message: invite.dishList.title,
          senderId: userId,
          receiverId: invite.inviterId,
          data: JSON.stringify({
            dishListId: invite.dishListId,
            dishListTitle: invite.dishList.title,
            userId,
            userName: accepterName,
          }),
        },
      });
    });

    res.json({
      success: true,
      dishListId: invite.dishListId,
      dishListTitle: invite.dishList.title,
    });
  } catch (error) {
    console.error("Accept invite error:", error);
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

// ============================================
// POST /invites/:token/decline
// Decline invite via token (requires auth)
// ============================================
router.post("/:token/decline", authToken, async (req: AuthRequest, res) => {
  try {
    const { token } = req.params;
    const userId = req.user!.uid;

    const invite = await prisma.dishListInvite.findUnique({
      where: { token },
    });

    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    // If invite is for specific user, verify it's them
    if (invite.inviteeId && invite.inviteeId !== userId) {
      return res.status(403).json({ error: "This invite is for another user" });
    }

    // Delete the invite and any related notification
    await prisma.$transaction(async (tx) => {
      // Only delete if it's a direct invite (has inviteeId)
      if (invite.inviteeId) {
        await tx.dishListInvite.delete({
          where: { id: invite.id },
        });
      }

      // Delete notification
      await tx.notification.deleteMany({
        where: {
          type: "DISHLIST_INVITATION",
          receiverId: userId,
          data: { contains: invite.dishListId },
        },
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Decline invite error:", error);
    res.status(500).json({ error: "Failed to decline invite" });
  }
});

export default router;