import { teltonikaCrc16 } from './crc16';

/** Teltonika standard IO ids. Verify against the actual unit's parameter list before trusting. */
export const IO_IGNITION = 239;
export const IO_MOVEMENT = 240;

export const CODEC_8 = 0x08;
export const CODEC_8_EXTENDED = 0x8e;
export const CODEC_12 = 0x0c;

/** Header is preamble (4) + data length (4); the CRC field after the data is 4. */
const HEADER_BYTES = 8;
const CRC_BYTES = 4;

/**
 * Upper bound on a data field. Real frames are far smaller; the limit exists so a garbage
 * length field cannot make the server buffer unbounded data.
 */
export const MAX_DATA_FIELD_BYTES = 8192;

export interface DevicePosition {
  timestamp: Date;
  priority: number;
  latitude: number;
  longitude: number;
  altitude: number;
  angle: number;
  satellites: number;
  /** km/h as reported by the device. */
  speed: number;
  /** IO id that triggered the record, 0 for a periodic report. */
  eventIoId: number;
  /** Every IO property in the record, by id, so nothing is silently dropped. */
  io: Record<number, number>;
  /** Null when the device did not report the property, which is not the same as false. */
  ignition: boolean | null;
  movement: boolean | null;
  /**
   * A record with no satellites carries no usable fix. Teltonika reports 0/0 coordinates in
   * that case, which must not be stored as a position in the Gulf of Guinea.
   */
  hasFix: boolean;
}

export interface CommandResponse {
  text: string;
}

export type ParsedFrame =
  | { status: 'incomplete' }
  | { status: 'records'; consumed: number; records: DevicePosition[] }
  | { status: 'command-response'; consumed: number; response: CommandResponse }
  /** Framed correctly but unusable. The frame is skipped and the connection continues. */
  | { status: 'invalid'; consumed: number; reason: string }
  /** The stream cannot be resynchronised. The caller must close the connection. */
  | { status: 'unrecoverable'; reason: string };

/**
 * Reads one frame from the head of the buffer.
 *
 * Returns how many bytes it consumed so the caller can slice exactly that much and loop. It
 * never consumes more than one frame, and it never throws: a malformed packet from one device
 * must not take down the listener.
 */
export function parseFrame(buffer: Buffer): ParsedFrame {
  if (buffer.length < HEADER_BYTES) {
    return { status: 'incomplete' };
  }

  const preamble = buffer.readUInt32BE(0);

  if (preamble !== 0) {
    // Not a frame boundary, and there is no way to know where the next one starts.
    return {
      status: 'unrecoverable',
      reason: 'expected zero preamble, got 0x' + preamble.toString(16),
    };
  }

  const dataLength = buffer.readUInt32BE(4);

  if (dataLength === 0 || dataLength > MAX_DATA_FIELD_BYTES) {
    return {
      status: 'unrecoverable',
      reason: 'implausible data length ' + String(dataLength),
    };
  }

  const frameLength = HEADER_BYTES + dataLength + CRC_BYTES;

  if (buffer.length < frameLength) {
    return { status: 'incomplete' };
  }

  const data = buffer.subarray(HEADER_BYTES, HEADER_BYTES + dataLength);
  const declaredCrc = buffer.readUInt32BE(HEADER_BYTES + dataLength);
  const computedCrc = teltonikaCrc16(data);

  if (declaredCrc !== computedCrc) {
    return {
      status: 'invalid',
      consumed: frameLength,
      reason:
        'crc mismatch: frame says 0x' +
        declaredCrc.toString(16) +
        ', computed 0x' +
        computedCrc.toString(16),
    };
  }

  const codecId = data.readUInt8(0);

  if (codecId === CODEC_12) {
    return readCommandResponse(data, frameLength);
  }

  if (codecId === CODEC_8_EXTENDED) {
    // Codec 8 Extended uses 2-byte IO ids and counts. Guessing at it would yield
    // plausible-looking wrong coordinates, so it is refused loudly instead. Either configure
    // the device for Codec 8, or implement 8E properly.
    return {
      status: 'invalid',
      consumed: frameLength,
      reason:
        'codec 8 extended (0x8e) is not supported; configure the device for codec 8',
    };
  }

  if (codecId !== CODEC_8) {
    return {
      status: 'invalid',
      consumed: frameLength,
      reason: 'unsupported codec 0x' + codecId.toString(16),
    };
  }

  return readCodec8Records(data, frameLength);
}

function readCodec8Records(data: Buffer, frameLength: number): ParsedFrame {
  const invalid = (reason: string): ParsedFrame => ({
    status: 'invalid',
    consumed: frameLength,
    reason,
  });

  if (data.length < 3) {
    return invalid('data field too short for a codec 8 packet');
  }

  const declaredCount = data.readUInt8(1);
  const trailingCount = data.readUInt8(data.length - 1);

  if (declaredCount === 0) {
    return invalid('record count is zero');
  }

  // The count appears both before and after the records. A mismatch means the packet is not
  // what it claims, even though the CRC passed.
  if (declaredCount !== trailingCount) {
    return invalid(
      'record count mismatch: leading ' +
        String(declaredCount) +
        ', trailing ' +
        String(trailingCount),
    );
  }

  const records: DevicePosition[] = [];
  let offset = 2;

  for (let index = 0; index < declaredCount; index += 1) {
    const record = readRecord(data, offset);

    if ('error' in record) {
      return invalid('record ' + String(index) + ': ' + record.error);
    }

    records.push(record.position);
    offset = record.offset;
  }

  // Everything between the records and the trailing count must be accounted for. Leftover bytes
  // mean the record layout was misread, which is precisely the case where the coordinates look
  // reasonable but are wrong.
  if (offset !== data.length - 1) {
    return invalid(
      'record data does not fill the packet: parsed to ' +
        String(offset) +
        ', trailing count at ' +
        String(data.length - 1),
    );
  }

  return { status: 'records', consumed: frameLength, records };
}

interface RecordOk {
  position: DevicePosition;
  offset: number;
}

interface RecordError {
  error: string;
}

function readRecord(data: Buffer, start: number): RecordOk | RecordError {
  // 8 timestamp + 1 priority + 15 gps + 2 io header = 26 bytes before the IO groups.
  if (start + 26 > data.length) {
    return { error: 'truncated before io header' };
  }

  let offset = start;

  const milliseconds = data.readBigInt64BE(offset);
  offset += 8;
  const priority = data.readUInt8(offset);
  offset += 1;

  const longitude = data.readInt32BE(offset) / 1e7;
  offset += 4;
  const latitude = data.readInt32BE(offset) / 1e7;
  offset += 4;
  const altitude = data.readInt16BE(offset);
  offset += 2;
  const angle = data.readUInt16BE(offset);
  offset += 2;
  const satellites = data.readUInt8(offset);
  offset += 1;
  const speed = data.readUInt16BE(offset);
  offset += 2;

  const eventIoId = data.readUInt8(offset);
  offset += 1;
  // Total property count. Deliberately not used for framing: the per-width counts below are
  // what the layout actually depends on.
  offset += 1;

  const io: Record<number, number> = {};

  for (const width of [1, 2, 4, 8]) {
    if (offset >= data.length) {
      return { error: 'truncated before ' + String(width) + '-byte io count' };
    }

    const count = data.readUInt8(offset);
    offset += 1;

    for (let i = 0; i < count; i += 1) {
      if (offset + 1 + width > data.length) {
        return {
          error: 'truncated inside ' + String(width) + '-byte io group',
        };
      }

      const id = data.readUInt8(offset);
      offset += 1;

      io[id] =
        width === 8
          ? Number(data.readBigInt64BE(offset))
          : data.readUIntBE(offset, width);
      offset += width;
    }
  }

  const timestampMs = Number(milliseconds);

  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    return { error: 'implausible timestamp ' + milliseconds.toString() };
  }

  const readFlag = (id: number): boolean | null =>
    id in io ? io[id] === 1 : null;

  return {
    offset,
    position: {
      timestamp: new Date(timestampMs),
      priority,
      latitude,
      longitude,
      altitude,
      angle,
      satellites,
      speed,
      eventIoId,
      io,
      ignition: readFlag(IO_IGNITION),
      movement: readFlag(IO_MOVEMENT),
      hasFix: satellites > 0,
    },
  };
}

/**
 * A Codec 12 response to a command this server sent:
 * codec id (1) + quantity (1) + type (1) + size (4) + text + quantity (1).
 */
function readCommandResponse(data: Buffer, frameLength: number): ParsedFrame {
  if (data.length < 8) {
    return {
      status: 'invalid',
      consumed: frameLength,
      reason: 'codec 12 frame too short',
    };
  }

  const size = data.readUInt32BE(3);

  if (7 + size > data.length) {
    return {
      status: 'invalid',
      consumed: frameLength,
      reason: 'codec 12 response size ' + String(size) + ' exceeds the frame',
    };
  }

  return {
    status: 'command-response',
    consumed: frameLength,
    response: { text: data.toString('ascii', 7, 7 + size).trim() },
  };
}

export type ImeiHandshake =
  | { status: 'incomplete' }
  | { status: 'ok'; imei: string; consumed: number }
  | { status: 'invalid'; reason: string };

/**
 * The device's first message: a 2-byte length followed by the IMEI in ASCII.
 *
 * Reports 'incomplete' while the prefix or the digits have not all arrived, so a handshake
 * split across TCP segments is waited for rather than rejected.
 */
export function parseImeiHandshake(buffer: Buffer): ImeiHandshake {
  if (buffer.length < 2) {
    return { status: 'incomplete' };
  }

  const length = buffer.readUInt16BE(0);

  // A real IMEI is 15 digits; Teltonika allows 8 to 17 here. Anything outside that is not a
  // handshake at all, and waiting for more bytes would hold the connection open forever.
  if (length < 8 || length > 17) {
    return {
      status: 'invalid',
      reason: 'implausible imei length ' + String(length),
    };
  }

  if (buffer.length < 2 + length) {
    return { status: 'incomplete' };
  }

  const imei = buffer.toString('ascii', 2, 2 + length);

  if (!/^\d+$/.test(imei)) {
    return { status: 'invalid', reason: 'imei is not numeric' };
  }

  return { status: 'ok', imei, consumed: 2 + length };
}
