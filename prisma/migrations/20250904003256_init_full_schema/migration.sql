/*
  Warnings:

  - A unique constraint covering the columns `[username]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."DishListVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "public"."NotificationType" AS ENUM ('DISHLIST_INVITATION', 'DISHLIST_SHARED', 'RECIPE_ADDED', 'DISHLIST_FOLLOWED', 'COLLABORATION_ACCEPTED', 'COLLABORATION_DECLINED', 'USER_FOLLOWED', 'SYSTEM_UPDATE');

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "username" TEXT;

-- CreateTable
CREATE TABLE "public"."DishList" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "public"."DishListVisibility" NOT NULL DEFAULT 'PUBLIC',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "DishList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Recipe" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "ingredients" TEXT,
    "prepTime" INTEGER,
    "cookTime" INTEGER,
    "servings" INTEGER,
    "imageUrl" TEXT,
    "originalRecipeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "creatorId" TEXT NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DishListRecipe" (
    "id" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dishListId" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,

    CONSTRAINT "DishListRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DishListCollaborator" (
    "id" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dishListId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "DishListCollaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DishListFollower" (
    "id" TEXT NOT NULL,
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dishListId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "DishListFollower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserFollow" (
    "id" TEXT NOT NULL,
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,

    CONSTRAINT "UserFollow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "type" "public"."NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "data" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "senderId" TEXT,
    "receiverId" TEXT NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DishListRecipe_dishListId_recipeId_key" ON "public"."DishListRecipe"("dishListId", "recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "DishListCollaborator_dishListId_userId_key" ON "public"."DishListCollaborator"("dishListId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DishListFollower_dishListId_userId_key" ON "public"."DishListFollower"("dishListId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserFollow_followerId_followingId_key" ON "public"."UserFollow"("followerId", "followingId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "public"."User"("username");

-- AddForeignKey
ALTER TABLE "public"."DishList" ADD CONSTRAINT "DishList_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Recipe" ADD CONSTRAINT "Recipe_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Recipe" ADD CONSTRAINT "Recipe_originalRecipeId_fkey" FOREIGN KEY ("originalRecipeId") REFERENCES "public"."Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListRecipe" ADD CONSTRAINT "DishListRecipe_dishListId_fkey" FOREIGN KEY ("dishListId") REFERENCES "public"."DishList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListRecipe" ADD CONSTRAINT "DishListRecipe_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListRecipe" ADD CONSTRAINT "DishListRecipe_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "public"."User"("uid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListCollaborator" ADD CONSTRAINT "DishListCollaborator_dishListId_fkey" FOREIGN KEY ("dishListId") REFERENCES "public"."DishList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListCollaborator" ADD CONSTRAINT "DishListCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListFollower" ADD CONSTRAINT "DishListFollower_dishListId_fkey" FOREIGN KEY ("dishListId") REFERENCES "public"."DishList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListFollower" ADD CONSTRAINT "DishListFollower_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserFollow" ADD CONSTRAINT "UserFollow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserFollow" ADD CONSTRAINT "UserFollow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "public"."User"("uid") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;
