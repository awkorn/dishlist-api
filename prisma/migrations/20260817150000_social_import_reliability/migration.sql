-- Durable queue, stable social identity, quality metadata, and Import Activity.
-- Deploy this migration before deploying the corresponding API build.
ALTER TYPE "SocialPlatform" ADD VALUE IF NOT EXISTS 'YOUTUBE';
ALTER TYPE "SocialPlatform" ADD VALUE IF NOT EXISTS 'PINTEREST';
ALTER TYPE "RecipeImportStatus" ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';
ALTER TYPE "RecipeImportStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "Recipe"
  ADD COLUMN "sourceLanguage" TEXT,
  ADD COLUMN "importWarnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "importConfidence" DOUBLE PRECISION,
  ADD COLUMN "importNeedsReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "importSource" TEXT;

ALTER TABLE "RecipeImport"
  ADD COLUMN "platformPostId" TEXT,
  ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "presentedAt" TIMESTAMP(3),
  ADD COLUMN "extractionSource" TEXT,
  ADD COLUMN "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "confidence" DOUBLE PRECISION;

CREATE UNIQUE INDEX "RecipeImport_userId_platform_platformPostId_key"
  ON "RecipeImport"("userId", "platform", "platformPostId");
CREATE INDEX "RecipeImport_status_nextAttemptAt_leaseExpiresAt_idx"
  ON "RecipeImport"("status", "nextAttemptAt", "leaseExpiresAt");
