CREATE TABLE "RecipeShare" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipeId" TEXT NOT NULL,
    "sharedById" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,

    CONSTRAINT "RecipeShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Recipe_creatorId_originalRecipeId_key"
ON "Recipe"("creatorId", "originalRecipeId");

CREATE UNIQUE INDEX "RecipeShare_recipeId_recipientId_key"
ON "RecipeShare"("recipeId", "recipientId");

CREATE INDEX "RecipeShare_recipientId_idx"
ON "RecipeShare"("recipientId");

ALTER TABLE "RecipeShare"
ADD CONSTRAINT "RecipeShare_recipeId_fkey"
FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecipeShare"
ADD CONSTRAINT "RecipeShare_sharedById_fkey"
FOREIGN KEY ("sharedById") REFERENCES "User"("uid")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecipeShare"
ADD CONSTRAINT "RecipeShare_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "User"("uid")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "RecipeShare" ("id", "recipeId", "sharedById", "recipientId", "createdAt")
SELECT
  'backfill-' || n."id",
  n."data"::jsonb ->> 'recipeId',
  n."senderId",
  n."receiverId",
  n."createdAt"
FROM "Notification" n
WHERE n."type" = 'RECIPE_SHARED'
  AND n."senderId" IS NOT NULL
  AND n."data" IS NOT NULL
  AND n."data"::jsonb ? 'recipeId'
  AND EXISTS (
    SELECT 1
    FROM "Recipe" r
    WHERE r."id" = n."data"::jsonb ->> 'recipeId'
  )
ON CONFLICT ("recipeId", "recipientId") DO NOTHING;
