import { BatteryMode, BatteryInfo, SolarInfo, GridInfo, DeviceStatus } from '../types/common.js';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { FroniusModbus, InverterControlError, SupplyAuthorizationExpiredError, type ControlPolicy } from './fronius-modbus.js';
import { createEnergyCounterReader } from './energy-counters.js';
export { InverterControlError } from './fronius-modbus.js';

const DEFAULT_BATTERY_CAPACITY_KWH = 75;
const DEFAULT_SOLAR_CAPACITY_KW = 8.5;

type PowerFlowData = {
  Site?: {
    P_PV?: number;
    P_Load?: number;
    P_Grid?: number;
    P_Akku?: number;
  };
  Storage?: Record<string, StorageEntry>;
  Inverters?: Record<string, { SOC?: number | null; Battery_Mode?: string | null }>;
};

type StorageEntry = {
  Controller?: StoragePayload;
} & StoragePayload;

type StoragePayload = {
  SOC?: number | null;
  StateOfCharge?: number | null;
  StateOfCharge_Relative?: number | null;
  Current_DC?: number | null;
  Power_DC?: number | null;
  P_Akku?: number | null;
};

type StorageRealtimeData = {
  StateOfCharge_Relative?: number | null;
  StateOfCharge?: number | null;
  Current_DC?: number | null;
  Power_DC?: number | null;
  P_Akku?: number | null;
};

export interface SystemOverview {
  solar: SolarInfo | null;
  grid: GridInfo | null;
  battery: BatteryInfo | null;
  site?: PowerFlowData['Site'] | null;
}

export type InverterModbus = Pick<FroniusModbus,
  'connect' | 'disconnect' | 'setBatteryMode' | 'setBatteryStandby' | 'setBatteryHold' | 'setBatterySupply' | 'setBatteryChargePower' |
  'setBatteryChargeLimit' | 'getBatterySOC' | 'readSafetyState' | 'verifyControl' | 'releaseControl' | 'getControlPolicy' | 'scanForModel124' | 'readDiagnostics'>;
export interface FroniusInverterOptions {
  modbus?: InverterModbus;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: any) => void;
  /** Fresh load includes the Tesla, but excludes battery charging. */
  readSiteLoadWatts?: () => Promise<number | null>;
  energyCounterFetch?: typeof globalThis.fetch;
}
export interface InverterControlStatus {
  enabled: boolean;
  active: boolean;
  watts?: number;
  targetSocPercent?: number;
  startedAt?: string;
  expiresAt?: string | null;
  automationOwner?: string;
  automationMode?: 'charge' | 'hold' | 'supply';
  minimumSocPercent?: number;
  error?: string;
  sitePowerProtection?: { limitWatts: number; siteLoadWatts: number | null; chargingLimitWatts: number; error: string | null };
  requestedWatts?: number;
  chargingPowerLimitWatts?: number;
  siteLoadWatts?: number | null;
  siteLimitExceeded?: boolean;
}
export interface AutomationFence { bootId: string; generation: number }
export function isAutomationFence(value: unknown): value is AutomationFence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fence = value as Record<string, unknown>;
  return Object.keys(fence).every(key => key === 'bootId' || key === 'generation')
    && typeof fence.bootId === 'string' && fence.bootId.length > 0 && fence.bootId.length <= 80
    && typeof fence.generation === 'number' && Number.isSafeInteger(fence.generation) && fence.generation >= 0;
}
type ControlSession = {
  generation: number;
  watts: number;
  requestedWatts: number;
  chargingPowerLimitWatts?: number;
  siteLoadWatts?: number | null;
  target?: number;
  interval: number;
  started: number;
  deadline?: number;
  /** Persistent control with renewable finite supervision leases, including custom SOC targets. */
  chargeUntilFull: boolean;
  automationOwner?: string;
  automationMode?: 'charge' | 'hold' | 'supply';
  minimumSocPercent?: number;
  timer?: unknown;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};
type PendingAutomationStop = {owner: string; error?: Error; timer?: unknown};

/**
 * Fronius Symo Gen24 10 Plus inverter
 * Controls solar panels, battery, and grid interaction
 * Uses HTTP API for reading data and Modbus TCP for control
 */
export class FroniusInverter {
  private readonly ipAddress: string;
  private readonly port: number;
  private readonly apiBaseUrl: string;
  private modbus: InverterModbus;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  private readonly clearTimer: (timer: any) => void;
  private readonly readSiteLoadWatts: () => Promise<number | null>;
  private readonly energyCounterReader: ReturnType<typeof createEnergyCounterReader>;
  private controlQueue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private readonly bootId = randomUUID();
  private session?: ControlSession;
  private pendingAutomationStop?: PendingAutomationStop;
  private controlError?: Error;
  private automaticRecovery = false;
  private sitePowerTimer?: unknown;
  private sitePowerRunning = false;
  private naturalChargingLimited = false;
  private sitePowerProtection?: InverterControlStatus['sitePowerProtection'];
  private automationReserve?: { at: number; value: number | null };
  private initialization?: Promise<void>;
  private powerFlowRequest?: Promise<PowerFlowData | null>;
  private storageRequest?: Promise<StorageRealtimeData | null>;
  private status: DeviceStatus;

  constructor(ipAddress?: string, port?: number, options: FroniusInverterOptions = {}) {
    this.ipAddress = ipAddress || config.fronius.ip;
    this.port = port || config.fronius.port;
    // Only include port if it's not the default HTTP port (80)
    const portSuffix = this.port === 80 ? '' : `:${this.port}`;
    this.apiBaseUrl = `http://${this.ipAddress}${portSuffix}/solar_api/v1`;
    // Initialize Modbus client for control operations
    this.modbus = options.modbus ?? new FroniusModbus(this.ipAddress);
    this.now = options.now ?? Date.now;
    this.energyCounterReader = createEnergyCounterReader({ baseUrl: this.apiBaseUrl, fetch: options.energyCounterFetch,
      now: () => new Date(this.now()) });
    this.setTimer = options.setTimer ?? ((callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer; });
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.readSiteLoadWatts = options.readSiteLoadWatts ?? (async () => {
      const load = (await this.fetchPowerFlowData())?.Site?.P_Load;
      return typeof load === 'number' && Number.isFinite(load) && load <= 0 ? -load : null;
    });
    this.status = {
      isOnline: false,
      lastSeen: new Date(),
      error: undefined,
    };
  }

  /**
   * Initialize inverter connection (HTTP API and Modbus)
   */
  public initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    const pending = (async () => {
      try {
        await this.getInverterInfo();
        // Monitoring does not need a Modbus connection; unsupported/offline control must not block HTTP telemetry.
        if (this.modbus.getControlPolicy().enabled) await this.modbus.connect();
        this.updateStatus(true);
      } catch (error) {
        this.updateStatus(false, error instanceof Error ? error.message : 'Unknown error');
        throw error;
      }
    })();
    this.initialization = pending;
    void pending.catch(() => { if (this.initialization === pending) this.initialization = undefined; });
    return pending;
  }

  public async disconnect(): Promise<void> {
    this.sitePowerRunning = false;
    if (this.sitePowerTimer !== undefined) this.clearTimer(this.sitePowerTimer);
    this.sitePowerTimer = undefined;
    try {
      await this.cancelControl();
      if (this.naturalChargingLimited) await this.serialized(() => this.modbus.releaseControl());
      this.naturalChargingLimited = false;
    } finally {
      try { await this.modbus.disconnect(); } finally { this.initialization = undefined; this.updateStatus(false); }
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.controlQueue.then(operation);
    this.controlQueue = pending.catch(() => undefined);
    return pending;
  }

  private recordControlError(error?: unknown, automated = false): void {
    this.controlError = error === undefined ? undefined : error instanceof Error ? error : new Error(String(error));
    this.automaticRecovery = automated && this.controlError instanceof InverterControlError && this.controlError.recoverable;
  }

  public getControlStatus(): InverterControlStatus {
    const active = this.session;
    return {
      enabled: this.modbus.getControlPolicy().enabled,
      active: !!active,
      ...(this.sitePowerProtection ? {sitePowerProtection: {...this.sitePowerProtection}} : {}),
      ...(active ? {watts: active.watts, targetSocPercent: active.target,
        requestedWatts: active.requestedWatts,
        ...(active.chargingPowerLimitWatts === undefined ? {} : {
          chargingPowerLimitWatts: active.chargingPowerLimitWatts, siteLoadWatts: active.siteLoadWatts,
          siteLimitExceeded: active.siteLoadWatts !== null && active.siteLoadWatts !== undefined && active.siteLoadWatts > 16000 }),
        ...(active.minimumSocPercent === undefined ? {} : {minimumSocPercent: active.minimumSocPercent}),
        startedAt: new Date(active.started).toISOString(), expiresAt: active.deadline === undefined ? null : new Date(active.deadline).toISOString(),
        ...(active.automationOwner ? {automationOwner: active.automationOwner, automationMode: active.automationMode} : {})} : {}),
      ...(this.controlError ? {error: this.controlError.message} : {}),
    };
  }

  /** A snapshot authorizes supply only while the same control generation still owns it. */
  public getAutomationFence(): AutomationFence {
    return {bootId: this.bootId, generation: this.session?.generation ?? this.generation};
  }

  /** Fresh inverter reserve for planning; a read failure must not prevent manual recovery. */
  public getAutomationReserve(): Promise<number | null> {
    if (!this.modbus.getControlPolicy().enabled) return Promise.resolve(null);
    return this.serialized(async () => {
      const now = this.now();
      if (this.automationReserve && now >= this.automationReserve.at && now - this.automationReserve.at < 5000) {
        return this.automationReserve.value;
      }
      let value: number | null = null;
      try {
        const state = await this.modbus.readSafetyState({ deadline: now + 4000 });
        if (Number.isFinite(state.reserve) && state.reserve >= 0 && state.reserve <= 100) {
          value = state.reserve;
          // Only a fresh complete safety check and confirmed normal mode can clear an
          // automated interruption. The planner must authorize any new command.
          if (this.automaticRecovery && !this.session && state.mode === 0) this.recordControlError();
        }
      } catch (error) {
        // A real device/control rejection observed while waiting must not later be
        // cleared as though it were still the original temporary interruption.
        if (this.automaticRecovery && error instanceof InverterControlError && error.statusCode === 409 && !error.recoverable) {
          this.recordControlError(error);
        }
        // Unknown reserve blocks automation, while status and explicit recovery remain available.
      }
      this.automationReserve = { at: now, value };
      return value;
    });
  }

  public setBatteryMode(mode: BatteryMode): Promise<void> {
    if (mode !== BatteryMode.NORMAL) return Promise.reject(new InverterControlError('Force modes require explicit signed power; use the power command', 400));
    ++this.generation;
    return this.serialized(async () => {
      try {
        const hadSession = !!this.session;
        await this.finishControl(new InverterControlError('Battery control cancelled', 409));
        if (!hadSession) await this.modbus.setBatteryMode(BatteryMode.NORMAL);
        this.clearPendingAutomationStop();
        this.recordControlError();
      } catch (error) {
        this.recordControlError(error);
        throw error;
      }
    });
  }

  public async setBatteryStandby(): Promise<void> { await this.startControl(0); }

  public async setBatteryChargePower(watts: number, targetSocPercent?: number): Promise<void> {
    const policy = this.modbus.getControlPolicy();
    if (targetSocPercent !== undefined && (!Number.isFinite(watts) || watts <= 0 || typeof targetSocPercent !== 'number'
      || !Number.isFinite(targetSocPercent) || targetSocPercent <= 0 || targetSocPercent > policy.maxSocPercent)) {
      throw new InverterControlError('Target SOC requires finite positive watts and a target inside configured SOC limits', 400);
    }
    if (watts === 0) return this.cancelControl();
    await this.startControl(watts, {chargeUntilFull: watts > 0, targetSocPercent});
  }

  public async chargeToTarget(watts: number, targetSocPercent: number, checkIntervalMs?: number): Promise<void> {
    const policy = this.modbus.getControlPolicy();
    if (!Number.isFinite(watts) || watts <= 0 || !Number.isFinite(targetSocPercent) || targetSocPercent <= 0 || targetSocPercent > policy.maxSocPercent) {
      throw new InverterControlError('Target charging requires finite positive watts and a target inside configured SOC limits', 400);
    }
    const session = await this.startControl(watts, {targetSocPercent, checkIntervalMs});
    if (session) await session.completion;
  }

  /** Automation can renew only its own finite lease; manual control always takes priority. */
  public async setAutomationCharge(watts: number, targetSocPercent: number, expiresAt: string, owner: string): Promise<void> {
    const policy = this.modbus.getControlPolicy();
    const deadline = Date.parse(expiresAt);
    if (!Number.isInteger(watts) || watts <= 0 || watts > 6000 || !Number.isFinite(targetSocPercent) || targetSocPercent <= 0 || targetSocPercent > policy.maxSocPercent
      || typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)
      || typeof expiresAt !== 'string' || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== expiresAt
      || deadline <= this.now() || deadline > this.now() + 16 * 60_000) {
      throw new InverterControlError('Automation requires integer power from 1 to 6000 W within configured limits, a safe SOC target, an owner and a UTC expiry within 16 minutes', 400);
    }
    await this.startControl(watts, {targetSocPercent, chargeUntilFull: true, deadline, automationOwner: owner});
  }

  public stopAutomationCharge(owner: string): Promise<void> {
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)) {
      return Promise.reject(new InverterControlError('A valid automation owner is required', 400));
    }
    const requestedGeneration = this.generation;
    return this.serialized(async () => {
      if (requestedGeneration !== this.generation || this.session && this.session.automationOwner !== owner) {
        throw new InverterControlError('Automation cannot replace another battery controller', 409);
      }
      if (this.pendingAutomationStop && this.pendingAutomationStop.owner !== owner) {
        throw new InverterControlError('Automation cannot replace another battery controller', 409);
      }
      ++this.generation;
      if (this.session) await this.finishControl();
      else if (this.pendingAutomationStop) await this.retryAutomationStop(this.pendingAutomationStop);
    });
  }

  public async setAutomationHold(expiresAt: string, owner: string): Promise<void> {
    const deadline = Date.parse(expiresAt);
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)
      || typeof expiresAt !== 'string' || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== expiresAt
      || deadline <= this.now() || deadline > this.now() + 16 * 60_000) {
      throw new InverterControlError('Automation hold requires an owner and a UTC expiry within 16 minutes', 400);
    }
    // The hold permits solar charging up to 6 kW, so the same configured ceiling is required.
    this.validateControl(6000, this.modbus.getControlPolicy().checkIntervalMs, this.modbus.getControlPolicy());
    await this.startControl(0, {deadline, automationOwner: owner, hold: true});
  }

  /** Allow natural discharge only, with a controller-supervised floor; never force it. */
  public async setAutomationSupply(maxPowerWatts: number, minimumSocPercent: number, expiresAt: string, owner: string, automationFence: AutomationFence, authorizationExpiresAt: string): Promise<void> {
    const deadline = Date.parse(expiresAt);
    const authorizationDeadline = Date.parse(authorizationExpiresAt);
    if (!Number.isFinite(maxPowerWatts) || maxPowerWatts <= 0 || maxPowerWatts > 7000
      || !Number.isFinite(minimumSocPercent) || minimumSocPercent < 0 || minimumSocPercent >= 100
      || typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)
      || !isAutomationFence(automationFence)
      || typeof authorizationExpiresAt !== 'string' || !Number.isFinite(authorizationDeadline)
      || new Date(authorizationDeadline).toISOString() !== authorizationExpiresAt || authorizationDeadline > this.now() + 10_000
      || typeof expiresAt !== 'string' || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== expiresAt
      || deadline <= this.now() || deadline > this.now() + 16 * 60_000) {
      throw new InverterControlError('Automation supply requires a safe power cap, SOC floor, owner and UTC expiry within 16 minutes', 400);
    }
    await this.startControl(-maxPowerWatts, {deadline, automationOwner: owner, minimumSocPercent, expectedFence: {...automationFence}, authorizationDeadline});
  }

  /** Invalidate synchronously so preflight/old callbacks cannot start or stop a later owner. */
  public cancelControl(): Promise<void> {
    ++this.generation;
    return this.serialized(async () => { await this.finishControl(new InverterControlError('Battery control cancelled', 409)); });
  }

  private validateControl(watts: number, interval: number, policy: ControlPolicy): void {
    if (!policy.enabled || !Number.isFinite(policy.maxPowerWatts) || policy.maxPowerWatts! <= 0) throw new InverterControlError('Inverter control requires explicit enablement and power ceiling', 403);
    if (!Number.isFinite(watts) || Math.abs(watts) > policy.maxPowerWatts! || !Number.isFinite(interval) || interval < 1000 || interval > policy.checkIntervalMs) {
      throw new InverterControlError('Power or monitoring interval is outside configured limits', 400);
    }
  }

  private async startControl(watts: number, options: {targetSocPercent?: number; checkIntervalMs?: number; chargeUntilFull?: boolean; deadline?: number; automationOwner?: string; hold?: boolean; minimumSocPercent?: number; expectedFence?: AutomationFence; authorizationDeadline?: number} = {}): Promise<ControlSession | undefined> {
    let requestedWatts = watts;
    let chargingPowerLimitWatts: number | undefined;
    let siteLoadWatts: number | null | undefined;
    const policy = this.modbus.getControlPolicy();
    let chargeUntilFull = options.chargeUntilFull === true;
    let target = options.targetSocPercent ?? (chargeUntilFull ? 100 : undefined);
    let hold = options.hold === true;
    let supply = options.minimumSocPercent !== undefined;
    const interval = options.checkIntervalMs ?? policy.checkIntervalMs;
    this.validateControl(watts, interval, policy);
    const requestedGeneration = this.generation;
    // An automated request must not invalidate pending manual preflight before checking ownership.
    let generation = options.automationOwner ? requestedGeneration : ++this.generation;
    const current = () => { if (generation !== this.generation) throw new InverterControlError('Battery control superseded before activation', 409); };
    return this.serialized(async () => {
      const continuingOwned = this.session !== undefined && this.session.automationOwner === options.automationOwner;
      if (options.automationOwner) {
        if (options.authorizationDeadline !== undefined && this.now() >= options.authorizationDeadline) {
          throw new InverterControlError('Automation supply source authorization expired; a fresh plan is required', 409);
        }
        if (options.expectedFence && (options.expectedFence.bootId !== this.bootId || options.expectedFence.generation !== this.generation)) {
          throw new InverterControlError('Automation supply authorization was superseded; read a fresh control status', 409);
        }
        if (requestedGeneration !== this.generation || this.session && this.session.automationOwner !== options.automationOwner
          || this.pendingAutomationStop && this.pendingAutomationStop.owner !== options.automationOwner) {
          throw new InverterControlError('Automation cannot replace another battery controller', 409);
        }
        if (options.deadline! - 5000 <= this.now()) {
          if (this.session) await this.finishControl();
          else if (this.pendingAutomationStop?.owner === options.automationOwner) await this.retryAutomationStop(this.pendingAutomationStop);
          throw new InverterControlError('Automation lease expired before activation', 409, true);
        }
        generation = ++this.generation;
      }
      if (options.automationOwner && this.session?.automationOwner === options.automationOwner) {
        // Retain the owned Modbus window during renewal/charge-to-hold transitions.
        // Its existing finite deadline remains enforced until the replacement is verified.
        const previous = this.session;
        this.session = undefined;
        if (previous.timer !== undefined) this.clearTimer(previous.timer);
        previous.reject(new InverterControlError('Battery control replaced', 409));
      } else await this.finishControl(new InverterControlError('Battery control replaced', 409));
      current();
      const started = this.now();
      const deadline = options.deadline ?? (chargeUntilFull ? undefined : started + policy.maxDurationMs);
      const context = {deadline: deadline ?? started + policy.revertTimeoutSeconds * 1000, chargeUntilFull, renewable: hold || supply,
        isCurrent: () => generation === this.generation && (!options.automationOwner || this.now() < deadline! - 5000)};
      let authorizationError: InverterControlError | undefined;
      try {
        const state = await this.modbus.readSafetyState(context);
        this.automationReserve = { at: this.now(), value: Number.isFinite(state.reserve) && state.reserve >= 0 && state.reserve <= 100 ? state.reserve : null };
        current();
        if (options.automationOwner && this.now() >= deadline! - 5000) throw new InverterControlError('Automation deadline elapsed during preflight', 409, true);
        if (supply) {
          if (this.now() >= options.authorizationDeadline!) {
            authorizationError = new InverterControlError('Automation supply source authorization expired during preflight; owned hold retained', 409);
            if (!continuingOwned) throw authorizationError;
            hold = true; supply = false; watts = 0;
          }
          if (options.minimumSocPercent! < state.reserve || state.soc <= options.minimumSocPercent!) {
            if (!continuingOwned) throw new InverterControlError('Supply floor must protect installed reserve and be below current SOC', 409);
            options.minimumSocPercent = Math.max(options.minimumSocPercent!, state.reserve);
            hold = true; supply = false; watts = 0;
          }
        }
        if (target !== undefined && state.soc >= target) {
          if (!options.automationOwner) { this.recordControlError(); return undefined; }
          hold = true; watts = 0; target = undefined; chargeUntilFull = false;
          requestedWatts = 0;
          context.chargeUntilFull = false; context.renewable = true;
        }
        if (watts > 0 && state.soc >= (chargeUntilFull ? 100 : policy.maxSocPercent) || watts < 0 && state.soc <= state.reserve) throw new InverterControlError('Requested direction violates SOC limits', 409);
        if (watts > 0 || hold) {
          siteLoadWatts = await this.readSiteLoadWatts().catch(() => null);
          current();
          const desired = watts > 0 ? watts : Math.min(6000, policy.maxPowerWatts!);
          chargingPowerLimitWatts = this.siteChargingAllowance(siteLoadWatts, desired);
          this.sitePowerProtection = {limitWatts: 16000, siteLoadWatts, chargingLimitWatts: chargingPowerLimitWatts, error: null};
          if (watts > 0) { watts = chargingPowerLimitWatts; if (watts === 0) hold = true; }
        }
        if (hold) await this.modbus.setBatteryHold({ ...context, chargeUntilFull: false, renewable: true },
          chargingPowerLimitWatts ?? Math.min(6000, policy.maxPowerWatts!));
        else if (supply) {
          try { await this.modbus.setBatterySupply(-watts, options.minimumSocPercent!, context, options.authorizationDeadline); }
          catch (error) {
            if (!(error instanceof SupplyAuthorizationExpiredError) || !continuingOwned) throw error;
            current();
            authorizationError = new InverterControlError(`${error.message}; owned hold retained`, 409);
            hold = true; supply = false; watts = 0;
            siteLoadWatts = await this.readSiteLoadWatts().catch(() => null);
            current();
            chargingPowerLimitWatts = this.siteChargingAllowance(siteLoadWatts, Math.min(6000, policy.maxPowerWatts!));
            await this.modbus.setBatteryHold(context, chargingPowerLimitWatts);
          }
        }
        else if (watts === 0) await this.modbus.setBatteryStandby(context);
        else await this.modbus.setBatteryChargePower(watts, context);
        current();
        if (this.now() >= context.deadline) throw new InverterControlError('Control deadline elapsed during activation', 503);
      } catch (error) {
        // Low-level recovery owns partial register transactions; this also handles cancellation after activation.
        let cleanupFailure: unknown;
        try { await this.modbus.releaseControl(); } catch (failure) { cleanupFailure = failure; }
        try { await this.modbus.disconnect(); }
        catch (failure) { cleanupFailure ??= failure; }
        if (cleanupFailure && options.automationOwner) {
          this.clearPendingAutomationStop();
          this.pendingAutomationStop = {owner: options.automationOwner, error: error instanceof Error ? error : new Error(String(error))};
          this.scheduleAutomationStopRetry(this.pendingAutomationStop);
        }
        const failure = cleanupFailure ?? error;
        this.recordControlError(failure, !cleanupFailure && !!options.automationOwner);
        throw error;
      }
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      // Power/standby calls return after activation; their later failures remain visible through status.
      void completion.catch(() => undefined);
      const session: ControlSession = {generation, watts, requestedWatts, chargingPowerLimitWatts, siteLoadWatts,
        target, interval, started, deadline, chargeUntilFull, completion, resolve, reject, automationOwner: options.automationOwner,
        ...(options.minimumSocPercent === undefined ? {} : {minimumSocPercent: options.minimumSocPercent}),
        ...(options.automationOwner ? {automationMode: requestedWatts > 0 ? 'charge' : hold ? 'hold' : supply ? 'supply' : 'charge'} : {})};
      // Expired source permission is a policy rejection; a verified owned hold is healthy.
      this.session = session; this.recordControlError();
      this.clearPendingAutomationStop();
      this.scheduleControl(session);
      // Report stale permission after committing the safe owned hold, outside release-on-error cleanup.
      if (authorizationError) throw authorizationError;
      return session;
    });
  }

  /** Explicit runtime start; construction and status reads never issue commands. */
  public startSitePowerSupervision(): void {
    if (this.sitePowerRunning || !this.modbus.getControlPolicy().enabled) return;
    this.sitePowerRunning = true;
    const tick = () => {
      this.sitePowerTimer = undefined;
      void this.serialized(async () => {
        if (!this.sitePowerRunning || this.session || this.pendingAutomationStop || this.controlError) return;
        const generation = this.generation;
        const isCurrent = () => this.sitePowerRunning && !this.session && generation === this.generation;
        const load = await this.readSiteLoadWatts().catch(() => null);
        if (!isCurrent()) return;
        const policy = this.modbus.getControlPolicy();
        const limit = this.siteChargingAllowance(load, Math.min(6000, policy.maxPowerWatts!));
        this.sitePowerProtection = {limitWatts: 16000, siteLoadWatts: load, chargingLimitWatts: limit, error: null};
        await this.modbus.setBatteryChargeLimit(limit, {deadline: this.now() + policy.revertTimeoutSeconds * 1000,
          renewable: true, isCurrent});
        this.naturalChargingLimited = true;
      }).catch(error => {
        if (this.sitePowerProtection) this.sitePowerProtection.error = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        if (this.sitePowerRunning) this.sitePowerTimer = this.setTimer(tick, this.modbus.getControlPolicy().checkIntervalMs);
      });
    };
    tick();
  }

  private siteChargingAllowance(load: number | null | undefined, desiredWatts: number): number {
    return load !== null && load !== undefined && Number.isFinite(load) && load >= 0
      ? Math.max(0, Math.floor(Math.min(desiredWatts, 16000 - load))) : 0;
  }

  private async regulateSiteCharging(session: ControlSession): Promise<void> {
    if (!(session.requestedWatts > 0 || session.automationMode === 'hold')) return;
    const load = await this.readSiteLoadWatts().catch(() => null);
    if (this.session !== session || session.generation !== this.generation) return;
    const policy = this.modbus.getControlPolicy();
    const limit = this.siteChargingAllowance(load, session.requestedWatts > 0 ? session.requestedWatts : Math.min(6000, policy.maxPowerWatts!));
    const changed = limit !== session.chargingPowerLimitWatts;
    session.siteLoadWatts = load;
    this.sitePowerProtection = {limitWatts: 16000, siteLoadWatts: load, chargingLimitWatts: limit, error: null};
    if (!changed) return;
    const context = { deadline: session.deadline ?? this.now() + policy.revertTimeoutSeconds * 1000,
      isCurrent: () => this.session === session && session.generation === this.generation,
      renewable: !(session.requestedWatts > 0 && limit > 0), chargeUntilFull: session.requestedWatts > 0 && limit > 0 && session.chargeUntilFull };
    if (session.requestedWatts > 0 && limit > 0) await this.modbus.setBatteryChargePower(limit, context);
    else await this.modbus.setBatteryHold({ ...context, chargeUntilFull: false }, limit);
    if (this.session !== session || session.generation !== this.generation) return;
    session.generation = ++this.generation;
    session.chargingPowerLimitWatts = limit;
    if (session.requestedWatts > 0) session.watts = limit;
  }

  private async setGovernedHold(session: ControlSession): Promise<void> {
    const load = await this.readSiteLoadWatts().catch(() => null);
    const isCurrent = () => this.session === session && session.generation === this.generation;
    if (!isCurrent()) throw new InverterControlError('Battery control superseded', 409);
    const policy = this.modbus.getControlPolicy();
    const limit = this.siteChargingAllowance(load, Math.min(6000, policy.maxPowerWatts!));
    await this.modbus.setBatteryHold({deadline: session.deadline!, renewable: true, isCurrent}, limit);
    session.siteLoadWatts = load;
    session.chargingPowerLimitWatts = limit;
  }

  private scheduleControl(session: ControlSession): void {
    // Leave room for verified normal-mode cleanup before Modbus's hard deadline blocks all traffic.
    const stopAt = session.deadline === undefined ? undefined : session.deadline - (session.automationOwner ? 5000 : 0);
    session.timer = this.setTimer(() => {
      void this.serialized(async () => {
        if (this.session !== session || this.generation !== session.generation) return;
        // Do not refresh Fronius's inactivity fallback after a stalled event loop or app deadline.
        if (stopAt !== undefined && this.now() >= stopAt) { await this.finishControl(new InverterControlError('Battery control duration expired', 409, !!session.automationOwner)); return; }
        try {
          const policy = this.modbus.getControlPolicy();
          const state = await this.modbus.verifyControl({deadline: session.deadline ?? this.now() + policy.revertTimeoutSeconds * 1000, isCurrent:()=>this.session === session && this.generation === session.generation});
          this.automationReserve = { at: this.now(), value: Number.isFinite(state.reserve) && state.reserve >= 0 && state.reserve <= 100 ? state.reserve : null };
          await this.regulateSiteCharging(session);
          if (this.session !== session || this.generation !== session.generation) return;
          if (session.automationOwner && session.automationMode === 'supply'
            && state.soc <= Math.max(state.reserve, session.minimumSocPercent!)) {
            await this.setGovernedHold(session);
            if (this.session !== session || this.generation !== session.generation) return;
            session.generation = ++this.generation;
            session.watts = 0; session.automationMode = 'hold';
            this.scheduleControl(session);
            return;
          }
          if (session.target !== undefined && state.soc >= session.target || session.watts > 0 && state.soc >= (session.chargeUntilFull ? 100 : policy.maxSocPercent) || session.watts < 0 && state.soc <= state.reserve) {
            if (session.automationOwner && session.automationMode === 'charge') {
              await this.setGovernedHold(session);
              if (this.session !== session || this.generation !== session.generation) return;
              session.generation = ++this.generation;
              session.watts = 0; session.target = undefined; session.chargeUntilFull = false; session.automationMode = 'hold';
              session.requestedWatts = 0;
              this.scheduleControl(session);
              return;
            }
            await this.finishControl(); return;
          }
          if (stopAt !== undefined && this.now() >= stopAt) { await this.finishControl(new InverterControlError('Battery control duration expired', 409, !!session.automationOwner)); return; }
          this.scheduleControl(session);
        } catch (error) {
          if (session.automationOwner && session.minimumSocPercent !== undefined
            && this.session === session && this.generation === session.generation
            && session.deadline !== undefined && this.now() < session.deadline - 5000) {
            try {
              await this.setGovernedHold(session);
              if (this.session !== session || this.generation !== session.generation) return;
              session.generation = ++this.generation;
              session.watts = 0; session.automationMode = 'hold';
              this.recordControlError(error, true);
              this.scheduleControl(session);
              return;
            } catch { /* Device/transport failure still retains the finite inverter fallback. */ }
          }
          await this.finishControl(error instanceof Error ? error : new Error(String(error)), true);
        }
      }).catch(error => { this.recordControlError(error); });
    }, Math.min(session.interval, stopAt === undefined ? session.interval : Math.max(0, stopAt - this.now())));
  }

  private clearPendingAutomationStop(): void {
    if (this.pendingAutomationStop?.timer !== undefined) this.clearTimer(this.pendingAutomationStop.timer);
    this.pendingAutomationStop = undefined;
  }

  private scheduleAutomationStopRetry(pending: PendingAutomationStop): void {
    if (this.pendingAutomationStop !== pending || pending.timer !== undefined) return;
    pending.timer = this.setTimer(() => {
      pending.timer = undefined;
      void this.serialized(async () => {
        if (this.pendingAutomationStop !== pending || this.session) return;
        await this.retryAutomationStop(pending);
      }).catch(() => { /* The failed stop remains visible and schedules its next retry. */ });
    }, 5000);
  }

  private async retryAutomationStop(pending: PendingAutomationStop): Promise<void> {
    try {
      await this.modbus.releaseControl({retry: true});
      this.clearPendingAutomationStop();
      this.recordControlError(pending.error, true);
    } catch (error) {
      this.recordControlError(error);
      this.scheduleAutomationStopRetry(pending);
      throw error;
    }
  }

  private async finishControl(error?: Error, disconnect = false): Promise<void> {
    const session = this.session;
    if (!session) return;
    // Expiry/failure also consumes the old permission. Replacement/manual calls already advanced it.
    if (this.generation === session.generation) ++this.generation;
    this.session = undefined;
    if (session.timer !== undefined) this.clearTimer(session.timer);
    const pending = session.automationOwner ? {owner: session.automationOwner, error} : undefined;
    if (pending) {
      this.clearPendingAutomationStop();
      this.pendingAutomationStop = pending;
    }
    let failure: Error | undefined;
    try { await this.modbus.releaseControl(); }
    catch (restoreError) { failure = restoreError instanceof Error ? restoreError : new Error(String(restoreError)); disconnect = true; }
    if (disconnect) {
      try { await this.modbus.disconnect(); }
      catch (closeError) { failure ??= closeError instanceof Error ? closeError : new Error(String(closeError)); }
    }
    const result = failure ?? error;
    this.recordControlError(result, !failure && !!session.automationOwner);
    if (pending) {
      if (failure) this.scheduleAutomationStopRetry(pending);
      else this.clearPendingAutomationStop();
    }
    if (result) session.reject(result);
    else session.resolve();
    if (failure) throw failure;
  }

  /**
   * Read Modbus diagnostics (register values)
   */
  public async scanForModel124(): Promise<number | null> {
    try {
      return await this.modbus.scanForModel124();
    } catch (error) {
      console.error('Failed to scan for Model 124:', error);
      throw error;
    }
  }

  public async readModbusDiagnostics(): Promise<void> {
    try {
      await this.modbus.readDiagnostics();
    } catch (error) {
      console.error('Failed to read diagnostics:', error);
      throw error;
    }
  }

  /**
   * Get battery data from inverter
   */
  public async getBatteryData(): Promise<BatteryInfo | null> {
    const [powerFlow, storageRealtime] = await Promise.all([
      this.fetchPowerFlowData(),
      this.fetchStorageRealtimeData(),
    ]);

    return this.buildBatteryInfo(powerFlow, storageRealtime);
  }

  /**
   * Get solar panel data
   */
  public async getSolarData(): Promise<SolarInfo | null> {
    const powerFlow = await this.fetchPowerFlowData();
    if (!powerFlow) {
      return null;
    }
    return this.buildSolarInfo(powerFlow);
  }

  /**
   * Get grid/meter data
   */
  public async getGridData(): Promise<GridInfo | null> {
    const powerFlow = await this.fetchPowerFlowData();
    if (!powerFlow) {
      return null;
    }
    return this.buildGridInfo(powerFlow);
  }

  public async getSystemOverview(): Promise<SystemOverview> {
    const [powerFlow, storageRealtime] = await Promise.all([
      this.fetchPowerFlowData(),
      this.fetchStorageRealtimeData(),
    ]);

    if (!powerFlow && !storageRealtime) {
      return {
        solar: null,
        grid: null,
        battery: null,
      };
    }

    const batteryInfo = await this.buildBatteryInfo(powerFlow, storageRealtime);

    return {
      solar: powerFlow ? this.buildSolarInfo(powerFlow) : null,
      grid: powerFlow ? this.buildGridInfo(powerFlow) : null,
      battery: batteryInfo,
      site: powerFlow?.Site ?? null,
    };
  }

  private fetchPowerFlowData(): Promise<PowerFlowData | null> {
    if (this.powerFlowRequest) return this.powerFlowRequest;
    this.powerFlowRequest = this.requestPowerFlowData().finally(() => { this.powerFlowRequest = undefined; });
    return this.powerFlowRequest;
  }

  private async requestPowerFlowData(): Promise<PowerFlowData | null> {
    try {
      const endpoint = `${this.apiBaseUrl}/GetPowerFlowRealtimeData.fcgi`;
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        console.warn(`Failed to get power flow data: HTTP ${response.status}`);
        return null;
      }
      const payload = await response.json();
      return payload?.Body?.Data ?? null;
    } catch (error) {
      console.warn('Failed to get power flow data:', error);
      return null;
    }
  }

  private fetchStorageRealtimeData(): Promise<StorageRealtimeData | null> {
    if (this.storageRequest) return this.storageRequest;
    this.storageRequest = this.requestStorageRealtimeData().finally(() => { this.storageRequest = undefined; });
    return this.storageRequest;
  }

  private async requestStorageRealtimeData(): Promise<StorageRealtimeData | null> {
    try {
      const endpoint = `${this.apiBaseUrl}/GetStorageRealtimeData.cgi?Scope=Device&DeviceId=1`;
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });

      if (!response.ok) {
        console.warn(`Failed to get storage realtime data: HTTP ${response.status}`);
        return null;
      }

      const payload = await response.json();
      const controller = payload?.Body?.Data?.[0]?.Controller;

      if (!controller || typeof controller !== 'object') {
        return null;
      }

      return {
        StateOfCharge_Relative: controller.StateOfCharge_Relative ?? controller.SOC ?? null,
        StateOfCharge: controller.StateOfCharge ?? null,
        Current_DC: controller.Current_DC ?? null,
        Power_DC: controller.Power_DC ?? controller.P_Akku ?? null,
        P_Akku: controller.P_Akku ?? null,
      };
    } catch (error) {
      console.warn('Failed to get storage realtime data:', error);
      return null;
    }
  }

  private buildSolarInfo(data: PowerFlowData): SolarInfo | null {
    const site = data.Site;
    if (!site) {
      return null;
    }
    const pvPower = site.P_PV ?? null;
    return {
      capacityKw: DEFAULT_SOLAR_CAPACITY_KW,
      currentProductionKw: pvPower != null ? pvPower / 1000 : 0,
      dailyProductionKwh: 0,
    };
  }

  private buildGridInfo(data: PowerFlowData): GridInfo | null {
    const site = data.Site;
    if (!site) {
      return null;
    }

    const gridPower = site.P_Grid ?? null;
    const loadPower = site.P_Load ?? null;
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:config.system.timezone, hour:'2-digit',hourCycle:'h23'}).format(now));
    const isNightTime = hour >= 21 || hour < 7;
    const pricePerKwh = isNightTime ? 0.21 : 0.32;

    return {
      currentConsumptionKw: loadPower != null ? Math.max(loadPower, 0) / 1000 : 0,
      currentFeedInKw: gridPower != null && gridPower > 0 ? gridPower / 1000 : 0,
      dailyConsumptionKwh: 0,
      dailyFeedInKwh: 0,
      pricePerKwh,
    };
  }

  private async buildBatteryInfo(
    powerFlow: PowerFlowData | null,
    storageRealtime: StorageRealtimeData | null,
  ): Promise<BatteryInfo | null> {
    const site = powerFlow?.Site;
    const storageEntriesRaw = powerFlow?.Storage ? Object.values(powerFlow.Storage) : [];
    const storageFromPowerFlow = storageEntriesRaw
      .map((entry) => this.normalizeStorageEntry(entry))
      .find((entry) => entry !== null);

    // GEN24 reports SOC here even when its separate Storage API has no device.
    // Multiple battery-bearing inverters cannot be attributed to this battery safely.
    const inverters = powerFlow?.Inverters;
    const inverterSocs = inverters && typeof inverters === 'object' && !Array.isArray(inverters)
      ? Object.values(inverters).filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
        && entry.Battery_Mode !== 'disabled' && entry.Battery_Mode !== 'none operable'
        && typeof entry.SOC === 'number' && Number.isFinite(entry.SOC) && entry.SOC >= 0 && entry.SOC <= 100)
        .map(entry => entry.SOC!)
      : [];
    const inverterSoc = inverterSocs.length === 1 ? inverterSocs[0] : null;

    const rawSoc =
      storageRealtime?.StateOfCharge_Relative ??
      storageRealtime?.StateOfCharge ??
      storageFromPowerFlow?.StateOfCharge_Relative ??
      storageFromPowerFlow?.StateOfCharge ??
      inverterSoc ??
      null;

    const socPercent =
      typeof rawSoc === 'number' && Number.isFinite(rawSoc) && rawSoc >= 0 && rawSoc <= 100 ? rawSoc : null;

    const capacityKwh = DEFAULT_BATTERY_CAPACITY_KWH;
    const currentChargeKwh =
      socPercent != null ? (socPercent / 100) * capacityKwh : 0;

    const batteryPowerSite = site?.P_Akku ?? null;
    const powerDc = storageRealtime?.Power_DC ?? storageFromPowerFlow?.Power_DC ?? null;
    const powerAkku = storageRealtime?.P_Akku ?? storageFromPowerFlow?.P_Akku ?? null;

    const chargeRateKw = (() => {
      if (batteryPowerSite != null && batteryPowerSite < 0) {
        return Math.abs(batteryPowerSite) / 1000;
      }
      if (powerDc != null && powerDc < 0) {
        return Math.abs(powerDc) / 1000;
      }
      if (powerAkku != null && powerAkku < 0) {
        return Math.abs(powerAkku) / 1000;
      }
      return 0;
    })();

    const dischargeRateKw = (() => {
      if (batteryPowerSite != null && batteryPowerSite > 0) {
        return batteryPowerSite / 1000;
      }
      if (powerDc != null && powerDc > 0) {
        return powerDc / 1000;
      }
      if (powerAkku != null && powerAkku > 0) {
        return powerAkku / 1000;
      }
      return 0;
    })();

    // Determine which values are valid
    const validValues: Array<'soc' | 'chargeRate' | 'dischargeRate'> = [];
    if (socPercent != null) {
      validValues.push('soc');
    }
    if (chargeRateKw !== 0) {
      validValues.push('chargeRate');
    }
    if (dischargeRateKw !== 0) {
      validValues.push('dischargeRate');
    }

    return {
      capacityKwh,
      currentChargeKwh,
      chargeRateKw,
      dischargeRateKw,
      efficiency: 0.95,
      socPercent,
      validValues,
    };
  }

  private normalizeStorageEntry(entry: unknown): StorageRealtimeData | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const storage = entry as StorageEntry;
    const target: StoragePayload | undefined =
      storage.Controller && typeof storage.Controller === 'object'
        ? storage.Controller
        : storage;

    if (!target || typeof target !== 'object') {
      return null;
    }

    return {
      StateOfCharge_Relative: target.StateOfCharge_Relative ?? target.SOC ?? null,
      StateOfCharge: target.StateOfCharge ?? null,
      Current_DC: target.Current_DC ?? null,
      Power_DC: target.Power_DC ?? target.P_Akku ?? null,
      P_Akku: target.P_Akku ?? null,
    };
  }

  /**
   * Get basic inverter information
   * Using GetPowerFlowRealtimeData as it's more reliable for testing connectivity
   */
  private async getInverterInfo(): Promise<void> {
    try {
      const endpoint = `${this.apiBaseUrl}/GetPowerFlowRealtimeData.fcgi`;
      console.log(`Attempting to connect to: ${endpoint}`);
      console.log(`Note: Ensure the Fronius Solar API is enabled in your inverter settings`);
      
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('✓ Successfully connected to inverter');
      
      // Log some basic info if available
      if (data?.Body?.Data?.Site) {
        const site = data.Body.Data.Site;
        console.log(`  Power from PV: ${site.P_PV || 0} W`);
        console.log(`  Power to Grid: ${site.P_Grid || 0} W`);
        console.log(`  Power to Load: ${site.P_Load || 0} W`);
      }
    } catch (error) {
      // Enhanced error logging
      console.error('\nDetailed error information:');
      console.error('  Error type:', error instanceof Error ? error.constructor.name : typeof error);
      if (error instanceof Error) {
        console.error('  Error name:', error.name);
        console.error('  Error message:', error.message);
        if ('cause' in error) {
          console.error('  Error cause:', error.cause);
        }
      }
      
      if (error instanceof Error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          throw new Error(`Connection timeout: inverter at ${this.ipAddress}:${this.port} did not respond within 10 seconds. Check if Solar API is enabled.`);
        }
        if (error.message.includes('ECONNREFUSED')) {
          throw new Error(`Connection refused by inverter at ${this.ipAddress}:${this.port}. Verify IP address and that Solar API is enabled.`);
        }
        if (error.message.includes('EHOSTUNREACH') || error.message.includes('ENETUNREACH') || error.message.includes('EHOSTDOWN')) {
          throw new Error(`Cannot reach inverter at ${this.ipAddress}:${this.port}. Network error - check if device is on the same network/VLAN.`);
        }
        if (error.message.includes('ENOTFOUND')) {
          throw new Error(`DNS lookup failed for ${this.ipAddress}. Verify the IP address.`);
        }
        throw new Error(`Failed to connect to inverter at ${this.ipAddress}:${this.port}: ${error.message}`);
      }
      throw new Error(`Failed to connect to inverter at ${this.ipAddress}:${this.port}: ${error}`);
    }
  }

  /**
   * Get inverter IP address
   */
  public getIpAddress(): string {
    return this.ipAddress;
  }

  public getEnergyCounters() { return this.energyCounterReader(); }

  public getStatus(): DeviceStatus {
    return { ...this.status };
  }

  public isOnline(): boolean {
    return this.status.isOnline;
  }

  private updateStatus(isOnline: boolean, error?: string) {
    this.status = {
      isOnline,
      lastSeen: new Date(),
      error,
    };
  }
}
