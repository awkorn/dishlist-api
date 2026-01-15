import express from "express";
import { authToken, AuthRequest } from "../middleware/auth";
import prisma from "../lib/prisma";

const router = express.Router();

// GET /notifications - Fetch all notifications for current user
router.get("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    const notifications = await prisma.notification.findMany({
      where: { receiverId: userId },
      include: {
        sender: {
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

    res.json({ notifications });
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// GET /notifications/unread-count - Get count of unread notifications
router.get("/unread-count", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    const count = await prisma.notification.count({
      where: {
        receiverId: userId,
        isRead: false,
      },
    });

    res.json({ count });
  } catch (error) {
    console.error("Get unread count error:", error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

// PATCH /notifications/:id/read - Mark single notification as read
router.patch("/:id/read", authToken, async (req: AuthRequest, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user!.uid;

    // Verify notification belongs to user
    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        receiverId: userId,
      },
    });

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    await prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Mark notification read error:", error);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

// PATCH /notifications/read-all - Mark all notifications as read
router.patch("/read-all", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    const result = await prisma.notification.updateMany({
      where: {
        receiverId: userId,
        isRead: false,
      },
      data: { isRead: true },
    });

    res.json({ success: true, updated: result.count });
  } catch (error) {
    console.error("Mark all read error:", error);
    res.status(500).json({ error: "Failed to mark notifications as read" });
  }
});

// DELETE /notifications/:id - Delete single notification
router.delete("/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user!.uid;

    // Verify notification belongs to user
    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        receiverId: userId,
      },
    });

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    await prisma.notification.delete({
      where: { id: notificationId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Delete notification error:", error);
    res.status(500).json({ error: "Failed to delete notification" });
  }
});

// DELETE /notifications - Delete all notifications (Clear All)
router.delete("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    const result = await prisma.notification.deleteMany({
      where: { receiverId: userId },
    });

    res.json({ success: true, deleted: result.count });
  } catch (error) {
    console.error("Clear all notifications error:", error);
    res.status(500).json({ error: "Failed to clear notifications" });
  }
});

// POST /notifications/:id/accept-invitation - Accept DishList collaboration invitation
router.post("/:id/accept-invitation", authToken, async (req: AuthRequest, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user!.uid;

    // Get the notification and verify it's an invitation for this user
    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        receiverId: userId,
        type: "DISHLIST_INVITATION",
      },
    });

    if (!notification) {
      return res.status(404).json({ error: "Invitation not found" });
    }

    // Parse the data to get dishListId
    const data = notification.data ? JSON.parse(notification.data) : null;
    if (!data?.dishListId) {
      return res.status(400).json({ error: "Invalid invitation data" });
    }

    const dishListId = data.dishListId;

    // Verify the DishList still exists
    const dishList = await prisma.dishList.findUnique({
      where: { id: dishListId },
    });

    if (!dishList) {
      // Delete the notification since the DishList no longer exists
      await prisma.notification.delete({ where: { id: notificationId } });
      return res.status(404).json({ error: "DishList no longer exists" });
    }

    // Check if user is already a collaborator
    const existingCollab = await prisma.dishListCollaborator.findUnique({
      where: {
        dishListId_userId: {
          dishListId,
          userId,
        },
      },
    });

    if (existingCollab) {
      // Already a collaborator, just delete the notification
      await prisma.notification.delete({ where: { id: notificationId } });
      return res.json({ success: true, message: "Already a collaborator" });
    }

    // Add user as collaborator and delete the notification in a transaction
    await prisma.$transaction(async (tx) => {
      // Add as collaborator
      await tx.dishListCollaborator.create({
        data: {
          dishListId,
          userId,
        },
      });

      // Delete the invitation notification
      await tx.notification.delete({
        where: { id: notificationId },
      });

      // Send notification to the inviter that invitation was accepted
      if (notification.senderId) {
        const acceptingUser = await tx.user.findUnique({
          where: { uid: userId },
          select: { username: true, firstName: true },
        });

        const accepterName = acceptingUser?.firstName || acceptingUser?.username || "Someone";

        await tx.notification.create({
          data: {
            type: "COLLABORATION_ACCEPTED",
            title: `${accepterName} accepted your invitation`,
            message: dishList.title,
            senderId: userId,
            receiverId: notification.senderId,
            data: JSON.stringify({
              dishListId,
              dishListTitle: dishList.title,
              userId,
              userName: accepterName,
            }),
          },
        });
      }
    });

    res.json({ success: true, dishListId });
  } catch (error) {
    console.error("Accept invitation error:", error);
    res.status(500).json({ error: "Failed to accept invitation" });
  }
});

// POST /notifications/:id/decline-invitation - Decline DishList collaboration invitation
router.post("/:id/decline-invitation", authToken, async (req: AuthRequest, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user!.uid;

    // Get the notification and verify it's an invitation for this user
    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        receiverId: userId,
        type: "DISHLIST_INVITATION",
      },
    });

    if (!notification) {
      return res.status(404).json({ error: "Invitation not found" });
    }

    // Simply delete the notification (no need to notify the sender for declines)
    await prisma.notification.delete({
      where: { id: notificationId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Decline invitation error:", error);
    res.status(500).json({ error: "Failed to decline invitation" });
  }
});

// POST /notifications/:id/accept-follow - Accept follow request
router.post("/:id/accept-follow", authToken, async (req: AuthRequest, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user!.uid;

    // Get the notification and verify it's a follow request for this user
    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        receiverId: userId,
        type: "FOLLOW_REQUEST",
      },
    });

    if (!notification) {
      return res.status(404).json({ error: "Follow request not found" });
    }

    const requesterId = notification.senderId;
    if (!requesterId) {
      return res.status(400).json({ error: "Invalid follow request" });
    }

    // Find the pending follow relationship
    const followRelation = await prisma.userFollow.findUnique({
      where: {
        followerId_followingId: {
          followerId: requesterId,
          followingId: userId,
        },
      },
    });

    if (!followRelation) {
      // Follow request was cancelled
      await prisma.notification.delete({ where: { id: notificationId } });
      return res.status(404).json({ error: "Follow request no longer exists" });
    }

    if (followRelation.status === "ACCEPTED") {
      return res.status(400).json({ error: "Already following" });
    }

    // Get accepting user info for notification
    const acceptingUser = await prisma.user.findUnique({
      where: { uid: userId },
      select: { username: true, firstName: true, avatarUrl: true },
    });

    const accepterName = acceptingUser?.firstName || acceptingUser?.username || "Someone";

    // Update follow to accepted and send notification
    await prisma.$transaction(async (tx) => {
      // Update follow status
      await tx.userFollow.update({
        where: { id: followRelation.id },
        data: {
          status: "ACCEPTED",
          acceptedAt: new Date(),
        },
      });

      // Delete the follow request notification
      await tx.notification.delete({
        where: { id: notificationId },
      });

      // Send acceptance notification to requester
      await tx.notification.create({
        data: {
          type: "FOLLOW_ACCEPTED",
          title: `${accepterName} accepted your follow request`,
          message: "You are now following them",
          senderId: userId,
          receiverId: requesterId,
          data: JSON.stringify({
            userId,
            userName: accepterName,
            avatarUrl: acceptingUser?.avatarUrl || null,
          }),
        },
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Accept follow error:", error);
    res.status(500).json({ error: "Failed to accept follow request" });
  }
});

// POST /notifications/:id/decline-follow - Decline follow request (silent)
router.post("/:id/decline-follow", authToken, async (req: AuthRequest, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user!.uid;

    // Get the notification and verify it's a follow request for this user
    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        receiverId: userId,
        type: "FOLLOW_REQUEST",
      },
    });

    if (!notification) {
      return res.status(404).json({ error: "Follow request not found" });
    }

    const requesterId = notification.senderId;

    // Delete both the follow relationship and notification silently
    await prisma.$transaction(async (tx) => {
      // Delete pending follow relationship if exists
      if (requesterId) {
        await tx.userFollow.deleteMany({
          where: {
            followerId: requesterId,
            followingId: userId,
            status: "PENDING",
          },
        });
      }

      // Delete the notification
      await tx.notification.delete({
        where: { id: notificationId },
      });
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Decline follow error:", error);
    res.status(500).json({ error: "Failed to decline follow request" });
  }
});

// UPDATE: Get notifications - include sender avatar
router.get("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    const notifications = await prisma.notification.findMany({
      where: { receiverId: userId },
      include: {
        sender: {
          select: {
            uid: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true, // Include avatar
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({ notifications });
  } catch (error) {
    console.error("Get notifications error:", error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

export default router;