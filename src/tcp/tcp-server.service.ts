import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createServer, type Server, type Socket } from 'node:net';
import type { Env } from '../config/env.validation';
import {
  type DevicePosition,
  parseFrame,
  parseImeiHandshake,
} from './codec8-parser';
import {
  type DeviceCommand,
  commandText,
  encodeCommand,
} from './command-encoder';
import {
  DEVICE_COMMAND_RESPONSE,
  DEVICE_CONNECTED,
  DEVICE_DISCONNECTED,
  DEVICE_POSITIONS,
  type DeviceCommandResponseEvent,
  type DeviceConnectedEvent,
  type DeviceDisconnectedEvent,
  type DevicePositionsEvent,
} from './tcp.events';

const HANDSHAKE_ACCEPTED = Buffer.from([0x01]);
const HANDSHAKE_REJECTED = Buffer.from([0x00]);

/** Guard against a device that connects and then says nothing, holding a socket open. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Cap on buffered bytes for one connection before the handshake completes. A device that never
 * sends a valid handshake must not be able to grow this indefinitely.
 */
const MAX_PENDING_BYTES = 64 * 1024;

interface DeviceConnection {
  imei: string;
  socket: Socket;
  remoteAddress: string;
  connectedAt: Date;
  lastSeenAt: Date;
}

export type CommandResult =
  | { delivered: true; command: DeviceCommand; text: string }
  | {
      delivered: false;
      reason: 'not-connected' | 'write-failed';
      detail?: string;
    };

/**
 * The only part of the application that speaks the tracker's binary protocol.
 *
 * It knows nothing about contracts, arrears or why a bike is being immobilized. It keeps the
 * IMEI to socket map, decodes and acknowledges incoming packets, emits what it decoded as
 * events, and writes command bytes when something else asks it to.
 *
 * sendCommand fires unconditionally. The stationary safety interlock lives in enforcement,
 * never here (see CLAUDE.md).
 */
@Injectable()
export class TcpServerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TcpServerService.name);
  private readonly connections = new Map<string, DeviceConnection>();
  /**
   * Every open socket, including ones that have not completed a handshake and so have no IMEI.
   * Without this, shutdown hangs: server.close() waits for existing connections to end, and a
   * device that connected but never identified itself is not in the IMEI map to be destroyed.
   */
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly events: EventEmitter2,
  ) {}

  onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('TCP_DEVICE_ENABLED', { infer: true })) {
      this.logger.warn('Device TCP listener disabled by TCP_DEVICE_ENABLED');
      return Promise.resolve();
    }

    return this.listen(this.config.get('TCP_DEVICE_PORT', { infer: true }));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  listen(port: number): Promise<void> {
    const server = createServer((socket) => {
      this.handleConnection(socket);
    });

    // An error on the server itself (a port already in use, for instance) must not be an
    // unhandled event that takes the process down.
    server.on('error', (error: Error) => {
      this.logger.error(`Device listener error: ${error.message}`);
    });

    this.server = server;

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.removeListener('error', reject);
        this.logger.log(`Device TCP listener on port ${this.port()}`);
        resolve();
      });
    });
  }

  /** The bound port, which differs from the configured one when port 0 was requested. */
  port(): number | null {
    const address = this.server?.address();

    return address !== null && typeof address === 'object'
      ? address.port
      : null;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.connections.clear();

    const server = this.server;

    if (!server) {
      return;
    }

    this.server = null;

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  /** IMEIs with an open socket right now. Not proof any of them is reachable. */
  connectedImeis(): string[] {
    return [...this.connections.keys()];
  }

  isConnected(imei: string): boolean {
    return this.connections.has(imei);
  }

  /**
   * Writes a command to a device's open socket.
   *
   * Reports not-connected rather than throwing or hanging, because the caller has to be able to
   * tell "the device refused" from "the device was not reachable". Delivery here is not
   * confirmation: a successful write only means the bytes left this process. Confirmation comes
   * from the device's Codec 12 response, emitted as a separate event.
   */
  sendCommand(imei: string, command: DeviceCommand): CommandResult {
    const connection = this.connections.get(imei);

    if (!connection) {
      this.logger.warn(
        `Cannot send ${command} to ${imei}: device is not connected`,
      );

      return { delivered: false, reason: 'not-connected' };
    }

    const text = commandText(command);

    try {
      connection.socket.write(encodeCommand(command));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Write of ${command} to ${imei} failed: ${detail}`);

      return { delivered: false, reason: 'write-failed', detail };
    }

    this.logger.log(`Sent ${command} ("${text}") to ${imei}`);

    return { delivered: true, command, text };
  }

  private handleConnection(socket: Socket): void {
    const remoteAddress = socket.remoteAddress ?? 'unknown';
    let buffer: Buffer = Buffer.alloc(0);
    let imei: string | null = null;

    this.sockets.add(socket);
    socket.setNoDelay(true);

    const handshakeTimer = setTimeout(() => {
      if (imei === null) {
        this.logger.warn(`No handshake from ${remoteAddress}, closing`);
        socket.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const drop = (reason: string): void => {
      this.logger.warn(
        `Closing connection ${imei ?? remoteAddress}: ${reason}`,
      );
      socket.destroy();
    };

    socket.on('data', (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);

        if (imei === null) {
          if (buffer.length > MAX_PENDING_BYTES) {
            socket.write(HANDSHAKE_REJECTED);
            drop('handshake buffer overflow');
            return;
          }

          const handshake = parseImeiHandshake(buffer);

          if (handshake.status === 'incomplete') {
            return;
          }

          if (handshake.status === 'invalid') {
            socket.write(HANDSHAKE_REJECTED);
            drop(`rejected handshake: ${handshake.reason}`);
            return;
          }

          imei = handshake.imei;
          buffer = buffer.subarray(handshake.consumed);
          clearTimeout(handshakeTimer);

          socket.write(HANDSHAKE_ACCEPTED);
          this.register(handshake.imei, socket, remoteAddress);
        }

        buffer = this.consumeFrames(imei, buffer, socket, drop);
      } catch (error) {
        // One device sending something unexpected must never take down the listener.
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Unhandled error handling data from ${imei ?? remoteAddress}: ${detail}`,
        );
        socket.destroy();
      }
    });

    socket.on('error', (error: Error) => {
      // Expected constantly in the field: resets, timeouts, dropped signal.
      this.logger.warn(
        `Socket error for ${imei ?? remoteAddress}: ${error.message}`,
      );
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.sockets.delete(socket);

      if (imei !== null) {
        this.unregister(imei, socket);
      }
    });
  }

  /**
   * Parses as many whole frames as the buffer holds and returns what is left.
   *
   * TCP is a stream: a chunk can hold several frames, or half of one. Consuming exactly the
   * bytes each frame reports is what keeps back-to-back packets from being dropped, which is
   * what happens in weak signal, exactly when the data matters most.
   */
  private consumeFrames(
    imei: string,
    input: Buffer,
    socket: Socket,
    drop: (reason: string) => void,
  ): Buffer {
    let buffer = input;

    for (;;) {
      if (buffer.length === 0) {
        return buffer;
      }

      const frame = parseFrame(buffer);

      if (frame.status === 'incomplete') {
        return buffer;
      }

      if (frame.status === 'unrecoverable') {
        drop(`cannot resynchronise stream: ${frame.reason}`);
        return Buffer.alloc(0);
      }

      buffer = buffer.subarray(frame.consumed);

      if (frame.status === 'invalid') {
        // Deliberately not acknowledged. The device resends, which is the behaviour that makes
        // a corrupted packet recoverable instead of lost.
        this.logger.warn(`Discarded frame from ${imei}: ${frame.reason}`);
        continue;
      }

      if (frame.status === 'command-response') {
        this.touch(imei);
        this.logger.log(
          `Command response from ${imei}: "${frame.response.text}"`,
        );
        this.events.emit(DEVICE_COMMAND_RESPONSE, {
          imei,
          text: frame.response.text,
          receivedAt: new Date(),
        } satisfies DeviceCommandResponseEvent);
        continue;
      }

      this.acknowledge(socket, frame.records.length);
      this.touch(imei);
      this.emitPositions(imei, frame.records);
    }
  }

  /**
   * Acknowledges with the number of records accepted. The device keeps unacknowledged records
   * in its own memory and resends them, so getting this count right is what stops it from
   * retrying and draining its battery.
   */
  private acknowledge(socket: Socket, recordCount: number): void {
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(recordCount, 0);
    socket.write(ack);
  }

  private emitPositions(imei: string, records: DevicePosition[]): void {
    for (const record of records) {
      // Debug level: useful when commissioning a device, too noisy for a fleet. Coordinates are
      // logged so a new unit can be checked against its actual known location rather than
      // "some numbers arrived".
      this.logger.debug(
        `${imei} ${record.timestamp.toISOString()} ` +
          `lat=${record.latitude} lng=${record.longitude} ` +
          `speed=${record.speed} ignition=${String(record.ignition)} ` +
          `movement=${String(record.movement)} fix=${String(record.hasFix)}`,
      );
    }

    // Emitted rather than written here: this layer owns no storage and makes no decisions.
    // Listeners persist and enforce (see CLAUDE.md).
    this.events.emit(DEVICE_POSITIONS, {
      imei,
      records,
      receivedAt: new Date(),
    } satisfies DevicePositionsEvent);
  }

  private register(imei: string, socket: Socket, remoteAddress: string): void {
    const existing = this.connections.get(imei);

    if (existing && existing.socket !== socket) {
      // A reconnect before the old socket was noticed as dead. The newest socket is the live
      // one; the superseded one is destroyed so it does not leak or receive commands.
      this.logger.warn(`${imei} reconnected, replacing previous connection`);
      existing.socket.destroy();
    }

    const now = new Date();

    this.connections.set(imei, {
      imei,
      socket,
      remoteAddress,
      connectedAt: now,
      lastSeenAt: now,
    });

    this.logger.log(`${imei} connected from ${remoteAddress}`);
    this.events.emit(DEVICE_CONNECTED, {
      imei,
      remoteAddress,
      connectedAt: now,
    } satisfies DeviceConnectedEvent);
  }

  private unregister(imei: string, socket: Socket): void {
    const current = this.connections.get(imei);

    // Only remove the entry if it still points at this socket. Otherwise the close event of a
    // socket that was already replaced would delete the live connection's entry, and the device
    // would look offline while it is not.
    if (!current || current.socket !== socket) {
      return;
    }

    this.connections.delete(imei);
    this.logger.log(`${imei} disconnected`);
    this.events.emit(DEVICE_DISCONNECTED, {
      imei,
      disconnectedAt: new Date(),
    } satisfies DeviceDisconnectedEvent);
  }

  private touch(imei: string): void {
    const connection = this.connections.get(imei);

    if (connection) {
      connection.lastSeenAt = new Date();
    }
  }
}
