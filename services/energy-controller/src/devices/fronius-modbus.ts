import ModbusRTU from 'modbus-serial';
import { BatteryMode } from '../types/common.js';
import { config } from '../config/index.js';

export class InverterControlError extends Error {
  constructor(message: string, public readonly statusCode = 409, public readonly recoverable = false) {
    super(message); this.name = 'InverterControlError';
  }
}
/** No supply register was changed; an existing owned window remains available for hold. */
export class SupplyAuthorizationExpiredError extends InverterControlError {
  constructor() { super('Automation supply source authorization expired before device write', 409); this.name = 'SupplyAuthorizationExpiredError'; }
}

export interface ControlPolicy {
  enabled: boolean;
  maxPowerWatts: number | null;
  maxSocPercent: number;
  maxDurationMs: number;
  revertTimeoutSeconds: number;
  checkIntervalMs: number;
}
export interface ModbusTransport {
  connectTCP(host: string, options: {port: number; timeout?: number}): Promise<unknown>;
  setID(id: number): void;
  setTimeout(ms: number): void;
  readHoldingRegisters(address: number, length: number): Promise<{data: number[]}>;
  writeRegister(address: number, value: number): Promise<unknown>;
  close(callback: () => void): void;
  destroy?(callback: () => void): void;
}
export interface ModbusOptions { client?: ModbusTransport; control?: ControlPolicy; now?: () => number; }
export interface StorageState { soc: number; reserve: number; maxPower: number; rateScale: number; mode: number; gridChargingAllowed: boolean; }

type Model = {id: number; address: number; length: number};
export interface ControlRequestContext { deadline: number; isCurrent?: () => boolean; chargeUntilFull?: boolean; renewable?: boolean; }
type Window = {out: number; input: number; timeout: number; chargeUntilFull: boolean; renewable: boolean; minimumSocPercent?: number};
const signed = (value: number) => value > 32767 ? value - 65536 : value;
const encoded = (value: number) => value === 0 ? 0 : value < 0 ? value + 65536 : value;

/** All requests, including reads and complete mutations, share one transport queue. */
export class FroniusModbus {
  private client: ModbusTransport;
  private readonly policy: ControlPolicy;
  private queue: Promise<unknown> = Promise.resolve();
  private connected = false;
  private transportOpen = false;
  private requestContext?: ControlRequestContext;
  private blockedUntil = 0;
  private storage?: Model;
  private inverter?: Model;
  private owned?: Window;
  private pendingRelease?: Window;
  private pendingReleaseAlternate?: Window;
  private ownershipMismatch?: string;
  private ownedDeadline = 0;
  private ownedTimer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;

  constructor(
    private readonly host = config.fronius.ip,
    private readonly port = config.fronius.modbus.port,
    private readonly unitId = config.fronius.modbus.unitId,
    _mode: 'int' | 'float' = config.fronius.modbus.mode,
    options: ModbusOptions = {},
  ) {
    this.client = options.client ?? new ModbusRTU();
    this.now = options.now ?? Date.now;
    this.policy = {...(options.control ?? config.fronius.control)};
  }

  getControlPolicy(): ControlPolicy { return {...this.policy}; }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async guardRequest(): Promise<number> {
    const deadline = Math.min(this.requestContext?.deadline ?? Infinity, this.owned ? this.ownedDeadline : Infinity);
    if (this.now() >= deadline) {
      await this.abandonControl();
      throw new InverterControlError('Battery control duration expired; transport closed for inverter fallback', 409);
    }
    if (this.requestContext?.isCurrent && !this.requestContext.isCurrent()) throw new InverterControlError('Battery control superseded during transaction', 409);
    if (!this.connected && this.now() < this.blockedUntil) throw new InverterControlError('Waiting for the inverter fallback before further Modbus traffic', 503);
    return Math.max(1, Math.min(5000, deadline - this.now()));
  }

  private async request<T>(operation: (timeout: number) => Promise<T>): Promise<T> {
    const timeout = await this.guardRequest();
    this.client.setTimeout(timeout);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation(timeout),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.abandonControl();
            reject(new InverterControlError('Modbus request timed out; connection closed', 503));
          }, timeout);
        }),
      ]);
      await this.guardRequest();
      return result;
    } finally { if (timer) clearTimeout(timer); }
  }

  private async read(address: number, length: number): Promise<number[]> {
    const {data} = await this.request(() => this.client.readHoldingRegisters(address, length));
    if (data.length !== length || data.some(value => !Number.isInteger(value) || value < 0 || value > 65535)) {
      throw new InverterControlError('Malformed Modbus response', 503);
    }
    return data;
  }

  private async writeVerified(address: number, value: number): Promise<void> {
    await this.request(() => this.client.writeRegister(address, value));
    if ((await this.read(address, 1))[0] !== value) throw new InverterControlError(`Register ${address} did not retain the requested value`, 503);
  }

  private async closeTransport(): Promise<void> {
    if (this.owned) this.pendingRelease ??= this.owned;
    this.clearOwned();
    if (!this.transportOpen) return;
    this.transportOpen = false; this.connected = false;
    this.storage = undefined; this.inverter = undefined;
    // Destroy, rather than graceful half-close: pending reads/connects must not keep the queue or fallback alive.
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 250);
      const done = () => { clearTimeout(timer); resolve(); };
      try { if (this.client.destroy) this.client.destroy(done); else this.client.close(done); }
      catch { done(); }
    });
  }

  private async abandonControl(): Promise<void> {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + this.policy.revertTimeoutSeconds * 1000);
    await this.closeTransport();
  }

  async connect(): Promise<void> { return this.exclusive(() => this.ensureConnected()); }

  private async ensureConnected(enforceLifetime = true): Promise<void> {
    if (enforceLifetime) await this.checkLifetime();
    await this.guardRequest();
    if (this.connected) return;
    try {
      this.transportOpen = true;
      await this.request(timeout => this.client.connectTCP(this.host, {port: this.port, timeout}));
      this.connected = true;
      this.client.setID(this.unitId); this.client.setTimeout(5000);
      await this.discover();
    } catch (error) {
      await this.closeTransport();
      throw error;
    }
  }

  private async discover(): Promise<void> {
    const signature = await this.read(40000, 2);
    if (signature[0] !== 0x5375 || signature[1] !== 0x6e53) throw new InverterControlError('SunSpec signature not found at PDU address 40000', 503);
    let address = 40002;
    let common: Model | undefined;
    let storage: Model | undefined;
    let inverter: Model | undefined;
    let terminated = false;
    for (let count = 0; count < 128 && address <= 65000; count++) {
      const [id, length] = await this.read(address, 2);
      if (id === 65535) {
        if (length !== 0) throw new InverterControlError('Invalid SunSpec terminator', 503);
        terminated = true; break;
      }
      if (id === 0 || length === 0 || length > 4096 || address + length + 2 > 65535) throw new InverterControlError('Invalid SunSpec model chain', 503);
      const model = {id, address, length};
      if (id === 1) { if (common || address !== 40002 || length !== 65) throw new InverterControlError('Unsupported SunSpec common model', 503); common = model; }
      if (id === 124) { if (storage || length !== 24) throw new InverterControlError('Unsupported storage model layout', 503); storage = model; }
      if ([101, 102, 103, 111, 112, 113].includes(id)) {
        if (inverter || length !== (id < 110 ? 50 : 60)) throw new InverterControlError('Unsupported inverter model layout', 503);
        inverter = model;
      }
      address += length + 2;
    }
    if (!terminated || !common || !storage || !inverter) throw new InverterControlError('Complete supported SunSpec model chain is required', 503);
    const identity = await this.read(common.address + 2, 32);
    const string = (words: number[]) => words.map(word => String.fromCharCode(word >> 8, word & 255)).join('').replace(/\0.*$/s, '').trim();
    if (string(identity.slice(0,16)).toLowerCase() !== 'fronius' || !/\b(?:primo|symo)\s+gen24\b/i.test(string(identity.slice(16)))) {
      throw new InverterControlError('Control supports identified Fronius Primo/Symo GEN24 devices only', 503);
    }
    this.storage = storage; this.inverter = inverter;
  }

  async scanForModel124(): Promise<number | null> {
    return this.exclusive(async () => { await this.ensureConnected(); return this.storage!.address; });
  }

  private scale(raw: number): number {
    const exponent = signed(raw);
    if (raw === 32768 || exponent < -6 || exponent > 6) throw new InverterControlError('Required SunSpec scale factor is unavailable or unsupported', 503);
    return 10 ** exponent;
  }

  private unsigned(raw: number, scale: number): number {
    if (raw === 65535) throw new InverterControlError('Required SunSpec value is unavailable', 503);
    return raw * scale;
  }

  private async safetyState(): Promise<StorageState> {
    const data = await this.read(this.storage!.address + 2, 24);
    const maxPower = this.unsigned(data[0], this.scale(data[16]));
    const reserve = this.unsigned(data[5], this.scale(data[19]));
    const soc = this.unsigned(data[6], this.scale(data[20]));
    const rateScale = this.scale(data[23]);
    if (!(maxPower > 0) || soc < 0 || soc > 100 || reserve < 0 || reserve > 100 || 100 / rateScale > 32767 || rateScale > 100) {
      // Invalid telemetry blocks every command, but an automatic interruption can
      // recover after a complete fresh safety read confirms healthy normal mode.
      throw new InverterControlError(
        `Invalid battery power, SOC, reserve or rate scaling (maxPowerWatts=${maxPower}, socPercent=${soc}, reserveSocPercent=${reserve}, rateScale=${rateScale})`,
        503, true,
      );
    }
    if (![2,3,4,5,6].includes(data[9])) throw new InverterControlError('Battery is off, calibrating or has unknown status', 409);
    if (![0,1,2,3].includes(data[3]) || ![0,1].includes(data[15])) throw new InverterControlError('Unsupported battery control settings', 409);
    const stateOffset = this.inverter!.id < 110 ? 38 : 48;
    const state = await this.read(this.inverter!.address + stateOffset, 10);
    const eventsSafe = state.slice(2,6).every(value => value === 0)
      && [6,8].every(index => state[index] === 0 && [0,4].includes(state[index + 1]));
    if (![4,5,8].includes(state[0]) || !eventsSafe) {
      const events = ['Evt1', 'Evt2', 'EvtVnd1', 'EvtVnd2'].map((name, index) => {
        const offset = 2 + index * 2;
        const value = state[offset] * 65536 + state[offset + 1];
        return `${name}=0x${value.toString(16).padStart(8, '0')}`;
      });
      // Off/sleeping/starting/shutting down can occur during routine insulation checks.
      // Faults, unknown states and event warnings still require explicit recovery.
      throw new InverterControlError(
        `Inverter is not ready or reports an active fault/warning (state=${state[0]}, StVnd=${state[1]}, ${events.join(', ')})`,
        409, eventsSafe && [1,2,3,6].includes(state[0]),
      );
    }
    return {soc, reserve, maxPower, rateScale, mode: data[3], gridChargingAllowed: data[15] === 1};
  }

  async readSafetyState(context?: ControlRequestContext): Promise<StorageState> {
    return this.exclusive(async () => {
      this.requestContext = context;
      try { await this.ensureConnected(); return await this.safetyState(); }
      finally { this.requestContext = undefined; }
    });
  }

  async getBatterySOC(): Promise<number> {
    return this.exclusive(async () => {
      await this.ensureConnected();
      const data = await this.read(this.storage!.address + 8, 1);
      const factor = await this.read(this.storage!.address + 22, 1);
      const soc = this.unsigned(data[0], this.scale(factor[0]));
      if (soc < 0 || soc > 100) throw new InverterControlError('Battery SOC is invalid', 503);
      return soc;
    });
  }

  private writable(): void {
    if (!this.policy.enabled) throw new InverterControlError('Inverter control is disabled; monitoring only', 403);
    if (!Number.isFinite(this.policy.maxPowerWatts) || this.policy.maxPowerWatts! <= 0) throw new InverterControlError('An explicit positive control power ceiling is required', 403);
    const p = this.policy;
    if (![p.maxSocPercent,p.maxDurationMs,p.revertTimeoutSeconds,p.checkIntervalMs].every(Number.isFinite) || p.maxSocPercent <= 0 || p.maxSocPercent > 100 || p.maxDurationMs < 1000 || p.maxDurationMs > 3600000 || !Number.isInteger(p.revertTimeoutSeconds) || p.revertTimeoutSeconds < 10 || p.revertTimeoutSeconds > 120 || p.checkIntervalMs < 1000 || p.checkIntervalMs > p.revertTimeoutSeconds * 1000 / 3) {
      throw new InverterControlError('Invalid inverter control safety policy', 403);
    }
  }

  private async ownsWindow(): Promise<boolean> {
    if (!this.owned || !this.connected || !this.storage) {
      this.ownershipMismatch = 'No active owned Modbus connection';
      return false;
    }
    const mode = (await this.read(this.storage.address + 5, 1))[0];
    const data = await this.read(this.storage.address + 12, 4);
    this.ownershipMismatch = [
      ['StorCtl_Mod', 3, mode],
      ['OutWRte', signed(this.owned.out), signed(data[0])],
      ['InWRte', signed(this.owned.input), signed(data[1])],
      ['InOutWRte_RvrtTms', this.owned.timeout, data[3]],
    ].filter(([, expected, observed]) => expected !== observed)
      .map(([name, expected, observed]) => `${name} expected ${expected}, observed ${observed}`).join('; ');
    return !this.ownershipMismatch;
  }

  private clearOwned(): void {
    this.owned = undefined;
    if (this.ownedTimer) clearTimeout(this.ownedTimer);
    this.ownedTimer = undefined;
  }

  private async checkLifetime(): Promise<void> { await this.guardRequest(); }

  private superviseLifetime(deadline: number): void {
    if (this.ownedTimer) clearTimeout(this.ownedTimer);
    this.ownedDeadline = deadline;
    const owner = this.owned;
    this.ownedTimer = setTimeout(() => {
      // This must run outside the request queue: a slow in-flight read cannot postpone disconnect.
      if (this.owned === owner && this.ownedDeadline === deadline) void this.abandonControl();
    }, Math.max(0, deadline - this.now()));
    this.ownedTimer.unref();
  }

  private async loseOwnership(): Promise<never> {
    const detail = this.ownershipMismatch ? ` (${this.ownershipMismatch})` : '';
    await this.abandonControl();
    throw new InverterControlError(`Battery control ownership was lost${detail}; no further commands were issued`, 409);
  }

  private async restore(): Promise<void> {
    if (!this.owned) return;
    this.pendingRelease = this.owned;
    try {
      if ((await this.read(this.storage!.address + 5, 1))[0] === 0) {
        this.clearPendingRelease();
        return;
      }
      if (!await this.ownsWindow()) {
        // A bound write may have reached the device even if its acknowledgement
        // was lost. Only the exact old or attempted window may be stopped.
        if (!this.pendingReleaseAlternate || this.owned === this.pendingReleaseAlternate) return await this.loseOwnership();
        this.owned = this.pendingReleaseAlternate;
        this.pendingRelease = this.owned;
        if (!await this.ownsWindow()) return await this.loseOwnership();
      }
      await this.writeVerified(this.storage!.address + 5, 0);
      this.clearPendingRelease();
    } finally { this.clearOwned(); }
  }

  private clearPendingRelease(): void {
    this.pendingRelease = undefined;
    this.pendingReleaseAlternate = undefined;
  }

  /** Passive cancellation only releases a window that is still ours. */
  async releaseControl(options: {retry?: boolean} = {}): Promise<void> {
    return this.exclusive(async () => {
      if (!this.owned && !this.pendingRelease) return;
      try {
        if (!this.owned) {
          // A failed stop retains its window across disconnect. Only cleanup may
          // reconnect before fallback; it must observe normal or verify that window.
          this.writable();
          if (!options.retry) await this.guardRequest();
          this.blockedUntil = 0;
          this.requestContext = {deadline: this.now() + 10_000};
          await this.ensureConnected(false);
          this.owned = this.pendingRelease;
          this.ownedDeadline = this.requestContext.deadline;
        }
        await this.restore();
      } catch (error) { await this.abandonControl(); throw error; }
      finally { this.requestContext = undefined; }
    });
  }

  /** Explicit recovery may clear a previous client's mode, but requires full control authorization. */
  async setBatteryMode(mode: BatteryMode): Promise<void> {
    if (mode !== BatteryMode.NORMAL) throw new InverterControlError('Force modes require explicit signed power; use setBatteryChargePower', 400);
    return this.exclusive(async () => {
      this.writable();
      this.blockedUntil = 0;
      this.requestContext = {deadline: this.now() + 30000};
      try {
        await this.ensureConnected(false);
        if (this.owned) await this.restore();
        else {
          const mode = (await this.read(this.storage!.address + 5, 1))[0];
          if (![0,1,2,3].includes(mode)) throw new InverterControlError('Unsupported storage control mode', 503);
          await this.writeVerified(this.storage!.address + 5, 0);
        }
        this.clearPendingRelease();
      } catch (error) { await this.abandonControl(); throw error; }
      finally { this.requestContext = undefined; }
    });
  }

  async setBatteryStandby(context?: ControlRequestContext): Promise<void> { return this.apply(0, context); }
  /** Charge-only [-6000 W, 0 W], per Fronius Power Window Specifications, examples 1/4:
   * https://manuals.fronius.com/html/4204102049/en-US.html
   * Zero remains allowed; the positive input bound sets a ceiling, not a charging request.
   */
  async setBatteryHold(context: ControlRequestContext, maxChargePowerWatts = 6000): Promise<void> {
    if (!context?.renewable || !Number.isFinite(context.deadline) || context.chargeUntilFull) {
      throw new InverterControlError('Battery hold requires a finite renewable supervision deadline', 400);
    }
    if (!Number.isFinite(maxChargePowerWatts) || maxChargePowerWatts < 0 || maxChargePowerWatts > 6000) {
      throw new InverterControlError('Battery hold power must be finite and between 0 and 6000 W', 400);
    }
    return this.apply(maxChargePowerWatts, context, true);
  }
  /** Natural discharge-only [0,+cap], never a forced negative-power setpoint. */
  async setBatterySupply(maxPowerWatts: number, minimumSocPercent: number, context: ControlRequestContext, authorizationDeadline?: number): Promise<void> {
    if (!context?.renewable || !Number.isFinite(context.deadline) || context.chargeUntilFull
      || !Number.isFinite(maxPowerWatts) || maxPowerWatts <= 0 || maxPowerWatts > 7000
      || !Number.isFinite(minimumSocPercent) || minimumSocPercent < 0 || minimumSocPercent >= 100
      || authorizationDeadline !== undefined && !Number.isFinite(authorizationDeadline)) {
      throw new InverterControlError('Battery supply requires a finite 0–7 kW cap, SOC floor and renewable deadline', 400);
    }
    return this.apply(-maxPowerWatts, context, false, minimumSocPercent, authorizationDeadline);
  }
  /** Natural operation with a charging ceiling; discharge remains permitted, never forced. */
  async setBatteryChargeLimit(maxChargePowerWatts: number, context: ControlRequestContext): Promise<void> {
    if (!context?.renewable || context.chargeUntilFull || !Number.isFinite(context.deadline)
      || !Number.isFinite(maxChargePowerWatts) || maxChargePowerWatts < 0 || maxChargePowerWatts > 6000) {
      throw new InverterControlError('Natural charging limit requires 0–6000 W and a renewable deadline', 400);
    }
    return this.apply(maxChargePowerWatts, context, false, undefined, undefined, true);
  }
  async setBatteryChargePower(watts: number, context?: ControlRequestContext): Promise<void> {
    if (watts === 0) {
      if (context?.chargeUntilFull) throw new InverterControlError('Charging until full requires positive power', 400);
      return this.releaseControl();
    }
    return this.apply(watts, context);
  }

  private async apply(watts: number, context?: ControlRequestContext, hold = false, minimumSocPercent?: number, authorizationDeadline?: number, chargeLimit = false): Promise<void> {
    return this.exclusive(async () => {
      this.writable();
      if (!Number.isFinite(watts) || Math.abs(watts) > this.policy.maxPowerWatts!) throw new InverterControlError('Requested power exceeds the configured limit or is not finite', 400);
      const chargeUntilFull = context?.chargeUntilFull === true;
      const supply = minimumSocPercent !== undefined;
      if (chargeUntilFull && (watts <= 0 || !Number.isFinite(context.deadline))) throw new InverterControlError('Charging until full requires positive power and a finite supervision deadline', 400);
      if (context?.renewable && !hold && !supply && !chargeLimit) throw new InverterControlError('Renewable supervision without charging requires battery hold or supply', 400);
      const renewable = chargeUntilFull || hold || supply || chargeLimit;
      let changed = false;
      const deadline = Math.min(context?.deadline ?? Infinity, this.now() + (renewable ? this.policy.revertTimeoutSeconds * 1000 : this.policy.maxDurationMs));
      this.requestContext = {...context, deadline};
      try {
        await this.ensureConnected();
        const state = await this.safetyState();
        if (supply && (minimumSocPercent! < state.reserve || state.soc <= minimumSocPercent!)) {
          throw new InverterControlError('Battery supply floor must protect installed reserve and be below current SOC', 409);
        }
        if (!hold && !chargeLimit && watts > 0 && !state.gridChargingAllowed) throw new InverterControlError('Forced charging requires grid-charging permission configured on the inverter', 409);
        if (Math.abs(watts) > state.maxPower) throw new InverterControlError('Requested power exceeds the SunSpec power reference', 400);
        if (!hold && !chargeLimit && (watts > 0 && state.soc >= (chargeUntilFull ? 100 : this.policy.maxSocPercent) || watts < 0 && state.soc <= state.reserve)) throw new InverterControlError('Requested direction violates SOC limits', 409);
        if (this.owned) {
          if (!await this.ownsWindow()) return await this.loseOwnership();
        } else if (state.mode !== 0) throw new InverterControlError('Another controller already owns the battery', 409, true);
        const units = Math.floor(Math.abs(watts) / state.maxPower * 100 / state.rateScale);
        if (watts !== 0 && units === 0) throw new InverterControlError('Requested power is below supported register resolution', 400);
        const window: Window = {out: chargeLimit ? Math.floor(Math.min(state.maxPower, 7000, this.policy.maxPowerWatts!) / state.maxPower * 100 / state.rateScale) : hold ? 0 : encoded(watts >= 0 ? -units : units), input: supply ? 0 : encoded(watts >= 0 ? units : -units),
          timeout: this.policy.revertTimeoutSeconds, chargeUntilFull, renewable,
          ...(supply ? {minimumSocPercent} : {})};
        // Initial source permission must still be fresh after every raw preflight read.
        // It never becomes a lifetime limit for an activated floor-controlled session.
        if (supply && authorizationDeadline !== undefined && this.now() >= authorizationDeadline) throw new SupplyAuthorizationExpiredError();
        // Renew identical windows without releasing control. A charge-to-hold
        // transition changes only the discharge bound, keeping solar charge available.
        if (this.owned && this.owned.input === window.input && this.owned.timeout === window.timeout
          && (this.owned.out === window.out || hold)) {
          changed = true;
          if (this.owned.out !== window.out) {
            this.pendingReleaseAlternate = window;
            await this.writeVerified(this.storage!.address + 12, window.out);
            this.owned = window;
          }
          await this.writeVerified(this.storage!.address + 5, 3);
          this.owned = window;
          this.superviseLifetime(deadline);
          if (!await this.ownsWindow()) return await this.loseOwnership();
          this.clearPendingRelease();
          return;
        }
        if (this.owned && (supply || hold || chargeLimit || watts > 0 || this.owned.minimumSocPercent !== undefined) && this.owned.timeout === window.timeout) {
          changed = true;
          const bound = async (key: 'out' | 'input', value: number) => {
            if (this.owned![key] === value) return;
            const next = {...this.owned!, [key]: value};
            this.pendingReleaseAlternate = next;
            await this.writeVerified(this.storage!.address + (key === 'out' ? 12 : 13), value);
            this.owned = next;
          };
          // Remove forced minima before narrowing to zero. Only then open the
          // new permitted direction; StorCtl_Mod stays owned/active throughout.
          if (signed(this.owned.out) < 0) await bound('out', 0);
          if (signed(this.owned.input) < 0) await bound('input', 0);
          await bound('out', 0); await bound('input', 0);
          if (signed(window.out) >= 0) await bound('out', window.out);
          if (signed(window.input) >= 0) await bound('input', window.input);
          if (signed(window.out) < 0) await bound('out', window.out);
          if (signed(window.input) < 0) await bound('input', window.input);
          await this.writeVerified(this.storage!.address + 5, 3);
          this.owned = window;
          this.superviseLifetime(deadline);
          if (!await this.ownsWindow()) return await this.loseOwnership();
          this.clearPendingRelease();
          return;
        }
        // Disable our previous window before changing either bound; never transiently create an invalid active window.
        if (this.owned) { changed = true; await this.writeVerified(this.storage!.address + 5, 0); this.clearOwned(); }
        changed = true;
        this.pendingRelease = window;
        await this.writeVerified(this.storage!.address + 15, window.timeout);
        await this.writeVerified(this.storage!.address + 12, window.out);
        await this.writeVerified(this.storage!.address + 13, window.input);
        await this.writeVerified(this.storage!.address + 5, 3);
        this.owned = window;
        this.superviseLifetime(deadline);
        if (!await this.ownsWindow()) return await this.loseOwnership();
        await this.checkLifetime();
        this.clearPendingRelease();
      } catch (error) {
        // This typed refusal precedes all writes. Preserve the old owned window for safe hold.
        if (error instanceof SupplyAuthorizationExpiredError && !changed) throw error;
        // Cancellation permits only cleanup, and cleanup retains the original hard deadline.
        if (this.requestContext) this.requestContext = {deadline: this.requestContext.deadline};
        // A failed sequence began only after observing normal mode or verifying our own window.
        // If cleanup cannot confirm normal, quarantine traffic so retries cannot renew the abandoned window.
        const potentiallyActive = changed || !!this.owned;
        let normalVerified = false;
        if (this.owned && this.connected) {
          try { await this.restore(); normalVerified = true; } catch { /* Preserve the inverter fallback. */ }
        } else if (changed && this.connected && this.storage) {
          try { await this.writeVerified(this.storage.address + 5, 0); normalVerified = true; } catch { /* Preserve the inverter fallback. */ }
        }
        this.clearOwned();
        if (potentiallyActive && !normalVerified) {
          await this.abandonControl();
          const detail = error instanceof Error ? error.message : String(error);
          throw new InverterControlError(`${detail}; normal-mode cleanup could not be verified`, 503);
        }
        if (normalVerified) this.clearPendingRelease();
        await this.closeTransport();
        throw error;
      } finally { this.requestContext = undefined; }
    });
  }

  async verifyControl(context?: ControlRequestContext): Promise<StorageState> {
    return this.exclusive(async () => {
      this.requestContext = context;
      try {
        await this.checkLifetime();
        if (!await this.ownsWindow()) return await this.loseOwnership();
        const state = await this.safetyState();
        const charging = signed(this.owned!.out) < 0;
        const discharging = signed(this.owned!.input) < 0 || this.owned!.minimumSocPercent !== undefined;
        if (charging && !state.gridChargingAllowed) throw new InverterControlError('Grid-charging permission was removed during control', 409);
        if (charging && state.soc >= (this.owned!.chargeUntilFull ? 100 : this.policy.maxSocPercent)
          || discharging && state.soc <= Math.max(state.reserve, this.owned!.minimumSocPercent ?? state.reserve)) return state;
        // GEN24 storage control can expire despite polling reads. Reassert only our verified,
        // safe window; request guards enforce the current lease/session deadline and cancellation.
        if (!await this.ownsWindow()) return await this.loseOwnership();
        await this.writeVerified(this.storage!.address + 5, 3);
        if (this.owned!.renewable) this.superviseLifetime(Math.min(context?.deadline ?? Infinity, this.now() + this.policy.revertTimeoutSeconds * 1000));
        return state;
      } finally { this.requestContext = undefined; }
    });
  }

  async disconnect(): Promise<void> {
    return this.exclusive(async () => {
      try { await this.restore(); }
      catch (error) { await this.abandonControl(); throw error; }
      finally { await this.closeTransport(); }
    });
  }

  async readDiagnostics(): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureConnected();
      console.log('SunSpec storage diagnostics:', {modelAddress: this.storage!.address, ...await this.safetyState()});
    });
  }
}
