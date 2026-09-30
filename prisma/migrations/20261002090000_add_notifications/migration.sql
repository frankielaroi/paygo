-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('PAYMENT_REMINDER', 'LOCKOUT_WARNING', 'BIKE_IMMOBILIZED', 'BIKE_RESTORED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "StaffAlertKind" AS ENUM ('ENFORCEMENT_REVIEW', 'NOTIFICATION_FAILED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "customerId" UUID NOT NULL,
    "loanId" UUID,
    "installmentId" UUID,
    "bikeId" UUID,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_alerts" (
    "id" UUID NOT NULL,
    "kind" "StaffAlertKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "bikeId" UUID,
    "customerId" UUID,
    "notificationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" UUID,

    CONSTRAINT "staff_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_status_createdAt_idx" ON "notifications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_customerId_createdAt_idx" ON "notifications"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_loanId_kind_idx" ON "notifications"("loanId", "kind");

-- CreateIndex
CREATE INDEX "notifications_providerMessageId_idx" ON "notifications"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_alerts_dedupeKey_key" ON "staff_alerts"("dedupeKey");

-- CreateIndex
CREATE INDEX "staff_alerts_acknowledgedAt_createdAt_idx" ON "staff_alerts"("acknowledgedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "loan_installments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_alerts" ADD CONSTRAINT "staff_alerts_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_alerts" ADD CONSTRAINT "staff_alerts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_alerts" ADD CONSTRAINT "staff_alerts_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written: attempts never go negative, and the timestamps agree with the status.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_times_check" CHECK (
  ("status" <> 'SENT' OR "sentAt" IS NOT NULL)
  AND ("status" <> 'DELIVERED' OR "deliveredAt" IS NOT NULL)
  AND ("status" <> 'FAILED' OR "failedAt" IS NOT NULL)
);
