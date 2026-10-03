import { isInsidePolygon, parsePolygon, type LatLng } from './geometry';

// Roughly central Accra.
const zone: LatLng[] = [
  [5.52, -0.3],
  [5.72, -0.3],
  [5.72, -0.05],
  [5.52, -0.05],
];

describe('isInsidePolygon', () => {
  it('finds a position inside the zone', () => {
    expect(isInsidePolygon([5.6037, -0.187], zone)).toBe(true);
  });

  it('finds a position outside the zone on each side', () => {
    expect(isInsidePolygon([5.8, -0.187], zone)).toBe(false);
    expect(isInsidePolygon([5.4, -0.187], zone)).toBe(false);
    expect(isInsidePolygon([5.6, -0.4], zone)).toBe(false);
    // Tema, east of the zone.
    expect(isInsidePolygon([5.6698, 0.0166], zone)).toBe(false);
  });

  it('follows a concave outline', () => {
    // An L: the notch at the top right is outside.
    const l: LatLng[] = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ];
    expect(isInsidePolygon([0.5, 1.5], l)).toBe(true);
    expect(isInsidePolygon([1.5, 0.5], l)).toBe(true);
    expect(isInsidePolygon([1.5, 1.5], l)).toBe(false);
  });

  it('does not depend on the direction the corners were drawn in', () => {
    expect(isInsidePolygon([5.6037, -0.187], [...zone].reverse())).toBe(true);
  });
});

describe('parsePolygon', () => {
  it('accepts three or more corners in range', () => {
    expect(parsePolygon(zone)).toEqual(zone);
  });

  it('refuses anything that is not an outline', () => {
    expect(parsePolygon('zone')).toBeNull();
    expect(parsePolygon(zone.slice(0, 2))).toBeNull();
    expect(parsePolygon([...zone, [5.6]])).toBeNull();
    expect(parsePolygon([...zone, ['5.6', '-0.1']])).toBeNull();
    expect(parsePolygon([...zone, [95, 0]])).toBeNull();
    expect(parsePolygon([...zone, [0, 181]])).toBeNull();
    expect(parsePolygon([...zone, [Number.NaN, 0]])).toBeNull();
  });

  it('refuses corners that all lie on one line', () => {
    expect(
      parsePolygon([
        [5.5, -0.2],
        [5.6, -0.2],
        [5.7, -0.2],
      ]),
    ).toBeNull();
  });
});
