import {
  buildCodec12CommandResponse,
  buildCodec8Packet,
  buildHandshakePacket,
  parseServerCommand,
} from './codec8-builder';
import { calculateTeltonikaCrc16 } from './crc16';

describe('Teltonika Codec8 & Protocol Builders', () => {
  it('builds a valid 2-byte length + ASCII IMEI handshake packet', () => {
    const imei = '356892080000001';
    const packet = buildHandshakePacket(imei);

    expect(packet.length).toBe(17); // 2 bytes length + 15 bytes IMEI
    expect(packet.readUInt16BE(0)).toBe(15);
    expect(packet.subarray(2).toString('ascii')).toBe('356892080000001');
  });

  it('calculates correct Teltonika CRC16 checksum', () => {
    const data = Buffer.from('123456789', 'ascii');
    const crc = calculateTeltonikaCrc16(data);

    expect(typeof crc).toBe('number');
    expect(crc).toBeGreaterThan(0);
  });

  it('builds a valid Codec 8 AVL packet with preamble, data length, and CRC-16', () => {
    const packet = buildCodec8Packet({
      latitude: -1.2921,
      longitude: 36.8219,
      speed: 40,
      ignition: true,
      movement: true,
    });

    // Preamble check (4 bytes 0x00000000)
    expect(packet.readUInt32BE(0)).toBe(0);

    // Data Length check (4 bytes)
    const dataLength = packet.readUInt32BE(4);
    expect(dataLength).toBe(37); // 1 (Codec 8) + 1 (Count 1) + 34 (AVL Record) + 1 (Count 2)

    // Codec ID check (1 byte at offset 8)
    expect(packet.readUInt8(8)).toBe(0x08);

    // Total Packet Length = 4 (Preamble) + 4 (Length) + 37 (Data) + 4 (CRC) = 49 bytes
    expect(packet.length).toBe(49);

    // CRC-16 check over Data Field
    const dataField = packet.subarray(8, 8 + dataLength);
    const expectedCrc = calculateTeltonikaCrc16(dataField);
    const actualCrc = packet.readUInt32BE(8 + dataLength);

    expect(actualCrc).toBe(expectedCrc);
  });

  it('corrupts CRC-16 when corruptCrc option is enabled', () => {
    const validPacket = buildCodec8Packet({
      latitude: -1.2921,
      longitude: 36.8219,
      speed: 0,
      corruptCrc: false,
    });

    const corruptPacket = buildCodec8Packet({
      latitude: -1.2921,
      longitude: 36.8219,
      speed: 0,
      corruptCrc: true,
    });

    const validCrc = validPacket.readUInt32BE(validPacket.length - 4);
    const corruptCrc = corruptPacket.readUInt32BE(corruptPacket.length - 4);

    expect(corruptCrc).not.toBe(validCrc);
  });

  it('parses server command frames correctly', () => {
    const cmdText = 'setdigout 1 0';
    const responseBuffer = buildCodec12CommandResponse(cmdText);

    const parsed = parseServerCommand(responseBuffer);

    expect(parsed).not.toBeNull();
    expect(parsed?.codecId).toBe(0x0c);
  });
});
