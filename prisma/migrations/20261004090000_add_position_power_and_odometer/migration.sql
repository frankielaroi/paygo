-- Pack voltage (Teltonika IO 66, mV) and tracker total odometer (IO 16, m) on each position.
-- Nullable: older rows and devices that don't report them have no value, which is not zero.
ALTER TABLE "bike_positions"
  ADD COLUMN "externalVoltageMv" INTEGER,
  ADD COLUMN "odometerMeters" INTEGER;

ALTER TABLE "bike_current_positions"
  ADD COLUMN "externalVoltageMv" INTEGER,
  ADD COLUMN "odometerMeters" INTEGER;
