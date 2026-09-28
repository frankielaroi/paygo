import { teltonikaCrc16 } from './crc16';
import { CODEC_12 } from './codec8-parser';

/**
 * What the protocol layer can ask a device to do. Deliberately the only vocabulary this layer
 * has: it knows nothing about arrears, contracts or why a bike is being locked.
 */
export type DeviceCommand = 'immobilize' | 'restore';

/**
 * Digital output 1 drives the relay in the ignition circuit.
 *
 * WHICH VALUE CUTS THE IGNITION DEPENDS ON THE WIRING, not on the protocol. These values assume
 * the relay is wired so that energising DOUT1 opens the circuit. With a normally-closed relay
 * the meaning is inverted, and shipping the wrong one means "immobilize" starts a bike and
 * "restore" strands a rider.
 *
 * Verify on a bench relay or LED before any vehicle, and re-verify after any wiring change.
 */
const COMMAND_TEXT: Record<DeviceCommand, string> = {
  immobilize: 'setdigout 1',
  restore: 'setdigout 0',
};

/** Codec 12 command type 5 is a command from the server to the device. */
const COMMAND_TYPE_SERVER_TO_DEVICE = 0x05;

export function commandText(command: DeviceCommand): string {
  return COMMAND_TEXT[command];
}

/**
 * Wraps a GPRS command in a Codec 12 frame:
 * preamble (4, zero) + data length (4) + data field + crc (4), where the data field is
 * codec id (1) + quantity (1) + type (1) + command size (4) + command text + quantity (1).
 */
export function encodeCommand(command: DeviceCommand): Buffer {
  return encodeCommandText(commandText(command));
}

export function encodeCommandText(text: string): Buffer {
  const payload = Buffer.from(text, 'ascii');
  const dataField = Buffer.alloc(1 + 1 + 1 + 4 + payload.length + 1);

  let offset = 0;
  dataField.writeUInt8(CODEC_12, offset);
  offset += 1;
  dataField.writeUInt8(1, offset); // quantity, first occurrence
  offset += 1;
  dataField.writeUInt8(COMMAND_TYPE_SERVER_TO_DEVICE, offset);
  offset += 1;
  dataField.writeUInt32BE(payload.length, offset);
  offset += 4;
  payload.copy(dataField, offset);
  offset += payload.length;
  dataField.writeUInt8(1, offset); // quantity, second occurrence

  const frame = Buffer.alloc(4 + 4 + dataField.length + 4);
  frame.writeUInt32BE(0, 0);
  frame.writeUInt32BE(dataField.length, 4);
  dataField.copy(frame, 8);
  frame.writeUInt32BE(teltonikaCrc16(dataField), 8 + dataField.length);

  return frame;
}
