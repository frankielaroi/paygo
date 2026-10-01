-- CreateEnum
CREATE TYPE "StaffAuditEventType" AS ENUM ('ACCOUNT_CREATED', 'PROFILE_UPDATED', 'ROLE_CHANGED', 'DEACTIVATED', 'REACTIVATED', 'PASSWORD_RESET', 'PASSWORD_CHANGED');

-- AlterEnum
ALTER TYPE "StaffRole" ADD VALUE 'FINANCE';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivationReason" TEXT,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "staff_audit_events" (
    "id" UUID NOT NULL,
    "type" "StaffAuditEventType" NOT NULL,
    "actorUserId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_audit_events_actorUserId_createdAt_idx" ON "staff_audit_events"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "staff_audit_events_targetUserId_createdAt_idx" ON "staff_audit_events"("targetUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "staff_audit_events" ADD CONSTRAINT "staff_audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_audit_events" ADD CONSTRAINT "staff_audit_events_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written: staff account history is append-only, like the other audit trails.
CREATE TRIGGER "staff_audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "staff_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "refuse_financial_history_change"();

-- Accounts deactivated before this column existed get a date, so the check below holds.
UPDATE "users" SET "deactivatedAt" = "updatedAt" WHERE "isActive" = false AND "deactivatedAt" IS NULL;

-- A deactivated account carries when it was deactivated; an active one does not.
ALTER TABLE "users" ADD CONSTRAINT "users_deactivation_check"
  CHECK ("isActive" = ("deactivatedAt" IS NULL));
