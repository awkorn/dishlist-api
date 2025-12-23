-- CreateTable
CREATE TABLE "public"."DishListInvite" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dishListId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT,

    CONSTRAINT "DishListInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DishListInvite_token_key" ON "public"."DishListInvite"("token");

-- CreateIndex
CREATE INDEX "DishListInvite_token_idx" ON "public"."DishListInvite"("token");

-- CreateIndex
CREATE INDEX "DishListInvite_dishListId_idx" ON "public"."DishListInvite"("dishListId");

-- CreateIndex
CREATE INDEX "DishListInvite_inviteeId_idx" ON "public"."DishListInvite"("inviteeId");

-- CreateIndex
CREATE INDEX "DishListInvite_expiresAt_idx" ON "public"."DishListInvite"("expiresAt");

-- AddForeignKey
ALTER TABLE "public"."DishListInvite" ADD CONSTRAINT "DishListInvite_dishListId_fkey" FOREIGN KEY ("dishListId") REFERENCES "public"."DishList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListInvite" ADD CONSTRAINT "DishListInvite_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DishListInvite" ADD CONSTRAINT "DishListInvite_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "public"."User"("uid") ON DELETE CASCADE ON UPDATE CASCADE;
