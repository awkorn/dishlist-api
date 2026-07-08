CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "DishList_title_idx" ON "DishList" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Recipe_title_idx" ON "Recipe" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Recipe_description_idx" ON "Recipe" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User" USING GIN ("username" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_firstName_idx" ON "User" USING GIN ("firstName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_lastName_idx" ON "User" USING GIN ("lastName" gin_trgm_ops);
