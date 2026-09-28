import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Socket, createConnection } from 'node:net';
import {
  buildCommandResponse,
  buildHandshake,
  buildTelemetryPacket,
} from './codec8-fixtures';
import type { Env } from '../config/env.validation';
import { encodeCommand } from './command-encoder';
import { TcpServerService } from './tcp-server.service';
import {
  DEVICE_COMMAND_RESPONSE,
  DEVICE_CONNECTED,
  DEVICE_DISCONNECTED,
  DEVICE_POSITIONS,
  type DeviceCommandResponseEvent,
  type DeviceDisconnectedEvent,
  type DevicePositionsEvent,
} from './tcp.events';

const IMEI_A = '356892080000001';
const IMEI_B = '356892080000002';
const NAIROBI = { latitude: -1.2921, longitude: 36.8219 };

/**
 * Drives the real service over real loopback sockets on an ephemeral port. The protocol layer's
 * job is stream handling and connection bookkeeping, and neither can be tested through a mocked
 * socket: framing bugs only appear when bytes actually arrive split or back to back.
 */
describe('TcpServerService', () => {
  let service: TcpServerService;
  let events: EventEmitter2;
  let port: number;
  const clients: Socket[] = [];

  beforeEach(async () => {
    events = new EventEmitter2();

    const config = {
      get: jest.fn((key: string) => (key === 'TCP_DEVICE_ENABLED' ? true : 0)),
    } as unknown as ConfigService<Env, true>;

    service = new TcpServerService(config, events);
    await service.listen(0);

    const bound = service.port();

    if (bound === null) {
      throw new Error('listener did not bind');
    }

    port = bound;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy();
    }

    await service.close();
  });

  /** A raw client that queues received chunks so a test can await the next one. */
  function connect(): {
    socket: Socket;
    next: () => Promise<Buffer>;
    closed: Promise<void>;
  } {
    const socket = createConnection({ port, host: '127.0.0.1' });
    clients.push(socket);

    const queue: Buffer[] = [];
    let waiting: ((chunk: Buffer) => void) | null = null;

    socket.on('data', (chunk: Buffer) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(chunk);
        return;
      }

      queue.push(chunk);
    });

    const closed = new Promise<void>((resolve) => {
      socket.on('close', () => {
        resolve();
      });
    });

    // Swallow resets: the server destroying a connection is expected in several tests.
    socket.on('error', () => undefined);

    return {
      socket,
      closed,
      next: () =>
        new Promise<Buffer>((resolve, reject) => {
          const queued = queue.shift();

          if (queued) {
            resolve(queued);
            return;
          }

          const timer = setTimeout(() => {
            reject(new Error('timed out waiting for bytes from the server'));
          }, 2000);

          waiting = (chunk) => {
            clearTimeout(timer);
            resolve(chunk);
          };
        }),
    };
  }

  async function handshake(imei: string): Promise<ReturnType<typeof connect>> {
    const client = connect();
    client.socket.write(buildHandshake(imei));

    const reply = await client.next();
    expect(reply[0]).toBe(0x01);

    return client;
  }

  function once<T>(event: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${event}`));
      }, 2000);

      events.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  describe('handshake', () => {
    it('accepts a valid imei and records the connection', async () => {
      const connected = once(DEVICE_CONNECTED);
      await handshake(IMEI_A);
      await connected;

      expect(service.isConnected(IMEI_A)).toBe(true);
      expect(service.connectedImeis()).toEqual([IMEI_A]);
    });

    it('accepts a handshake split across two writes', async () => {
      const client = connect();
      const packet = buildHandshake(IMEI_A);

      client.socket.write(packet.subarray(0, 5));
      await new Promise((resolve) => setTimeout(resolve, 20));
      client.socket.write(packet.subarray(5));

      const reply = await client.next();

      expect(reply[0]).toBe(0x01);
      expect(service.isConnected(IMEI_A)).toBe(true);
    });

    it('rejects a non-numeric imei and closes the connection', async () => {
      const client = connect();
      client.socket.write(
        Buffer.concat([
          Buffer.from([0x00, 0x0f]),
          Buffer.from('35689208000000X', 'ascii'),
        ]),
      );

      const reply = await client.next();

      expect(reply[0]).toBe(0x00);
      await client.closed;
      expect(service.connectedImeis()).toEqual([]);
    });
  });

  describe('telemetry', () => {
    it('acknowledges with the record count and emits the decoded position', async () => {
      const client = await handshake(IMEI_A);
      const positions = once<DevicePositionsEvent>(DEVICE_POSITIONS);

      client.socket.write(
        buildTelemetryPacket({
          ...NAIROBI,
          speed: 37,
          io: { 239: 1, 240: 1 },
        }),
      );

      const ack = await client.next();

      expect(ack).toHaveLength(4);
      expect(ack.readUInt32BE(0)).toBe(1);

      const event = await positions;

      expect(event.imei).toBe(IMEI_A);
      expect(event.records).toHaveLength(1);
      expect(event.records[0].speed).toBe(37);
      expect(event.records[0].ignition).toBe(true);
      expect(event.records[0].latitude).toBeCloseTo(NAIROBI.latitude, 6);
    });

    it('handles two packets arriving in one chunk', async () => {
      const client = await handshake(IMEI_A);
      const seen: DevicePositionsEvent[] = [];

      events.on(DEVICE_POSITIONS, (event: DevicePositionsEvent) => {
        seen.push(event);
      });

      client.socket.write(
        Buffer.concat([
          buildTelemetryPacket({ ...NAIROBI, speed: 11 }),
          buildTelemetryPacket({ ...NAIROBI, speed: 22 }),
        ]),
      );

      // Two packets, so two acknowledgements, though they may coalesce into one chunk.
      const acks: number[] = [];

      while (acks.length < 2) {
        const chunk = await client.next();

        for (let offset = 0; offset + 4 <= chunk.length; offset += 4) {
          acks.push(chunk.readUInt32BE(offset));
        }
      }

      expect(acks).toEqual([1, 1]);
      expect(seen.map((event) => event.records[0].speed)).toEqual([11, 22]);
    });

    it('reassembles a packet split mid-record', async () => {
      const client = await handshake(IMEI_A);
      const positions = once<DevicePositionsEvent>(DEVICE_POSITIONS);
      const packet = buildTelemetryPacket({ ...NAIROBI, speed: 55 });

      client.socket.write(packet.subarray(0, 20));
      await new Promise((resolve) => setTimeout(resolve, 20));
      client.socket.write(packet.subarray(20));

      const event = await positions;

      expect(event.records[0].speed).toBe(55);
    });

    // A corrupted packet must not be acknowledged: the device resends what it believes was not
    // received, which is what makes weak-signal data recoverable rather than lost.
    it('does not acknowledge a packet with a bad crc, and stays connected', async () => {
      const client = await handshake(IMEI_A);
      const emitted = jest.fn();
      events.on(DEVICE_POSITIONS, emitted);

      client.socket.write(
        buildTelemetryPacket({ ...NAIROBI, speed: 10, corruptCrc: true }),
      );

      // Then a good packet. The only acknowledgement must be for this one.
      client.socket.write(buildTelemetryPacket({ ...NAIROBI, speed: 20 }));

      const ack = await client.next();

      expect(ack.readUInt32BE(0)).toBe(1);
      expect(emitted).toHaveBeenCalledTimes(1);
      expect(service.isConnected(IMEI_A)).toBe(true);
    });

    it('survives a device sending garbage, and keeps serving others', async () => {
      const bad = await handshake(IMEI_A);

      bad.socket.write(Buffer.from('this is not a teltonika frame', 'ascii'));
      await bad.closed;

      expect(service.isConnected(IMEI_A)).toBe(false);

      // The listener is still up and a different device can still connect and report.
      const good = await handshake(IMEI_B);
      good.socket.write(buildTelemetryPacket({ ...NAIROBI, speed: 5 }));

      const ack = await good.next();

      expect(ack.readUInt32BE(0)).toBe(1);
    });
  });

  describe('commands', () => {
    it('reports not-connected instead of failing silently', () => {
      const result = service.sendCommand('000000000000000', 'immobilize');

      expect(result).toEqual({ delivered: false, reason: 'not-connected' });
    });

    it('writes the immobilize frame to the right device', async () => {
      const client = await handshake(IMEI_A);

      const result = service.sendCommand(IMEI_A, 'immobilize');

      expect(result).toEqual({
        delivered: true,
        command: 'immobilize',
        text: 'setdigout 1',
      });

      const received = await client.next();

      expect(received.equals(encodeCommand('immobilize'))).toBe(true);
    });

    it('sends restore as the opposite output value', async () => {
      const client = await handshake(IMEI_A);

      service.sendCommand(IMEI_A, 'restore');
      const received = await client.next();

      expect(received.equals(encodeCommand('restore'))).toBe(true);
      expect(received.equals(encodeCommand('immobilize'))).toBe(false);
    });

    it('emits the device response, which is what actually confirms a command', async () => {
      const client = await handshake(IMEI_A);
      const response = once<DeviceCommandResponseEvent>(
        DEVICE_COMMAND_RESPONSE,
      );

      service.sendCommand(IMEI_A, 'immobilize');
      await client.next();

      client.socket.write(
        buildCommandResponse('Setdigout 1 OK (Relay OFF / Immobilized)'),
      );

      const event = await response;

      expect(event.imei).toBe(IMEI_A);
      expect(event.text).toContain('Setdigout 1 OK');
    });

    // Two bikes must never cross: a command for one must not reach the other.
    it('keeps two connected devices independent', async () => {
      const a = await handshake(IMEI_A);
      const b = await handshake(IMEI_B);

      expect(service.connectedImeis().sort()).toEqual([IMEI_A, IMEI_B]);

      const bReceived = jest.fn();
      b.socket.on('data', bReceived);

      service.sendCommand(IMEI_A, 'immobilize');
      await a.next();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bReceived).not.toHaveBeenCalled();

      // Positions are attributed per connection, not to whichever device reported last.
      const seen: DevicePositionsEvent[] = [];
      events.on(DEVICE_POSITIONS, (event: DevicePositionsEvent) => {
        seen.push(event);
      });

      b.socket.write(buildTelemetryPacket({ ...NAIROBI, speed: 99 }));
      await b.next();

      expect(seen).toHaveLength(1);
      expect(seen[0].imei).toBe(IMEI_B);
      expect(seen[0].records[0].speed).toBe(99);
    });
  });

  describe('disconnects and reconnects', () => {
    it('removes a device when its socket closes', async () => {
      const client = await handshake(IMEI_A);
      const disconnected = once<DeviceDisconnectedEvent>(DEVICE_DISCONNECTED);

      client.socket.destroy();
      const event = await disconnected;

      expect(event.imei).toBe(IMEI_A);
      expect(service.isConnected(IMEI_A)).toBe(false);
      expect(service.connectedImeis()).toEqual([]);
    });

    it('re-establishes the mapping on reconnect without duplicating it', async () => {
      const first = await handshake(IMEI_A);
      first.socket.destroy();
      await once(DEVICE_DISCONNECTED);

      const second = await handshake(IMEI_A);

      expect(service.connectedImeis()).toEqual([IMEI_A]);

      second.socket.write(buildTelemetryPacket({ ...NAIROBI, speed: 8 }));
      const ack = await second.next();

      expect(ack.readUInt32BE(0)).toBe(1);
    });

    // The dangerous case: the old socket is dead but not noticed yet. The new one must win, and
    // the old one's close must not delete the live entry.
    it('replaces a stale connection and keeps the new one usable', async () => {
      const first = await handshake(IMEI_A);
      const second = await handshake(IMEI_A);

      await first.closed;

      // Give the close handler a chance to run before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(service.isConnected(IMEI_A)).toBe(true);

      const result = service.sendCommand(IMEI_A, 'restore');
      expect(result.delivered).toBe(true);

      const received = await second.next();
      expect(received.equals(encodeCommand('restore'))).toBe(true);
    });

    it('closes a connection that never sends a handshake on shutdown', async () => {
      const client = connect();

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(service.connectedImeis()).toEqual([]);

      await service.close();
      await client.closed;
    });
  });
});
