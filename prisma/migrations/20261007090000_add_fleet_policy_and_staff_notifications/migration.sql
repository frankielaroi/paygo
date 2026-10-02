-- Runtime fleet policy (one row, with a record of each change), and SMS alerts to staff: what
-- each person chose to be texted about, and what was sent.

-- CreateEnum
CREATE TYPE "StaffNotificationTopic" AS ENUM ('LOAN_OVERDUE', 'BIKE_OFFLINE', 'GEOFENCE_EXIT');

-- CreateEnum
CREATE TYPE "StaffMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "fleet_policies" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lockoutWarningLeadHours" INTEGER NOT NULL,
    "defaultInstallmentMinor" INTEGER,
    "defaultFrequency" "LoanFrequency" NOT NULL DEFAULT 'DAILY',
    "defaultGraceDays" INTEGER NOT NULL DEFAULT 1,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_policies_pkey" PRIMARY KEY ("id"),
    -- There is one policy for the fleet; a second row would be a policy nothing reads.
    CONSTRAINT "fleet_policies_single_row" CHECK ("id" = 1)
);

-- CreateTable
CREATE TABLE "policy_changes" (
    "id" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_notification_preferences" (
    "userId" UUID NOT NULL,
    "topic" "StaffNotificationTopic" NOT NULL,
    "sms" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_notification_preferences_pkey" PRIMARY KEY ("userId","topic")
);

-- CreateTable
CREATE TABLE "staff_messages" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topic" "StaffNotificationTopic" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "StaffMessageStatus" NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "error" TEXT,
    "bikeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "staff_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policy_changes_createdAt_idx" ON "policy_changes"("createdAt");

-- CreateIndex
CREATE INDEX "staff_messages_userId_createdAt_idx" ON "staff_messages"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "staff_messages_userId_dedupeKey_key" ON "staff_messages"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "fleet_policies" ADD CONSTRAINT "fleet_policies_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_changes" ADD CONSTRAINT "policy_changes_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_notification_preferences" ADD CONSTRAINT "staff_notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_messages" ADD CONSTRAINT "staff_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
