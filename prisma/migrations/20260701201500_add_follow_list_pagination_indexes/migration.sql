DROP INDEX "public"."UserFollow_followingId_status_idx";

CREATE INDEX "UserFollow_followingId_status_acceptedAt_id_idx"
ON "public"."UserFollow"("followingId", "status", "acceptedAt", "id");

CREATE INDEX "UserFollow_followerId_status_acceptedAt_id_idx"
ON "public"."UserFollow"("followerId", "status", "acceptedAt", "id");
