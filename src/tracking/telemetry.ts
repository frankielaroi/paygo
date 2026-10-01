/**
 * The Teltonika IO properties kept alongside each position. The parser keeps every IO value in
 * `DevicePosition.io`; these are the ones the product shows. IDs are Teltonika FMB AVL IDs.
 */
export const TELTONIKA_IO = {
  /** External (vehicle) voltage, in mV: the bike's battery pack when the tracker is wired to it. */
  EXTERNAL_VOLTAGE: 66,
  /** Total odometer, in metres, counted by the tracker from GPS. Needs odometer enabled on the device. */
  TOTAL_ODOMETER: 16,
} as const;

export interface PowerAndOdometer {
  externalVoltageMv: number | null;
  odometerMeters: number | null;
}

/** Null when the device did not send the property, which is not the same as 0. */
export function powerAndOdometerOf(
  io: Record<number, number>,
): PowerAndOdometer {
  const read = (id: number): number | null =>
    Object.prototype.hasOwnProperty.call(io, id) && Number.isFinite(io[id])
      ? io[id]
      : null;
  return {
    externalVoltageMv: read(TELTONIKA_IO.EXTERNAL_VOLTAGE),
    odometerMeters: read(TELTONIKA_IO.TOTAL_ODOMETER),
  };
}

/**
 * Battery charge estimated linearly from pack voltage between the configured empty and full
 * voltages, as a whole percentage clamped to 0-100. An estimate: pack voltage sags under load
 * and a lithium discharge curve is not linear, so treat it as a guide, not a fuel gauge.
 * Null without a reading.
 */
export function batteryPercentOf(
  externalVoltageMv: number | null | undefined,
  emptyMv: number,
  fullMv: number,
): number | null {
  if (externalVoltageMv === null || externalVoltageMv === undefined) {
    return null;
  }
  const fraction = (externalVoltageMv - emptyMv) / (fullMv - emptyMv);
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** Metres to kilometres, to one decimal. */
export function odometerKmOf(
  odometerMeters: number | null | undefined,
): number | null {
  return odometerMeters === null || odometerMeters === undefined
    ? null
    : Math.round(odometerMeters / 100) / 10;
}
