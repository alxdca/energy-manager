import { planBatteryCharge, type AutomationConfig, type AutomationPlan, type EnergyForecast } from './automation-plan.js';
import type { AutomationState } from './automation-state.js';
import { getLocalDate, getNightTariffEnd, getSchedule, policy } from './policy.js';
import type { Telemetry } from './status.js';
import type { CarBatteryConstraint } from './car-types.js';
import { batteryChargeAllowanceKw } from './site-power.js';

export interface AutomationControllerState {
  available: boolean;
  mode: 'manual' | 'auto' | 'unknown';
  powerKw: number | null;
  requestedPowerKw?: number | null;
  targetSocPercent: number | null;
  limits: { maxPowerKw: number; maxSocPercent: number; reserveSocPercent?: number | null };
  automationSupported?: boolean;
  automationHoldSupported?: boolean;
  automationSupplySupported?: boolean;
  automationMode?: 'charge' | 'hold' | 'supply';
  minimumSocPercent?: number | null;
  automationFence?: { bootId: string; generation: number };
  automationOwner?: string;
  expiresAt?: string | null;
  revertTimeoutSeconds?: number;
  error: string | null;
}
export interface AutomationController {
  read(): Promise<AutomationControllerState>;
  charge(owner: string, targetSocPercent: number, expiresAt: string, isCurrent: () => boolean, powerKw?: number): Promise<void>;
  hold(owner: string, expiresAt: string, isCurrent: () => boolean): Promise<void>;
  supply?(owner: string, maxPowerWatts: number, minimumSocPercent: number, expiresAt: string, isCurrent: () => boolean,
    authorizationExpiresAt?: string): Promise<void>;
  stop(owner: string): Promise<void>;
}
export interface AutomationStatus {
  enabled: boolean;
  status: 'disabled' | 'idle' | 'charging' | 'holding' | 'manual_override' | 'blocked' | 'error';
  lastEvaluatedAt: string | null;
  nextEvaluationAt: string | null;
  targetSocPercent: number | null;
  holdUntil: string | null;
  reason: string;
  plan: AutomationPlan | null;
  error: string | null;
}
export interface AutomationOptions {
  config: AutomationConfig;
  controller: AutomationController;
  readTelemetry(): Promise<Telemetry>;
  readForecast(dayOffset: 0 | 1): Promise<EnergyForecast>;
  state: AutomationState;
  now?: () => Date;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  readCarConstraint?: () => CarBatteryConstraint;
}
const quarter = 15 * 60_000;
const leaseRenewalMarginMs = 30_000;
const nextQuarter = (time: number) => (Math.floor(time / quarter) + 1) * quarter;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value >= 0;

function safetyReason(telemetry: Telemetry, now: number, powerKw: number): string | null {
  const observed = telemetry.observedAt === null ? NaN : Date.parse(telemetry.observedAt);
  if (telemetry.status !== 'online' || !finite(observed) || now - observed > 10_000 || observed - now > 5000) return 'telemetry_unavailable';
  if (!finite(telemetry.batterySocPercent) || telemetry.batterySocPercent < 0 || telemetry.batterySocPercent > 100) return 'soc_unavailable';
  const { gridImportKw, gridExportKw, batteryChargeKw, batteryDischargeKw } = telemetry;
  if (![gridImportKw, gridExportKw, batteryChargeKw, batteryDischargeKw].every(positive)) return 'grid_measurements_unavailable';
  if (!positive(telemetry.householdKw)) return 'grid_measurements_unavailable';
  if (telemetry.householdKw! + powerKw > policy.totalConsumptionLimitKw + 0.000001) return 'grid_limit';
  return null;
}

/** Quarter-hour planning with a separate five-second safety check; neither starts at import. */
export function createAutomation(options: AutomationOptions) {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let started = false;
  let stopping = false;
  let generation = 0;
  let timer: unknown;
  let pending: Promise<void> | undefined;
  let evaluation: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let evaluateAt = now().getTime();
  let forceEvaluation = false;
  // A timed-out POST can still be queued at the controller after our local call ends.
  let mayHaveControlled = false;
  let controlledUntil: number | null = null;
  let stopPending = false;
  let current: AutomationStatus = {
    enabled: options.config.enabled, status: options.config.enabled ? 'idle' : 'disabled',
    lastEvaluatedAt: null, nextEvaluationAt: null, targetSocPercent: null, holdUntil: null,
    reason: options.config.enabled ? 'not_started' : 'disabled', plan: null, error: null,
  };
  function update(status: AutomationStatus['status'], reason: string, error: string | null = null) {
    current = { ...current, status, reason, error, holdUntil: status === 'holding' ? current.holdUntil : null };
    if (status === 'manual_override' || status === 'disabled' || reason === 'outside_charging_window'
      || reason === 'state_unavailable' || reason === 'awaiting_evaluation') {
      current.plan = null;
      current.targetSocPercent = null;
    }
  }
  function owns(controller: AutomationControllerState) {
    return controller.available && controller.mode === 'manual' && controller.automationOwner === options.state.owner;
  }
  function foreign(controller: AutomationControllerState) {
    return controller.available && controller.mode === 'manual' && controller.automationOwner !== options.state.owner;
  }
  function stopped() {
    stopPending = false;
    mayHaveControlled = false;
    controlledUntil = null;
  }
  async function stopOwned(controller?: AutomationControllerState) {
    if (controller && foreign(controller)) { stopped(); return; }
    if (!stopPending && !mayHaveControlled && (!controller || !owns(controller))) return;
    stopPending = true;
    try { await options.controller.stop(options.state.owner); }
    catch (failure) {
      // A confirmed replacement ends our authority; unavailable status never
      // cancels an unacknowledged stop or authorizes another charging command.
      const observed = await options.controller.read().catch(() => null);
      if (observed && foreign(observed)) { stopped(); return; }
      throw failure;
    }
    stopped();
  }
  function schedule() {
    if (stopping || !started || !options.config.enabled) return;
    // Five-minute cutoffs are not aligned with quarter-hour plan evaluations.
    const releaseAt = current.holdUntil === null ? NaN : Date.parse(current.holdUntil);
    const deadline = Math.min(evaluateAt, controlledUntil ?? Infinity, finite(releaseAt) ? releaseAt : Infinity);
    const remaining = deadline - now().getTime();
    const delay = forceEvaluation ? 0 : remaining <= 0 ? 5000 : Math.min(5000, remaining);
    timer = setTimer(() => { timer = undefined; launch(); }, delay);
  }
  async function run() {
    const captured = generation;
    const isCurrent = () => !stopping && generation === captured && !options.state.manualOverride && !options.state.error;
    try {
      if (!options.config.enabled) { update('disabled', 'disabled'); return; }
      if (controlledUntil !== null && now().getTime() >= controlledUntil) stopPending = true;
      if (stopPending) {
        await stopOwned();
        update('idle', 'outside_charging_window');
        return;
      }
      if (options.state.error || options.state.manualOverride) {
        // A manual request pauses planning before its hardware mutation. If that mutation
        // fails, release the previous automation lease; a successful manual replacement
        // has another owner and the conditional controller stop must leave it untouched.
        try { await stopOwned(await options.controller.read()); } catch { /* Its lease still expires independently. */ }
        update(options.state.error ? 'blocked' : 'manual_override',
          options.state.error ? 'state_unavailable' : 'manual_override', options.state.error);
        return;
      }
      let controller = await options.controller.read();
      if (!isCurrent()) return;
      if (!controller.available || controller.mode === 'unknown') {
        update('blocked', 'controller_unavailable', controller.error); return;
      }
      if (controller.mode === 'manual' && !owns(controller)) {
        stopped();
        generation++;
        await options.state.setManualOverride(true);
        update('manual_override', 'manual_override');
        return;
      }
      const fallback = controller.revertTimeoutSeconds;
      if (controller.automationSupported !== true || controller.automationHoldSupported !== true || !finite(fallback) || fallback < 10 || fallback > 120
        || !finite(controller.limits.maxPowerKw) || controller.limits.maxPowerKw < 6
        || !finite(controller.limits.maxSocPercent) || controller.limits.maxSocPercent <= 0 || controller.limits.maxSocPercent > 100
        || !finite(controller.limits.reserveSocPercent) || controller.limits.reserveSocPercent < 0
        || controller.limits.reserveSocPercent >= controller.limits.maxSocPercent) {
        await stopOwned(controller); update('blocked', 'controller_capabilities'); return;
      }
      const reserveSocPercent = controller.limits.reserveSocPercent;
      const at = now();
      const scheduleNow = getSchedule(at);
      const carConstraint = options.readCarConstraint?.();
      const carUntil = carConstraint?.until ? Date.parse(carConstraint.until) : NaN;
      const nightEnd = getNightTariffEnd(at);
      const guardedNight = carConstraint?.active === true && carConstraint.guardNight === true && nightEnd !== null
        && Number.isFinite(carUntil) && carUntil > at.getTime() && carUntil <= Date.parse(nightEnd);
      const untilWindowStarts = Date.parse(scheduleNow.charging.nextWindow.start) - at.getTime();
      // Opening buffers preserve energy; the final five minutes allow normal supply.
      const preserving = guardedNight || scheduleNow.charging.allowed || (scheduleNow.tariff.kind === 'low'
        && untilWindowStarts > 0 && untilWindowStarts <= quarter);
      if (!preserving) {
        await stopOwned(controller); update('idle', 'outside_charging_window');
        if (at.getTime() >= evaluateAt || forceEvaluation) {
          evaluateAt = Math.min(nextQuarter(at.getTime()), Date.parse(scheduleNow.charging.nextWindow.start)); forceEvaluation = false;
          current.lastEvaluatedAt = at.toISOString();
        }
        return;
      }
      const gridWindowEnd = Date.parse(scheduleNow.charging.nextWindow.end);
      const windowEnd = guardedNight ? carUntil : gridWindowEnd;
      const carActive = carConstraint?.active === true && (scheduleNow.charging.allowed || guardedNight)
        && Number.isFinite(carUntil) && carUntil > at.getTime() && carUntil <= windowEnd;
      const telemetry = await options.readTelemetry();
      if (!isCurrent()) return;
      const carPowerCap = carActive && carConstraint?.maxChargePowerKw !== undefined
        ? finite(carConstraint.maxChargePowerKw) && carConstraint.maxChargePowerKw >= 0 && carConstraint.maxChargePowerKw <= 6
          ? carConstraint.maxChargePowerKw : 0
        : 6;
      const chargePowerKw = batteryChargeAllowanceKw(telemetry.householdKw ?? NaN, carPowerCap);
      const holdSafety = safetyReason(telemetry, now().getTime(), 0);
      if (holdSafety) {
        if (owns(controller) && (carActive || controller.automationMode === 'supply' || holdSafety === 'grid_limit')) {
          try {
            mayHaveControlled = true; controlledUntil = windowEnd;
            await options.controller.hold(options.state.owner,
              new Date(Math.min(now().getTime() + 16 * 60_000, windowEnd + 5000)).toISOString(),
              () => isCurrent() && now().getTime() < windowEnd);
            current.holdUntil = new Date(windowEnd).toISOString();
            if (current.plan) current.plan = { ...current.plan, powerKw: 0 };
            update('holding', holdSafety === 'grid_limit' ? 'site_power_limit' : 'solar_budget_protected');
          } catch (failure) {
            // Retain the owned bounded window; restoring normal would remove
            // the protected floor while the car stop may still be unconfirmed.
            update('blocked', 'protective_hold_unavailable', failure instanceof Error ? failure.message : 'Réserve non confirmée.');
          }
        } else { await stopOwned(controller); update('blocked', holdSafety); }
        return;
      }
      if (owns(controller)) controlledUntil = windowEnd;
      const beforeCutoff = () => isCurrent() && now().getTime() < windowEnd;
      const beforeGridCutoff = () => isCurrent() && getSchedule(now()).charging.allowed && now().getTime() < gridWindowEnd;
      const holdUntil = windowEnd;
      async function preserve(reason: string, renew = false) {
        if (!isCurrent()) return;
        if (now().getTime() >= holdUntil) {
          await stopOwned(controller); update('idle', 'outside_charging_window'); return;
        }
        const safety = safetyReason(telemetry, now().getTime(), 0);
        if (safety) { await stopOwned(controller); update('blocked', safety); return; }
        // A hold leaves solar charging available while preventing battery discharge.
        const expiration = typeof controller.expiresAt === 'string' ? Date.parse(controller.expiresAt) : NaN;
        if (!owns(controller) || controller.automationMode !== 'hold' || renew
          || !finite(expiration) || (expiration - now().getTime() <= leaseRenewalMarginMs && expiration < holdUntil + 5000)) {
          const expires = Math.min(now().getTime() + 16 * 60_000, holdUntil + 5000);
          if (!isCurrent()) return;
          mayHaveControlled = true;
          controlledUntil = windowEnd;
          await options.controller.hold(options.state.owner, new Date(expires).toISOString(), beforeCutoff);
          controller = { ...controller, mode: 'manual', automationOwner: options.state.owner,
            automationMode: 'hold', powerKw: 0, targetSocPercent: null, expiresAt: new Date(expires).toISOString() };
        }
        if (isCurrent()) {
          current.holdUntil = new Date(holdUntil).toISOString();
          if (current.plan) current.plan = { ...current.plan, powerKw: 0 };
          update('holding', reason);
        }
      }
      if (carActive && carConstraint?.supply) {
        const requested = carConstraint.supply;
        const floor = requested.minimumSocPercent;
        const maxWatts = Math.floor(Math.min(requested.maxDischargeKw, controller.limits.maxPowerKw, 7) * 1000);
        const maxKw = maxWatts / 1000;
        const sourceExpiry = requested.authorizationExpiresAt ? Date.parse(requested.authorizationExpiresAt) : NaN;
        if (!controller.automationSupplySupported || !options.controller.supply || !finite(floor)
          || floor < reserveSocPercent || floor >= 100 || !finite(maxKw) || maxKw <= 0
          || !finite(sourceExpiry) || sourceExpiry <= now().getTime() || sourceExpiry > now().getTime() + 10_000
          || telemetry.batterySocPercent! <= floor + 0.02) {
          await preserve('solar_budget_protected');
          return;
        }
        const expiration = typeof controller.expiresAt === 'string' ? Date.parse(controller.expiresAt) : NaN;
        const matching = owns(controller) && controller.automationMode === 'supply'
          && controller.minimumSocPercent === floor && controller.powerKw === -maxKw;
        if (!matching || !finite(expiration) || expiration - now().getTime() <= leaseRenewalMarginMs) {
          mayHaveControlled = true; controlledUntil = windowEnd;
          await options.controller.supply(options.state.owner, Math.floor(maxKw * 1000), floor,
            new Date(Math.min(now().getTime() + 16 * 60_000, windowEnd + 5000)).toISOString(), beforeCutoff, requested.authorizationExpiresAt);
        }
        current.plan = null; current.targetSocPercent = null;
        update('holding', 'solar_battery_support');
        return;
      }
      if (owns(controller) && controller.automationMode === 'supply') {
        await preserve('solar_budget_protected', true);
        controller = await options.controller.read();
      }
      if (carActive && carConstraint?.allowCharge === false) {
        const due = at.getTime() >= evaluateAt || forceEvaluation;
        await preserve('car_priority', due);
        if (current.plan) current.plan = { ...current.plan, action: 'hold', reason: 'car_priority' };
        current.targetSocPercent = null;
        if (due) { evaluateAt = nextQuarter(at.getTime()); forceEvaluation = false; current.lastEvaluatedAt = at.toISOString(); }
        return;
      }
      // Economic targets update on quarter hours, but Tesla has priority over
      // home-battery power on every safety tick. Keep the target through a zero
      // cap so the owned hold can resume as soon as fresh headroom returns.
      const plannedCharge = current.plan?.action === 'charge' && finite(current.targetSocPercent);
      const retainedTarget = finite(controller.targetSocPercent) ? controller.targetSocPercent
        : plannedCharge ? current.targetSocPercent : null;
      if (scheduleNow.charging.allowed && owns(controller) && finite(retainedTarget)
        && telemetry.batterySocPercent! < retainedTarget - 0.02
        && (controller.automationMode === 'charge' || plannedCharge && current.reason === 'site_power_limit')) {
        if (chargePowerKw === 0) {
          await preserve('site_power_limit');
          if (current.plan) current.plan = { ...current.plan, powerKw: 0 };
          if (now().getTime() < evaluateAt && !forceEvaluation) return;
        } else if (controller.automationMode !== 'charge' || controller.powerKw !== chargePowerKw) {
          const expiresAt = new Date(Math.min(now().getTime() + 16 * 60_000, gridWindowEnd + 5000)).toISOString();
          mayHaveControlled = true; controlledUntil = windowEnd;
          await options.controller.charge(options.state.owner, retainedTarget, expiresAt, beforeGridCutoff, chargePowerKw);
          controller = { ...controller, automationMode: 'charge', powerKw: chargePowerKw,
            targetSocPercent: retainedTarget, expiresAt };
          if (current.plan) current.plan = { ...current.plan, powerKw: chargePowerKw };
        }
      }
      if (owns(controller)) {
        const hold = controller.automationMode === 'hold';
        if ((hold && controller.powerKw !== 0) || (!hold && (!finite(controller.targetSocPercent)
          || controller.targetSocPercent <= 0 || controller.targetSocPercent > controller.limits.maxSocPercent
          || !finite(controller.powerKw) || controller.powerKw < 0 || controller.powerKw > 6))) {
          await stopOwned(controller); update('blocked', 'owned_charge_invalid'); return;
        }
        const expiration = typeof controller.expiresAt === 'string' ? Date.parse(controller.expiresAt) : NaN;
        if (!hold && telemetry.batterySocPercent! >= controller.targetSocPercent! - 0.02) {
          await preserve('preserving_energy');
        } else if (hold && (!finite(expiration) || expiration - now().getTime() <= leaseRenewalMarginMs)) {
          await preserve('preserving_energy');
        } else if (!hold && now().getTime() < evaluateAt && !forceEvaluation
          && (!finite(expiration) || expiration < windowEnd + 5000 && expiration - now().getTime() <= leaseRenewalMarginMs)) {
          const safety = safetyReason(telemetry, now().getTime(), controller.powerKw!);
          if (safety) { await stopOwned(controller); update('blocked', safety); return; }
          const expiresAt = new Date(Math.min(now().getTime() + 16 * 60_000, windowEnd + 5000)).toISOString();
          mayHaveControlled = true;
          controlledUntil = windowEnd;
          await options.controller.charge(options.state.owner, controller.targetSocPercent!, expiresAt, beforeGridCutoff, controller.powerKw!);
          controller = { ...controller, expiresAt };
        }
      }
      if (!scheduleNow.charging.allowed) {
        await preserve('holding_until_peak', at.getTime() >= evaluateAt || forceEvaluation);
        if (at.getTime() >= evaluateAt || forceEvaluation) {
          evaluateAt = Math.min(nextQuarter(at.getTime()), Date.parse(scheduleNow.charging.nextWindow.start)); forceEvaluation = false;
          current.lastEvaluatedAt = at.toISOString();
        }
        return;
      }
      const planningAt = now();
      if (planningAt.getTime() < evaluateAt && !forceEvaluation) {
        const holding = owns(controller) && controller.automationMode === 'hold';
        const safety = safetyReason(telemetry, now().getTime(), holding ? 0 : controller.powerKw ?? chargePowerKw);
        if (safety) { await stopOwned(controller); update('blocked', safety); return; }
        if (holding) current.holdUntil = new Date(holdUntil).toISOString();
        update(holding ? 'holding' : owns(controller) ? 'charging' : 'idle',
          holding ? current.status === 'holding' ? current.reason : 'preserving_energy'
            : owns(controller) ? 'charging' : current.reason);
        return;
      }
      evaluateAt = nextQuarter(planningAt.getTime());
      forceEvaluation = false;
      current.lastEvaluatedAt = planningAt.toISOString();
      const forecastDay = getLocalDate(new Date(scheduleNow.charging.nextWindow.end));
      const offset = scheduleNow.charging.currentWindow === 'night' && forecastDay !== getLocalDate(planningAt) ? 1 : 0;
      let forecast: EnergyForecast;
      try { forecast = await options.readForecast(offset); }
      catch (failure) {
        // A missing new forecast cannot justify releasing an already reserved battery.
        // Keep only a previously owned hold; unknown forecasts never initiate one.
        if (!isCurrent()) return;
        if ((!owns(controller) || controller.automationMode !== 'hold') && !carActive) throw failure;
        current.plan = null; current.targetSocPercent = null;
        await preserve('forecast_unavailable', true); return;
      }
      if (!isCurrent()) return;
      // Recheck elapsed freshness and the window after the weather request completes.
      const commandAt = now();
      const effectiveConfig = { ...options.config,
        reserveSocPercent: Math.max(options.config.reserveSocPercent, reserveSocPercent),
      };
      const plan = planBatteryCharge(commandAt, telemetry, forecast, effectiveConfig,
        { ...controller.limits, revertTimeoutSeconds: fallback });
      current.plan = { ...plan, powerKw: plan.action === 'charge' ? chargePowerKw : 0 };
      current.targetSocPercent = plan.targetSocPercent;
      const finalSafety = safetyReason(telemetry, commandAt.getTime(), plan.action === 'charge' ? chargePowerKw : 0);
      if (!finalSafety && plan.action === 'hold') {
        await preserve(plan.reason === 'outside_charging_window' ? 'holding_until_peak' : 'preserving_energy', true); return;
      }
      if (owns(controller) && controller.automationMode === 'hold'
        && ((finalSafety === 'grid_limit' && !safetyReason(telemetry, commandAt.getTime(), 0))
          || (!finalSafety && plan.action === 'blocked' && (plan.reason.startsWith('forecast_')
            || plan.reason === 'hourly_forecast_unavailable' || plan.reason === 'consumption_unavailable')))) {
        await preserve(finalSafety ?? plan.reason, true); return;
      }
      if (finalSafety || plan.action !== 'charge') {
        if (!finalSafety && carActive) { await preserve('car_power_reserved', true); return; }
        await stopOwned(controller);
        update(finalSafety || plan.action === 'blocked' ? 'blocked' : 'idle', finalSafety ?? plan.reason);
        return;
      }
      if (chargePowerKw === 0) {
        await preserve('site_power_limit', true);
        return;
      }
      const expires = Math.min(commandAt.getTime() + 16 * 60_000,
        Date.parse(plan.windowEndsAt!) + 5000);
      // Root's shared mutation lock checks this guard immediately before the hardware write.
      mayHaveControlled = true;
      controlledUntil = windowEnd;
      await options.controller.charge(options.state.owner, plan.targetSocPercent!, new Date(expires).toISOString(), beforeGridCutoff, chargePowerKw);
      if (isCurrent()) update('charging', plan.reason);
    } catch (failure) {
      // A write timeout may have applied. Never retry it here: next poll reconciles ownership.
      if (captured === generation && !stopping) update('error', 'automation_failed', failure instanceof Error ? failure.message : 'Pilotage indisponible');
    }
  }
  function launch() {
    if (pending || stopping) return;
    pending = run().finally(() => {
      pending = undefined;
      current.nextEvaluationAt = stopping || !options.config.enabled || options.state.manualOverride || options.state.error
        ? null : new Date(evaluateAt <= now().getTime() ? nextQuarter(now().getTime()) : evaluateAt).toISOString();
      schedule();
    });
  }
  return {
    start() {
      if (started || stopping) return;
      started = true;
      if (options.config.enabled) launch();
    },
    status(): AutomationStatus {
      return { ...current, plan: current.plan ? { ...current.plan } : null };
    },
    /** Consume a coordinator's published inputs before it captures the resulting projection. */
    evaluate(): Promise<void> {
      if (evaluation) return evaluation;
      if (!started || stopping || !options.config.enabled) return Promise.resolve();
      evaluation = (async () => {
        // A safety/quarter-hour run may already own the controller. Its completion
        // can arm another timer, so clear that timer only after the run has settled.
        while (pending) await pending;
        if (stopping || !started || !options.config.enabled) return;
        if (timer !== undefined) { clearTimer(timer); timer = undefined; }
        // Move the evaluation deadline forward rather than forcing zero-delay
        // retries through manual, unavailable-controller or unsafe branches.
        evaluateAt = now().getTime();
        launch();
        await pending;
      })().finally(() => { evaluation = undefined; });
      return evaluation;
    },
    async setManualOverride(value: boolean) {
      generation++;
      // setManualOverride updates its in-memory flag synchronously, before awaiting persistence.
      try { await options.state.setManualOverride(value); }
      catch (failure) { update('blocked', 'state_unavailable', options.state.error); throw failure; }
      update(value ? 'manual_override' : 'idle', value ? 'manual_override' : 'awaiting_evaluation');
      if (!value && started && !stopping) {
        forceEvaluation = true;
        if (timer !== undefined) { clearTimer(timer); timer = undefined; }
        if (!pending) schedule();
      }
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      generation++;
      if (timer !== undefined) { clearTimer(timer); timer = undefined; }
      current.nextEvaluationAt = null;
      stopPromise = (async () => {
        await pending;
        try {
          if (mayHaveControlled) {
            // Conditional release also invalidates an activation queued remotely, even if
            // a GET still says auto. The controller must check owner under its mutation lock.
            await options.controller.stop(options.state.owner);
          } else {
            const controller = await options.controller.read();
            await stopOwned(controller);
          }
          update(options.state.manualOverride ? 'manual_override' : 'idle', 'stopped');
        } catch (failure) { update('error', 'shutdown_failed', failure instanceof Error ? failure.message : 'Arrêt indisponible'); }
      })();
      return stopPromise;
    },
  };
}
export type Automation = ReturnType<typeof createAutomation>;
