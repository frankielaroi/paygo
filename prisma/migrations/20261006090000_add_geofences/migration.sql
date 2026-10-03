-- Operating zones: outlines drawn on the fleet map, which side of each zone every bike was last
-- seen on, and a record of each crossing for the dashboard's activity feed.

-- CreateEnum
CREATE TYPE "GeofenceCrossingDirection" AS ENUM ('EXITED', 'ENTERED');

-- CreateTable
CREATE TABLE "geofences" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "polygon" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "geofences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bike_geofence_states" (
    "bikeId" UUID NOT NULL,
    "geofenceId" UUID NOT NULL,
    "inside" BOOLEAN NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bike_geofence_states_pkey" PRIMARY KEY ("bikeId","geofenceId")
);

-- CreateTable
CREATE TABLE "geofence_crossings" (
    "id" UUID NOT NULL,
    "geofenceId" UUID NOT NULL,
    "bikeId" UUID NOT NULL,
    "direction" "GeofenceCrossingDirection" NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geofence_crossings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "geofences_deletedAt_idx" ON "geofences"("deletedAt");

-- CreateIndex
CREATE INDEX "bike_geofence_states_geofenceId_idx" ON "bike_geofence_states"("geofenceId");

-- CreateIndex
CREATE INDEX "geofence_crossings_createdAt_idx" ON "geofence_crossings"("createdAt");

-- CreateIndex
CREATE INDEX "geofence_crossings_bikeId_createdAt_idx" ON "geofence_crossings"("bikeId", "createdAt");

-- AddForeignKey
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_geofence_states" ADD CONSTRAINT "bike_geofence_states_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bike_geofence_states" ADD CONSTRAINT "bike_geofence_states_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "geofences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_crossings" ADD CONSTRAINT "geofence_crossings_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "geofences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_crossings" ADD CONSTRAINT "geofence_crossings_bikeId_fkey" FOREIGN KEY ("bikeId") REFERENCES "bikes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
