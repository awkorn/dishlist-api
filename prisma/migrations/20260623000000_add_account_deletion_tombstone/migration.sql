CREATE TABLE "public"."AccountDeletion" (
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("userId")
);
