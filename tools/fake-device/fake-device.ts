import * as net from 'node:net';
import {
  buildCodec12CommandResponse,
  buildCodec8Batch,
  buildHandshakePacket,
  parseServerCommand,
  TelemetryDataOptions,
} from './codec8-builder';

export type SimulationScenario =
  | 'stationary'
  | 'moving'
  | 'idle'
  | 'abrupt-disconnect'
  | 'corrupt-crc'
  | 'corrupt-data'
  /** Reports, drops the connection, comes back, and sends what it stored while away. */
  | 'reconnect'
  /** Writes each packet in two chunks, to exercise the server's stream reassembly. */
  | 'split-writes';

export type LogLevel = 'info' | 'warn' | 'error' | 'cmd';

export interface FakeDeviceOptions {
  host?: string;
  port?: number;
  imei?: string;
  scenario?: SimulationScenario;
  latitude?: number;
  longitude?: number;
  intervalSeconds?: number;
  maxPackets?: number;
  /** Maximum records per packet. A device that was offline sends its backlog in batches. */
  batchSize?: number;
  /**
   * How long to wait for an acknowledgement before assuming the packet was lost and sending it
   * again. A real unit retries; without this it would sit forever waiting for a server that never
   * answered, which is the one thing a test instrument must not do quietly.
   */
  ackTimeoutSeconds?: number;
  /** Reconnect after the connection drops, the way a real unit does. */
  reconnect?: boolean;
  reconnectDelaySeconds?: number;
  /**
   * Records held when there is nowhere to send them. Real units have finite memory and drop the
   * oldest when full, so this simulates loss rather than growing without bound.
   */
  maxStoredRecords?: number;
  logger?: (msg: string, level?: LogLevel) => void;
}

export interface FakeDeviceStats {
  imei: string;
  scenario: SimulationScenario;
  packetsSent: number;
  recordsSent: number;
  recordsAcknowledged: number;
  recordsStored: number;
  recordsDropped: number;
  acksReceived: number;
  retransmissions: number;
  commandsReceived: number;
  connections: number;
  handshakeAccepted: boolean;
  currentLocation: { lat: number; lng: number };
}

export class FakeDevice {
  private readonly host: string;
  private readonly port: number;
  private readonly imei: string;
  private readonly scenario: SimulationScenario;
  private lat: number;
  private lng: number;
  private readonly intervalSeconds: number;
  private readonly maxPackets: number;
  private readonly batchSize: number;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectDelaySeconds: number;
  private readonly maxStoredRecords: number;
  private readonly ackTimeoutMs: number;
  private readonly log: (msg: string, level?: LogLevel) => void;

  private socket: net.Socket | null = null;
  private handshakeAccepted = false;
  /** Bytes from the server that do not yet form a whole message. */
  private inbound: Buffer = Buffer.alloc(0);

  /**
   * Records generated but not yet acknowledged, oldest first. This is both the retransmit queue
   * and the offline store: with no connection, cycles keep appending here and the backlog goes
   * out on the next successful handshake.
   */
  private readonly unacknowledged: TelemetryDataOptions[] = [];
  private inFlight = 0;

  private packetsSent = 0;
  private recordsSent = 0;
  private recordsAcknowledged = 0;
  private recordsDropped = 0;
  private acksReceived = 0;
  private commandsReceived = 0;
  private connections = 0;
  private cyclesRun = 0;

  private timer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  private retransmissions = 0;
  private isRunning = false;
  private stopped: (() => void) | null = null;

  constructor(options: FakeDeviceOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 5027;
    this.imei = options.imei ?? '356892080000001';
    this.scenario = options.scenario ?? 'stationary';
    this.lat = options.latitude ?? -1.2921; // Nairobi default
    this.lng = options.longitude ?? 36.8219;
    this.intervalSeconds = options.intervalSeconds ?? 10;
    this.maxPackets = options.maxPackets ?? 0; // 0 = infinite
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 1, 255));
    this.reconnectDelaySeconds = options.reconnectDelaySeconds ?? 3;
    this.maxStoredRecords = options.maxStoredRecords ?? 500;
    this.ackTimeoutMs =
      (options.ackTimeoutSeconds ?? Math.max(2, this.intervalSeconds)) * 1000;
    // The reconnect scenario is about coming back, so it implies reconnecting.
    this.reconnectEnabled = options.reconnect ?? this.scenario === 'reconnect';

    this.log =
      options.logger ??
      ((msg, level = 'info') => {
        const timestamp = new Date().toISOString().slice(11, 19);
        const prefix = `[${timestamp}][IMEI:${this.imei}][${this.scenario}]`;
        if (level === 'error')
          console.error(`\x1b[31m${prefix} ERROR: ${msg}\x1b[0m`);
        else if (level === 'warn')
          console.warn(`\x1b[33m${prefix} WARN: ${msg}\x1b[0m`);
        else if (level === 'cmd')
          console.log(
            `\x1b[36m\x1b[1m${prefix} COMMAND RECEIVED: ${msg}\x1b[0m`,
          );
        else console.log(`\x1b[32m${prefix}\x1b[0m ${msg}`);
      });
  }

  /**
   * Runs the device until it is stopped, or until maxPackets is reached.
   *
   * Resolves when the simulation finishes rather than when a socket closes, because a device that
   * reconnects survives many closes.
   */
  start(): Promise<FakeDeviceStats> {
    if (this.isRunning) {
      return Promise.resolve(this.getStats());
    }

    this.isRunning = true;

    return new Promise<FakeDeviceStats>((resolve) => {
      this.stopped = () => {
        resolve(this.getStats());
      };

      this.connect();
    });
  }

  private connect(): void {
    if (!this.isRunning) {
      return;
    }

    this.log(`Connecting to TCP server at ${this.host}:${this.port}...`);

    const socket = new net.Socket();
    this.socket = socket;
    this.handshakeAccepted = false;
    this.inbound = Buffer.alloc(0);
    this.inFlight = 0;

    socket.connect(this.port, this.host, () => {
      this.connections += 1;
      this.log(`Connected. Sending IMEI handshake (${this.imei})...`);
      socket.write(buildHandshakePacket(this.imei));
    });

    socket.on('data', (data: Buffer) => {
      this.inbound = Buffer.concat([this.inbound, data]);
      this.drainInbound();
    });

    socket.on('error', (err: Error) => {
      // Expected when the server is not up yet, or on a reset. Not fatal when reconnecting.
      this.log(`Socket error: ${err.message}`, 'error');
    });

    socket.on('close', () => {
      this.handshakeAccepted = false;
      this.clearTimer();
      this.clearAckTimer();

      if (this.socket === socket) {
        this.socket = null;
      }

      if (!this.isRunning) {
        this.finish();
        return;
      }

      if (this.unacknowledged.length > 0) {
        this.log(
          `Connection lost with ${this.unacknowledged.length} record(s) unsent. Holding them in device memory.`,
          'warn',
        );
      }

      if (this.reconnectEnabled) {
        this.log(`Reconnecting in ${this.reconnectDelaySeconds}s...`, 'warn');
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, this.reconnectDelaySeconds * 1000);
        return;
      }

      this.log('Connection closed and reconnect is off. Stopping.', 'warn');
      this.isRunning = false;
      this.finish();
    });
  }

  /**
   * Consumes whole messages from the server, leaving partial ones buffered.
   *
   * The server's traffic is a stream too: a Codec 12 command can arrive split, or share a chunk
   * with an acknowledgement. Deciding what a chunk is by its length would misread both.
   */
  private drainInbound(): void {
    for (;;) {
      if (this.inbound.length === 0) {
        return;
      }

      if (!this.handshakeAccepted) {
        const verdict = this.inbound.readUInt8(0);
        this.inbound = this.inbound.subarray(1);

        if (verdict !== 0x01) {
          this.log(
            `Handshake REJECTED by server (byte 0x${verdict.toString(16).padStart(2, '0')})`,
            'error',
          );
          this.isRunning = false;
          this.socket?.destroy();
          return;
        }

        this.handshakeAccepted = true;
        this.log('Handshake ACCEPTED by server (0x01)');
        this.onHandshakeAccepted();
        continue;
      }

      // An acknowledgement is a bare 4-byte record count with no framing, so it is only
      // distinguishable from a Codec 12 frame by the zero preamble a frame starts with.
      const looksLikeFrame =
        this.inbound.length >= 4 && this.inbound.readUInt32BE(0) === 0;

      if (!looksLikeFrame) {
        if (this.inbound.length < 4) {
          return;
        }

        const accepted = this.inbound.readUInt32BE(0);
        this.inbound = this.inbound.subarray(4);
        this.onAcknowledgement(accepted);
        continue;
      }

      const command = parseServerCommand(this.inbound);

      if (!command) {
        // A frame that has not fully arrived yet.
        return;
      }

      this.inbound = this.inbound.subarray(command.raw.length);
      this.onCommand(command.commandText, command.codecId);
    }
  }

  private onHandshakeAccepted(): void {
    // Anything stored while offline goes out immediately, which is what a real unit does when it
    // regains signal. This is the case that matters for enforcement: a command decided while the
    // device was away has to be reconciled against the telemetry that arrives on reconnect.
    if (this.unacknowledged.length > 0) {
      this.log(
        `Flushing ${this.unacknowledged.length} stored record(s) after reconnect`,
      );
      this.flush();
    }

    this.startTelemetryLoop();
  }

  private onAcknowledgement(accepted: number): void {
    this.acksReceived += 1;
    this.clearAckTimer();

    if (accepted === this.inFlight && accepted > 0) {
      this.unacknowledged.splice(0, accepted);
      this.recordsAcknowledged += accepted;
      this.inFlight = 0;
      this.log(
        `ACK for ${accepted} record(s). ${this.unacknowledged.length} still unacknowledged.`,
      );
      return;
    }

    // A count that does not match what was sent means the server did not accept the packet. The
    // records stay queued and go out again, which is exactly how a real device behaves and why
    // a server must not acknowledge a corrupt packet.
    this.log(
      `ACK mismatch: server accepted ${accepted}, sent ${this.inFlight}. Keeping records for retransmission.`,
      'warn',
    );
    this.inFlight = 0;
  }

  /** No acknowledgement arrived in time, so the batch is eligible to be sent again. */
  private onAckTimeout(): void {
    if (this.inFlight === 0) {
      return;
    }

    this.retransmissions += 1;
    this.log(
      `No ACK for ${this.inFlight} record(s) within ${this.ackTimeoutMs / 1000}s. Will retransmit.`,
      'warn',
    );
    this.inFlight = 0;
    this.flush();
  }

  private clearAckTimer(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private onCommand(text: string, codecId: number): void {
    this.commandsReceived += 1;
    this.log(`Codec 0x${codecId.toString(16)} body: "${text}"`, 'cmd');

    const lowered = text.toLowerCase();
    const response = lowered.includes('setdigout 1')
      ? 'Setdigout 1 OK (Relay OFF / Immobilized)'
      : lowered.includes('setdigout 0')
        ? 'Setdigout 0 OK (Relay ON / Restored)'
        : `Command "${text}" Executed OK`;

    this.socket?.write(buildCodec12CommandResponse(response));
    this.log(`Sent Codec 12 response: "${response}"`);
  }

  private startTelemetryLoop(): void {
    this.clearTimer();
    this.sendTelemetryCycle();

    if (!this.isRunning) {
      return;
    }

    if (this.scenario === 'idle') {
      this.log(
        'Scenario [idle]: sent one report, now holding the socket open silently',
      );
      return;
    }

    if (this.scenario === 'abrupt-disconnect') {
      this.log(
        'Scenario [abrupt-disconnect]: simulating a battery pull, destroying the socket',
      );
      this.socket?.destroy();
      return;
    }

    this.timer = setInterval(() => {
      this.sendTelemetryCycle();

      // Drop the connection once, mid-run, then come back with the stored records.
      if (this.scenario === 'reconnect' && this.cyclesRun === 2) {
        this.log('Scenario [reconnect]: dropping the connection', 'warn');
        this.socket?.destroy();
      }
    }, this.intervalSeconds * 1000);
  }

  /** Generates one record and tries to send the queue. */
  private sendTelemetryCycle(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.maxPackets > 0 && this.packetsSent >= this.maxPackets) {
      this.log(`Reached max packets limit (${this.maxPackets}). Stopping.`);
      this.stop();
      return;
    }

    this.cyclesRun += 1;
    this.store(this.nextRecord());
    this.flush();
  }

  private nextRecord(): TelemetryDataOptions {
    let speed = 0;
    let ignition = false;
    let movement = false;

    switch (this.scenario) {
      case 'moving':
      case 'reconnect':
      case 'split-writes':
        this.lat += 0.00015; // roughly 15 m per cycle
        this.lng += 0.00015;
        speed = 35;
        ignition = true;
        movement = true;
        break;

      case 'stationary':
      case 'idle':
      case 'abrupt-disconnect':
      case 'corrupt-crc':
      case 'corrupt-data':
        speed = 0;
        ignition = false;
        movement = false;
        break;
    }

    return {
      timestamp: Date.now(),
      latitude: this.lat,
      longitude: this.lng,
      altitude: 1600,
      angle: speed > 0 ? 45 : 0,
      satellites: 12,
      speed,
      ignition,
      movement,
      corruptCrc: this.scenario === 'corrupt-crc',
      corruptData: this.scenario === 'corrupt-data',
    };
  }

  private store(record: TelemetryDataOptions): void {
    this.unacknowledged.push(record);

    while (this.unacknowledged.length > this.maxStoredRecords) {
      this.unacknowledged.shift();
      this.recordsDropped += 1;
    }

    if (this.recordsDropped > 0 && this.recordsDropped % 50 === 0) {
      this.log(
        `Device memory full: dropped ${this.recordsDropped} oldest record(s)`,
        'warn',
      );
    }
  }

  /** Sends up to batchSize queued records as one packet, if there is a connection to send on. */
  private flush(): void {
    if (!this.socket || !this.handshakeAccepted) {
      this.log(
        `No open connection: holding ${this.unacknowledged.length} record(s) in device memory`,
        'warn',
      );
      return;
    }

    if (this.inFlight > 0) {
      // Waiting for an acknowledgement. A real device sends one packet at a time.
      return;
    }

    if (this.unacknowledged.length === 0) {
      return;
    }

    const batch = this.unacknowledged.slice(0, this.batchSize);
    const packet = buildCodec8Batch(batch);

    this.inFlight = batch.length;
    this.packetsSent += 1;
    this.recordsSent += batch.length;

    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.onAckTimeout();
    }, this.ackTimeoutMs);

    const first = batch[0];
    const flags =
      (first.corruptCrc ? ' [DELIBERATELY CORRUPT CRC]' : '') +
      (first.corruptData ? ' [DELIBERATELY CORRUPT PAYLOAD]' : '');

    this.log(
      `Sending packet #${this.packetsSent} [${packet.length} bytes, ${batch.length} record(s)] | ` +
        `Lat: ${this.lat.toFixed(5)}, Lng: ${this.lng.toFixed(5)}, Speed: ${first.speed}km/h, ` +
        `Ignition: ${String(first.ignition)}, Movement: ${String(first.movement)}${flags}`,
    );

    if (this.scenario === 'split-writes' && packet.length > 12) {
      // Split mid-record, then pause, so the server has to hold a partial frame rather than
      // receiving a convenient whole one.
      const cut = Math.floor(packet.length / 2);
      this.socket.write(packet.subarray(0, cut));
      this.log(
        `Scenario [split-writes]: wrote ${cut} of ${packet.length} bytes, sending the rest shortly`,
      );
      setTimeout(() => {
        this.socket?.write(packet.subarray(cut));
      }, 50);
      return;
    }

    this.socket.write(packet);
  }

  /** Stops the simulation and closes the connection gracefully (FIN, not a reset). */
  stop(): void {
    this.isRunning = false;
    this.clearTimer();
    this.clearAckTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.end();
      return;
    }

    this.finish();
  }

  /** Simulates losing power or signal: a reset with no FIN. */
  kill(): void {
    this.isRunning = false;
    this.clearTimer();
    this.clearAckTimer();
    this.socket?.destroy();
  }

  private finish(): void {
    const done = this.stopped;
    this.stopped = null;
    done?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(): FakeDeviceStats {
    return {
      imei: this.imei,
      scenario: this.scenario,
      packetsSent: this.packetsSent,
      recordsSent: this.recordsSent,
      recordsAcknowledged: this.recordsAcknowledged,
      recordsStored: this.unacknowledged.length,
      recordsDropped: this.recordsDropped,
      acksReceived: this.acksReceived,
      retransmissions: this.retransmissions,
      commandsReceived: this.commandsReceived,
      connections: this.connections,
      handshakeAccepted: this.handshakeAccepted,
      currentLocation: { lat: this.lat, lng: this.lng },
    };
  }
}
