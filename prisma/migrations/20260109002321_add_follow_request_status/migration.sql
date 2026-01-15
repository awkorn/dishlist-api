-- CreateEnum
CREATE TYPE "public"."FollowStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."NotificationType" ADD VALUE 'FOLLOW_REQUEST';
ALTER TYPE "public"."NotificationType" ADD VALUE 'FOLLOW_ACCEPTED';

-- AlterTable
ALTER TABLE "public"."UserFollow" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "status" "public"."FollowStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "UserFollow_followingId_status_idx" ON "public"."UserFollow"("followingId", "status");
