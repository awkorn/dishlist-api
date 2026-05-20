-- CreateEnum
CREATE TYPE "ModerationTargetType" AS ENUM ('USER', 'DISHLIST', 'RECIPE', 'IMAGE');

-- CreateEnum
CREATE TYPE "ModerationInputType" AS ENUM ('TEXT', 'IMAGE');

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('APPROVED', 'REJECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "ContentReportReason" AS ENUM ('INAPPROPRIATE', 'HARASSMENT', 'SPAM', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'ACTIONED', 'DISMISSED');

-- CreateTable
CREATE TABLE "ContentReport" (
    "id" TEXT NOT NULL,
    "targetType" "ModerationTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" "ContentReportReason" NOT NULL,
    "details" TEXT,
    "status" "ContentReportStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "reporterId" TEXT NOT NULL,
    "ownerId" TEXT,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationReview" (
    "id" TEXT NOT NULL,
    "targetType" "ModerationTargetType" NOT NULL,
    "targetId" TEXT,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputType" "ModerationInputType" NOT NULL,
    "status" "ModerationStatus" NOT NULL,
    "categories" JSONB,
    "scores" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentReport_targetType_targetId_idx" ON "ContentReport"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ContentReport_status_createdAt_idx" ON "ContentReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");

-- CreateIndex
CREATE INDEX "ContentReport_ownerId_idx" ON "ContentReport"("ownerId");

-- CreateIndex
CREATE INDEX "ModerationReview_targetType_targetId_idx" ON "ModerationReview"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ModerationReview_userId_createdAt_idx" ON "ModerationReview"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationReview_status_createdAt_idx" ON "ModerationReview"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("uid") ON DELETE SET NULL ON UPDATE CASCADE;
