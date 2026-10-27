import { createHash, createHmac, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

export interface WattpilotConfig {
  url: string | null;
  password: string | null;
  controlEnabled: boolean;
  maxCurrentAmps: number | null;
  requestTimeoutMs: number;
  staleAfterMs: number;
}

export interface WattpilotCommand {
  mode: 'pause' | 'eco' | 'normal';
  currentAmps?: number;
  phases?: 1 | 3;
}

export interface WattpilotStatus {
  status: 'not_configured' | 'online' | 'stale' | 'offline' | 'error';
  configured: boolean;
  connected: boolean;
  ready: boolean;
  stale: boolean;
  observedAt: string | null;
  powerObservedAt: string | null;
  error: string | null;
  controlEnabled: boolean;
  mode: 'pause' | 'eco' | 'normal' | 'unknown';
  carConnected: boolean | null;
  charging: boolean | null;
  allowedCharging: boolean | null;
  currentAmps: number | null;
  phaseMode: 'auto' | 1 | 3 | null;
  phaseSwitchingSupported: boolean;
  powerWatts: number | null;
  sessionEnergyWh: number | null;
  totalEnergyWh: number | null;
  energyCounterSource?: string | null;
  limits: { minCurrentAmps: number; maxCurrentAmps: number | null };
  deviceLeaseSupported: false;
}

export class WattpilotError extends Error {
  constructor(message: string, public readonly statusCode = 503, public readonly outcome?: 'unknown') {
    super(message);
    this.name = 'WattpilotError';
  }
}

export type WattpilotSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'>;
interface Options {
  createSocket?: (url: string) => WattpilotSocket;
  now?: () => number;
  randomToken?: () => string;
}
interface PendingWrite {
  key: string;
  value: number;
  resolve: () => void;
  reject: (error: WattpilotError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const derive = promisify(pbkdf2);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Classic Wattpilot protocol; Flex/bcrypt requires a different adapter. */
export async function deriveWattpilotKey(password: string, serial: string): Promise<string> {
  return (await derive(password, serial, 100_000, 256, 'sha512')).toString('base64').slice(0, 32);
}

/**
 * Local device transport only. No schedules, automatic retries of commands, or
 * device-side expiry are implied. Native WebSocket needs Node 22.4+.
 */
export class Wattpilot {
  private socket: WattpilotSocket | null = null;
  private connecting: Promise<void> | null = null;
  private rejectConnection: ((error: WattpilotError) => void) | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private stopped = false;
  private authenticated = false;
  private initialized = false;
  private serial: string | null = null;
  private key: string | null = null;
  private secured = false;
  private properties: Record<string, unknown> = Object.create(null);
  private initialProperties: Record<string, unknown> = Object.create(null);
  private initialPowerAt: number | null = null;
  private lastStatusAt: number | null = null;
  private lastPowerAt: number | null = null;
  private powerRevision = 0;
  private error: string | null = null;
  private requestId = 0;
  private pending = new Map<string, PendingWrite>();
  private commanding = false;
  private statusWaiters = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly config: WattpilotConfig, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0
      || !Number.isFinite(config.staleAfterMs) || config.staleAfterMs <= 0) {
      throw new WattpilotError('Wattpilot timeouts must be positive finite numbers.', 400);
    }
    if (config.url) {
      let url: URL;
      try { url = new URL(config.url); }
      catch { throw new WattpilotError('Invalid Wattpilot WebSocket URL.', 400); }
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/ws' || !url.hostname) {
        throw new WattpilotError('Invalid Wattpilot WebSocket URL.', 400);
      }
    }
    if (config.maxCurrentAmps !== null && (!positiveInteger(config.maxCurrentAmps) || config.maxCurrentAmps < 6 || config.maxCurrentAmps > 16)) {
      throw new WattpilotError('Wattpilot current ceiling must be an integer from 6 to 16 A.', 400);
    }
    if (config.controlEnabled && (!config.url || !config.password || config.maxCurrentAmps === null)) {
      throw new WattpilotError('Wattpilot control requires a URL, password and explicit current ceiling.', 400);
    }
  }

  private fresh(): boolean {
    if (!this.authenticated || !this.initialized || this.lastStatusAt === null || this.socket?.readyState !== 1) return false;
    const age = this.now() - this.lastStatusAt;
    return age >= 0 && age <= this.config.staleAfterMs;
  }

  private maxCurrent(): number | null {
    const { ama, cbl, adi, var: variant } = this.properties;
    if (!positiveInteger(ama) || !positiveInteger(cbl) || ![11, 22].includes(variant as number) || typeof adi !== 'boolean') return null;
    const limits = [ama, cbl, variant === 11 ? 16 : 32, adi ? 16 : 32];
    if (this.config.maxCurrentAmps !== null) limits.push(this.config.maxCurrentAmps);
    return Math.min(...limits);
  }

  private snapshot(): WattpilotStatus {
    const configured = Boolean(this.config.url && this.config.password);
    const ready = this.fresh();
    const connected = this.authenticated && this.socket?.readyState === 1;
    const stale = this.lastStatusAt !== null && !ready;
    const props = this.properties;
    const car = props.car;
    const knownCar = typeof car === 'number' && [1, 2, 3, 4].includes(car);
    const nrg = Array.isArray(props.nrg) ? props.nrg : [];
    return {
      status: !configured ? 'not_configured' : ready ? 'online' : stale ? 'stale' : this.error ? 'error' : 'offline',
      configured, connected, ready, stale,
      observedAt: this.lastStatusAt === null ? null : new Date(this.lastStatusAt).toISOString(),
      powerObservedAt: this.lastPowerAt === null ? null : new Date(this.lastPowerAt).toISOString(),
      error: this.error,
      controlEnabled: this.config.controlEnabled,
      mode: props.frc === 1 ? 'pause' : props.frc === 0 && props.lmo === 3 ? 'normal'
        : props.frc === 0 && props.lmo === 4 ? 'eco' : 'unknown',
      carConnected: knownCar ? car !== 1 : null,
      charging: knownCar ? car === 2 : null,
      allowedCharging: typeof props.alw === 'boolean' ? props.alw : null,
      currentAmps: nonnegative(props.amp),
      phaseMode: props.psm === 0 ? 'auto' : props.psm === 1 ? 1 : props.psm === 2 ? 3 : null,
      phaseSwitchingSupported: [0, 1, 2].includes(props.psm as number),
      powerWatts: nonnegative(nrg[11]),
      sessionEnergyWh: nonnegative(props.wh),
      totalEnergyWh: nonnegative(props.eto),
      energyCounterSource: this.serial ? `Wattpilot:${this.serial}` : null,
      limits: { minCurrentAmps: 6, maxCurrentAmps: this.maxCurrent() },
      deviceLeaseSupported: false,
    };
  }

  async readStatus(): Promise<WattpilotStatus> {
    if (this.config.url && this.config.password && !this.stopped) {
      try { await this.connect(); }
      catch (error) { this.error = error instanceof WattpilotError ? error.message : 'Wattpilot connection failed.'; }
    }
    return this.snapshot();
  }

  private closeConnection(error: WattpilotError): void {
    ++this.generation;
    this.error = error.message;
    this.authenticated = false;
    this.initialized = false;
    this.key = null;
    this.serial = null;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    const reject = this.rejectConnection;
    this.rejectConnection = null;
    this.connecting = null;
    reject?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WattpilotError('Wattpilot command outcome is unknown after connection loss.', 503, 'unknown'));
    }
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(); } catch { /* Already closed transports require no further action. */ }
    for (const changed of this.statusWaiters) changed();
  }

  private connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new WattpilotError('Wattpilot controller is shut down.'));
    if (this.fresh()) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (!this.config.url || !this.config.password) return Promise.reject(new WattpilotError('Wattpilot is not configured.'));
    if (this.socket) this.closeConnection(new WattpilotError('Wattpilot status is stale.'));
    const generation = ++this.generation;
    this.authenticated = false;
    this.initialized = false;
    this.initialProperties = Object.create(null);
    this.initialPowerAt = null;
    let resolveConnection!: () => void;
    const connecting = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    this.connecting = connecting;
    this.connectionTimer = setTimeout(() => {
      if (generation === this.generation) this.closeConnection(new WattpilotError('Wattpilot authentication or status initialization timed out.', 504));
    }, this.config.requestTimeoutMs);
    try {
      const createSocket = this.options.createSocket ?? ((url: string) => {
        if (typeof globalThis.WebSocket !== 'function') throw new WattpilotError('Wattpilot requires native WebSocket support (Node.js 22.4 or later).');
        return new globalThis.WebSocket(url);
      });
      const socket = createSocket(this.config.url);
      this.socket = socket;
      let messages = Promise.resolve();
      socket.addEventListener('message', event => {
        messages = messages.then(async () => {
          if (generation !== this.generation) return;
          let message: unknown;
          try {
            if (typeof event.data !== 'string' || event.data.length > 1_048_576) throw new Error();
            message = JSON.parse(event.data);
          }
          catch { throw new WattpilotError('Wattpilot sent invalid protocol data.'); }
          if (!record(message)) throw new WattpilotError('Wattpilot sent invalid protocol data.');
          await this.handleMessage(message, generation, resolveConnection);
        }).catch(error => {
          if (generation === this.generation) this.closeConnection(error instanceof WattpilotError ? error : new WattpilotError('Wattpilot protocol failed.'));
        });
      });
      socket.addEventListener('close', () => {
        if (generation === this.generation) this.closeConnection(new WattpilotError('Wattpilot connection closed.'));
      });
      socket.addEventListener('error', () => {
        if (generation === this.generation) this.closeConnection(new WattpilotError('Wattpilot connection failed.'));
      });
    } catch (error) {
      this.closeConnection(error instanceof WattpilotError ? error : new WattpilotError('Wattpilot connection failed.'));
    }
    return connecting;
  }

  private async handleMessage(message: Record<string, unknown>, generation: number, resolveConnection: () => void): Promise<void> {
    if (message.type === 'hello') {
      if (this.serial || message.manufacturer !== 'fronius' || message.devicetype !== 'wattpilot' || message.protocol !== 2
        || typeof message.serial !== 'string' || !message.serial || message.serial.length > 128
        || typeof message.secured !== 'boolean') throw new WattpilotError('Unsupported Wattpilot device or protocol (Flex is not supported).');
      this.serial = message.serial;
      this.secured = message.secured;
    } else if (message.type === 'authRequired') {
      if (!this.serial || this.authenticated || (message.hash !== undefined && message.hash !== 'pbkdf2')
        || typeof message.token1 !== 'string' || !message.token1 || message.token1.length > 256
        || typeof message.token2 !== 'string' || !message.token2 || message.token2.length > 256) {
        throw new WattpilotError('Unsupported Wattpilot authentication challenge.');
      }
      const key = await deriveWattpilotKey(this.config.password!, this.serial);
      if (generation !== this.generation) return;
      this.key = key;
      const token3 = this.options.randomToken?.() ?? randomBytes(16).toString('hex');
      this.socket!.send(JSON.stringify({ type: 'auth', token3, hash: hash(token3 + message.token2 + hash(message.token1 + key)) }));
    } else if (message.type === 'authSuccess') {
      if (!this.key || this.authenticated) throw new WattpilotError('Unexpected Wattpilot authentication response.');
      this.authenticated = true;
    } else if (message.type === 'authError') {
      throw new WattpilotError('Wattpilot authentication failed.');
    } else if (message.type === 'fullStatus' || message.type === 'deltaStatus') {
      if (!this.authenticated || !record(message.status)
        || (message.type === 'fullStatus' && message.partial !== undefined && typeof message.partial !== 'boolean')) {
        throw new WattpilotError('Wattpilot status arrived before authentication or is invalid.');
      }
      if (message.type === 'deltaStatus' && !this.initialized) return;
      const properties = this.initialized ? this.properties : this.initialProperties;
      Object.assign(properties, message.status);
      if (Object.hasOwn(message.status, 'nrg')) {
        if (this.initialized) { this.lastPowerAt = this.now(); this.powerRevision++; }
        else this.initialPowerAt = this.now();
      }
      if (message.type === 'fullStatus' && message.partial !== true && !this.initialized) {
        this.properties = this.initialProperties;
        this.lastPowerAt = this.initialPowerAt;
        this.powerRevision++;
        this.initialized = true;
      }
      if (this.initialized) {
        this.lastStatusAt = this.now();
        this.error = null;
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
        this.rejectConnection = null;
        this.connecting = null;
        resolveConnection();
        for (const changed of this.statusWaiters) changed();
      }
    } else if (message.type === 'response') {
      if (!this.authenticated) throw new WattpilotError('Unexpected Wattpilot command response.');
      const requestId = String(message.requestId);
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (message.success !== true) {
        pending.reject(new WattpilotError('Wattpilot rejected the command.', 503));
      } else if (!record(message.status) || message.status[pending.key] !== pending.value) {
        pending.reject(new WattpilotError('Wattpilot command outcome is unknown: applied value was not verified.', 503, 'unknown'));
      } else {
        Object.assign(this.properties, message.status);
        pending.resolve();
      }
    }
  }

  private stoppedSince(powerRevision: number, requestedAt: number): boolean {
    const nrg = Array.isArray(this.properties.nrg) ? this.properties.nrg : [];
    const powerAge = this.lastPowerAt === null ? NaN : this.now() - this.lastPowerAt;
    return this.fresh() && this.properties.frc === 1
      && this.powerRevision > powerRevision && this.lastPowerAt !== null && this.lastPowerAt >= requestedAt
      && powerAge >= 0 && powerAge <= this.config.staleAfterMs
      && [1, 3, 4].includes(this.properties.car as number) && this.properties.alw === false && nrg[11] === 0;
  }

  private async waitForStopped(powerRevision: number, requestedAt: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: WattpilotError) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        this.statusWaiters.delete(changed);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(new WattpilotError('Wattpilot phase change was cancelled while paused.', 409, 'unknown'));
      const changed = () => {
        if (signal?.aborted) { aborted(); return; }
        if (!this.fresh()) { finish(new WattpilotError('Fresh Wattpilot state was lost while waiting for charging to stop.', 503, 'unknown')); return; }
        if (this.properties.frc !== 1) { finish(new WattpilotError('Wattpilot pause changed externally; phase change was cancelled.', 409, 'unknown')); return; }
        if (this.stoppedSince(powerRevision, requestedAt)) finish();
      };
      const timer = setTimeout(() => finish(new WattpilotError('Wattpilot did not confirm stopped charging; it remains paused and no phase change was sent.', 504, 'unknown')), this.config.requestTimeoutMs);
      this.statusWaiters.add(changed);
      signal?.addEventListener('abort', aborted, { once: true });
      changed();
    });
  }

  private async write(key: string, value: number, signal?: AbortSignal): Promise<void> {
    if (!this.fresh() || !this.key || !this.socket) throw new WattpilotError('Fresh authenticated Wattpilot status is required.');
    const requestId = ++this.requestId;
    const payload = JSON.stringify({ type: 'setValue', requestId, key, value });
    const message = this.secured ? JSON.stringify({
      type: 'securedMsg', data: payload, requestId: `${requestId}sm`,
      hmac: createHmac('sha256', this.key).update(payload).digest('hex'),
    }) : payload;
    await new Promise<void>((resolve, reject) => {
      const id = String(requestId);
      const finish = () => signal?.removeEventListener('abort', aborted);
      const rejectWrite = (error: WattpilotError) => { finish(); reject(error); };
      const aborted = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectWrite(new WattpilotError('Wattpilot command outcome is unknown after request cancellation.', 409, 'unknown'));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectWrite(new WattpilotError('Wattpilot command outcome is unknown: acknowledgement timed out.', 504, 'unknown'));
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { key, value, resolve: () => { finish(); resolve(); }, reject: rejectWrite, timer });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      try { this.socket!.send(message); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectWrite(new WattpilotError('Wattpilot command outcome is unknown: send failed.', 503, 'unknown'));
      }
    });
  }

  async setControl(command: WattpilotCommand, signal?: AbortSignal): Promise<WattpilotStatus> {
    return this.applyControl(command, signal, false);
  }

  /** Ordered pause plus a new status-frame measurement; an ACK/cache is insufficient. */
  async pauseAndConfirm(signal?: AbortSignal): Promise<WattpilotStatus> {
    return this.applyControl({ mode: 'pause' }, signal, true);
  }

  private async applyControl(command: WattpilotCommand, signal: AbortSignal | undefined, confirmStop: boolean): Promise<WattpilotStatus> {
    if (!record(command) || !['pause', 'eco', 'normal'].includes(command.mode)
      || Object.keys(command).some(key => !['mode', 'currentAmps', 'phases'].includes(key))
      || (command.mode === 'pause' && ('currentAmps' in command || 'phases' in command))
      || ('phases' in command && command.phases !== 1 && command.phases !== 3)
      || (command.mode !== 'pause' && (!positiveInteger(command.currentAmps) || command.currentAmps < 6))) {
      throw new WattpilotError('Use pause, or eco/normal with an integer currentAmps of at least 6 A.', 400);
    }
    if (!this.config.controlEnabled) throw new WattpilotError('Wattpilot control is disabled.', 403);
    if (command.currentAmps !== undefined && this.config.maxCurrentAmps !== null && command.currentAmps > this.config.maxCurrentAmps) {
      throw new WattpilotError(`Requested current exceeds the ${this.config.maxCurrentAmps} A Wattpilot limit.`, 400);
    }
    const checkCancellation = () => {
      if (signal?.aborted) throw new WattpilotError('Wattpilot request was cancelled.', 409);
    };
    checkCancellation();
    if (this.commanding) throw new WattpilotError('A Wattpilot command is already in progress.', 409);
    this.commanding = true;
    let wrote = false;
    try {
      const connection = this.connect();
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new WattpilotError('Wattpilot request was cancelled.', 409));
          signal.addEventListener('abort', aborted, { once: true });
          connection.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
          if (signal.aborted) aborted();
        });
      } else await connection;
      checkCancellation();
      if (!this.fresh()) throw new WattpilotError('Fresh authenticated Wattpilot status is required.');
      const requestedPhaseMode = command.phases === undefined ? undefined : command.phases === 1 ? 1 : 2;
      if (requestedPhaseMode !== undefined && ![0, 1, 2].includes(this.properties.psm as number)) {
        throw new WattpilotError('Verified Wattpilot phase switching support is required.');
      }
      const changingPhases = requestedPhaseMode !== undefined && requestedPhaseMode !== this.properties.psm;
      const preserveEco = command.mode === 'eco' && command.phases === undefined
        && positiveInteger(this.properties.amp) && this.properties.amp >= 6
        && this.properties.amp === command.currentAmps && this.config.maxCurrentAmps !== null
        && this.properties.amp <= this.config.maxCurrentAmps;
      if (command.mode !== 'pause') {
        const ceiling = this.maxCurrent();
        if (!preserveEco && (ceiling === null || ceiling < 6)) throw new WattpilotError('Verified Wattpilot device and cable current limits are required.');
        if (!preserveEco && command.currentAmps! > ceiling!) throw new WattpilotError(`Requested current exceeds the ${ceiling} A Wattpilot limit.`, 400);
        if (![0, 1, 2].includes(this.properties.frc as number) || ![3, 4, 5].includes(this.properties.lmo as number)
          || !positiveInteger(this.properties.amp)) throw new WattpilotError('Verified Wattpilot control state is required.');
      }
      const expected: Record<string, unknown> = command.mode === 'pause' ? {} : {
        frc: this.properties.frc, amp: this.properties.amp, lmo: this.properties.lmo,
        ...(Object.hasOwn(this.properties, 'psm') ? { psm: this.properties.psm } : {}),
      };
      const powerRevision = this.powerRevision;
      const pauseRequestedAt = this.now();
      let stoppedForPhaseChange = false;
      const apply = async (key: string, value: number) => {
        checkCancellation();
        if (stoppedForPhaseChange && !this.stoppedSince(powerRevision, pauseRequestedAt)) {
          throw new WattpilotError('Wattpilot stopped charging state changed; the remaining phase-change command was cancelled.', 409, 'unknown');
        }
        if (!preserveEco && (key === 'amp' || (key === 'frc' && value === 0))) {
          const ceiling = this.maxCurrent();
          if (ceiling === null || ceiling < command.currentAmps!) {
            throw new WattpilotError('Wattpilot current limits changed; the remaining command was cancelled.');
          }
        }
        if (Object.keys(expected).some(property => this.properties[property] !== expected[property])) {
          throw new WattpilotError('Wattpilot settings changed externally; the remaining command was cancelled.', 409, 'unknown');
        }
        wrote = true;
        await this.write(key, value, signal);
        expected[key] = value;
      };
      // Pause before changing current/mode; never force charging over device logic.
      await apply('frc', 1);
      if (confirmStop) {
        checkCancellation();
        // An ACK updates settings but carries no new power observation. Some
        // firmware sends only changed fields, so obtain a new read-only full
        // snapshot rather than accept the old zero or wait forever for a delta.
        const afterAckRevision = this.powerRevision;
        const afterAckAt = this.now();
        this.closeConnection(new WattpilotError('Refreshing Wattpilot stopped-state confirmation.'));
        await this.connect();
        checkCancellation();
        await this.waitForStopped(afterAckRevision, afterAckAt, signal);
      }
      if (command.mode !== 'pause') {
        if (changingPhases) {
          await this.waitForStopped(powerRevision, pauseRequestedAt, signal);
          stoppedForPhaseChange = true;
          await apply('psm', requestedPhaseMode!);
        }
        if (!preserveEco) await apply('amp', command.currentAmps!);
        await apply('lmo', command.mode === 'eco' ? 4 : 3);
        await apply('frc', 0);
      }
      if (Object.keys(expected).some(key => this.properties[key] !== expected[key])) {
        throw new WattpilotError('Wattpilot settings changed externally; command outcome is unknown.', 409, 'unknown');
      }
      return this.snapshot();
    } catch (error) {
      if (wrote && error instanceof WattpilotError && error.outcome !== 'unknown') {
        throw new WattpilotError(`${error.message} Some settings may already have changed.`, error.statusCode, 'unknown');
      }
      throw error;
    } finally {
      this.commanding = false;
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.closeConnection(new WattpilotError('Wattpilot controller is shut down.'));
  }
}
