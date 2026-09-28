import { teltonikaCrc16 } from './crc16';

describe('teltonikaCrc16', () => {
  // Known vectors for CRC-16/ARC, which is what Teltonika uses. Hard-coded rather than
  // computed by a second copy of the algorithm, so the test pins the polynomial itself.
  it('matches known CRC-16/ARC vectors', () => {
    expect(teltonikaCrc16(Buffer.from('', 'ascii'))).toBe(0x0000);
    expect(teltonikaCrc16(Buffer.from('A', 'ascii'))).toBe(0x30c0);
    expect(teltonikaCrc16(Buffer.from('123456789', 'ascii'))).toBe(0xbb3d);
  });

  it('stays within 16 bits', () => {
    const crc = teltonikaCrc16(Buffer.alloc(512, 0xff));

    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xffff);
  });

  it('changes when a single bit changes', () => {
    const a = Buffer.from([0x08, 0x01, 0x00]);
    const b = Buffer.from([0x08, 0x01, 0x01]);

    expect(teltonikaCrc16(a)).not.toBe(teltonikaCrc16(b));
  });
});
