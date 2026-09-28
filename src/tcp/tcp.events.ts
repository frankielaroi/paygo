import type { DevicePosition } from './codec8-parser';

/**
 * Event names the device layer emits. Listeners subscribe with @OnEvent from
 * @nestjs/event-emitter; nothing in this module knows who is listening, which is what keeps the
 * protocol layer free of business logic.
 */
export const DEVICE_CONNECTED = 'device.connected';
export const DEVICE_DISCONNECTED = 'device.disconnected';
export const DEVICE_POSITIONS = 'device.positions';
export const DEVICE_COMMAND_RESPONSE = 'device.command-response';

export interface DeviceConnectedEvent {
  imei: string;
  remoteAddress: string;
  connectedAt: Date;
}

export interface DeviceDisconnectedEvent {
  imei: string;
  disconnectedAt: Date;
}

export interface DevicePositionsEvent {
  imei: string;
  /** Every record from one packet, in the order the device sent them. */
  records: DevicePosition[];
  receivedAt: Date;
}

/**
 * The device's reply to a command. This, or subsequent telemetry, is the only thing that
 * confirms a command took effect. A successful socket write does not.
 */
export interface DeviceCommandResponseEvent {
  imei: string;
  text: string;
  receivedAt: Date;
}
