import test from 'node:test';
import assert from 'node:assert/strict';
import { createCarEnergySampler, carEnergyCounter } from '../src/car-energy.js';
import { summarizeRecordedEnergy } from '../src/recorded-energy.js';
import type { ObservationSample } from '../src/observation-types.js';
import { predictHousehold, trainHouseholdModel } from '../src/household-model.js';
import type { WattpilotTelemetry } from '../src/wattpilot.js';

const origin = Date.parse('2026-10-27T12:00:00Z');
const at = (seconds: number) => new Date(origin + seconds * 1000);
function sample(seconds: number, house = 10000, car: number | null = 5000): ObservationSample {
  const time = at(seconds).toISOString();
  return { battery: null, solar: null, household: { at: time, value: house, source: 'GEN24:meter-1' },
    car: car === null ? null : { at: time, value: car, source: 'Wattpilot:1' } };
}
function pair(first: ObservationSample, next: ObservationSample) {
  const sampler = createCarEnergySampler();
  sampler.record(first, at(870)); sampler.finalize(at(900));
  sampler.record(next, at(1770)); sampler.finalize(at(1800));
  return sampler;
}

test('counter deltas split house and charging energy without changing raw samples, and train only house consumption', () => {
  const first = sample(870), next = sample(1770, 13000, 7000), original = structuredClone(next);
  const sampler = pair(first, next), result = sampler.pending();
  assert.deepEqual(result.household, [{ at: at(1770).toISOString(), value: 1000 }]);
  assert.deepEqual(result.solar, [{ at: at(1770).toISOString(), value: 2000 }]);
  assert.deepEqual(next, original);
  const model = trainHouseholdModel({ id: 'car-free', at: at(1800), observations: result.household });
  const forecast = predictHousehold({ date: '2026-10-28', at: at(1800), model });
  assert.equal(forecast.scope, 'household_excluding_car'); assert.equal(forecast.excludesCar, true);
  assert.equal(forecast.slots.find(slot => slot.start === '2026-10-28T12:15:00.000Z')?.estimatedConsumptionKwh, 1);
});

test('measured zero charging is distinct from a missing charger reading', () => {
  const idle = pair(sample(870), sample(1770, 11000, 5000)).pending();
  assert.equal(idle.household[0].value, 1000); assert.equal(idle.solar[0].value, 0);
  for (const [first, next] of [[sample(870, 10000, null), sample(1770)], [sample(870), sample(1770, 11000, null)]]) {
    const result = pair(first, next).pending();
    assert.deepEqual(result.household, []); assert.deepEqual(result.solar, []);
  }
});

test('misaligned snapshots, resets, changed meters, and negative net consumption cannot create house energy', () => {
  const misaligned = sample(1770, 13000, 7000); misaligned.car!.at = at(1739).toISOString();
  const replacement = sample(1770, 13000, 7000); replacement.car!.source = 'Wattpilot:replacement';
  const nativeReset = sample(1770, 13000, 7000); nativeReset.household!.components = { grid: 100 };
  const first = sample(870); first.household!.components = { grid: 200 };
  for (const next of [misaligned, replacement, sample(1770, 13000, 100), sample(1770, 11000, 7000)]) {
    assert.deepEqual(pair(sample(870), next).pending().household, []);
  }
  assert.deepEqual(pair(first, nativeReset).pending().household, []);
  const aligned = sample(1770, 13000, 7000); aligned.car!.at = at(1740).toISOString();
  assert.equal(pair(sample(870), aligned).pending().household[0].value, 1000);
});

test('fresh independent meter clocks can differ by twenty seconds without starving house-only history', () => {
  const sampler = createCarEnergySampler();
  for (let i = 0; i < 5; i++) {
    const seconds = 870 + i * 900, value = sample(seconds, 10000 + i * 1000, 5000 + i * 500);
    value.car!.at = at(seconds - 20).toISOString();
    sampler.record(value, at(seconds)); sampler.finalize(at(seconds + 30));
  }
  assert.equal(sampler.pending().solar.length, 4);
  assert.deepEqual(sampler.pending().household.map(point => point.value), [500, 500, 500, 500]);
});

test('restart retains paired baselines; a missing quarter requires rebaselining', () => {
  const sampler = createCarEnergySampler(); sampler.record(sample(870), at(870)); sampler.finalize(at(900));
  const restored = createCarEnergySampler({ state: sampler.pending().state });
  restored.record(sample(1770, 13000, 7000), at(1770)); restored.finalize(at(1800));
  assert.equal(restored.pending().household[0].value, 1000);
  const saved = restored.pending(); restored.acknowledge(saved); assert.deepEqual(restored.pending().household, []);
  restored.record(sample(3570, 18000, 9000), at(3570)); restored.finalize(at(3600));
  assert.deepEqual(restored.pending().household, []);
});

test('charger energy remains recorded when household counters are unavailable', () => {
  const first = sample(870), next = sample(1770, 13000, 7000);
  first.household = null; next.household = null;
  const result = pair(first, next).pending();
  assert.deepEqual(result.household, []);
  assert.deepEqual(result.solar, [{ at: at(1770).toISOString(), value: 2000 }]);
});

test('daily totals keep house and car energy separate and preserve missing readings', () => {
  const points = { solar: [], household: [{ at: at(1770).toISOString(), value: 1000 }],
    car: [{ at: at(1770).toISOString(), value: 2000 }] };
  const summary = summarizeRecordedEnergy('2026-10-27', points, at(2700));
  assert.equal(summary.dailyEnergy.householdIncludesCar, false);
  assert.equal(summary.dailyEnergy.household.energyKwh, 1); assert.equal(summary.dailyEnergy.car?.energyKwh, 2);
  assert.equal('totalHousehold' in summary.dailyEnergy, false);
  const missing = summarizeRecordedEnergy('2026-10-27', { ...points, household: [] }, at(2700));
  assert.equal(missing.dailyEnergy.household.energyKwh, null); assert.equal(missing.dailyEnergy.car?.energyKwh, 2);
  assert.equal(missing.dailyEnergy.status, 'partial');
  assert.equal(missing.dailyEnergy.firstObservationAt, at(1770).toISOString());
});

test('only an identified, online charging meter can supply the energy counter', () => {
  const live = { status: 'online', ready: true, stale: false, observedAt: at(870).toISOString(),
    totalEnergyWh: 5000, energyCounterSource: 'Wattpilot:1' } as WattpilotTelemetry;
  assert.equal(carEnergyCounter(live)?.value, 5000);
  for (const change of [{ status: 'offline' }, { ready: false }, { stale: true }, { totalEnergyWh: null }, { energyCounterSource: null }]) {
    assert.equal(carEnergyCounter({ ...live, ...change } as WattpilotTelemetry), null);
  }
});
