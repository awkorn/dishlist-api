// Social-media recipe import endpoints. Mounted at /recipes BEFORE the main
// recipe router (see app.ts) so /recipes/imports/* is matched here rather than
// swallowed by recipe.ts's GET /:id.

import { Router } from "express";
import prisma from "../lib/prisma";
import { authToken, AuthRequest } from "../middleware/auth";
import {
  socialImportLimiter,
  socialImportDailyLimiter,
} from "../middleware/rateLimit";
import { processImport } from "../lib/socialImport/processImport";
import {
  canonicalizeSocialUrl,
  detectPlatform,
  extractFirstUrl,
} from "../lib/socialImport/urlUtils";
import { IMPORT_ERROR_MESSAGES } from "../lib/socialImport/types";

const router = Router();

// Rows stuck PENDING/PROCESSING longer than this are presumed lost (server
// restart mid-pipeline — processing is in-process, not queued) and are
// surfaced as FAILED/TIMEOUT.
const STALE_IMPORT_MS = 10 * 60 * 1000;

const importResponse = (record: {
  id: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  recipeId: string | null;
  sourceUrl: string;
  platform: string;
  createdAt: Date;
}) => ({
  importId: record.id,
  status: record.status,
  errorCode: record.errorCode,
  errorMessage: record.errorMessage,
  recipeId: record.recipeId,
  sourceUrl: record.sourceUrl,
  platform: record.platform,
  createdAt: record.createdAt,
});

// Kick off an import from a shared social URL. Responds 202 immediately;
// extraction runs in-process fire-and-forget and completion is delivered via
// push notification (+ the GET endpoints below for foreground polling).
router.post(
  "/import-from-social",
  authToken,
  socialImportLimiter,
  socialImportDailyLimiter,
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const rawInput = req.body?.url;

      if (typeof rawInput !== "string" || !rawInput.trim()) {
        return res.status(400).json({ error: "A URL is required" });
      }

      // Share sheets sometimes hand over text containing the link rather than
      // a bare URL.
      const url = extractFirstUrl(rawInput.trim());
      if (!url) {
        return res.status(400).json({ error: "No link found in the shared content" });
      }

      const platform = detectPlatform(url);
      if (!platform) {
        return res.status(400).json({
          error: "Only TikTok, Instagram and Facebook links are supported",
        });
      }

      const canonicalUrl = canonicalizeSocialUrl(url);

      // Idempotency: one row per (user, canonical URL). Re-shares reuse it.
      const existing = await prisma.recipeImport.findUnique({
        where: { userId_canonicalUrl: { userId, canonicalUrl } },
      });

      if (existing) {
        if (
          existing.status === "PENDING" ||
          existing.status === "PROCESSING"
        ) {
          return res.status(202).json(importResponse(existing));
        }
        if (existing.status === "COMPLETED" && existing.recipeId) {
          return res.status(200).json(importResponse(existing));
        }
        // FAILED (or COMPLETED with a since-deleted recipe): retry in place.
        const reset = await prisma.recipeImport.update({
          where: { id: existing.id },
          data: {
            status: "PENDING",
            errorCode: null,
            errorMessage: null,
            recipeId: null,
            sourceUrl: url,
          },
        });
        processImport(reset.id).catch((error) =>
          console.error(`Social import ${reset.id} escaped:`, error)
        );
        return res.status(202).json(importResponse(reset));
      }

      const created = await prisma.recipeImport.create({
        data: { userId, sourceUrl: url, canonicalUrl, platform },
      });

      // Fire-and-forget: processImport handles all its own failure paths; the
      // catch here is a belt-and-braces guard so a bug can never produce an
      // unhandled rejection.
      processImport(created.id).catch((error) =>
        console.error(`Social import ${created.id} escaped:`, error)
      );

      return res.status(202).json(importResponse(created));
    } catch (error) {
      console.error("Import from social error:", error);
      res.status(500).json({ error: "Failed to start import" });
    }
  }
);

// Recent imports for foreground reconciliation (e.g. after sharing while the
// app was backgrounded and push permission is denied).
router.get("/imports", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const statusFilter =
      typeof req.query.status === "string"
        ? req.query.status
            .split(",")
            .filter((s) =>
              ["PENDING", "PROCESSING", "COMPLETED", "FAILED"].includes(s)
            )
        : [];

    const records = await prisma.recipeImport.findMany({
      where: {
        userId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        ...(statusFilter.length > 0
          ? { status: { in: statusFilter as any } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json({ imports: records.map(importResponse) });
  } catch (error) {
    console.error("List imports error:", error);
    res.status(500).json({ error: "Failed to list imports" });
  }
});

// Poll a single import's status.
router.get("/imports/:id", authToken, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    let record = await prisma.recipeImport.findFirst({
      where: { id: req.params.id, userId },
    });

    if (!record) {
      return res.status(404).json({ error: "Import not found" });
    }

    // Staleness backstop for work lost to a restart.
    if (
      (record.status === "PENDING" || record.status === "PROCESSING") &&
      Date.now() - record.updatedAt.getTime() > STALE_IMPORT_MS
    ) {
      record = await prisma.recipeImport.update({
        where: { id: record.id },
        data: {
          status: "FAILED",
          errorCode: "TIMEOUT",
          errorMessage: IMPORT_ERROR_MESSAGES.TIMEOUT,
        },
      });
    }

    res.json(importResponse(record));
  } catch (error) {
    console.error("Get import status error:", error);
    res.status(500).json({ error: "Failed to fetch import status" });
  }
});

export default router;
