import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";

const router = Router();

const VALID_TARGET_TYPES = new Set(["USER", "DISHLIST", "RECIPE"]);
const VALID_REASONS = new Set(["INAPPROPRIATE", "HARASSMENT", "SPAM", "OTHER"]);

async function resolveOwnerId(targetType: string, targetId: string) {
  switch (targetType) {
    case "USER": {
      const user = await prisma.user.findUnique({
        where: { uid: targetId },
        select: { uid: true },
      });
      return user?.uid;
    }
    case "DISHLIST": {
      const dishList = await prisma.dishList.findUnique({
        where: { id: targetId },
        select: { ownerId: true },
      });
      return dishList?.ownerId;
    }
    case "RECIPE": {
      const recipe = await prisma.recipe.findUnique({
        where: { id: targetId },
        select: { creatorId: true },
      });
      return recipe?.creatorId;
    }
    default:
      return undefined;
  }
}

router.post("/", authToken, async (req: AuthRequest, res) => {
  try {
    const reporterId = req.user!.uid;
    const { targetType, targetId, reason = "INAPPROPRIATE", details } = req.body;

    if (!VALID_TARGET_TYPES.has(targetType)) {
      return res.status(400).json({ error: "Invalid report target" });
    }

    if (typeof targetId !== "string" || !targetId.trim()) {
      return res.status(400).json({ error: "Report target is required" });
    }

    if (!VALID_REASONS.has(reason)) {
      return res.status(400).json({ error: "Invalid report reason" });
    }

    const ownerId = await resolveOwnerId(targetType, targetId);
    if (!ownerId) {
      return res.status(404).json({ error: "Reported content not found" });
    }

    if (targetType === "USER" && targetId === reporterId) {
      return res.status(400).json({ error: "You cannot report yourself" });
    }

    if (ownerId === reporterId) {
      return res
        .status(400)
        .json({ error: "You cannot report your own content" });
    }

    const report = await prisma.contentReport.create({
      data: {
        targetType,
        targetId,
        reason,
        details:
          typeof details === "string" && details.trim()
            ? details.trim().slice(0, 1000)
            : null,
        reporterId,
        ownerId,
      },
    });

    res.status(201).json({ reportId: report.id, status: report.status });
  } catch (error) {
    console.error("Create report error:", error);
    res.status(500).json({ error: "Failed to submit report" });
  }
});

export default router;
