import { Prisma } from "@prisma/client";
import { Router } from "express";
import prisma, { adminPrisma } from "../lib/prisma";
import { buildReportDedupeKey } from "../lib/moderationWorkflow";
import { authToken, AuthRequest } from "../middleware/auth";

const router = Router();

const VALID_TARGET_TYPES = new Set(["USER", "DISHLIST", "RECIPE"]);
const VALID_REASONS = new Set(["INAPPROPRIATE", "HARASSMENT", "SPAM", "OTHER"]);

async function resolveReportTarget(targetType: string, targetId: string) {
  switch (targetType) {
    case "USER": {
      const user = await prisma.user.findUnique({
        where: { uid: targetId },
        select: {
          uid: true,
          username: true,
          firstName: true,
          lastName: true,
          bio: true,
          avatarUrl: true,
        },
      });
      return user
        ? { ownerId: user.uid, snapshot: { type: "USER", ...user } }
        : null;
    }
    case "DISHLIST": {
      const dishList = await prisma.dishList.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          title: true,
          visibility: true,
          ownerId: true,
          createdAt: true,
        },
      });
      return dishList
        ? {
            ownerId: dishList.ownerId,
            snapshot: { type: "DISHLIST", ...dishList },
          }
        : null;
    }
    case "RECIPE": {
      const recipe = await prisma.recipe.findUnique({
        where: { id: targetId },
        select: {
          id: true,
          title: true,
          description: true,
          ingredients: true,
          instructions: true,
          tags: true,
          imageUrl: true,
          imageUrls: true,
          creatorId: true,
          createdAt: true,
        },
      });
      return recipe
        ? {
            ownerId: recipe.creatorId,
            snapshot: { type: "RECIPE", ...recipe },
          }
        : null;
    }
    default:
      return null;
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

    const target = await resolveReportTarget(targetType, targetId);
    if (!target) {
      return res.status(404).json({ error: "Reported content not found" });
    }
    if (target.ownerId === reporterId) {
      return res.status(400).json({ error: "You cannot report your own content" });
    }

    const dedupeKey = buildReportDedupeKey(reporterId, targetType, targetId);
    const existing = await adminPrisma.contentReport.findUnique({
      where: { dedupeKey },
      select: { id: true, status: true },
    });
    if (existing) {
      return res.json({
        reportId: existing.id,
        status: existing.status,
        duplicate: true,
      });
    }

    try {
      const report = await adminPrisma.contentReport.create({
        data: {
          targetType,
          targetId,
          reason,
          details:
            typeof details === "string" && details.trim()
              ? details.trim().slice(0, 1000)
              : null,
          dedupeKey,
          targetSnapshot: target.snapshot as Prisma.InputJsonValue,
          reporterId,
          ownerId: target.ownerId,
        },
      });

      return res.status(201).json({
        reportId: report.id,
        status: report.status,
        duplicate: false,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const concurrent = await adminPrisma.contentReport.findUniqueOrThrow({
          where: { dedupeKey },
          select: { id: true, status: true },
        });
        return res.json({
          reportId: concurrent.id,
          status: concurrent.status,
          duplicate: true,
        });
      }
      throw error;
    }
  } catch (error) {
    console.error("Create report error:", error);
    return res.status(500).json({ error: "Failed to submit report" });
  }
});

export default router;
