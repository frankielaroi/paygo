/**
 * Teltonika CRC-16/IBM (reflected, polynomial 0xA001, init 0x0000), computed over the data
 * field only: codec id through the trailing record count, excluding preamble, length and the
 * CRC field itself.
 *
 * The test fixtures and the device simulator carry their own copies of this loop on purpose. If
 * the code that generates test packets and the code that validates them shared an implementation,
 * a wrong polynomial would agree with itself and every test would pass. crc16.spec.ts pins this
 * one against published CRC-16/ARC vectors.
 */
export function teltonikaCrc16(data: Buffer): number {
  let crc = 0x0000;

  for (const byte of data) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }

  return crc & 0xffff;
}
