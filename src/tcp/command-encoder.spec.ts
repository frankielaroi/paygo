import { decodeCommandFrame } from './codec8-fixtures';
import { parseFrame } from './codec8-parser';
import {
  commandFromResponse,
  commandText,
  encodeCommand,
} from './command-encoder';

describe('encodeCommand', () => {
  // Decoded by the fixture, which is a separate implementation, so this checks the frame against
  // something that did not build it.
  it('produces a codec 12 frame the device can read', () => {
    const decoded = decodeCommandFrame(encodeCommand('immobilize'));

    expect(decoded).not.toBeNull();
    expect(decoded?.codecId).toBe(0x0c);
    expect(decoded?.text).toBe('setdigout 1');
    expect(decoded?.crcValid).toBe(true);
  });

  it('distinguishes immobilize from restore', () => {
    expect(commandText('immobilize')).toBe('setdigout 1');
    expect(commandText('restore')).toBe('setdigout 0');
    expect(encodeCommand('immobilize').equals(encodeCommand('restore'))).toBe(
      false,
    );
  });

  it('writes a valid crc, so the device will not discard the command', () => {
    // Parsing our own frame exercises the crc path: a bad crc would come back as invalid.
    const frame = parseFrame(encodeCommand('restore'));

    expect(frame.status).toBe('command-response');
  });

  it('declares a length that matches the frame', () => {
    const frame = encodeCommand('immobilize');
    const dataLength = frame.readUInt32BE(4);

    expect(frame.readUInt32BE(0)).toBe(0);
    expect(frame.length).toBe(8 + dataLength + 4);
  });
});

describe('commandFromResponse', () => {
  it('reads the state from an echoed setdigout reply', () => {
    expect(
      commandFromResponse('Setdigout 1 OK (Relay OFF / Immobilized)'),
    ).toBe('immobilize');
    expect(commandFromResponse('Setdigout 0 OK (Relay ON / Restored)')).toBe(
      'restore',
    );
  });

  it('reads the state from an output report', () => {
    expect(commandFromResponse('DOUT1:1 DOUT2:0 Timeout:INFINITY')).toBe(
      'immobilize',
    );
    expect(commandFromResponse('DOUT1:0 DOUT2:1')).toBe('restore');
  });

  it('returns null for a reply that does not state DOUT1, never a guess', () => {
    expect(commandFromResponse('Command executed OK')).toBeNull();
    expect(commandFromResponse('DOUT2:1')).toBeNull();
    expect(commandFromResponse('')).toBeNull();
  });

  it('round-trips every command through the text it sends', () => {
    expect(commandFromResponse(commandText('immobilize'))).toBe('immobilize');
    expect(commandFromResponse(commandText('restore'))).toBe('restore');
  });
});
