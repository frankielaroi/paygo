-- CreateTable
CREATE TABLE "bikes" (
    "id" UUID NOT NULL,
    "imei" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "lastReportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bikes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bike_positions" (
    "id" UUID NOT NULL,
    "bikeId" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "altitude" INTEGER NOT NULL,
    "angle" INTEGER NOT NULL,
    "satellites" INTEGER NOT NULL,
    "speed" INTEGER NOT NULL,
    "ignition" BOOLEAN,
    "movement" BOOLEAN,
    "hasFix" BOOLEAN NOT NULL,

    CONSTRAINT "bike_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bike_current_positions" (
    "bikeId" UUID NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "altitude" INTEGER NOT NULL,
    "angle" INTEGER NOT NULL,
    "satellites" INTEGER NOT NULL,
    "speed" INTEGER NOT NULL,
    "ignition" BOOLEAN,
    "movement" BOOLEAN,
    "hasFix" BOOLEAN NOT NULL,

    CONSTRAINT "bike_current_positions_pkey" PRIMARY KEY ("bikeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "bikes_imei_key" ON "bikes"("imei");

-- CreateIndex
CREATE UNIQUE INDEX "bikes_registrationNumber_key" ON "bikes"("registrationNumber");

-- CreateIndex
CREATE INDEX "bike_positions_bikeId_recordedAt_idx" ON "bike_positions"("bikeId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "bike_positions_bikeId_recordedAt_key" ON "bike_positions"("bikeId", "recordedAt");

-- CreateIndex
CREATE INDEX "bike_current_positions_receivedAt_idx" ON "bike_current_positions"("receivedAt");

-- AddForeignKey
ALTER TABLE "bike_positions" ADD CONSTRAINT "bike_positions_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_current_positions" ADD CONSTRAINT "bike_current_positions_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
