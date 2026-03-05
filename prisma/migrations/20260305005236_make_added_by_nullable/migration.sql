-- DropForeignKey
ALTER TABLE "public"."DishListRecipe" DROP CONSTRAINT "DishListRecipe_addedById_fkey";

-- AlterTable
ALTER TABLE "public"."DishListRecipe" ALTER COLUMN "addedById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."DishListRecipe" ADD CONSTRAINT "DishListRecipe_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "public"."User"("uid") ON DELETE SET NULL ON UPDATE CASCADE;
