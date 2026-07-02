-- CreateIndex
CREATE INDEX "DishList_ownerId_idx" ON "DishList"("ownerId");

-- CreateIndex
CREATE INDEX "DishListCollaborator_userId_idx" ON "DishListCollaborator"("userId");

-- CreateIndex
CREATE INDEX "DishListFollower_userId_idx" ON "DishListFollower"("userId");

-- CreateIndex
CREATE INDEX "Notification_receiverId_createdAt_idx" ON "Notification"("receiverId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_receiverId_isRead_idx" ON "Notification"("receiverId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_senderId_idx" ON "Notification"("senderId");

-- CreateIndex
CREATE INDEX "UserDishListPin_userId_idx" ON "UserDishListPin"("userId");
