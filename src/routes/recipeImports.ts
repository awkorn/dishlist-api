import { Router } from "express";
import prisma from "../lib/prisma";
import { logSocialImportEvent } from "../lib/socialImport/metrics";
import {
  canonicalizeSocialUrl,
  detectPlatform,
  extractPlatformPostId,
  extractUrls,
} from "../lib/socialImport/urlUtils";
import { authToken, type AuthRequest } from "../middleware/auth";
import {
  socialImportDailyLimiter,
  socialImportLimiter,
} from "../middleware/rateLimit";

const router = Router();
const DAILY_NEW_IMPORT_LIMIT = 15;
const TERMINAL = ["COMPLETED", "REVIEW_REQUIRED", "FAILED", "CANCELLED"];

function runLimiter(limiter: any, req: any, res: any): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
    res.once("finish", finish);
    const next = (error?: unknown) => {
      if (settled) return;
      settled = true;
      res.off("finish", finish);
      if (error) reject(error);
      else resolve(true);
    };
    try {
      void Promise.resolve(limiter(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  });
}

async function consumeImportQuota(req: AuthRequest, res: any): Promise<boolean> {
  if (!(await runLimiter(socialImportLimiter, req, res))) return false;
  return runLimiter(socialImportDailyLimiter, req, res);
}

const importResponse = (record: any) => ({
  importId: record.id,
  status: record.status,
  phase: record.phase,
  attempt: record.attempt,
  errorCode: record.errorCode,
  errorMessage: record.errorMessage,
  warnings: record.warnings ?? [],
  confidence: record.confidence,
  extractionSource: record.extractionSource,
  recipeId: record.recipeId,
  recipeTitle: record.recipe?.title ?? null,
  sourceUrl: record.sourceUrl,
  platform: record.platform,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  presentedAt: record.presentedAt,
  alreadySaved: Boolean(
    record.recipeId &&
      (record.status === "COMPLETED" || record.status === "REVIEW_REQUIRED")
  ),
});

async function findExisting(
  userId: string,
  platform: any,
  canonicalUrl: string,
  platformPostId: string | null
) {
  return prisma.recipeImport.findFirst({
    where: {
      userId,
      OR: [
        { canonicalUrl },
        ...(platformPostId ? [{ platform, platformPostId }] : []),
      ],
    },
    include: { recipe: { select: { title: true } } },
  });
}

router.post(
  "/import-from-social",
  authToken,
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      if (typeof req.body?.url !== "string" || !req.body.url.trim()) {
        return res.status(400).json({ error: "A URL is required", code: "MISSING_URL" });
      }

      const url = extractUrls(req.body.url.trim()).find(detectPlatform);
      if (!url) {
        return res.status(400).json({
          error: "Share a TikTok, Instagram, Facebook, YouTube, or Pinterest post.",
          code: "UNSUPPORTED_URL",
        });
      }
      const platform = detectPlatform(url)!;
      const canonicalUrl = canonicalizeSocialUrl(url);
      const platformPostId = extractPlatformPostId(url, platform);
      const existing = await findExisting(
        userId,
        platform,
        canonicalUrl,
        platformPostId
      );

      if (existing) {
        if (existing.status === "PENDING" || existing.status === "PROCESSING") {
          return res.status(202).json(importResponse(existing));
        }
        if (
          (existing.status === "COMPLETED" ||
            existing.status === "REVIEW_REQUIRED") &&
          existing.recipeId
        ) {
          return res.status(200).json(importResponse(existing));
        }
        if (!(await consumeImportQuota(req, res))) return;
        const reset = await prisma.recipeImport.update({
          where: { id: existing.id },
          data: {
            status: "PENDING",
            phase: "QUEUED",
            sourceUrl: url,
            platformPostId,
            attempt: 0,
            nextAttemptAt: new Date(),
            cancelRequestedAt: null,
            startedAt: null,
            finishedAt: null,
            presentedAt: null,
            errorCode: null,
            errorMessage: null,
            warnings: [],
            confidence: null,
            recipeId: null,
          },
          include: { recipe: { select: { title: true } } },
        });
        logSocialImportEvent("manually_requeued", { importId: reset.id, platform });
        return res.status(202).json(importResponse(reset));
      }

      if (!(await consumeImportQuota(req, res))) return;

      const recentNewImports = await prisma.recipeImport.count({
        where: {
          userId,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (recentNewImports >= DAILY_NEW_IMPORT_LIMIT) {
        return res.status(429).json({
          error: "Daily import limit reached. Please try again tomorrow.",
          code: "DAILY_LIMIT",
          retryAfterSeconds: 24 * 60 * 60,
        });
      }

      let created;
      try {
        created = await prisma.recipeImport.create({
          data: {
            userId,
            sourceUrl: url,
            canonicalUrl,
            platformPostId,
            platform,
          },
          include: { recipe: { select: { title: true } } },
        });
      } catch (error) {
        if ((error as { code?: string })?.code !== "P2002") throw error;
        const raced = await findExisting(
          userId,
          platform,
          canonicalUrl,
          platformPostId
        );
        if (!raced) throw error;
        return res
          .status(raced.recipeId ? 200 : 202)
          .json(importResponse(raced));
      }

      logSocialImportEvent("accepted", { importId: created.id, platform });
      return res.status(202).json(importResponse(created));
    } catch (error) {
      console.error("Import from social error:", error);
      return res.status(500).json({
        error: "Failed to start import",
        code: "INTERNAL",
      });
    }
  }
);

router.get("/imports", authToken, async (req: AuthRequest, res) => {
  try {
    const statusFilter =
      typeof req.query.status === "string"
        ? req.query.status.split(",").filter((status) =>
            ["PENDING", "PROCESSING", ...TERMINAL].includes(status)
          )
        : [];
    const records = await prisma.recipeImport.findMany({
      where: {
        userId: req.user!.uid,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        ...(req.query.unpresented === "true" ? { presentedAt: null } : {}),
        ...(statusFilter.length ? { status: { in: statusFilter as any } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { recipe: { select: { title: true } } },
    });
    return res.json({ imports: records.map(importResponse) });
  } catch (error) {
    console.error("List imports error:", error);
    return res.status(500).json({ error: "Failed to list imports" });
  }
});

router.get("/imports/:id", authToken, async (req: AuthRequest, res) => {
  const record = await prisma.recipeImport.findFirst({
    where: { id: req.params.id, userId: req.user!.uid },
    include: { recipe: { select: { title: true } } },
  });
  if (!record) return res.status(404).json({ error: "Import not found" });
  return res.json(importResponse(record));
});

router.patch("/imports/:id/presented", authToken, async (req: AuthRequest, res) => {
  const updated = await prisma.recipeImport.updateMany({
    where: { id: req.params.id, userId: req.user!.uid, status: { in: TERMINAL as any } },
    data: { presentedAt: new Date() },
  });
  if (updated.count === 0) return res.status(404).json({ error: "Terminal import not found" });
  return res.status(204).send();
});

router.post("/imports/:id/retry", authToken, socialImportLimiter, socialImportDailyLimiter, async (req: AuthRequest, res) => {
  const existing = await prisma.recipeImport.findFirst({
    where: { id: req.params.id, userId: req.user!.uid },
  });
  if (!existing) return res.status(404).json({ error: "Import not found" });
  if (existing.status !== "FAILED" && existing.status !== "CANCELLED") {
    return res.status(409).json({ error: "Only failed or cancelled imports can be retried" });
  }
  const record = await prisma.recipeImport.update({
    where: { id: existing.id },
    data: {
      status: "PENDING",
      phase: "QUEUED",
      attempt: 0,
      nextAttemptAt: new Date(),
      cancelRequestedAt: null,
      finishedAt: null,
      presentedAt: null,
      errorCode: null,
      errorMessage: null,
    },
    include: { recipe: { select: { title: true } } },
  });
  return res.status(202).json(importResponse(record));
});

router.post("/imports/:id/cancel", authToken, async (req: AuthRequest, res) => {
  const existing = await prisma.recipeImport.findFirst({
    where: { id: req.params.id, userId: req.user!.uid },
  });
  if (!existing) return res.status(404).json({ error: "Import not found" });
  if (existing.status === "PENDING") {
    await prisma.recipeImport.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", phase: "CANCELLED", finishedAt: new Date() },
    });
  } else if (existing.status === "PROCESSING") {
    await prisma.recipeImport.update({
      where: { id: existing.id },
      data: { cancelRequestedAt: new Date(), phase: "CANCELLING" },
    });
  } else {
    return res.status(409).json({ error: "Import is already finished" });
  }
  return res.status(202).json({ importId: existing.id, status: "CANCELLED" });
});

export default router;
