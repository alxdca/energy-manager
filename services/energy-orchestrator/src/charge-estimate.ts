import type { Telemetry } from './status.js';

export interface BatteryChargeEstimate {
  status: 'available' | 'window_limited' | 'estimating' | 'target_reached' | 'not_charging' | 'unavailable';
  targetSocPercent: number | null;
  estimatedCompletionAt: string | null;
  remainingMinutes: number | null;
  observedAt: string | null;
  method: 'soc_trend';
  chargingEndsAt?: string;
}

interface ChargeControl {
  available: boolean;
  mode: 'manual' | 'auto' | 'unknown';
  powerKw: number | null;
  targetSocPercent: number | null;
  chargeUntil?: string | null;
}

interface Sample { time: number; soc: number; power: number }
const WINDOW_MS = 10 * 60_000;
const MIN_SPAN_MS = 120_000;
const STALL_MS = 5 * 60_000;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Learns observed SOC progress, without assuming an energy capacity or conversion efficiency. */
export function createChargeEstimator() {
  let samples: Sample[] = [];
  let signature: string | null = null;
  let previousNow: number | null = null;
  let hasEstimate = false;

  function clearSamples() {
    samples = [];
    hasEstimate = false;
  }

  function reset() {
    clearSamples();
    signature = null;
    previousNow = null;
  }

  function observe(telemetry: Telemetry, control: ChargeControl, now: Date): BatteryChargeEstimate {
    const clock = now.getTime();
    const cutoff = control.chargeUntil == null ? null : Date.parse(control.chargeUntil);
    const target = control.available && control.mode === 'manual'
      && finite(control.powerKw) && control.powerKw > 0
      && finite(control.targetSocPercent) && control.targetSocPercent > 0 && control.targetSocPercent <= 100
      ? control.targetSocPercent : null;
    const result = (status: BatteryChargeEstimate['status'], observedAt: string | null = null): BatteryChargeEstimate => ({
      status, targetSocPercent: target, estimatedCompletionAt: null,
      remainingMinutes: null, observedAt, method: 'soc_trend',
      ...(cutoff !== null && finite(cutoff) ? { chargingEndsAt: new Date(cutoff).toISOString() } : {}),
    });
    const time = typeof telemetry.observedAt === 'string' ? Date.parse(telemetry.observedAt) : NaN;
    const soc = telemetry.batterySocPercent;
    if (target === null || !finite(clock) || (cutoff !== null && !finite(cutoff)) || telemetry.status !== 'online'
      || !finite(time) || clock - time > 30_000 || time - clock > 5000
      || !finite(soc) || soc < 0 || soc > 100) {
      reset();
      return result('unavailable');
    }

    const nextSignature = `${control.powerKw}:${target}`;
    if (signature !== nextSignature || (previousNow !== null && clock < previousNow)) clearSamples();
    signature = nextSignature;
    previousNow = clock;
    const observedAt = new Date(time).toISOString();
    if (soc >= target) {
      clearSamples();
      return result('target_reached', observedAt);
    }
    if (cutoff !== null && clock >= cutoff) {
      clearSamples();
      return result('not_charging', observedAt);
    }

    const power = telemetry.batteryChargeKw;
    const discharge = telemetry.batteryDischargeKw;
    if (!finite(power) || power < 0 || !finite(discharge) || discharge < 0) {
      clearSamples();
      return result('unavailable', observedAt);
    }
    if (power < 0.05 || discharge > 0) {
      clearSamples();
      return result('not_charging', observedAt);
    }

    let previous = samples.at(-1);
    if (previous && (time < previous.time || time - previous.time > 30_000
      || soc < previous.soc - 0.02 - 1e-9
      // GEN24 SOC can advance in coarse steps after many unchanged readings.
      || soc - previous.soc > 2 + 1e-9
      || Math.abs(power - samples[0].power) > samples[0].power * 0.25 + 1e-9)) {
      clearSamples();
      previous = undefined;
    }
    // Cached observations may be returned repeatedly by either dashboard endpoint.
    if (!previous || time > previous.time) samples.push({ time, soc, power });
    samples = samples.filter(sample => time - sample.time <= WINDOW_MS).slice(-121);

    // Allow coarse SOC updates, but eventually retire an ETA when progress stops.
    let stallStart = samples.length - 1;
    while (stallStart >= 0 && samples[stallStart].time > time - STALL_MS) stallStart--;
    const recent = stallStart >= 0 ? samples.slice(stallStart) : [];
    if (hasEstimate && recent.length >= 3 && time - recent[0].time >= STALL_MS
      && Math.max(...recent.map(sample => sample.soc)) - Math.min(...recent.map(sample => sample.soc)) <= 0.02 + 1e-9) {
      const latest = samples[samples.length - 1];
      clearSamples();
      samples.push(latest);
    }
    return result('estimating', observedAt);
  }

  function estimate(telemetry: Telemetry, control: ChargeControl, now: Date): BatteryChargeEstimate {
    const observed = observe(telemetry, control, now);
    if (observed.status !== 'estimating') return observed;
    const clock = now.getTime();
    const time = Date.parse(observed.observedAt!);
    const soc = telemetry.batterySocPercent!;
    const target = observed.targetSocPercent!;
    // Count meaningful progress, accumulating smooth small increments while ignoring SOC noise.
    let positiveUpdates = 0;
    let countedSoc = samples[0].soc;
    for (const sample of samples) {
      if (sample.soc > countedSoc + 0.02 + 1e-9) {
        positiveUpdates++;
        countedSoc = sample.soc;
      }
    }
    if (samples.length < 3 || time - samples[0].time < MIN_SPAN_MS
      || positiveUpdates < 2 || soc - samples[0].soc < 0.1 - 1e-9) return observed;

    // Centered seconds avoid subtracting large epoch-valued regression products.
    const origin = samples[0].time;
    const meanSeconds = samples.reduce((sum, sample) => sum + (sample.time - origin) / 1000, 0) / samples.length;
    const meanSoc = samples.reduce((sum, sample) => sum + sample.soc, 0) / samples.length;
    let covariance = 0;
    let variance = 0;
    for (const sample of samples) {
      const centered = (sample.time - origin) / 1000 - meanSeconds;
      covariance += centered * (sample.soc - meanSoc);
      variance += centered * centered;
    }
    const slope = covariance / variance;
    const minutes = Math.ceil(((target - soc) / slope / 60) / 5) * 5;
    const completion = clock + minutes * 60_000;
    if (!finite(slope) || slope <= 0 || !finite(minutes) || minutes <= 0
      || !finite(completion) || !finite(new Date(completion).getTime())) return observed;
    hasEstimate = true;
    const cutoff = observed.chargingEndsAt ? Date.parse(observed.chargingEndsAt) : null;
    const limited = cutoff !== null && clock + (target - soc) / slope * 1000 > cutoff + 1;
    const end = cutoff === null ? completion : Math.min(completion, cutoff);
    return {
      ...observed, status: limited ? 'window_limited' : 'available',
      remainingMinutes: cutoff === null ? minutes : Math.ceil((end - clock) / 60_000),
      estimatedCompletionAt: new Date(end).toISOString(),
    };
  }

  return { observe, estimate, reset };
}
