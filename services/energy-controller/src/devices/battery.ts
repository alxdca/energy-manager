import { BatteryMode, BatteryInfo, DeviceStatus } from '../types/common.js';
import { FroniusInverter, type AutomationFence } from './fronius-inverter.js';

export interface BatteryOptions {
  capacityKwh?: number;
  /** Clock injection for deterministic status timestamps. */
  now?: () => Date;
}

/** Battery telemetry and exclusive ownership of manual battery controls. */
export class Battery {
  private batteryInfo: BatteryInfo | null = null;
  private readonly configuredCapacityKwh: number | null;
  private readonly now: () => Date;
  private status: DeviceStatus = { isOnline: false, lastSeen: new Date() };
  private generation = 0;
  private transition: Promise<unknown> = Promise.resolve();
  private refresh: Promise<void> | null = null;
  private activeJob: { generation: number; promise: Promise<void> } | null = null;

  constructor(private readonly inverter: FroniusInverter, options: BatteryOptions = {}) {
    this.configuredCapacityKwh = options.capacityKwh ?? null;
    this.now = options.now ?? (() => new Date());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation);
    this.transition = result.catch(() => undefined);
    return result;
  }

  private conflict(message = 'Battery control request was superseded'): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode: 409 });
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw this.conflict();
  }

  /** Invalidate inverter preflight immediately, even while a wrapper transition is awaiting I/O. */
  private beginControlTransition(): { generation: number; cancellation: Promise<void> } {
    const generation = ++this.generation;
    const cancellation = this.cancelOwnedControl();
    // A newer request may supersede this queue entry before it gets a chance to await cleanup.
    void cancellation.catch(() => undefined);
    return { generation, cancellation };
  }

  private async cancelOwnedControl(): Promise<void> {
    const job = this.activeJob;
    await this.inverter.cancelControl();
    // cancelControl ends the inverter's supervised job, including its pending wait.
    if (job) await job.promise.catch(() => undefined);
    if (this.activeJob === job) this.activeJob = null;
  }

  public async initialize(): Promise<void> {
    try {
      if (!this.inverter.isOnline()) await this.inverter.initialize();
      await this.refreshBatteryInfo();
    } catch (error) {
      this.updateStatus(false, this.errorMessage(error));
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    const { generation, cancellation } = this.beginControlTransition();
    await this.serialize(async () => {
      this.assertGeneration(generation);
      let failure: unknown;
      try {
        await cancellation;
      } catch (error) {
        failure = error;
      }
      this.assertGeneration(generation);
      try {
        await this.inverter.disconnect();
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], `Battery cleanup failed: ${this.errorMessage(failure)}; ${this.errorMessage(error)}`)
          : error;
      } finally {
        this.batteryInfo = null;
        this.updateStatus(false, failure ? this.errorMessage(failure) : undefined);
      }
      if (failure) throw failure;
      this.assertGeneration(generation);
    });
  }

  public getBatteryInfo(): BatteryInfo | null {
    return this.batteryInfo ? { ...this.batteryInfo, validValues: [...this.batteryInfo.validValues] } : null;
  }

  public async refreshInfo(): Promise<BatteryInfo | null> {
    await this.refreshBatteryInfo();
    return this.getBatteryInfo();
  }

  /** Unknown/malformed SOC stays unknown; energy/capacity estimates are not control telemetry. */
  public getChargePercentage(): number | null {
    const soc = this.batteryInfo?.socPercent;
    return this.batteryInfo?.validValues.includes('soc') && typeof soc === 'number'
      && Number.isFinite(soc) && soc >= 0 && soc <= 100 ? soc : null;
  }

  private async manualControl(operation: () => Promise<void>): Promise<void> {
    const { generation, cancellation } = this.beginControlTransition();
    await this.serialize(async () => {
      this.assertGeneration(generation);
      await cancellation;
      this.assertGeneration(generation);
      await operation();
      this.assertGeneration(generation);
    });
  }

  public async setChargePower(watts: number, targetSocPercent?: number): Promise<void> {
    await this.manualControl(() => this.inverter.setBatteryChargePower(watts, targetSocPercent));
  }

  /** Unlike manual commands, automation never cancels an existing control before ownership checks. */
  public async setAutomationCharge(watts: number, targetSocPercent: number, expiresAt: string, owner: string): Promise<void> {
    const generation = this.generation;
    await this.serialize(async () => {
      this.assertGeneration(generation);
      await this.inverter.setAutomationCharge(watts, targetSocPercent, expiresAt, owner);
      this.assertGeneration(generation);
    });
  }

  public async stopAutomationCharge(owner: string): Promise<void> {
    const generation = this.generation;
    await this.serialize(async () => {
      this.assertGeneration(generation);
      await this.inverter.stopAutomationCharge(owner);
      this.assertGeneration(generation);
    });
  }

  public async setAutomationHold(expiresAt: string, owner: string): Promise<void> {
    const generation = this.generation;
    await this.serialize(async () => {
      this.assertGeneration(generation);
      await this.inverter.setAutomationHold(expiresAt, owner);
      this.assertGeneration(generation);
    });
  }

  public async setAutomationSupply(maxPowerWatts: number, minimumSocPercent: number, expiresAt: string, owner: string, automationFence: AutomationFence, authorizationExpiresAt: string): Promise<void> {
    const generation = this.generation;
    await this.serialize(async () => {
      this.assertGeneration(generation);
      await this.inverter.setAutomationSupply(maxPowerWatts, minimumSocPercent, expiresAt, owner, automationFence, authorizationExpiresAt);
      this.assertGeneration(generation);
    });
  }

  /** Wait for a target job without holding the transition lock needed to cancel it. */
  public async chargeToTarget(watts: number, targetSocPercent: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw this.conflict('Battery target request was aborted');
    const { generation, cancellation } = this.beginControlTransition();
    let job: { generation: number; promise: Promise<void> } | null = null;
    let abortCancellation: Promise<void> | null = null;
    const abort = () => {
      // A disconnected older client must never stop the replacement owner's control.
      if (generation !== this.generation) return;
      abortCancellation = this.beginControlTransition().cancellation;
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Covers an abort delivered synchronously by initial cleanup before listener registration.
    if (signal?.aborted) abort();
    try {
      await this.serialize(async () => {
        this.assertGeneration(generation);
        await cancellation;
        this.assertGeneration(generation);
        job = { generation, promise: this.inverter.chargeToTarget(watts, targetSocPercent) };
        this.activeJob = job;
        void job.promise.catch(() => undefined);
      });
      const startedJob = job as { generation: number; promise: Promise<void> } | null;
      if (!startedJob) throw this.conflict();
      await startedJob.promise;
      this.assertGeneration(generation);
    } finally {
      signal?.removeEventListener('abort', abort);
      // Cleanup belongs to the generation captured by the listener; it never targets a later job.
      if (abortCancellation) await abortCancellation;
      if (this.activeJob === job) this.activeJob = null;
    }
  }

  public async setMode(mode: BatteryMode): Promise<void> {
    await this.manualControl(() => this.inverter.setBatteryMode(mode));
  }

  public async setStandby(): Promise<void> {
    await this.manualControl(() => this.inverter.setBatteryStandby());
  }

  private refreshBatteryInfo(): Promise<void> {
    if (this.refresh) return this.refresh;
    const refresh = (async () => {
      try {
        const data = await this.inverter.getBatteryData();
        this.batteryInfo = data ? {
          ...data,
          validValues: [...data.validValues],
          capacityKwh: this.configuredCapacityKwh ?? data.capacityKwh,
        } : null;
        if (this.batteryInfo && this.getChargePercentage() === null) {
          this.batteryInfo.socPercent = null;
          this.batteryInfo.validValues = this.batteryInfo.validValues.filter(value => value !== 'soc');
        }
        this.updateStatus(data !== null);
      } catch (error) {
        this.batteryInfo = null;
        this.updateStatus(false, this.errorMessage(error));
        throw error;
      }
    })();
    this.refresh = refresh;
    void refresh.finally(() => {
      if (this.refresh === refresh) this.refresh = null;
    }).catch(() => undefined);
    return refresh;
  }

  public getStatus(): DeviceStatus { return { ...this.status }; }
  public isOnline(): boolean { return this.status.isOnline; }

  private updateStatus(isOnline: boolean, error?: string): void {
    this.status = { isOnline, lastSeen: this.now(), error };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  public async cleanup(): Promise<void> { await this.disconnect(); }
}
