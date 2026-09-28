/**
 * Teltonika CRC-16 implementation.
 *
 * Teltonika uses standard 16-bit CRC with polynomial 0xA001 (bit-reversed 0x8005)
 * initialized to 0x0000.
 *
 * Calculated over the Data Field (from Codec ID to Number of Data 2 inclusive).
 */
export function calculateTeltonikaCrc16(buffer: Buffer): number {
  let crc = 0x0000;

  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x0001) !== 0) {
        crc = (crc >> 1) ^ 0xa001;
      } else {
        crc = crc >> 1;
      }
    }
  }

  return crc & 0xffff;
}
