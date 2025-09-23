/*
  Warnings:

  - The `instructions` column on the `Recipe` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `ingredients` column on the `Recipe` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "public"."Recipe" ADD COLUMN     "nutrition" JSONB,
DROP COLUMN "instructions",
ADD COLUMN     "instructions" TEXT[],
DROP COLUMN "ingredients",
ADD COLUMN     "ingredients" TEXT[];
