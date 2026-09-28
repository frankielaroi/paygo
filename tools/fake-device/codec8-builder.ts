import { calculateTeltonikaCrc16 } from './crc16';

export interface TelemetryDataOptions {
  timestamp?: number;
  priority?: number;
  latitude: number;
  longitude: number;
  altitude?: number;
  angle?: number;
  satellites?: number;
  speed: number;
  ignition?: boolean;
  movement?: boolean;
  corruptCrc?: boolean;
  corruptData?: boolean;
}

export interface IncomingCommand {
  codecId: number;
  commandText: string;
  raw: Buffer;
}

/**
 * Builds the Teltonika 2-byte length + ASCII IMEI handshake packet.
 */
export function buildHandshakePacket(imei: string): Buffer {
  const imeiBuffer = Buffer.from(imei, 'ascii');
  const buffer = Buffer.alloc(2 + imeiBuffer.length);

  buffer.writeUInt16BE(imeiBuffer.length, 0);
  imeiBuffer.copy(buffer, 2);

  return buffer;
}

/**
 * Builds a Codec 8 packet containing several AVL records, which is what a real device sends
 * after it has been offline and has records stored in its own memory.
 */
export function buildCodec8Batch(records: TelemetryDataOptions[]): Buffer {
  if (records.length === 0) {
    throw new Error('a codec 8 packet must contain at least one record');
  }

  if (records.length > 255) {
    throw new Error('codec 8 carries at most 255 records per packet');
  }

  const encoded = records.map(buildAvlRecord);
  const body = Buffer.concat(encoded);

  // Codec ID (1) + record count (1) + records + record count (1)
  const dataField = Buffer.alloc(2 + body.length + 1);
  dataField.writeUInt8(0x08, 0);
  dataField.writeUInt8(records.length, 1);
  body.copy(dataField, 2);

  // The trailing count must match the leading one. A server that checks both will reject the
  // packet when corruptData is set, which is the point of that flag.
  const corruptData = records.some((record) => record.corruptData);
  dataField.writeUInt8(corruptData ? 99 : records.length, dataField.length - 1);

  let crc = calculateTeltonikaCrc16(dataField);

  if (records.some((record) => record.corruptCrc)) {
    crc ^= 0xffff;
  }

  const packet = Buffer.alloc(4 + 4 + dataField.length + 4);
  packet.writeUInt32BE(0, 0);
  packet.writeUInt32BE(dataField.length, 4);
  dataField.copy(packet, 8);
  packet.writeUInt32BE(crc, 8 + dataField.length);

  return packet;
}

/**
 * Builds a single-record Codec 8 AVL Telemetry Data Packet.
 */
export function buildCodec8Packet(options: TelemetryDataOptions): Buffer {
  return buildCodec8Batch([options]);
}

/**
 * One AVL record: header (9) + GPS (15) + IO (10) = 34 bytes with two one-byte IO properties.
 */
function buildAvlRecord(options: TelemetryDataOptions): Buffer {
  const timestamp = BigInt(options.timestamp ?? Date.now());
  const priority = options.priority ?? 0;
  const latInt = Math.round(options.latitude * 10_000_000);
  const lngInt = Math.round(options.longitude * 10_000_000);
  const alt = options.altitude ?? 1600;
  const angle = options.angle ?? 0;
  const sats = options.satellites ?? 12;
  const speed = options.speed;
  const ignition = options.ignition ?? false;
  const movement = options.movement ?? false;

  // Record header (9 bytes) + GPS (15 bytes) + IO (10 bytes) = 34 bytes
  const avlRecord = Buffer.alloc(34);
  let offset = 0;

  // Timestamp (8 bytes)
  avlRecord.writeBigInt64BE(timestamp, offset);
  offset += 8;

  // Priority (1 byte)
  avlRecord.writeUInt8(priority, offset);
  offset += 1;

  // GPS Element (15 bytes)
  avlRecord.writeInt32BE(lngInt, offset); // Longitude (4 bytes)
  offset += 4;
  avlRecord.writeInt32BE(latInt, offset); // Latitude (4 bytes)
  offset += 4;
  avlRecord.writeInt16BE(alt, offset); // Altitude (2 bytes)
  offset += 2;
  avlRecord.writeUInt16BE(angle, offset); // Angle (2 bytes)
  offset += 2;
  avlRecord.writeUInt8(sats, offset); // Satellites (1 byte)
  offset += 1;
  avlRecord.writeUInt16BE(speed, offset); // Speed (2 bytes)
  offset += 2;

  // IO Element (10 bytes)
  avlRecord.writeUInt8(0, offset); // Event IO ID (0 = periodic)
  offset += 1;
  avlRecord.writeUInt8(2, offset); // Total N of properties (2)
  offset += 1;

  // N1 (1-byte IO count = 2)
  avlRecord.writeUInt8(2, offset);
  offset += 1;

  // IO 239: Ignition (1 byte ID + 1 byte value)
  avlRecord.writeUInt8(239, offset);
  offset += 1;
  avlRecord.writeUInt8(ignition ? 1 : 0, offset);
  offset += 1;

  // IO 240: Movement (1 byte ID + 1 byte value)
  avlRecord.writeUInt8(240, offset);
  offset += 1;
  avlRecord.writeUInt8(movement ? 1 : 0, offset);
  offset += 1;

  // N2 (2-byte IO count = 0)
  avlRecord.writeUInt8(0, offset);
  offset += 1;

  // N4 (4-byte IO count = 0)
  avlRecord.writeUInt8(0, offset);
  offset += 1;

  // N8 (8-byte IO count = 0)
  avlRecord.writeUInt8(0, offset);
  offset += 1;

  return avlRecord;
}

/**
 * Parses incoming server command frames (Codec 12 / Codec 8 command).
 */
export function parseServerCommand(buffer: Buffer): IncomingCommand | null {
  if (buffer.length < 12) {
    return null; // Not enough bytes for header
  }

  const preamble = buffer.readUInt32BE(0);
  if (preamble !== 0) {
    return null;
  }

  const dataLength = buffer.readUInt32BE(4);
  if (buffer.length < 8 + dataLength + 4) {
    return null; // Partial packet
  }

  const codecId = buffer.readUInt8(8);

  if (codecId === 0x0c) {
    // Codec 12 Command Packet
    // Header layout:
    // [0..3]: Preamble
    // [4..7]: Length
    // [8]: Codec ID 0x0C
    // [9]: Command Quantity 1
    // [10]: Command Type
    // [11..14]: Size of command
    // [15..15+size-1]: Command text
    let commandText = '';
    if (buffer.length >= 15) {
      const commandSize = buffer.readUInt32BE(11);
      if (buffer.length >= 15 + commandSize) {
        commandText = buffer.toString('ascii', 15, 15 + commandSize);
      } else {
        commandText = buffer.toString('ascii', 11, 8 + dataLength - 1);
      }
    } else {
      commandText = buffer.toString('ascii', 10, 8 + dataLength - 1);
    }

    return {
      codecId,
      commandText: commandText.trim(),
      raw: buffer.subarray(0, 8 + dataLength + 4),
    };
  }

  // Generic fallback if server sent plain command text or other codec
  const text = buffer
    .subarray(8, 8 + dataLength)
    .toString('ascii')
    .trim();
  return {
    codecId,
    commandText: text,
    raw: buffer.subarray(0, 8 + dataLength + 4),
  };
}

/**
 * Builds Codec 12 Command Response packet to send back to server.
 */
export function buildCodec12CommandResponse(responseText: string): Buffer {
  const respBuffer = Buffer.from(responseText, 'ascii');

  // Data Field: Codec ID (1) + Quantity 1 (1) + Type (1) + RespSize (4) + RespText (N) + Quantity 2 (1)
  const dataField = Buffer.alloc(1 + 1 + 1 + 4 + respBuffer.length + 1);
  let offset = 0;

  dataField.writeUInt8(0x0c, offset++); // Codec 12
  dataField.writeUInt8(1, offset++); // Quantity 1
  // Type 6 is a response from the device. Type 5 is a command from the server, which is what a
  // real unit would never send back.
  dataField.writeUInt8(6, offset++);
  dataField.writeUInt32BE(respBuffer.length, offset); // Size
  offset += 4;
  respBuffer.copy(dataField, offset);
  offset += respBuffer.length;
  dataField.writeUInt8(1, offset++); // Quantity 2

  const crc = calculateTeltonikaCrc16(dataField);

  const packet = Buffer.alloc(4 + 4 + dataField.length + 4);
  packet.writeUInt32BE(0, 0); // Preamble
  packet.writeUInt32BE(dataField.length, 4); // Data Length
  dataField.copy(packet, 8);
  packet.writeUInt32BE(crc, 8 + dataField.length);

  return packet;
}
