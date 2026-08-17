import crypto from "crypto";
import prisma from "../prisma";
import { logSocialImportEvent } from "./metrics";
import { processImport, socialImportLeaseMs } from "./processImport";

const POLL_MS = 2_000;
const MAX_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.SOCIAL_IMPORT_WORKER_CONCURRENCY) || 2)
);

export function startSocialImportWorker(): () => void {
  const active = new Set<string>();
  let stopped = false;
  let ticking = false;

  const tick = async () => {
    if (stopped || ticking || active.size >= MAX_CONCURRENCY) return;
    ticking = true;
    try {
      const now = new Date();
      // A cancellation requested just before a process/server crash must not
      // be reclaimed as fresh work when its lease expires.
      await prisma.recipeImport.updateMany({
        where: {
          status: "PROCESSING",
          cancelRequestedAt: { not: null },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          status: "CANCELLED",
          phase: "CANCELLED",
          finishedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      while (!stopped && active.size < MAX_CONCURRENCY) {
        const now = new Date();
        const candidate = await prisma.recipeImport.findFirst({
          where: {
            OR: [
              { status: "PENDING", nextAttemptAt: { lte: now } },
              {
                status: "PROCESSING",
                cancelRequestedAt: null,
                OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
              },
            ],
          },
          orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
        });
        if (!candidate) break;

        const leaseToken = crypto.randomUUID();
        const claimed = await prisma.recipeImport.updateMany({
          where:
            candidate.status === "PENDING"
              ? { id: candidate.id, status: "PENDING", nextAttemptAt: { lte: now } }
              : {
                  id: candidate.id,
                  status: "PROCESSING",
                  cancelRequestedAt: null,
                  leaseToken: candidate.leaseToken,
                  OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
                },
          data: {
            status: "PROCESSING",
            phase: "CLAIMED",
            attempt: { increment: 1 },
            leaseToken,
            leaseExpiresAt: new Date(Date.now() + socialImportLeaseMs),
            cancelRequestedAt: null,
            startedAt: candidate.startedAt ?? new Date(),
          },
        });
        if (claimed.count !== 1) continue;

        active.add(candidate.id);
        logSocialImportEvent("claimed", {
          importId: candidate.id,
          platform: candidate.platform,
          attempt: candidate.attempt + 1,
        });
        void processImport(candidate.id, { leaseToken })
          .catch((error) => console.error(`Import worker escaped ${candidate.id}:`, error))
          .finally(() => active.delete(candidate.id));
      }
    } catch (error) {
      console.error("Social import worker tick failed:", error);
    } finally {
      ticking = false;
    }
  };

  const interval = setInterval(() => void tick(), POLL_MS);
  void tick();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
