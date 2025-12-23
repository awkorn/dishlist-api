-- Step 1: Add new JSON columns
ALTER TABLE "public"."Recipe" ADD COLUMN "ingredients_new" JSONB;
ALTER TABLE "public"."Recipe" ADD COLUMN "instructions_new" JSONB;

-- Step 2: Migrate existing data from TEXT[] to JSONB
-- Converts ["item1", "item2"] to [{"type": "item", "text": "item1"}, {"type": "item", "text": "item2"}]
UPDATE "public"."Recipe"
SET "ingredients_new" = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('type', 'item', 'text', elem)
    ),
    '[]'::jsonb
  )
  FROM unnest("ingredients") AS elem
),
"instructions_new" = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('type', 'item', 'text', elem)
    ),
    '[]'::jsonb
  )
  FROM unnest("instructions") AS elem
);

-- Step 3: Handle NULL or empty arrays (set to empty JSONB array)
UPDATE "public"."Recipe"
SET "ingredients_new" = '[]'::jsonb
WHERE "ingredients_new" IS NULL;

UPDATE "public"."Recipe"
SET "instructions_new" = '[]'::jsonb
WHERE "instructions_new" IS NULL;

-- Step 4: Drop old columns
ALTER TABLE "public"."Recipe" DROP COLUMN "ingredients";
ALTER TABLE "public"."Recipe" DROP COLUMN "instructions";

-- Step 5: Rename new columns to original names
ALTER TABLE "public"."Recipe" RENAME COLUMN "ingredients_new" TO "ingredients";
ALTER TABLE "public"."Recipe" RENAME COLUMN "instructions_new" TO "instructions";

-- Step 6: Set NOT NULL constraint (now safe since we've populated data)
ALTER TABLE "public"."Recipe" ALTER COLUMN "ingredients" SET NOT NULL;
ALTER TABLE "public"."Recipe" ALTER COLUMN "instructions" SET NOT NULL;

-- Step 7: Set default value for new recipes
ALTER TABLE "public"."Recipe" ALTER COLUMN "ingredients" SET DEFAULT '[]'::jsonb;
ALTER TABLE "public"."Recipe" ALTER COLUMN "instructions" SET DEFAULT '[]'::jsonb;