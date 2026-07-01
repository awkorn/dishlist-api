import {
  ContentReportReason,
  ContentReportStatus,
  ModerationTargetType,
} from "@prisma/client";
import { Router } from "express";
import { adminPrisma } from "../lib/prisma";
import {
  isResolutionAllowed,
  type ResolutionDecision,
} from "../lib/moderationWorkflow";
import {
  authToken,
  AuthRequest,
  requireAdmin,
  requireModerator,
} from "../middleware/auth";

const router = Router();
const OPEN_STATUSES: ContentReportStatus[] = ["PENDING", "REVIEWED"];
const PAGE_SIZE = 50;

router.use(authToken, requireModerator);

function parseNote(value: unknown) {
  if (typeof value !== "string" || value.trim().length < 3) return null;
  return value.trim().slice(0, 2000);
}

async function getTarget(targetType: ModerationTargetType, targetId: string) {
  if (targetType === "USER") {
    return adminPrisma.user.findUnique({
      where: { uid: targetId },
      select: {
        uid: true,
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        avatarUrl: true,
        status: true,
        suspendedAt: true,
        createdAt: true,
      },
    });
  }
  if (targetType === "DISHLIST") {
    return adminPrisma.dishList.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        title: true,
        visibility: true,
        moderationState: true,
        ownerId: true,
        createdAt: true,
      },
    });
  }
  return adminPrisma.recipe.findUnique({
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
      moderationState: true,
      creatorId: true,
      createdAt: true,
    },
  });
}

router.get("/me", async (req: AuthRequest, res) => {
  const user = await adminPrisma.user.findUnique({
    where: { uid: req.user!.uid },
    select: {
      uid: true,
      email: true,
      username: true,
      firstName: true,
      lastName: true,
      role: true,
    },
  });
  return res.json({ user });
});

router.get("/reports/summary", async (_req, res) => {
  const [grouped, oldest] = await Promise.all([
    adminPrisma.contentReport.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    adminPrisma.contentReport.findFirst({
      where: { status: { in: OPEN_STATUSES } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { createdAt: true },
    }),
  ]);
  const counts = Object.fromEntries(
    grouped.map((entry) => [entry.status, entry._count._all])
  );
  return res.json({
    counts,
    openCount: (counts.PENDING || 0) + (counts.REVIEWED || 0),
    oldestOpenCreatedAt: oldest?.createdAt ?? null,
    slaHours: 24,
    warningHours: 18,
  });
});

router.get("/reports", async (req, res) => {
  const status = req.query.status as ContentReportStatus | undefined;
  const reason = req.query.reason as ContentReportReason | undefined;
  const targetType = req.query.targetType as ModerationTargetType | undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const requestedLimit = Number(req.query.limit || PAGE_SIZE);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : PAGE_SIZE;

  const validStatuses: ContentReportStatus[] = [
    "PENDING",
    "REVIEWED",
    "ACTIONED",
    "DISMISSED",
  ];
  const validReasons: ContentReportReason[] = [
    "INAPPROPRIATE",
    "HARASSMENT",
    "SPAM",
    "OTHER",
  ];
  const validTargetTypes: ModerationTargetType[] = ["USER", "DISHLIST", "RECIPE"];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid report status" });
  }
  if (reason && !validReasons.includes(reason)) {
    return res.status(400).json({ error: "Invalid report reason" });
  }
  if (targetType && !validTargetTypes.includes(targetType)) {
    return res.status(400).json({ error: "Invalid target type" });
  }

  const reports = await adminPrisma.contentReport.findMany({
    where: {
      ...(status ? { status } : { status: { in: OPEN_STATUSES } }),
      ...(reason ? { reason } : {}),
      ...(targetType ? { targetType } : {}),
    },
    include: {
      reporter: {
        select: {
          uid: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      assignedTo: {
        select: { uid: true, username: true, firstName: true, lastName: true },
      },
      _count: { select: { actions: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = reports.length > limit;
  const items = hasMore ? reports.slice(0, limit) : reports;
  return res.json({
    reports: items,
    nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
  });
});

router.get("/reports/:id", async (req, res) => {
  const report = await adminPrisma.contentReport.findUnique({
    where: { id: req.params.id },
    include: {
      reporter: {
        select: {
          uid: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      assignedTo: {
        select: { uid: true, username: true, firstName: true, lastName: true },
      },
      resolvedBy: {
        select: { uid: true, username: true, firstName: true, lastName: true },
      },
      actions: {
        include: {
          moderator: {
            select: { uid: true, username: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  const [target, relatedReports, automatedReviews] = await Promise.all([
    getTarget(report.targetType, report.targetId),
    adminPrisma.contentReport.findMany({
      where: {
        targetType: report.targetType,
        targetId: report.targetId,
        id: { not: report.id },
      },
      select: {
        id: true,
        reason: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    adminPrisma.moderationReview.findMany({
      where: { targetType: report.targetType, targetId: report.targetId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return res.json({
    report,
    target,
    relatedReports,
    automatedReviews,
    legacyEvidence: report.targetSnapshot === null,
  });
});

router.post("/reports/:id/claim", async (req: AuthRequest, res) => {
  const report = await adminPrisma.contentReport.findUnique({
    where: { id: req.params.id },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });
  if (!OPEN_STATUSES.includes(report.status)) {
    return res.status(409).json({ error: "Report is already resolved" });
  }
  if (
    report.assignedToId &&
    report.assignedToId !== req.user!.uid &&
    req.user!.role !== "ADMIN"
  ) {
    return res.status(409).json({ error: "Report is assigned to another moderator" });
  }

  const updated = await adminPrisma.$transaction(async (tx) => {
    const claimed = await tx.contentReport.update({
      where: { id: report.id },
      data: {
        status: "REVIEWED",
        assignedToId: req.user!.uid,
        reviewedAt: report.reviewedAt || new Date(),
      },
    });
    await tx.moderationAction.create({
      data: {
        targetType: report.targetType,
        targetId: report.targetId,
        action: "CLAIM",
        note: "Report claimed for review",
        reportId: report.id,
        moderatorId: req.user!.uid,
      },
    });
    return claimed;
  });
  return res.json({ report: updated });
});

router.post("/reports/:id/resolve", async (req: AuthRequest, res) => {
  const note = parseNote(req.body.note);
  const decision = req.body.decision as ResolutionDecision;
  if (!note) {
    return res.status(400).json({ error: "A resolution note is required" });
  }
  if (!["DISMISS", "HIDE_CONTENT", "SUSPEND_USER"].includes(decision)) {
    return res.status(400).json({ error: "Invalid resolution decision" });
  }

  const report = await adminPrisma.contentReport.findUnique({
    where: { id: req.params.id },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });
  if (!OPEN_STATUSES.includes(report.status)) {
    return res.status(409).json({ error: "Report is already resolved" });
  }
  if (
    report.assignedToId &&
    report.assignedToId !== req.user!.uid &&
    req.user!.role !== "ADMIN"
  ) {
    return res.status(409).json({ error: "Report is assigned to another moderator" });
  }
  if (!isResolutionAllowed(report.targetType, decision)) {
    return res.status(400).json({ error: "Decision is not valid for this target" });
  }

  const now = new Date();
  const resolved = await adminPrisma.$transaction(async (tx) => {
    if (decision === "DISMISS") {
      await tx.contentReport.update({
        where: { id: report.id },
        data: {
          status: "DISMISSED",
          dedupeKey: null,
          resolutionNote: note,
          resolvedAt: now,
          resolvedById: req.user!.uid,
        },
      });
      await tx.moderationAction.create({
        data: {
          targetType: report.targetType,
          targetId: report.targetId,
          action: "DISMISS_REPORT",
          note,
          reportId: report.id,
          moderatorId: req.user!.uid,
        },
      });
      await tx.notification.create({
        data: {
          type: "REPORT_RESOLVED",
          title: "Report reviewed",
          message: "Thanks for helping keep DishList safe. We reviewed your report.",
          receiverId: report.reporterId,
          data: JSON.stringify({ reportId: report.id, resolution: "REVIEWED" }),
        },
      });
      return { affectedReports: 1 };
    }

    if (report.targetType === "USER") {
      await tx.user.update({
        where: { uid: report.targetId },
        data: { status: "SUSPENDED", suspendedAt: now },
      });
    } else if (report.targetType === "DISHLIST") {
      await tx.dishList.update({
        where: { id: report.targetId },
        data: { moderationState: "HIDDEN" },
      });
    } else {
      await tx.recipe.update({
        where: { id: report.targetId },
        data: { moderationState: "HIDDEN" },
      });
    }

    const openReports = await tx.contentReport.findMany({
      where: {
        targetType: report.targetType,
        targetId: report.targetId,
        status: { in: OPEN_STATUSES },
      },
      select: { id: true, reporterId: true },
    });
    await tx.contentReport.updateMany({
      where: { id: { in: openReports.map((item) => item.id) } },
      data: {
        status: "ACTIONED",
        dedupeKey: null,
        resolutionNote: note,
        resolvedAt: now,
        resolvedById: req.user!.uid,
      },
    });
    await tx.moderationAction.create({
      data: {
        targetType: report.targetType,
        targetId: report.targetId,
        action: decision,
        note,
        reportId: report.id,
        moderatorId: req.user!.uid,
        metadata: { affectedReportIds: openReports.map((item) => item.id) },
      },
    });
    for (const reporterId of new Set(openReports.map((item) => item.reporterId))) {
      await tx.notification.create({
        data: {
          type: "REPORT_RESOLVED",
          title: "Report reviewed",
          message:
            "Thanks for helping keep DishList safe. We reviewed your report and took action.",
          receiverId: reporterId,
          data: JSON.stringify({ reportId: report.id, resolution: "ACTIONED" }),
        },
      });
    }
    return { affectedReports: openReports.length };
  });

  return res.json({ success: true, ...resolved });
});

router.post(
  "/targets/:targetType/:targetId/restore",
  requireAdmin,
  async (req: AuthRequest, res) => {
    const note = parseNote(req.body.note);
    const targetType = req.params.targetType as ModerationTargetType;
    const targetId = req.params.targetId;
    if (!note) {
      return res.status(400).json({ error: "A restoration note is required" });
    }
    if (!["USER", "DISHLIST", "RECIPE"].includes(targetType)) {
      return res.status(400).json({ error: "Invalid target type" });
    }

    await adminPrisma.$transaction(async (tx) => {
      if (targetType === "USER") {
        await tx.user.update({
          where: { uid: targetId },
          data: { status: "ACTIVE", suspendedAt: null },
        });
      } else if (targetType === "DISHLIST") {
        await tx.dishList.update({
          where: { id: targetId },
          data: { moderationState: "VISIBLE" },
        });
      } else {
        await tx.recipe.update({
          where: { id: targetId },
          data: { moderationState: "VISIBLE" },
        });
      }
      await tx.moderationAction.create({
        data: {
          targetType,
          targetId,
          action: targetType === "USER" ? "RESTORE_USER" : "RESTORE_CONTENT",
          note,
          moderatorId: req.user!.uid,
        },
      });
    });
    return res.json({ success: true });
  }
);

export default router;
