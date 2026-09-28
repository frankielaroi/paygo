import { createServer, type Server, type Socket } from 'node:net';
import { FakeDevice, type FakeDeviceOptions } from './fake-device';
import { parseServerCommand } from './codec8-builder';

/**
 * Drives the simulator against a minimal stand-in server, not against the real TcpServerService.
 *
 * Deliberate: the simulator is a test instrument, and an instrument has to be trustworthy
 * independently of the thing it measures. If these tests ran against the real server, a shared
 * misreading of the protocol would look like agreement.
 */
class StubServer {
  /** Data fields of every packet received, in order. */
  readonly received: Buffer[] = [];
  readonly sockets: Socket[] = [];
  /** Set false to reject handshakes. */
  acceptHandshake = true;
  /** Set false to stay silent instead of acknowledging. */
  ack = true;
  /** Set to acknowledge this count regardless of what arrived. */
  ackOverride: number | null = null;

  private readonly server: Server;
  port = 0;

  constructor() {
    // A class, not an object literal spread into a result: spreading copies the boolean flags by
    // value, so a test setting stub.ack = false would not reach the running server. That mistake
    // makes tests pass for the wrong reason.
    this.server = createServer((socket) => {
      this.sockets.push(socket);
      this.handle(socket);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });

    const address = this.server.address();
    this.port =
      address !== null && typeof address === 'object' ? address.port : 0;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  dropAllConnections(): void {
    for (const socket of this.sockets.splice(0)) {
      socket.destroy();
    }
  }

  private handle(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    let handshaken = false;

    socket.on('error', () => undefined);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      for (;;) {
        if (!handshaken) {
          if (buffer.length < 2) {
            return;
          }

          const length = buffer.readUInt16BE(0);

          if (buffer.length < 2 + length) {
            return;
          }

          buffer = buffer.subarray(2 + length);
          handshaken = true;
          socket.write(Buffer.from([this.acceptHandshake ? 0x01 : 0x00]));

          if (!this.acceptHandshake) {
            socket.destroy();
            return;
          }

          continue;
        }

        if (buffer.length < 12) {
          return;
        }

        const dataLength = buffer.readUInt32BE(4);

        if (buffer.length < 8 + dataLength + 4) {
          return;
        }

        const dataField = Buffer.from(buffer.subarray(8, 8 + dataLength));
        buffer = buffer.subarray(8 + dataLength + 4);

        this.received.push(dataField);

        // Codec 12 is the device answering a command, not telemetry to acknowledge.
        if (dataField.readUInt8(0) === 0x0c) {
          continue;
        }

        if (this.ack) {
          const ack = Buffer.alloc(4);
          ack.writeUInt32BE(this.ackOverride ?? dataField.readUInt8(1), 0);
          socket.write(ack);
        }
      }
    });
  }
}

/** Record count from a codec 8 data field. */
function recordCount(dataField: Buffer): number {
  return dataField.readUInt8(1);
}

function telemetry(received: Buffer[]): Buffer[] {
  return received.filter((data) => data.readUInt8(0) === 0x08);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('FakeDevice', () => {
  let stub: StubServer;

  beforeEach(async () => {
    stub = new StubServer();
    await stub.listen();
  });

  afterEach(async () => {
    await stub.close();
  });

  function device(options: FakeDeviceOptions = {}): FakeDevice {
    return new FakeDevice({
      host: '127.0.0.1',
      port: stub.port,
      intervalSeconds: 1,
      logger: () => undefined,
      ...options,
    });
  }

  it('handshakes and reports telemetry', async () => {
    const unit = device({ scenario: 'stationary', maxPackets: 1 });
    const stats = await unit.start();

    expect(stats.connections).toBe(1);
    expect(stats.packetsSent).toBe(1);
    expect(telemetry(stub.received)).toHaveLength(1);
  });

  it('clears its queue when the server acknowledges', async () => {
    const unit = device({ scenario: 'stationary', maxPackets: 2 });
    const stats = await unit.start();

    expect(stats.recordsAcknowledged).toBe(stats.recordsSent);
    expect(stats.recordsStored).toBe(0);
  });

  // The behaviour that makes a corrupt packet recoverable: an unacknowledged record is kept and
  // sent again, which is why a server must never acknowledge a frame it could not read.
  it('keeps records for retransmission when the server does not acknowledge', async () => {
    stub.ack = false;

    const unit = device({ scenario: 'stationary', intervalSeconds: 1 });
    const running = unit.start();

    await waitFor(() => unit.getStats().recordsStored >= 2);
    unit.stop();

    const stats = await running;

    expect(stats.recordsAcknowledged).toBe(0);
    expect(stats.recordsStored).toBeGreaterThanOrEqual(2);
  });

  it('treats a mismatched acknowledgement as a refusal', async () => {
    stub.ackOverride = 99;

    const unit = device({ scenario: 'stationary', maxPackets: 1 });
    const running = unit.start();

    await waitFor(() => unit.getStats().acksReceived >= 1);
    unit.stop();

    const stats = await running;

    expect(stats.acksReceived).toBe(1);
    expect(stats.recordsAcknowledged).toBe(0);
    expect(stats.recordsStored).toBe(1);
  });

  it('stops when the handshake is rejected', async () => {
    stub.acceptHandshake = false;

    const stats = await device({ scenario: 'stationary' }).start();

    expect(stats.handshakeAccepted).toBe(false);
    expect(telemetry(stub.received)).toHaveLength(0);
  });

  it('answers a command with a codec 12 response', async () => {
    const unit = device({ scenario: 'idle' });
    const running = unit.start();

    await waitFor(
      () => stub.sockets.length > 0 && telemetry(stub.received).length > 0,
    );

    // A server-to-device command frame, as TcpServerService would send.
    const payload = Buffer.from('setdigout 1', 'ascii');
    const dataField = Buffer.alloc(1 + 1 + 1 + 4 + payload.length + 1);
    dataField.writeUInt8(0x0c, 0);
    dataField.writeUInt8(1, 1);
    dataField.writeUInt8(5, 2);
    dataField.writeUInt32BE(payload.length, 3);
    payload.copy(dataField, 7);
    dataField.writeUInt8(1, dataField.length - 1);

    const frame = Buffer.alloc(8 + dataField.length + 4);
    frame.writeUInt32BE(0, 0);
    frame.writeUInt32BE(dataField.length, 4);
    dataField.copy(frame, 8);
    // The device does not verify the command crc, so a zero here is enough for this test.
    stub.sockets[0].write(frame);

    await waitFor(() => unit.getStats().commandsReceived >= 1);

    const responses = stub.received.filter(
      (data) => data.readUInt8(0) === 0x0c,
    );
    expect(responses.length).toBeGreaterThanOrEqual(1);

    const decoded = parseServerCommand(
      Buffer.concat([
        (() => {
          const header = Buffer.alloc(8);
          header.writeUInt32BE(0, 0);
          header.writeUInt32BE(responses[0].length, 4);
          return header;
        })(),
        responses[0],
        Buffer.alloc(4),
      ]),
    );

    expect(decoded?.commandText).toContain('Immobilized');

    unit.stop();
    await running;
  });

  // The case that matters for enforcement: a device that was away comes back and delivers what it
  // stored, so a decision made while it was offline has fresh telemetry to reconcile against.
  it('stores records while disconnected and sends them on reconnect', async () => {
    const unit = device({
      scenario: 'stationary',
      intervalSeconds: 1,
      reconnect: true,
      reconnectDelaySeconds: 1,
      batchSize: 10,
    });

    const running = unit.start();

    await waitFor(() => unit.getStats().recordsAcknowledged >= 1);

    // Drop the connection from the server side and refuse to acknowledge, so records pile up.
    stub.ack = false;
    stub.dropAllConnections();

    await waitFor(() => unit.getStats().recordsStored >= 2, 6000);
    const storedWhileAway = unit.getStats().recordsStored;

    // Now accept again. The backlog should arrive in one packet.
    stub.ack = true;
    stub.received.length = 0;

    await waitFor(() => telemetry(stub.received).length > 0, 8000);

    const batch = telemetry(stub.received)[0];

    expect(storedWhileAway).toBeGreaterThanOrEqual(2);
    expect(recordCount(batch)).toBeGreaterThanOrEqual(2);
    expect(unit.getStats().connections).toBeGreaterThanOrEqual(2);

    unit.stop();
    await running;
  }, 20000);

  it('drops the oldest records when device memory fills', async () => {
    stub.ack = false;

    const unit = device({
      scenario: 'stationary',
      intervalSeconds: 1,
      maxStoredRecords: 2,
    });

    const running = unit.start();

    await waitFor(() => unit.getStats().recordsDropped >= 1, 6000);
    unit.stop();

    const stats = await running;

    expect(stats.recordsStored).toBe(2);
    expect(stats.recordsDropped).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('sends a packet in two writes under the split-writes scenario', async () => {
    const unit = device({ scenario: 'split-writes', maxPackets: 1 });
    const running = unit.start();

    // The stub reassembles, so a successfully parsed packet proves the halves arrived and were
    // joined rather than dropped.
    await waitFor(() => telemetry(stub.received).length >= 1);

    unit.stop();
    await running;

    expect(recordCount(telemetry(stub.received)[0])).toBe(1);
  });

  it('batches several records into one packet', async () => {
    stub.ack = false;

    const unit = device({
      scenario: 'stationary',
      intervalSeconds: 1,
      batchSize: 5,
    });

    const running = unit.start();

    await waitFor(() => unit.getStats().recordsStored >= 3, 8000);

    // Nothing was acknowledged, so the queue holds several records. Acknowledge now and the next
    // flush should carry them together.
    stub.ack = true;
    stub.received.length = 0;

    await waitFor(() => telemetry(stub.received).length >= 1, 8000);

    expect(recordCount(telemetry(stub.received)[0])).toBeGreaterThanOrEqual(2);

    unit.stop();
    await running;
  }, 20000);
});
