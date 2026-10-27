import { getCarForceWindow, planCarCharge, validateCarTargetOverride } from './car-plan.js';
import { getCarTarget, getLocalDate, getNightTariffEnd, getSchedule } from './policy.js';
import type { CarTelemetry } from './tesla.js';
import type { Telemetry } from './status.js';
import type { EnergyForecast } from './automation-plan.js';
import type { WattpilotTelemetry } from './wattpilot.js';
import type { CarActivation, CarAutomationConfig, CarAutomationController, CarAutomationState,
  CarAutomationStatus, CarBatteryConstraint, CarBatteryContext, CarCheckpoint, CarPlan,
  CarPlanInput, CarTargetOverride } from './car-types.js';

export interface CarAutomationOptions {
  config: CarAutomationConfig;
  state: CarAutomationState;
  controller: CarAutomationController;
  readCar(): Promise<CarTelemetry>;
  refreshCarForCharging?(signal?: AbortSignal): Promise<CarTelemetry>;
  readTelemetry(): Promise<Telemetry>;
  readBattery(): Promise<CarBatteryContext>;
  readForecasts(): Promise<EnergyForecast[]>;
  coordinate(plan: CarPlan, isCurrent: () => boolean): Promise<void>;
  releaseCoordination(): Promise<void>;
  now?: () => Date;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onChange?: () => void;
  plan?: (input: CarPlanInput) => CarPlan;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const idleConstraint = (): CarBatteryConstraint => ({ active: false, allowCharge: true, until: null });

/** Explicitly opted-in policy execution; construction/status reads never actuate. */
export function createCarAutomation(options: CarAutomationOptions) {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const planner = options.plan ?? planCarCharge;
  let started = false, stopping = false;
  let generation = 0;
  let timer: unknown, cutoffTimer: unknown;
  let pending: Promise<void> | null = null;
  let evaluation: Promise<void> | null = null;
  let stopPending: Promise<void> | null = null;
  let shutdown: Promise<void> | null = null;
  let runAbort: AbortController | null = null;
  let constraint = idleConstraint();
  let uncertain = false;
  let mayHaveControlled = false;
  let lastWakeAt = -Infinity;
  let wasConnected: boolean | null = null;
  let checkpointTarget: CarPlan['target'] | null = null;
  let checkpointObservation: CarTelemetry | null = null;
  let current: CarAutomationStatus = {
    enabled: !options.state.manualOverride && !options.state.error,
    status: options.state.error ? 'blocked' : options.state.manualOverride ? 'manual' : 'idle',
    reason: options.state.error ? 'state_unavailable' : options.state.manualOverride ? 'manual_override' : 'not_started',
    error: options.state.error, lastEvaluatedAt: null, nextEvaluationAt: null, plan: null,
    lastCheckpoint: options.state.lastCheckpoint,
  };
  function changed() { try { options.onChange?.(); } catch { /* Observers cannot affect supervision. */ } }
  function update(status: CarAutomationStatus['status'], reason: string, error: string | null = null, plan = current.plan) {
    current = { ...current, enabled: !options.state.manualOverride && !options.state.error && !stopping,
      status, reason, error, plan, lastCheckpoint: options.state.lastCheckpoint };
    changed();
  }
  function clearCutoff() {
    if (cutoffTimer !== undefined) clearTimer(cutoffTimer);
    cutoffTimer = undefined;
  }
  async function release() {
    const active = constraint.active;
    constraint = idleConstraint();
    if (active) await options.releaseCoordination();
  }
  function stoppedStatus(charger: WattpilotTelemetry, revision: number) {
    const info = charger.automation;
    return info !== null && info !== undefined && info.owner === options.state.owner && info.epoch === options.state.epoch
      && info.lastRevision >= revision && !info.active && !info.stopping;
  }
  function responsibilityRevoked(charger: WattpilotTelemetry, epoch: string) {
    const info = charger.automation;
    return charger.status === 'online' && charger.ready && !charger.stale && info?.supported
      && !info.stopping && !info.error
      && (info.owner !== options.state.owner || info.epoch !== epoch || info.manualOverride);
  }
  function stopOwned(): Promise<void> {
    if (stopPending) return stopPending;
    clearCutoff();
    const epoch = options.state.epoch;
    const revision = options.state.revision;
    const task = (async () => {
      if (!epoch || revision < 1 || !mayHaveControlled && !uncertain) { await afterConfirmedStop(); return; }
      update('stopping', 'stopping');
      let result: WattpilotTelemetry;
      try { result = await options.controller.stop({ owner: options.state.owner, epoch, revision }); }
      catch (error) {
        const observed = await options.controller.read().catch(() => null);
        if (!observed || !responsibilityRevoked(observed, epoch)) {
          uncertain = true;
          throw error;
        }
        result = observed;
      }
      if (!stoppedStatus(result, revision) && !responsibilityRevoked(result, epoch)) {
        uncertain = true;
        throw new Error('L’arrêt de la recharge voiture n’est pas encore confirmé.');
      }
      mayHaveControlled = false;
      uncertain = false;
      // Keep the battery reservation until the owned car stop is confirmed.
      await afterConfirmedStop();
    })();
    stopPending = task;
    void task.finally(() => { if (stopPending === task) stopPending = null; }).catch(() => {});
    return task;
  }
  async function afterConfirmedStop() {
    const until = getNightTariffEnd(now());
    if (constraint.guardNight && until && wasConnected === true && !options.state.manualOverride && !options.state.error && !stopping) {
      // Normal can stop at 06:55 while the anti-grid-origin night guard lasts to 07:00.
      constraint = { active: true, allowCharge: true, until, guardNight: true };
      await options.releaseCoordination().catch(() => {});
    } else await release().catch(() => {});
  }
  function armCutoff(until: string) {
    clearCutoff();
    const end = Date.parse(until);
    if (!finite(end)) return;
    cutoffTimer = setTimer(() => {
      cutoffTimer = undefined;
      generation++;
      runAbort?.abort();
      void stopOwned().then(() => update('paused', 'outside_charging_window', null, null))
        .catch(error => update('stopping', 'stop_unconfirmed', error instanceof Error ? error.message : 'Arrêt indisponible.'));
    }, Math.max(0, end - now().getTime()));
  }
  function freshCar(car: CarTelemetry) {
    const at = car.observedAt === null ? NaN : Date.parse(car.observedAt);
    return car.status === 'online' && finite(car.socPercent) && car.socPercent >= 0 && car.socPercent <= 100
      && finite(at) && at <= now().getTime() + 5000 && now().getTime() - at <= options.config.socFreshnessMs
      && ['Charging', 'Complete', 'Stopped', 'Starting', 'NoPower'].includes(car.chargingState ?? '');
  }
  function safeSite(telemetry: Telemetry) {
    const at = telemetry.observedAt === null ? NaN : Date.parse(telemetry.observedAt);
    return telemetry.status === 'online' && finite(at) && at <= now().getTime() + 5000 && now().getTime() - at <= 10_000
      && [telemetry.householdKw, telemetry.gridImportKw, telemetry.gridExportKw, telemetry.batteryChargeKw, telemetry.batteryDischargeKw]
        .every(value => finite(value) && value >= 0);
  }
  async function checkpoint(car: CarTelemetry) {
    const target = checkpointTarget;
    if (target && freshCar(car)) {
      const at = Date.parse(car.observedAt!);
      const previous = Date.parse(checkpointObservation?.observedAt ?? '');
      // A response received on the checkpoint tick may carry the newest eligible
      // pre-departure sample. A later observation cannot establish an earlier SOC.
      if (at <= Date.parse(target.deadline) && (!finite(previous) || at > previous)) checkpointObservation = { ...car };
    }
    if (target && now().getTime() >= Date.parse(target.deadline)
      && !(options.state.lastCheckpoint?.date === target.date
        && options.state.lastCheckpoint.kind === (target.kind ?? 'morning'))) {
      const observed = checkpointObservation;
      const at = observed?.observedAt === null ? NaN : Date.parse(observed?.observedAt ?? '');
      const recent = observed?.status === 'online' && finite(observed.socPercent) && finite(at)
        && at <= Date.parse(target.deadline) && Date.parse(target.deadline) - at <= options.config.socFreshnessMs;
      const record: CarCheckpoint = { date: target.date, targetSocPercent: target.minimumSocPercent,
        observedSocPercent: recent ? observed!.socPercent : null,
        result: recent ? observed!.socPercent! >= target.minimumSocPercent ? 'met' : 'missed' : 'unknown',
        recordedAt: now().toISOString(), kind: target.kind ?? 'morning' };
      await options.state.setCheckpoint(record);
      checkpointTarget = null;
      checkpointObservation = null;
    }
    const override = options.state.targetOverride;
    if (override && Date.parse(override.deadline) <= now().getTime()
      && getLocalDate(new Date(override.deadline)) !== getCarTarget(now()).date) {
      await options.state.setTargetOverride(null);
    }
  }
  function allocation(plan: CarPlan, charger: WattpilotTelemetry): CarBatteryConstraint {
    const nightEnd = getNightTariffEnd(now());
    const guardNight = nightEnd !== null && charger.carConnected === true;
    const support = plan.batterySupport;
    const powerAt = charger.powerObservedAt === null ? NaN : Date.parse(charger.powerObservedAt);
    const drawing = finite(charger.powerWatts) && charger.powerWatts > 0 && finite(powerAt)
      && powerAt <= now().getTime() + 5000 && now().getTime() - powerAt <= 30_000;
    const supply = guardNight && drawing && support?.available && support.usableStoredKwh > 0
      && finite(support.minimumSocPercent) && support.minimumSocPercent >= 0 && support.minimumSocPercent <= 100
      && finite(support.maxDischargeKw) && support.maxDischargeKw > 0 && support.maxDischargeKw <= 7
      ? { minimumSocPercent: support.minimumSocPercent, maxDischargeKw: support.maxDischargeKw,
        ...(support.authorizationExpiresAt ? { authorizationExpiresAt: support.authorizationExpiresAt } : {}) } : undefined;
    return { active: guardNight || plan.action === 'charge' && plan.source === 'grid',
      allowCharge: supply ? false : plan.allowBatteryCharge,
      ...(plan.maxBatteryChargePowerKw === undefined ? {} : { maxChargePowerKw: plan.maxBatteryChargePowerKw }),
      until: guardNight ? nightEnd : plan.action === 'charge' ? plan.windowEndsAt : null,
      ...(guardNight ? { guardNight: true } : {}), ...(supply ? { supply } : {}) };
  }
  async function applyPlan(plan: CarPlan, car: CarTelemetry, telemetry: Telemetry,
    initialCharger: WattpilotTelemetry, abort: AbortController, isCurrent: () => boolean) {
    current.plan = plan;
    if (plan.status === 'blocked' || !['charge', 'eco'].includes(plan.action)) {
      await stopOwned();
      update(plan.status === 'blocked' ? 'blocked' : plan.action === 'wait' ? 'idle' : 'paused', plan.reason, null, plan);
      return;
    }
    const mode = plan.action === 'eco' ? 'eco' : 'normal';
    const forced = mode === 'normal';
    let charger = initialCharger;
    if (!charger.ready || !charger.controlEnabled || !Number.isInteger(plan.currentAmps)
      || plan.currentAmps! < 6 || plan.currentAmps! > options.config.maxCurrentAmps) {
      await stopOwned(); update('blocked', 'charger_unavailable', null, plan); return;
    }
    if (forced && (!freshCar(car) || !safeSite(telemetry) || charger.carConnected !== true
      || ![1, 3].includes(plan.phases as number) || !plan.windowEndsAt || plan.source !== 'grid')) {
      await stopOwned(); update('blocked', 'safety_unavailable', 'Des mesures récentes sont nécessaires pour forcer la recharge.', null); return;
    }
    if (!forced && charger.carConnected === true && !safeSite(telemetry)) {
      await stopOwned(); update('blocked', 'site_unavailable', 'L’état du réseau est indisponible.', plan); return;
    }
    const end = forced ? Date.parse(plan.windowEndsAt!) : Infinity;
    const permitted = () => isCurrent() && (!forced || now().getTime() < end && getCarForceWindow(now()) !== null);
    if (!permitted()) { await stopOwned(); update('paused', 'outside_charging_window', null, plan); return; }
    let info = charger.automation!;
    const matches = (observed: WattpilotTelemetry) => observed.mode === mode && observed.currentAmps === plan.currentAmps
      && (plan.phases === null || observed.phaseMode === plan.phases);
    const same = info.active && matches(charger) && info.revision === options.state.revision;
    if (!same && info.active) {
      await stopOwned();
      if (!permitted()) return;
      charger = await options.controller.read();
      info = charger.automation!;
      if (!info || info.epoch !== options.state.epoch || info.owner !== options.state.owner || info.manualOverride || info.stopping) {
        throw new Error('La session de recharge voiture a changé.');
      }
    }
    if (!permitted()) return;
    const previousAllocation = constraint.active;
    constraint = allocation(plan, charger);
    if (previousAllocation && !constraint.active) await options.releaseCoordination();
    await options.coordinate(plan, permitted);
    if (!permitted()) { await stopOwned(); return; }
    const expiresAt = new Date(Math.min(end, now().getTime() + options.config.leaseSeconds * 1000)).toISOString();
    const confirmed = (observed: WattpilotTelemetry, revision: number) => {
      const lease = observed.automation;
      return lease?.active && !lease.stopping && !lease.manualOverride && !lease.error
        && lease.epoch === options.state.epoch && lease.owner === options.state.owner && lease.revision === revision && matches(observed);
    };
    if (same) {
      const expiry = info.expiresAt === null ? NaN : Date.parse(info.expiresAt);
      const renewalAfterMs = Math.min(30_000, options.config.leaseSeconds * 500);
      const renewalMarginMs = options.config.leaseSeconds * 1000 - renewalAfterMs;
      if (!finite(expiry) || expiry - now().getTime() <= renewalMarginMs && Date.parse(expiresAt) > expiry) {
        const renewed = await options.controller.renew({ owner: options.state.owner, epoch: options.state.epoch!,
          revision: options.state.revision, expiresAt }, permitted, abort.signal);
        if (!permitted()) return;
        if (!confirmed(renewed, options.state.revision)) { uncertain = true; throw new Error('Le renouvellement de recharge voiture n’a pas pu être confirmé.'); }
      }
    } else {
      const revision = Math.max(options.state.revision, info.lastRevision) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('La révision de recharge est invalide.');
      await options.state.setSession(options.state.epoch, revision);
      if (!permitted()) return;
      const activation: CarActivation = { owner: options.state.owner, epoch: options.state.epoch!, revision,
        expiresAt, mode, currentAmps: plan.currentAmps!, ...(plan.phases === null ? {} : { phases: plan.phases }) };
      mayHaveControlled = true;
      if (forced) armCutoff(plan.windowEndsAt!);
      const applied = await options.controller.activate(activation, permitted, abort.signal);
      if (!permitted()) { await stopOwned(); return; }
      if (!confirmed(applied, revision)) {
        uncertain = true; await stopOwned(); throw new Error('La commande de recharge voiture n’a pas pu être confirmée.');
      }
    }
    if (!permitted()) return;
    if (forced) armCutoff(plan.windowEndsAt!);
    else clearCutoff();
    update(forced ? 'charging' : 'eco', plan.reason, null, plan);
  }
  async function run() {
    if (stopping || options.state.manualOverride) return;
    const captured = generation;
    const abort = new AbortController();
    let wakeBlockedReason: string | null = null;
    let wakeMaintenance = false;
    runAbort = abort;
    const isCurrent = () => captured === generation && !stopping && !options.state.manualOverride && !abort.signal.aborted;
    try {
      if (options.state.error) { await stopOwned(); update('blocked', 'state_unavailable', options.state.error, null); return; }
      let charger = await options.controller.read();
      if (!isCurrent()) return;
      if (wasConnected === false && charger.carConnected === true) lastWakeAt = -Infinity;
      wasConnected = charger.carConnected;
      const info = charger.automation;
      if (!info?.supported || !options.state.epoch) {
        await stopOwned(); update('blocked', 'controller_capabilities', 'Le contrôleur ne permet pas la supervision automatique de la voiture.', null); return;
      }
      if (info.epoch !== options.state.epoch || info.owner !== options.state.owner || info.manualOverride) {
        mayHaveControlled = false; uncertain = false;
        await release();
        await options.state.setManualOverride(true);
        update('manual', 'manual_override', null, null); return;
      }
      if (info.active && (!Number.isSafeInteger(info.revision) || info.revision! > options.state.revision)) {
        await release(); update('blocked', 'ownership_unavailable', 'La session active de recharge a changé.', null); return;
      }
      // A persisted revision can precede a delayed HTTP activation at restart.
      // Fence it off even when a read still reports no active controller job.
      if (info.lastRevision < options.state.revision || info.active && info.revision! < options.state.revision) {
        mayHaveControlled = true;
        uncertain = true;
      }
      if (info.active) mayHaveControlled = true;
      if (!info.active && !info.stopping && info.lastRevision >= options.state.revision) {
        mayHaveControlled = false; uncertain = false;
      }
      if (info.error) {
        await stopOwned(); update('blocked', 'controller_unavailable', 'La supervision de la borne est indisponible.', null); return;
      }
      if (uncertain || info.stopping) {
        if (options.state.revision < 1) { update('stopping', 'stop_unconfirmed', null, null); return; }
        await stopOwned(); update('paused', 'reconciled', null, null); return;
      }
      const unavailableCar: CarTelemetry = { status: 'error', vehicleName: null, socPercent: null,
        chargeLimitPercent: null, chargingState: null, observedAt: null, error: null };
      const unavailableSite: Telemetry = { status: 'offline', observedAt: null, error: null, solarKw: null,
        householdKw: null, gridImportKw: null, gridExportKw: null, batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null };
      const unavailableBattery: CarBatteryContext = { available: false, automatic: false, requestedPowerKw: 0,
        socPercent: null, goalSocPercent: 80 };
      let [car, telemetry, battery, forecasts] = await Promise.all([
        options.readCar().catch(() => unavailableCar), options.readTelemetry().catch(() => unavailableSite),
        options.readBattery().catch(() => unavailableBattery), options.readForecasts().catch(() => []),
      ]);
      if (!isCurrent()) return;
      // Pair fresh charger and site readings after slower policy inputs. A stale
      // EV reading must not turn its own consumption into apparent house demand.
      [charger, telemetry] = await Promise.all([options.controller.read(), options.readTelemetry()]);
      if (!isCurrent()) return;
      await checkpoint(car);
      if (!isCurrent()) return;
      let plan = planner({ now: now(), config: options.config, car, charger, telemetry, battery, forecasts,
        override: options.state.targetOverride });
      const rememberTarget = () => {
        if (!checkpointTarget || checkpointTarget.date !== plan.target.date
          || (checkpointTarget.kind ?? 'morning') !== (plan.target.kind ?? 'morning')) {
          checkpointTarget = { ...plan.target }; checkpointObservation = null;
        }
        if (freshCar(car) && Date.parse(car.observedAt!) <= Date.parse(plan.target.deadline)) checkpointObservation = { ...car };
      };
      rememberTarget();
      // Eco is the native default, including while SOC is unknown or the car sleeps.
      // Only a force window justifies a bounded wake-up for a Normal decision.
      if (!freshCar(car) && getCarForceWindow(now()) !== null) {
        await applyPlan(plan, car, telemetry, charger, abort, isCurrent);
        if (!isCurrent()) return;
        wakeMaintenance = current.status === 'eco' && mayHaveControlled;
        const canWake = options.refreshCarForCharging && charger.ready && charger.carConnected === true
          && car.status !== 'auth_required' && car.status !== 'not_configured'
          && car.chargingState !== 'Disconnected' && now().getTime() - lastWakeAt >= options.config.wakeCooldownMs;
        if (canWake) {
          lastWakeAt = now().getTime();
          update('waking', 'refreshing_soc', null, plan);
          let wakeWatch: unknown;
          let wakeWatchTask: Promise<void> | null = null;
          let watching = true;
          const watch = () => {
            wakeWatch = undefined;
            if (!watching || !isCurrent()) return;
            if (getCarForceWindow(now()) === null) {
              wakeBlockedReason = 'outside_charging_window'; abort.abort(); return;
            }
            const task = Promise.all([options.controller.read(), options.readTelemetry(), options.readBattery()]).then(async ([observed, site, storage]) => {
              if (!watching || !isCurrent()) return;
              if (!observed.ready || observed.carConnected !== true
                || observed.automation?.epoch !== options.state.epoch || observed.automation.manualOverride) {
                if (observed.carConnected === false) wasConnected = false;
                wakeBlockedReason = observed.carConnected === false ? 'car_unplugged' : 'controller_unavailable';
                abort.abort(); return;
              }
              if (!safeSite(site)) { wakeBlockedReason = 'site_unavailable'; abort.abort(); return; }
              const eco = planner({ now: now(), config: options.config, car, charger: observed, telemetry: site,
                battery: storage, forecasts, override: options.state.targetOverride });
              if (eco.action === 'eco') {
                await applyPlan(eco, car, site, observed, abort, isCurrent);
                wakeMaintenance = current.status === 'eco' && mayHaveControlled;
                if (watching && wakeMaintenance) update('waking', 'refreshing_soc', null, eco);
              }
              if (!watching || !isCurrent()) return;
              const remaining = Date.parse(getSchedule(now()).charging.nextWindow.end) - now().getTime();
              wakeWatch = setTimer(watch, Math.max(0, Math.min(5000, remaining)));
            }).catch(() => { if (watching) { wakeBlockedReason = 'controller_unavailable'; wakeMaintenance = false; abort.abort(); } });
            wakeWatchTask = task;
            void task.finally(() => { if (wakeWatchTask === task) wakeWatchTask = null; }).catch(() => {});
          };
          const remaining = Date.parse(getSchedule(now()).charging.nextWindow.end) - now().getTime();
          wakeWatch = setTimer(watch, Math.max(0, Math.min(5000, remaining)));
          try { car = await options.refreshCarForCharging!(abort.signal); }
          finally {
            watching = false;
            if (wakeWatch !== undefined) clearTimer(wakeWatch);
            if (wakeWatchTask) await wakeWatchTask;
          }
          if (!isCurrent()) return;
          [charger, telemetry, battery] = await Promise.all([
            options.controller.read(), options.readTelemetry(), options.readBattery(),
          ]);
          if (!isCurrent()) return;
          const observed = charger.automation;
          if (observed?.epoch !== options.state.epoch || observed.owner !== options.state.owner || observed.manualOverride) {
            await options.state.setManualOverride(true); await release(); update('manual', 'manual_override', null, null); return;
          }
          await checkpoint(car);
          plan = planner({ now: now(), config: options.config, car, charger, telemetry, battery, forecasts,
            override: options.state.targetOverride });
          rememberTarget();
        } else if (wakeMaintenance) {
          current.lastEvaluatedAt = now().toISOString();
          update('eco', plan.reason, null, plan); return;
        }
      }
      if (!isCurrent()) return;
      current.lastEvaluatedAt = now().toISOString();
      await applyPlan(plan, car, telemetry, charger, abort, isCurrent);
    } catch (error) {
      if (wakeMaintenance && ['car_unplugged', 'outside_charging_window'].includes(wakeBlockedReason ?? '')
        && captured === generation && !stopping && !options.state.manualOverride) {
        if (wakeBlockedReason === 'car_unplugged') await release().catch(() => {});
        update('eco', wakeBlockedReason === 'car_unplugged' ? 'eco_car_unplugged' : 'eco_default', null, current.plan);
        return;
      }
      if (mayHaveControlled) {
        uncertain = true;
        try { await stopOwned(); } catch { /* Retain uncertain state until a confirmed stop. */ }
      }
      if (captured === generation && !stopping && !options.state.manualOverride) {
        update(uncertain ? 'stopping' : wakeBlockedReason ? 'blocked' : 'error', uncertain ? 'stop_unconfirmed' : wakeBlockedReason ?? 'automation_failed',
          error instanceof Error ? error.message : 'La recharge automatique de la voiture est indisponible.', null);
      }
    } finally { if (runAbort === abort) runAbort = null; }
  }
  function schedule() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (!started || stopping || options.state.manualOverride) { current.nextEvaluationAt = null; return; }
    current.nextEvaluationAt = new Date(now().getTime() + 5000).toISOString();
    timer = setTimer(() => { timer = undefined; launch(); }, 5000);
  }
  function launch() {
    if (pending || !started || stopping || options.state.manualOverride) return;
    const task = run();
    pending = task;
    void task.finally(() => { if (pending === task) pending = null; schedule(); }).catch(() => {});
  }
  return {
    start() { if (started || stopping) return; started = true; launch(); },
    status(): CarAutomationStatus { return structuredClone({ ...current,
      enabled: !options.state.manualOverride && !options.state.error && !stopping, lastCheckpoint: options.state.lastCheckpoint }); },
    batteryConstraint(): CarBatteryConstraint { return { ...constraint }; },
    evaluate(): Promise<void> {
      if (evaluation) return evaluation;
      if (!started || stopping || options.state.manualOverride) return Promise.resolve();
      const task = (async () => {
        if (timer !== undefined) { clearTimer(timer); timer = undefined; }
        while (pending) await pending;
        if (stopping || options.state.manualOverride) return;
        launch();
        await pending;
      })();
      evaluation = task;
      void task.finally(() => { if (evaluation === task) evaluation = null; }).catch(() => {});
      return task;
    },
    async setManualOverride(value: boolean) {
      if (typeof value !== 'boolean') throw new Error('Le mode de recharge est invalide.');
      const captured = ++generation;
      runAbort?.abort();
      clearCutoff();
      if (timer !== undefined) { clearTimer(timer); timer = undefined; }
      if (value) {
        try { await options.state.setManualOverride(true); }
        finally { await stopOwned(); }
        update('manual', 'manual_override', null, null);
        return;
      }
      // Keep the durable manual barrier until explicit authorization is confirmed.
      await options.state.setManualOverride(true);
      await stopOwned();
      const charger = await options.controller.authorize(options.state.owner);
      if (captured !== generation || stopping) return;
      const info = charger.automation;
      if (!info?.supported || info.owner !== options.state.owner || !info.epoch || info.manualOverride || info.stopping) {
        throw new Error('L’autorisation de recharge automatique n’a pas pu être confirmée.');
      }
      await options.state.setSession(info.epoch, info.lastRevision);
      if (captured !== generation || stopping) return;
      await options.state.setManualOverride(false);
      if (captured !== generation || stopping) return;
      uncertain = false; mayHaveControlled = false;
      update('idle', 'awaiting_evaluation', null, null);
      launch();
    },
    async setTargetOverride(value: CarTargetOverride | null) {
      const validated = validateCarTargetOverride(value, now());
      generation++;
      runAbort?.abort();
      await options.state.setTargetOverride(validated);
      lastWakeAt = -Infinity;
      await stopOwned();
      update(options.state.manualOverride ? 'manual' : 'idle', options.state.manualOverride ? 'manual_override' : 'awaiting_evaluation', null, null);
      if (!pending) launch();
    },
    stop(): Promise<void> {
      if (shutdown) return shutdown;
      stopping = true;
      generation++;
      runAbort?.abort();
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      clearCutoff();
      current.nextEvaluationAt = null;
      shutdown = (async () => {
        try { await stopOwned(); await pending; update('paused', 'stopped', null, null); }
        catch (error) { update('stopping', 'shutdown_failed', error instanceof Error ? error.message : 'Arrêt indisponible.', null); }
      })();
      return shutdown;
    },
  };
}

export type CarAutomation = ReturnType<typeof createCarAutomation>;
