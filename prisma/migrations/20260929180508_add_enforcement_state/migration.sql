-- CreateEnum
CREATE TYPE "MobilityState" AS ENUM ('MOBILE', 'IMMOBILIZED');

-- CreateEnum
CREATE TYPE "DesiredStateSource" AS ENUM ('ARREARS', 'STAFF');

-- CreateEnum
CREATE TYPE "EnforcementEventType" AS ENUM ('DESIRED_STATE_CHANGED', 'COMMAND_SENT', 'COMMAND_FAILED', 'COMMAND_DEFERRED', 'STATE_CONFIRMED', 'RESPONSE_UNRECOGNIZED', 'REVIEW_FLAGGED');

-- CreateTable
CREATE TABLE "bike_enforcement" (
    "bikeId" UUID NOT NULL,
    "desiredState" "MobilityState" NOT NULL DEFAULT 'MOBILE',
    "desiredSource" "DesiredStateSource" NOT NULL DEFAULT 'ARREARS',
    "confirmedState" "MobilityState",
    "confirmedAt" TIMESTAMP(3),
    "pendingCommand" "MobilityState",
    "pendingSentAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "reviewReason" TEXT,
    "reviewSince" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bike_enforcement_pkey" PRIMARY KEY ("bikeId")
);

-- CreateTable
CREATE TABLE "enforcement_events" (
    "id" UUID NOT NULL,
    "bikeId" UUID NOT NULL,
    "type" "EnforcementEventType" NOT NULL,
    "actorUserId" UUID,
    "trigger" TEXT NOT NULL,
    "fromState" "MobilityState",
    "toState" "MobilityState",
    "reason" TEXT NOT NULL,
    "telemetry" JSONB,
    "detail" JSONB,
    "deviceResponse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enforcement_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bike_enforcement_reviewReason_idx" ON "bike_enforcement"("reviewReason");

-- CreateIndex
CREATE INDEX "enforcement_events_bikeId_createdAt_idx" ON "enforcement_events"("bikeId", "createdAt");

-- AddForeignKey
ALTER TABLE "bike_enforcement" ADD CONSTRAINT "bike_enforcement_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_events" ADD CONSTRAINT "enforcement_events_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enforcement_events" ADD CONSTRAINT "enforcement_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
