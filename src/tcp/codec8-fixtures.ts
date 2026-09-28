/**
 * Packet builders for the parser specs.
 *
 * Deliberately a separate encoder from `codec8-parser.ts`, and with its own CRC loop rather than
 * an import of `crc16.ts`: if the code that builds test packets and the code under test shared an
 * implementation, a misreading of the Teltonika spec would agree with itself and every test would
 * pass. `crc16.spec.ts` pins the real CRC against published CRC-16/ARC vectors, which is what
 * anchors both.
 *
 * This duplicates part of `tools/fake-device`, which is git-ignored and therefore cannot be a
 * dependency of the committed test suite. The simulator remains the way to exercise a running
 * server; this is the way to exercise the parser.
 *
 * Not a .spec.ts file, so Jest does not treat it as a suite.
 */

function crc16(data: Buffer): number {
  let crc = 0;

  for (const byte of data) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }

  return crc & 0xffff;
}

/** Wraps a data field as preamble (4, zero) + length (4) + data + crc (4). */
function frame(dataField: Buffer, crcOverride?: number): Buffer {
  const packet = Buffer.alloc(8 + dataField.length + 4);

  packet.writeUInt32BE(0, 0);
  packet.writeUInt32BE(dataField.length, 4);
  dataField.copy(packet, 8);
  packet.writeUInt32BE(crcOverride ?? crc16(dataField), 8 + dataField.length);

  return packet;
}

export function buildHandshake(imei: string): Buffer {
  const ascii = Buffer.from(imei, 'ascii');
  const packet = Buffer.alloc(2 + ascii.length);

  packet.writeUInt16BE(ascii.length, 0);
  ascii.copy(packet, 2);

  return packet;
}

export interface RecordOptions {
  timestamp?: number;
  priority?: number;
  latitude: number;
  longitude: number;
  altitude?: number;
  angle?: number;
  satellites?: number;
  speed: number;
  eventIoId?: number;
  /** One-byte IO properties, by id. Omit ignition (239) or movement (240) to leave them unreported. */
  io?: Record<number, number>;
}

/** One AVL record: 8 timestamp + 1 priority + 15 gps + io header + io groups. */
function buildRecord(options: RecordOptions): Buffer {
  const io = options.io ?? {};
  const ids = Object.keys(io).map(Number);

  // 26 bytes of header and gps, plus the four group counts (N1, N2, N4, N8), plus two bytes per
  // one-byte io property.
  const record = Buffer.alloc(30 + ids.length * 2);
  let offset = 0;

  record.writeBigInt64BE(BigInt(options.timestamp ?? Date.now()), offset);
  offset += 8;
  record.writeUInt8(options.priority ?? 0, offset);
  offset += 1;

  record.writeInt32BE(Math.round(options.longitude * 1e7), offset);
  offset += 4;
  record.writeInt32BE(Math.round(options.latitude * 1e7), offset);
  offset += 4;
  record.writeInt16BE(options.altitude ?? 1600, offset);
  offset += 2;
  record.writeUInt16BE(options.angle ?? 0, offset);
  offset += 2;
  record.writeUInt8(options.satellites ?? 12, offset);
  offset += 1;
  record.writeUInt16BE(options.speed, offset);
  offset += 2;

  record.writeUInt8(options.eventIoId ?? 0, offset);
  offset += 1;
  record.writeUInt8(ids.length, offset); // total property count
  offset += 1;

  record.writeUInt8(ids.length, offset); // one-byte properties
  offset += 1;

  for (const id of ids) {
    record.writeUInt8(id, offset);
    offset += 1;
    record.writeUInt8(io[id], offset);
    offset += 1;
  }

  record.writeUInt8(0, offset); // two-byte
  offset += 1;
  record.writeUInt8(0, offset); // four-byte
  offset += 1;
  record.writeUInt8(0, offset); // eight-byte

  return record;
}

export interface TelemetryOptions extends RecordOptions {
  /** Flip the CRC so the packet fails validation. */
  corruptCrc?: boolean;
  /** Write a trailing record count that disagrees with the leading one. */
  mismatchRecordCount?: boolean;
  /** Override the codec id, for testing unsupported codecs. */
  codecId?: number;
}

export function buildTelemetryPacket(options: TelemetryOptions): Buffer {
  return buildMultiRecordPacket([options], options);
}

export function buildMultiRecordPacket(
  records: RecordOptions[],
  options: Omit<TelemetryOptions, keyof RecordOptions> = {},
): Buffer {
  const encoded = records.map(buildRecord);
  const body = Buffer.concat(encoded);
  const dataField = Buffer.alloc(2 + body.length + 1);

  dataField.writeUInt8(options.codecId ?? 0x08, 0);
  dataField.writeUInt8(records.length, 1);
  body.copy(dataField, 2);
  dataField.writeUInt8(
    options.mismatchRecordCount ? records.length + 1 : records.length,
    dataField.length - 1,
  );

  const crc = crc16(dataField);

  return frame(dataField, options.corruptCrc ? crc ^ 0xffff : crc);
}

/** A Codec 12 response, as a device sends after executing a command. */
export function buildCommandResponse(text: string): Buffer {
  const payload = Buffer.from(text, 'ascii');
  const dataField = Buffer.alloc(1 + 1 + 1 + 4 + payload.length + 1);

  let offset = 0;
  dataField.writeUInt8(0x0c, offset);
  offset += 1;
  dataField.writeUInt8(1, offset);
  offset += 1;
  dataField.writeUInt8(0x06, offset); // type 6: device to server
  offset += 1;
  dataField.writeUInt32BE(payload.length, offset);
  offset += 4;
  payload.copy(dataField, offset);
  offset += payload.length;
  dataField.writeUInt8(1, offset);

  return frame(dataField);
}

/**
 * Decodes a Codec 12 command frame the way a device would, so the encoder is checked by
 * something other than itself.
 */
export function decodeCommandFrame(
  packet: Buffer,
): { codecId: number; text: string; crcValid: boolean } | null {
  if (packet.length < 12 || packet.readUInt32BE(0) !== 0) {
    return null;
  }

  const length = packet.readUInt32BE(4);

  if (packet.length < 8 + length + 4) {
    return null;
  }

  const dataField = packet.subarray(8, 8 + length);
  const size = dataField.readUInt32BE(3);

  return {
    codecId: dataField.readUInt8(0),
    text: dataField.toString('ascii', 7, 7 + size),
    crcValid: packet.readUInt32BE(8 + length) === crc16(dataField),
  };
}
