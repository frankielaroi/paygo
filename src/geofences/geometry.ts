/**
 * Pure zone geometry: what a valid zone outline is, and whether a position falls inside one.
 * No database and no clock, so the rule that raises an out-of-zone alert can be tested with
 * explicit coordinates.
 */

/** [latitude, longitude] in decimal degrees. */
export type LatLng = [number, number];

export const MIN_POLYGON_POINTS = 3;
export const MAX_POLYGON_POINTS = 200;

/**
 * A zone outline as stored and sent: its corners in order, not closed (the last corner joins
 * the first). Returns null for anything else, so callers refuse it rather than store a shape
 * that can never contain a bike.
 */
export function parsePolygon(value: unknown): LatLng[] | null {
  if (
    !Array.isArray(value) ||
    value.length < MIN_POLYGON_POINTS ||
    value.length > MAX_POLYGON_POINTS
  ) {
    return null;
  }
  const points: LatLng[] = [];
  for (const corner of value as unknown[]) {
    if (!Array.isArray(corner) || corner.length !== 2) {
      return null;
    }
    const [latitude, longitude] = corner as unknown[];
    if (
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return null;
    }
    points.push([latitude, longitude]);
  }
  // Corners that all sit on one line enclose nothing.
  return Math.abs(signedArea(points)) > 0 ? points : null;
}

function signedArea(points: readonly LatLng[]): number {
  return points.reduce((sum, [lat, lng], index) => {
    const [nextLat, nextLng] = points[(index + 1) % points.length];
    return sum + (lng * nextLat - nextLng * lat);
  }, 0);
}

/**
 * Ray casting, treating degrees as a flat plane. That is exact enough for a zone the size of a
 * city or a region; it would not be for one spanning the antimeridian or a pole, which no
 * operating zone here does.
 */
export function isInsidePolygon(
  [latitude, longitude]: LatLng,
  polygon: readonly LatLng[],
): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const [latA, lngA] = polygon[current];
    const [latB, lngB] = polygon[previous];
    const straddles = latA > latitude !== latB > latitude;
    if (
      straddles &&
      longitude < ((lngB - lngA) * (latitude - latA)) / (latB - latA) + lngA
    ) {
      inside = !inside;
    }
  }
  return inside;
}
