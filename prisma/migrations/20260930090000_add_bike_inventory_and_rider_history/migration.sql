-- CreateEnum
CREATE TYPE "BikeStatus" AS ENUM ('IN_INVENTORY', 'ASSIGNED', 'REPOSSESSED', 'SOLD', 'RETIRED');

-- CreateEnum
CREATE TYPE "AssignmentEndReason" AS ENUM ('RETURNED', 'TRANSFERRED', 'REPOSSESSED', 'SOLD');

-- AlterEnum
ALTER TYPE "EnforcementEventType" ADD VALUE 'TRACKER_CHANGED';

-- DropForeignKey
ALTER TABLE "bike_positions" DROP CONSTRAINT "bike_positions_bikeId_fkey";

-- AlterTable: vin, make and model start nullable and become required after the backfill below.
ALTER TABLE "bikes" ADD COLUMN     "color" TEXT,
ADD COLUMN     "make" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "purchaseCurrency" CHAR(3),
ADD COLUMN     "purchasePriceMinor" INTEGER,
ADD COLUMN     "purchasedAt" DATE,
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "status" "BikeStatus" NOT NULL DEFAULT 'IN_INVENTORY',
ADD COLUMN     "supplier" TEXT,
ADD COLUMN     "vin" TEXT,
ADD COLUMN     "year" INTEGER,
ALTER COLUMN "imei" DROP NOT NULL;

-- Backfill bikes created before inventory fields existed, so the columns can become required.
-- The placeholder VIN is unique per row and obviously not real; replace it once the chassis
-- number is known.
UPDATE "bikes" SET "vin" = 'UNKNOWN-' || "id"::text WHERE "vin" IS NULL;
UPDATE "bikes" SET "make" = 'Unknown' WHERE "make" IS NULL;
UPDATE "bikes" SET "model" = 'Unknown' WHERE "model" IS NULL;
ALTER TABLE "bikes" ALTER COLUMN "vin" SET NOT NULL,
ALTER COLUMN "make" SET NOT NULL,
ALTER COLUMN "model" SET NOT NULL;

-- A purchase price without its currency is meaningless, and a currency without a price is noise.
ALTER TABLE "bikes" ADD CONSTRAINT "bikes_purchase_price_currency_check"
  CHECK (("purchasePriceMinor" IS NULL) = ("purchaseCurrency" IS NULL));
ALTER TABLE "bikes" ADD CONSTRAINT "bikes_purchase_price_nonnegative_check"
  CHECK ("purchasePriceMinor" IS NULL OR "purchasePriceMinor" >= 0);

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivationReason" TEXT;

-- CreateTable
CREATE TABLE "bike_tracker_installations" (
    "id" UUID NOT NULL,
    "bikeId" UUID NOT NULL,
    "imei" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "installedById" UUID,
    "removedAt" TIMESTAMP(3),
    "removedById" UUID,
    "removedReason" TEXT,

    CONSTRAINT "bike_tracker_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bike_assignments" (
    "id" UUID NOT NULL,
    "bikeId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" UUID NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" "AssignmentEndReason",
    "endedById" UUID,
    "notes" TEXT,

    CONSTRAINT "bike_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bike_status_changes" (
    "id" UUID NOT NULL,
    "bikeId" UUID NOT NULL,
    "fromStatus" "BikeStatus",
    "toStatus" "BikeStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "actorUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bike_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bike_tracker_installations_bikeId_installedAt_idx" ON "bike_tracker_installations"("bikeId", "installedAt");

-- CreateIndex
CREATE INDEX "bike_tracker_installations_imei_idx" ON "bike_tracker_installations"("imei");

-- CreateIndex
CREATE INDEX "bike_assignments_bikeId_startedAt_idx" ON "bike_assignments"("bikeId", "startedAt");

-- CreateIndex
CREATE INDEX "bike_assignments_customerId_startedAt_idx" ON "bike_assignments"("customerId", "startedAt");

-- CreateIndex
CREATE INDEX "bike_status_changes_bikeId_createdAt_idx" ON "bike_status_changes"("bikeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bikes_vin_key" ON "bikes"("vin");

-- CreateIndex
CREATE INDEX "bikes_status_idx" ON "bikes"("status");

-- AddForeignKey
ALTER TABLE "bike_tracker_installations" ADD CONSTRAINT "bike_tracker_installations_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_tracker_installations" ADD CONSTRAINT "bike_tracker_installations_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_tracker_installations" ADD CONSTRAINT "bike_tracker_installations_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_assignments" ADD CONSTRAINT "bike_assignments_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_assignments" ADD CONSTRAINT "bike_assignments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_assignments" ADD CONSTRAINT "bike_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_assignments" ADD CONSTRAINT "bike_assignments_endedById_fkey" FOREIGN KEY ("endedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_status_changes" ADD CONSTRAINT "bike_status_changes_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_status_changes" ADD CONSTRAINT "bike_status_changes_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: Restrict, not Cascade. Bikes are retired, never deleted, and history must stay.
ALTER TABLE "bike_positions" ADD CONSTRAINT "bike_positions_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Not expressible in the Prisma schema: at most one open tracker per bike and per IMEI, and at
-- most one open assignment per bike. These make a double assignment impossible under a race,
-- rather than merely checked for.
CREATE UNIQUE INDEX "bike_tracker_installations_open_bike_key"
  ON "bike_tracker_installations" ("bikeId") WHERE "removedAt" IS NULL;
CREATE UNIQUE INDEX "bike_tracker_installations_open_imei_key"
  ON "bike_tracker_installations" ("imei") WHERE "removedAt" IS NULL;
CREATE UNIQUE INDEX "bike_assignments_open_bike_key"
  ON "bike_assignments" ("bikeId") WHERE "endedAt" IS NULL;

-- Record the trackers already fitted, so installation history starts complete.
INSERT INTO "bike_tracker_installations" ("id", "bikeId", "imei", "installedAt")
SELECT gen_random_uuid(), "id", "imei", "createdAt" FROM "bikes" WHERE "imei" IS NOT NULL;
