-- CreateTable
CREATE TABLE "public"."UserDishListPin" (
    "id" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dishListId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserDishListPin_pkey" PRIMARY KEY ("id")
);

-- Migrate existing pins: Create pin records for owners who had isPinned = true
INSERT INTO "public"."UserDishListPin" ("id", "dishListId", "userId", "pinnedAt")
SELECT 
    gen_random_uuid()::text,
    "id",
    "ownerId",
    NOW()
FROM "public"."DishList"
WHERE "isPinned" = true;

-- CreateIndex
CREATE UNIQUE INDEX "UserDishListPin_dishListId_userId_key" ON "public"."UserDishListPin"("dishListId", "userId");

-- AddForeignKey
ALTER TABLE "public"."UserDishListPin" ADD CONSTRAINT "UserDishListPin_dishListId_fkey" FOREIGN KEY ("dishListId") REFERENCES "public"."DishList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserDishListPin" ADD CONSTRAINT "UserDishListPin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop the old column
ALTER TABLE "public"."DishList" DROP COLUMN "isPinned";