import express from "express";
import { authToken, AuthRequest } from "../middleware/auth";
import { pushTokenLimiter } from "../middleware/rateLimit";
import prisma from "../lib/prisma";
import {
  validateExpoPushToken,
  MAX_PUSH_TOKENS_PER_USER,
} from "../lib/notificationHelpers";

const router = express.Router();

// POST /push-tokens - Register a push token for the current user
router.post("/", authToken, pushTokenLimiter, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const token = validateExpoPushToken(req.body?.token);

    if (!token) {
      return res.status(400).json({ error: "A valid Expo push token is required" });
    }

    // Upsert, then evict the oldest tokens beyond the per-user cap so the
    // table can't grow unbounded for one account.
    await prisma.$transaction(async (tx) => {
      await tx.pushToken.upsert({
        where: { userId_token: { userId, token } },
        create: { userId, token },
        update: {}, // No-op if already exists
      });

      const count = await tx.pushToken.count({ where: { userId } });
      if (count > MAX_PUSH_TOKENS_PER_USER) {
        const excess = await tx.pushToken.findMany({
          where: { userId },
          orderBy: { createdAt: "asc" },
          take: count - MAX_PUSH_TOKENS_PER_USER,
          select: { id: true },
        });
        await tx.pushToken.deleteMany({
          where: { id: { in: excess.map((t) => t.id) } },
        });
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Register push token error:", error);
    res.status(500).json({ error: "Failed to register push token" });
  }
});

// DELETE /push-tokens - Unregister a push token
router.delete("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { token } = req.body;

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Push token is required" });
    }

    await prisma.pushToken.deleteMany({
      where: { userId, token },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Unregister push token error:", error);
    res.status(500).json({ error: "Failed to unregister push token" });
  }
});

export default router;
