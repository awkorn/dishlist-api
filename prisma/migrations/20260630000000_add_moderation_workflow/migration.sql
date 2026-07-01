CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN');
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "ContentModerationState" AS ENUM ('VISIBLE', 'HIDDEN');
CREATE TYPE "ModerationActionType" AS ENUM (
  'CLAIM',
  'DISMISS_REPORT',
  'HIDE_CONTENT',
  'SUSPEND_USER',
  'RESTORE_CONTENT',
  'RESTORE_USER'
);

ALTER TYPE "NotificationType" ADD VALUE 'REPORT_RESOLVED';

ALTER TABLE "User"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER',
  ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "suspendedAt" TIMESTAMP(3);

ALTER TABLE "DishList"
  ADD COLUMN "moderationState" "ContentModerationState" NOT NULL DEFAULT 'VISIBLE';

ALTER TABLE "Recipe"
  ADD COLUMN "moderationState" "ContentModerationState" NOT NULL DEFAULT 'VISIBLE';

ALTER TABLE "ContentReport"
  ADD COLUMN "dedupeKey" TEXT,
  ADD COLUMN "targetSnapshot" JSONB,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "resolutionNote" TEXT,
  ADD COLUMN "assignedToId" TEXT,
  ADD COLUMN "resolvedById" TEXT;

CREATE TABLE "ModerationAction" (
  "id" TEXT NOT NULL,
  "targetType" "ModerationTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "action" "ModerationActionType" NOT NULL,
  "note" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reportId" TEXT,
  "moderatorId" TEXT,
  CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentReport_assignedToId_idx" ON "ContentReport"("assignedToId");
CREATE UNIQUE INDEX "ContentReport_dedupeKey_key" ON "ContentReport"("dedupeKey");
CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "User_role_idx" ON "User"("role");
CREATE INDEX "DishList_moderationState_idx" ON "DishList"("moderationState");
CREATE INDEX "Recipe_moderationState_idx" ON "Recipe"("moderationState");
CREATE INDEX "ModerationAction_targetType_targetId_createdAt_idx"
  ON "ModerationAction"("targetType", "targetId", "createdAt");
CREATE INDEX "ModerationAction_reportId_idx" ON "ModerationAction"("reportId");
CREATE INDEX "ModerationAction_moderatorId_createdAt_idx"
  ON "ModerationAction"("moderatorId", "createdAt");

ALTER TABLE "ContentReport"
  ADD CONSTRAINT "ContentReport_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("uid")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContentReport"
  ADD CONSTRAINT "ContentReport_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("uid")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModerationAction"
  ADD CONSTRAINT "ModerationAction_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "ContentReport"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModerationAction"
  ADD CONSTRAINT "ModerationAction_moderatorId_fkey"
  FOREIGN KEY ("moderatorId") REFERENCES "User"("uid")
  ON DELETE SET NULL ON UPDATE CASCADE;
