-- AlterTable
ALTER TABLE "public"."Recipe" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
