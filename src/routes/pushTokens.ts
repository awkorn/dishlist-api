import express from "express";
import { authToken, AuthRequest } from "../middleware/auth";
import prisma from "../lib/prisma";

const router = express.Router();

// POST /push-tokens - Register a push token for the current user
router.post("/", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { token } = req.body;

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Push token is required" });
    }

    // Upsert: if this user+token combo already exists, just return success
    await prisma.pushToken.upsert({
      where: { userId_token: { userId, token } },
      create: { userId, token },
      update: {}, // No-op if already exists
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
