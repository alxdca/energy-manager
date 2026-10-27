import { observationTimestamp } from './daily-energy.js';
import type { Telemetry } from './status.js';
import { getNightTariffEnd } from './policy.js';

const efficiency = Math.sqrt(0.95);
const maximumGapMs = 15_000;
const maximumAgeMs = 30_000;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export interface BatteryNightOrigin {
  id: string;
  valid: boolean;
  solarAtStartKwh: number;
  storedAtStartKwh: number;
  dischargedKwh: number;
}

export interface BatteryOriginSnapshot {
  available: boolean;
  solarStoredKwh: number | null;
  storedKwh: number | null;
  observedAt: string | null;
  error: string | null;
  night: BatteryNightOrigin | null;
}
export interface BatteryOriginCheckpoint {
  version: 1;
  capacityKwh: number;
  maxPowerKw: number;
  solarStoredKwh: number;
  modeledStoredKwh: number | null;
  measuredStoredKwh: number | null;
  observedAt: string | null;
  accountedAt: string | null;
  night: BatteryNightOrigin | null;
}
interface Sample { at: number; solarChargeKw: number; chargeKw: number; dischargeKw: number }

/**
 * Conservative source accounting, conditional on accurate sampled power/SOC and a 7 kW
 * battery power limit. Initial storage is unknown. All discharge consumes solar first.
 * Subtracting ALL grid import from battery charging deliberately attributes grid to the
 * battery first; PV DC only bounds that remainder, never supplies an AC house balance.
 * Between samples the smaller solar charge and larger discharge endpoints are used.
 * As with other power integrals, sub-sample transients cannot be reconstructed.
 *
 * The flow model retains charge across flat, quantized SOC readings. SOC increases
 * never add energy; changed SOC reconciles downward. A flat reading permits at most
 * one percentage point of modeled growth before downward reconciliation. The exposed
 * stored amount never exceeds the latest measured SOC amount. Unknown intervals and
 * restarts assume maximum discharge, including storage losses, and earn no credit.
 * A continuously observed 23:00 crossing also freezes a night authorization baseline.
 * No night charge increases it; all night losses consume its cumulative discharge
 * allowance, so grid deposits cannot replenish permission to discharge for the car.
 */
export function createBatteryOrigin(options: {
  capacityKwh?: number; maxPowerKw?: number; now?: () => Date; checkpoint?: unknown;
} = {}) {
  const capacityKwh = options.capacityKwh ?? 60;
  const maxPowerKw = options.maxPowerKw ?? 7;
  if (!positive(capacityKwh) || capacityKwh === 0 || !positive(maxPowerKw) || maxPowerKw === 0) {
    throw new Error('Paramètres de provenance de la batterie invalides.');
  }
  const clock = options.now ?? (() => new Date());
  let solar = 0;
  let modeled: number | null = null;
  let measured: number | null = null;
  let observedAt: string | null = null;
  let accountedAt: number | null = null;
  let previous: Sample | null = null;
  let dischargeSinceSocChange = 0;
  let available = false;
  let error: string | null = 'Origine de l’énergie de la batterie encore inconnue.';
  let night: BatteryNightOrigin | null = null;
  const nightId = (at: number) => Number.isFinite(at) ? getNightTariffEnd(new Date(at)) : null;
  const invalidNight = (id: string): BatteryNightOrigin => ({ id, valid: false, solarAtStartKwh: 0, storedAtStartKwh: 0, dischargedKwh: 0 });

  function syncNight(at: number, crossing = false) {
    const id = nightId(at);
    if (id === null) { night = null; return; }
    if (night?.id === id) return;
    // Only uninterrupted observation across 23:00 establishes a baseline. Starting
    // or restoring halfway through a night cannot distinguish earlier grid deposits.
    const continuousCrossing = crossing && previous !== null && at > previous.at
      && at - previous.at <= maximumGapMs && nightId(previous.at) !== id
      && modeled !== null && measured !== null;
    if (!continuousCrossing) { night = invalidNight(id); return; }
    const unseen = maxPowerKw * (at - previous!.at) / 3_600_000 / efficiency;
    night = { id, valid: true, solarAtStartKwh: Math.max(0, solar - unseen),
      storedAtStartKwh: Math.max(0, Math.min(modeled!, measured!) - unseen), dischargedKwh: 0 };
  }

  function clamp() {
    if (modeled !== null) modeled = Math.max(0, Math.min(capacityKwh, modeled));
    solar = Math.max(0, Math.min(solar, modeled ?? 0, measured ?? 0));
  }
  function debit(amount: number, discharge = false) {
    if (night) night.dischargedKwh += amount;
    if (discharge) dischargeSinceSocChange += amount;
    solar = Math.max(0, solar - amount);
    if (modeled !== null) modeled = Math.max(0, modeled - amount);
  }
  function unknownUntil(at: number) {
    syncNight(at);
    if (!Number.isFinite(at) || (accountedAt !== null && at < accountedAt)) {
      solar = 0;
      if (night) night.valid = false;
    } else {
      if (accountedAt !== null) debit(maxPowerKw * (at - accountedAt) / 3_600_000 / efficiency, true);
      accountedAt = at;
    }
    previous = null;
    available = false;
    clamp();
  }
  const saved = options.checkpoint;
  if (saved !== undefined && saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
    const state = saved as Record<string, unknown>;
    const date = (value: unknown) => value === null || observationTimestamp(value) !== null;
    if (state.version === 1 && Object.hasOwn(state, 'night') && state.night !== undefined
      && state.capacityKwh === capacityKwh && state.maxPowerKw === maxPowerKw
      && positive(state.solarStoredKwh) && state.solarStoredKwh <= capacityKwh
      && (state.modeledStoredKwh === null || (positive(state.modeledStoredKwh) && state.modeledStoredKwh <= capacityKwh))
      && (state.measuredStoredKwh === null || (positive(state.measuredStoredKwh) && state.measuredStoredKwh <= capacityKwh))
      && date(state.observedAt) && date(state.accountedAt)
      && (state.solarStoredKwh === 0 || (state.modeledStoredKwh !== null && state.measuredStoredKwh !== null
        && state.observedAt !== null && state.accountedAt !== null))) {
      solar = state.solarStoredKwh;
      modeled = state.modeledStoredKwh as number | null;
      measured = state.measuredStoredKwh as number | null;
      observedAt = state.observedAt as string | null;
      accountedAt = state.accountedAt === null ? null : Date.parse(state.accountedAt as string);
      const candidate = state.night;
      if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const value = candidate as Record<string, unknown>;
        if (typeof value.id === 'string' && observationTimestamp(value.id) === value.id
          && nightId(Date.parse(value.id) - 1000) === value.id && typeof value.valid === 'boolean'
          && positive(value.solarAtStartKwh) && value.solarAtStartKwh <= capacityKwh
          && positive(value.storedAtStartKwh) && value.storedAtStartKwh <= capacityKwh
          && value.solarAtStartKwh <= value.storedAtStartKwh && positive(value.dischargedKwh)) {
          night = { id: value.id, valid: value.valid, solarAtStartKwh: value.solarAtStartKwh,
            storedAtStartKwh: value.storedAtStartKwh, dischargedKwh: value.dischargedKwh };
        }
      }
      clamp();
      unknownUntil(clock().getTime());
      error = 'Provenance en attente d’une mesure après redémarrage.';
    }
  }

  function record(telemetry: Telemetry, at = clock()) {
    const now = at.getTime();
    const stamp = observationTimestamp(telemetry.observedAt);
    const timestamp = stamp === null ? NaN : Date.parse(stamp);
    const channels = [telemetry.solarKw, telemetry.gridImportKw, telemetry.batteryChargeKw,
      telemetry.batteryDischargeKw, telemetry.batterySocPercent];
    if (!Number.isFinite(now) || telemetry.status !== 'online' || !Number.isFinite(timestamp)
      || timestamp < now - maximumAgeMs || timestamp > now + 5000
      || channels.some(value => !positive(value)) || telemetry.batterySocPercent! > 100
      || telemetry.batteryChargeKw! > maxPowerKw || telemetry.batteryDischargeKw! > maxPowerKw
      || (telemetry.batteryChargeKw! > 0 && telemetry.batteryDischargeKw! > 0)) {
      unknownUntil(now);
      error = 'Mesures insuffisantes pour établir l’origine de l’énergie.';
      return;
    }
    if ((observedAt !== null && timestamp <= Date.parse(observedAt))
      || (accountedAt !== null && timestamp < accountedAt)) {
      unknownUntil(now);
      error = 'Mesure de provenance répétée ou hors ordre.';
      return;
    }
    syncNight(timestamp, true);
    const nextMeasured = capacityKwh * telemetry.batterySocPercent! / 100;
    const next: Sample = { at: timestamp,
      solarChargeKw: Math.min(telemetry.solarKw!, Math.max(0, telemetry.batteryChargeKw! - telemetry.gridImportKw!)),
      chargeKw: telemetry.batteryChargeKw!, dischargeKw: telemetry.batteryDischargeKw! };
    if (previous && timestamp - previous.at <= maximumGapMs) {
      const hours = (timestamp - previous.at) / 3_600_000;
      const removed = Math.max(previous.dischargeKw, next.dischargeKw) * hours / efficiency;
      debit(removed, true);
      const added = Math.min(previous.chargeKw, next.chargeKw) * hours * efficiency;
      const headroom = capacityKwh - (modeled ?? 0);
      modeled = (modeled ?? nextMeasured) + Math.min(headroom, added);
      solar += Math.min(headroom, Math.min(previous.solarChargeKw, next.solarChargeKw) * hours * efficiency);
    } else {
      unknownUntil(timestamp);
      if (modeled === null) modeled = nextMeasured;
    }
    if (measured !== null && nextMeasured !== measured) {
      // Every unexplained SOC loss consumes solar, even if a prior upward jump
      // was deliberately left unknown. Already integrated discharge is not reused.
      debit(Math.max(0, measured - nextMeasured - dischargeSinceSocChange));
      dischargeSinceSocChange = 0;
    }
    // A positive SOC correction is unknown energy. Flat SOC tolerates quantization,
    // but cannot mask indefinite modeled charging in the absence of a SOC rise.
    const ceiling = nextMeasured === measured ? Math.min(capacityKwh, nextMeasured + capacityKwh / 100) : nextMeasured;
    if (modeled! > ceiling) debit(modeled! - ceiling);
    measured = nextMeasured;
    clamp();
    observedAt = stamp!;
    accountedAt = timestamp;
    previous = next;
    available = true;
    error = null;
  }

  function snapshot(at = clock()): BatteryOriginSnapshot {
    const now = at.getTime();
    const age = observedAt === null ? Infinity : now - Date.parse(observedAt);
    const valid = available && Number.isFinite(now) && age >= -5000 && age <= maximumAgeMs;
    // Conservatively reserve possible consumption since the last measured instant.
    const unseenDischarge = accountedAt === null || !Number.isFinite(now) ? 0
      : maxPowerKw * Math.max(0, now - accountedAt) / 3_600_000 / efficiency;
    const id = nightId(now);
    const nightSnapshot = id === null ? null : night?.id === id
      ? { ...night, dischargedKwh: night.dischargedKwh + unseenDischarge } : invalidNight(id);
    if (!valid) return { available: false, solarStoredKwh: null, storedKwh: null, observedAt,
      error: error ?? 'Mesures de provenance périmées.', night: nightSnapshot };
    return { available: true, solarStoredKwh: Math.max(0, solar - unseenDischarge),
      storedKwh: Math.max(0, Math.min(modeled!, measured!) - unseenDischarge), observedAt, error: null, night: nightSnapshot };
  }
  function checkpoint(): BatteryOriginCheckpoint {
    return { version: 1, capacityKwh, maxPowerKw, solarStoredKwh: solar, modeledStoredKwh: modeled,
      measuredStoredKwh: measured, observedAt, accountedAt: accountedAt === null ? null : new Date(accountedAt).toISOString(),
      night: night === null ? null : { ...night } };
  }
  return { record, snapshot, checkpoint };
}
