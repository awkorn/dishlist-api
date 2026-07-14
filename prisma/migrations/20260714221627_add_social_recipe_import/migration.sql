-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('TIKTOK', 'INSTAGRAM', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "RecipeImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'RECIPE_IMPORT_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE 'RECIPE_IMPORT_FAILED';

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "sourceAuthor" TEXT,
ADD COLUMN     "sourcePlatform" "SocialPlatform",
ADD COLUMN     "sourceUrl" TEXT;

-- CreateTable
CREATE TABLE "RecipeImport" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "RecipeImportStatus" NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "recipeId" TEXT,

    CONSTRAINT "RecipeImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipeImport_userId_createdAt_idx" ON "RecipeImport"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeImport_userId_canonicalUrl_key" ON "RecipeImport"("userId", "canonicalUrl");

-- AddForeignKey
ALTER TABLE "RecipeImport" ADD CONSTRAINT "RecipeImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeImport" ADD CONSTRAINT "RecipeImport_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;
