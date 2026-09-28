import {
  buildCommandResponse,
  buildHandshake,
  buildTelemetryPacket,
} from './codec8-fixtures';
import {
  IO_IGNITION,
  IO_MOVEMENT,
  MAX_DATA_FIELD_BYTES,
  parseFrame,
  parseImeiHandshake,
} from './codec8-parser';

/**
 * Packets come from codec8-fixtures.ts, a separate encoder with its own CRC loop, so the parser
 * is checked against bytes it did not produce itself. That is the only way these tests can catch
 * a misreading of the spec that the parser and the encoder would otherwise share. The real CRC is
 * pinned independently by published vectors in crc16.spec.ts.
 */
const NAIROBI = { latitude: -1.2921, longitude: 36.8219 };

describe('parseImeiHandshake', () => {
  it('reads a complete handshake', () => {
    const result = parseImeiHandshake(buildHandshake('356892080000001'));

    expect(result).toEqual({
      status: 'ok',
      imei: '356892080000001',
      consumed: 17,
    });
  });

  it('waits when only the length prefix has arrived', () => {
    const packet = buildHandshake('356892080000001');

    expect(parseImeiHandshake(packet.subarray(0, 2)).status).toBe('incomplete');
    expect(parseImeiHandshake(packet.subarray(0, 10)).status).toBe(
      'incomplete',
    );
  });

  it('waits on a single byte rather than guessing', () => {
    expect(parseImeiHandshake(Buffer.from([0x00])).status).toBe('incomplete');
  });

  it('rejects a non-numeric imei', () => {
    const packet = Buffer.concat([
      Buffer.from([0x00, 0x0f]),
      Buffer.from('35689208000000X', 'ascii'),
    ]);

    expect(parseImeiHandshake(packet)).toEqual({
      status: 'invalid',
      reason: 'imei is not numeric',
    });
  });

  // Without this, a device sending garbage would leave the socket waiting for bytes forever.
  it('rejects an implausible length instead of waiting', () => {
    const result = parseImeiHandshake(Buffer.from([0xff, 0xff, 0x01]));

    expect(result.status).toBe('invalid');
  });
});

describe('parseFrame with codec 8 telemetry', () => {
  it('decodes coordinates, speed and io flags', () => {
    const packet = buildTelemetryPacket({
      ...NAIROBI,
      speed: 42,
      io: { [IO_IGNITION]: 1, [IO_MOVEMENT]: 1 },
      timestamp: 1_700_000_000_000,
      altitude: 1600,
      angle: 270,
      satellites: 11,
    });

    const frame = parseFrame(packet);

    expect(frame.status).toBe('records');

    if (frame.status !== 'records') {
      throw new Error('expected records');
    }

    expect(frame.consumed).toBe(packet.length);
    expect(frame.records).toHaveLength(1);

    const [record] = frame.records;

    // Rounded because the wire format is fixed-point at 1e-7 degrees.
    expect(record.latitude).toBeCloseTo(NAIROBI.latitude, 6);
    expect(record.longitude).toBeCloseTo(NAIROBI.longitude, 6);
    expect(record.speed).toBe(42);
    expect(record.altitude).toBe(1600);
    expect(record.angle).toBe(270);
    expect(record.satellites).toBe(11);
    expect(record.ignition).toBe(true);
    expect(record.movement).toBe(true);
    expect(record.hasFix).toBe(true);
    expect(record.timestamp.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(record.io).toEqual({ [IO_IGNITION]: 1, [IO_MOVEMENT]: 1 });
  });

  // Latitude and longitude are signed and adjacent on the wire, so swapping them or reading
  // them unsigned is an easy mistake that still produces numbers.
  it('keeps southern and western coordinates negative', () => {
    const frame = parseFrame(
      buildTelemetryPacket({
        latitude: -33.9249,
        longitude: -18.4241,
        speed: 0,
      }),
    );

    if (frame.status !== 'records') {
      throw new Error('expected records');
    }

    expect(frame.records[0].latitude).toBeCloseTo(-33.9249, 6);
    expect(frame.records[0].longitude).toBeCloseTo(-18.4241, 6);
  });

  it('reports a stationary bike with ignition off', () => {
    const frame = parseFrame(
      buildTelemetryPacket({
        ...NAIROBI,
        speed: 0,
        io: { [IO_IGNITION]: 0, [IO_MOVEMENT]: 0 },
      }),
    );

    if (frame.status !== 'records') {
      throw new Error('expected records');
    }

    expect(frame.records[0].speed).toBe(0);
    expect(frame.records[0].ignition).toBe(false);
    expect(frame.records[0].movement).toBe(false);
  });

  // A record with no satellites has no fix. Reporting 0,0 as a position would put the bike in
  // the ocean, and an interlock reading that as "stationary" would be reading nothing at all.
  it('flags a record with no satellites as having no fix', () => {
    const frame = parseFrame(
      buildTelemetryPacket({
        latitude: 0,
        longitude: 0,
        speed: 0,
        satellites: 0,
      }),
    );

    if (frame.status !== 'records') {
      throw new Error('expected records');
    }

    expect(frame.records[0].hasFix).toBe(false);
  });

  it('rejects a packet whose crc does not match', () => {
    const frame = parseFrame(
      buildTelemetryPacket({ ...NAIROBI, speed: 10, corruptCrc: true }),
    );

    expect(frame.status).toBe('invalid');

    if (frame.status !== 'invalid') {
      throw new Error('expected invalid');
    }

    expect(frame.reason).toContain('crc mismatch');
    // Still consumed, so the stream can continue with the next frame.
    expect(frame.consumed).toBeGreaterThan(0);
  });

  it('rejects a packet whose two record counts disagree', () => {
    // The fixture recomputes the crc, so the count check is what fires rather than the checksum.
    const packet = buildTelemetryPacket({
      ...NAIROBI,
      speed: 10,
      mismatchRecordCount: true,
    });

    const frame = parseFrame(packet);

    if (frame.status !== 'invalid') {
      throw new Error('expected invalid');
    }

    expect(frame.reason).toContain('record count mismatch');
  });

  // Guards the check that the records exactly fill the packet. A truncated io group would
  // otherwise be read as a valid record with coordinates taken from the wrong offsets.
  it('rejects a packet whose records do not fill it', () => {
    const packet = buildTelemetryPacket({ ...NAIROBI, speed: 10 });
    const data = packet.subarray(8, packet.length - 4);
    // Claim one fewer 1-byte io property than the packet actually carries.
    data.writeUInt8(1, 28);
    packet.writeUInt32BE(recomputeCrc(data), packet.length - 4);

    const frame = parseFrame(packet);

    if (frame.status !== 'invalid') {
      throw new Error('expected invalid');
    }

    expect(frame.reason).toMatch(/does not fill the packet|truncated/);
  });
});

describe('parseFrame framing', () => {
  const packet = buildTelemetryPacket({ ...NAIROBI, speed: 7 });

  it('waits for the rest of a split packet', () => {
    for (const cut of [1, 4, 8, 12, packet.length - 1]) {
      expect(parseFrame(packet.subarray(0, cut)).status).toBe('incomplete');
    }
  });

  // The bug this guards against: consuming the whole buffer after one packet silently drops
  // everything a device sent back to back, which is what happens in weak signal.
  it('consumes exactly one packet, leaving the next untouched', () => {
    const two = Buffer.concat([packet, packet]);
    const first = parseFrame(two);

    if (first.status !== 'records') {
      throw new Error('expected records');
    }

    expect(first.consumed).toBe(packet.length);

    const second = parseFrame(two.subarray(first.consumed));

    expect(second.status).toBe('records');
  });

  it('refuses a non-zero preamble as unrecoverable', () => {
    const corrupt = Buffer.from(packet);
    corrupt.writeUInt32BE(0xdeadbeef, 0);

    const frame = parseFrame(corrupt);

    expect(frame.status).toBe('unrecoverable');
  });

  it('refuses an implausible length instead of buffering forever', () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0, 0);
    header.writeUInt32BE(MAX_DATA_FIELD_BYTES + 1, 4);

    expect(parseFrame(header).status).toBe('unrecoverable');
  });

  it('refuses a zero length', () => {
    const header = Buffer.alloc(8);

    expect(parseFrame(header).status).toBe('unrecoverable');
  });
});

describe('parseFrame with codec 12', () => {
  it('reads a command response', () => {
    const frame = parseFrame(
      buildCommandResponse('Setdigout 1 OK (Relay OFF / Immobilized)'),
    );

    expect(frame.status).toBe('command-response');

    if (frame.status !== 'command-response') {
      throw new Error('expected command-response');
    }

    expect(frame.response.text).toBe(
      'Setdigout 1 OK (Relay OFF / Immobilized)',
    );
  });
});

describe('parseFrame with unsupported codecs', () => {
  // Codec 8 Extended has a different IO layout. Parsing it as Codec 8 would produce
  // plausible-looking wrong coordinates, so it has to be refused rather than guessed at.
  it('refuses codec 8 extended loudly', () => {
    const frame = parseFrame(
      buildTelemetryPacket({ ...NAIROBI, speed: 5, codecId: 0x8e }),
    );

    if (frame.status !== 'invalid') {
      throw new Error('expected invalid');
    }

    expect(frame.reason).toContain('codec 8 extended');
  });
});

function recomputeCrc(data: Buffer): number {
  let crc = 0x0000;

  for (const byte of data) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }

  return crc & 0xffff;
}
