import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargeEstimator } from '../src/charge-estimate.js';
import type { Telemetry } from '../src/status.js';

const start = Date.parse('2026-10-24T12:00:00.000Z');
const control = { available: true, mode: 'manual' as const, powerKw: 5, targetSocPercent: 80 };
const clock = (seconds: number) => new Date(start + seconds * 1000);
const telemetry = (seconds: number, soc = 40 + seconds / 600, overrides: Partial<Telemetry> = {}): Telemetry => ({
  status: 'online', observedAt: clock(seconds).toISOString(), error: null,
  solarKw: null, householdKw: null, gridImportKw: null, gridExportKw: null,
  batterySocPercent: soc, batteryChargeKw: 5, batteryDischargeKw: 0, ...overrides,
});
const train = (estimator: ReturnType<typeof createChargeEstimator>, end = 120) => {
  let result = estimator.estimate(telemetry(0), control, clock(0));
  for (let seconds = 30; seconds <= end; seconds += 30) result = estimator.estimate(telemetry(seconds), control, clock(seconds));
  return result;
};

test('a charge window caps the finish time and reports an unreachable target', () => {
  const estimator = createChargeEstimator();
  const bounded = { ...control, chargeUntil: clock(15 * 60).toISOString() };
  let result;
  for (let second = 0; second <= 120; second += 30) {
    result = estimator.estimate(telemetry(second), bounded, clock(second));
  }
  assert.equal(result!.status, 'window_limited');
  assert.equal(result!.estimatedCompletionAt, bounded.chargeUntil);
  assert.equal(result!.chargingEndsAt, bounded.chargeUntil);
  assert.equal(result!.remainingMinutes, 13);
  assert.equal(result!.targetSocPercent, 80);
  assert.equal(estimator.estimate(telemetry(900), bounded, clock(900)).status, 'not_charging');
});

test('an attainable target remains available and duration rounding never crosses its window end', () => {
  for (const target of [40.25, 40.3]) {
    const estimator = createChargeEstimator();
    const bounded = { ...control, targetSocPercent: target, chargeUntil: clock(180).toISOString() };
    let result;
    for (let second = 0; second <= 120; second += 30) result = estimator.estimate(telemetry(second), bounded, clock(second));
    assert.equal(result!.status, 'available');
    assert.equal(result!.estimatedCompletionAt, bounded.chargeUntil);
    assert.equal(result!.remainingMinutes, 1);
  }
});

test('the cutoff is known while learning and malformed cutoffs cannot promise an ETA', () => {
  const estimator = createChargeEstimator();
  const bounded = { ...control, chargeUntil: clock(900).toISOString() };
  assert.equal(estimator.estimate(telemetry(0), bounded, clock(0)).chargingEndsAt, bounded.chargeUntil);
  assert.equal(estimator.estimate(telemetry(0), { ...bounded, chargeUntil: 'bad' }, clock(0)).status, 'unavailable');
});

test('dense observations retain the SOC trend without producing an ETA until explicitly estimated', () => {
  const estimator = createChargeEstimator();
  for (let seconds = 0; seconds <= 120; seconds += 5) {
    const observed = estimator.observe(telemetry(seconds), control, clock(seconds));
    assert.equal(observed.status, 'estimating');
    assert.equal(observed.remainingMinutes, null);
    assert.equal(observed.estimatedCompletionAt, null);
    assert.equal(observed.observedAt, clock(seconds).toISOString());
  }
  const result = estimator.estimate(telemetry(120), control, clock(120));
  assert.equal(result.status, 'available');
  assert.equal(result.remainingMinutes, 400);
  assert.equal(result.estimatedCompletionAt, clock(120 + 400 * 60).toISOString());
});

test('observation-only reads still validate current charge state and reset invalid learning', () => {
  const estimator = createChargeEstimator();
  train(estimator);
  assert.equal(estimator.observe(telemetry(150, undefined, { status: 'stale' }), control, clock(150)).status, 'unavailable');
  assert.equal(estimator.estimate(telemetry(180), control, clock(180)).status, 'estimating');
  assert.equal(estimator.observe(telemetry(185, undefined, { batteryChargeKw: 0 }), control, clock(185)).status, 'not_charging');
  assert.equal(estimator.observe(telemetry(190, 80), control, clock(190)).status, 'target_reached');
});

test('learns a measured SOC ramp and rounds the remaining time up to five minutes', () => {
  const estimator = createChargeEstimator();
  assert.equal(estimator.estimate(telemetry(0), control, clock(0)).status, 'estimating');
  assert.equal(estimator.estimate(telemetry(30), control, clock(30)).status, 'estimating');
  const result = train(estimator);
  assert.equal(result.status, 'available');
  assert.equal(result.targetSocPercent, 80);
  assert.equal(result.remainingMinutes, 400);
  assert.equal(result.estimatedCompletionAt, clock(120 + 400 * 60).toISOString());
  assert.equal(result.observedAt, clock(120).toISOString());
  assert.equal(result.method, 'soc_trend');
});

test('small SOC noise is tolerated and measured charge need not match the command', () => {
  const estimator = createChargeEstimator();
  const values = [40, 40.06, 40.05, 40.16, 40.2];
  let result;
  values.forEach((soc, index) => {
    result = estimator.estimate(telemetry(index * 30, soc, { batteryChargeKw: 1.4 }), control, clock(index * 30));
  });
  assert.equal(result!.status, 'available');
  assert.ok(result!.remainingMinutes! > 0);
});

test('duplicates cannot build a trend or overweight the regression', () => {
  const estimator = createChargeEstimator();
  for (let index = 0; index < 20; index++) {
    assert.equal(estimator.estimate(telemetry(0), control, clock(index)).status, 'estimating');
  }
  const expected = train(createChargeEstimator());
  const result = train(estimator);
  assert.equal(result.remainingMinutes, expected.remainingMinutes);
});

test('a known target can be reached with stopped or missing power, but no automatic target is assumed', () => {
  const estimator = createChargeEstimator();
  const reached = estimator.estimate(telemetry(0, 80, { batteryChargeKw: 0, batteryDischargeKw: 0 }), control, clock(0));
  assert.equal(reached.status, 'target_reached');
  assert.equal(reached.remainingMinutes, null);
  assert.equal(estimator.estimate(telemetry(0, 90, { batteryChargeKw: null }), control, clock(0)).status, 'target_reached');
  for (const change of [
    { mode: 'auto' as const }, { mode: 'unknown' as const }, { available: false },
    { targetSocPercent: null }, { targetSocPercent: 0 }, { targetSocPercent: 101 },
    { targetSocPercent: NaN }, { powerKw: 0 }, { powerKw: -1 }, { powerKw: Infinity }, { powerKw: null },
  ]) {
    const result = estimator.estimate(telemetry(0, 100), { ...control, ...change }, clock(0));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.targetSocPercent, null);
  }
});

test('nominal charging alone, pauses and discharge never produce an ETA', () => {
  const estimator = createChargeEstimator();
  for (const overrides of [
    { batteryChargeKw: 0 }, { batteryChargeKw: 0.049 }, { batteryDischargeKw: 0.001 },
  ]) {
    train(estimator);
    const result = estimator.estimate(telemetry(150, undefined, overrides), control, clock(150));
    assert.equal(result.status, 'not_charging');
    assert.equal(result.estimatedCompletionAt, null);
    assert.equal(estimator.estimate(telemetry(180), control, clock(180)).status, 'estimating');
  }
  for (const overrides of [{ batteryChargeKw: null }, { batteryChargeKw: NaN }, { batteryChargeKw: -1 }, { batteryDischargeKw: null }, { batteryDischargeKw: -1 }]) {
    assert.equal(estimator.estimate(telemetry(0, undefined, overrides), control, clock(0)).status, 'unavailable');
  }
});

test('offline, stale, missing SOC and invalid or old timestamps clear all previous estimates', () => {
  for (const overrides of [
    { status: 'offline' as const }, { status: 'stale' as const }, { status: 'not_configured' as const },
    { observedAt: null }, { observedAt: 'invalid' }, { batterySocPercent: null },
    { batterySocPercent: NaN }, { batterySocPercent: -1 }, { batterySocPercent: 101 },
    { observedAt: clock(119).toISOString() }, { observedAt: clock(156).toISOString() },
  ]) {
    const estimator = createChargeEstimator();
    train(estimator);
    const result = estimator.estimate(telemetry(150, undefined, overrides), control, clock(150));
    assert.equal(result.status, 'unavailable', JSON.stringify(overrides));
    assert.equal(result.estimatedCompletionAt, null);
    assert.equal(estimator.estimate(telemetry(180), control, clock(180)).status, 'estimating');
  }
});

test('freshness boundaries accept 30 second age and five second clock skew', () => {
  for (const age of [30, -5]) {
    const estimator = createChargeEstimator();
    const result = estimator.estimate(telemetry(0), control, clock(age));
    assert.equal(result.status, 'estimating');
  }
});

test('gaps, out of order observations and backwards local clocks restart learning', () => {
  const scenarios = [
    { observation: 151, now: 151 }, { observation: 119, now: 121 }, { observation: 120, now: 119 },
  ];
  for (const scenario of scenarios) {
    const estimator = createChargeEstimator();
    train(estimator);
    assert.equal(estimator.estimate(telemetry(scenario.observation), control, clock(scenario.now)).status, 'estimating');
  }
  assert.equal(createChargeEstimator().estimate(telemetry(0), control, new Date(NaN)).status, 'unavailable');
});

test('target, command and mode changes invalidate the old rate', () => {
  for (const change of [{ targetSocPercent: 70 }, { powerKw: 4 }]) {
    const estimator = createChargeEstimator();
    train(estimator);
    assert.equal(estimator.estimate(telemetry(150), { ...control, ...change }, clock(150)).status, 'estimating');
  }
  const estimator = createChargeEstimator();
  train(estimator);
  estimator.estimate(telemetry(150), { ...control, mode: 'auto' }, clock(150));
  assert.equal(estimator.estimate(telemetry(180), control, clock(180)).status, 'estimating');
});

test('SOC corrections and power drift greater than 25 percent restart learning', () => {
  for (const overrides of [
    { batterySocPercent: 40.17 }, { batterySocPercent: 45.2 },
    { batteryChargeKw: 6.26 }, { batteryChargeKw: 3.74 },
  ]) {
    const estimator = createChargeEstimator();
    train(estimator);
    assert.equal(estimator.estimate(telemetry(150, undefined, overrides), control, clock(150)).status, 'estimating');
  }
  const estimator = createChargeEstimator();
  train(estimator);
  assert.equal(estimator.estimate(telemetry(150, undefined, { batteryChargeKw: 6.25 }), control, clock(150)).status, 'available');
});

test('a genuinely stalled SOC clears an earlier ETA and constant noisy SOC never learns one', () => {
  const estimator = createChargeEstimator();
  assert.equal(train(estimator).status, 'available');
  let result;
  for (let second = 150; second <= 450; second += 30) {
    result = estimator.estimate(telemetry(second, 40.2), control, clock(second));
    if (second < 420) assert.equal(result.status, 'available');
  }
  assert.equal(result!.status, 'estimating');
  assert.equal(result!.estimatedCompletionAt, null);
  const noise = createChargeEstimator();
  for (let second = 0; second <= 600; second += 30) {
    assert.equal(noise.estimate(telemetry(second, 40 + (second % 60 === 0 ? 0.009 : 0)), control, clock(second)).status, 'estimating');
  }
});

test('rolling memory, explicit reset and tiny progress remain safe', () => {
  const estimator = createChargeEstimator();
  assert.equal(train(estimator, 1200).status, 'available');
  estimator.reset();
  assert.equal(estimator.estimate(telemetry(1230), control, clock(1230)).status, 'estimating');
  const tiny = createChargeEstimator();
  for (let second = 0; second <= 600; second += 30) {
    const result = tiny.estimate(telemetry(second, 40 + second * 1e-12), control, clock(second));
    assert.equal(result.status, 'estimating');
    assert.equal(result.remainingMinutes, null);
  }
});

test('irregular polling still detects a stalled SOC without an exact five minute timestamp', () => {
  const estimator = createChargeEstimator();
  assert.equal(train(estimator).status, 'available');
  let result;
  for (let second = 125.1; second < 435; second += 5.1) {
    result = estimator.estimate(telemetry(second, 40.2), control, clock(second));
  }
  assert.equal(result!.status, 'estimating');
  assert.equal(result!.remainingMinutes, null);
});

test('coarse GEN24 SOC steps learn after two increases despite five second observations', () => {
  const estimator = createChargeEstimator();
  let result;
  for (let second = 0; second <= 600; second += 5) {
    const soc = 10.720000267 + Math.floor(second / 90) * 0.259999275;
    result = estimator.estimate(telemetry(second, soc), control, clock(second));
    assert.equal(result.status, second < 180 ? 'estimating' : 'available', `at ${second} seconds`);
  }
  assert.ok(result!.remainingMinutes! > 300 && result!.remainingMinutes! < 500);
});

test('an initial long SOC plateau stays available for learning and one increase never supplies an ETA', () => {
  const estimator = createChargeEstimator();
  for (let second = 0; second <= 270; second += 5) {
    const soc = second < 180 ? 10.72 : 10.98;
    assert.equal(estimator.estimate(telemetry(second, soc), control, clock(second)).status, 'estimating');
  }
  assert.equal(estimator.estimate(telemetry(275, 11.24), control, clock(275)).status, 'available');
});

test('a five percentage point recalibration in five seconds restarts a quantized trend', () => {
  const estimator = createChargeEstimator();
  for (let second = 0; second <= 180; second += 5) {
    estimator.estimate(telemetry(second, 10.72 + Math.floor(second / 90) * 0.26), control, clock(second));
  }
  assert.equal(estimator.estimate(telemetry(185, 16.24), control, clock(185)).status, 'estimating');
});

test('one coarse SOC increase followed by small noise does not count as two updates', () => {
  const estimator = createChargeEstimator();
  for (let second = 0; second <= 180; second += 5) {
    const soc = second < 180 ? 10.72 : 10.98;
    assert.equal(estimator.estimate(telemetry(second, soc), control, clock(second)).status, 'estimating');
  }
  assert.equal(estimator.estimate(telemetry(185, 10.981), control, clock(185)).status, 'estimating');
  assert.equal(estimator.estimate(telemetry(190, 10.9800001), control, clock(190)).status, 'estimating');
  assert.equal(estimator.estimate(telemetry(195, 11.006), control, clock(195)).status, 'available');
});

test('meaningful update counting accumulates a smooth five second ramp', () => {
  const estimator = createChargeEstimator();
  let result;
  for (let second = 0; second <= 120; second += 5) {
    result = estimator.estimate(telemetry(second), control, clock(second));
  }
  assert.equal(result!.status, 'available');
  assert.equal(result!.remainingMinutes, 400);
});
