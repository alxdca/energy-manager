import test from 'node:test';
import assert from 'node:assert/strict';
import { carSocObservation, createCarSocSampler } from '../src/car-soc.js';
import type { CarTelemetry } from '../src/tesla.js';

const origin = Date.parse('2026-10-27T12:00:00Z');
const at = (seconds: number) => new Date(origin + seconds * 1000);
const point = (seconds: number, value: number) => ({ at: at(seconds).toISOString(), value });

test('car SOC retains the latest actual reading before each quarter with slower Tesla timestamps', () => {
  const sampler = createCarSocSampler();
  sampler.record(point(30, 40), at(120));
  sampler.record(point(810, 42), at(870));
  assert.deepEqual(sampler.pending().battery, []);
  sampler.finalize(at(900));
  assert.deepEqual(sampler.pending().battery, [point(810, 42)]);
  const saved = sampler.pending(); sampler.acknowledge(saved);
  // The same cached reading during sleep never becomes a new observation.
  sampler.record(point(810, 42), at(930));
  sampler.record(null, at(1770)); sampler.finalize(at(1800));
  assert.deepEqual(sampler.pending().battery, []);
  sampler.record(point(2610, 0), at(2670)); sampler.finalize(at(2700));
  assert.deepEqual(sampler.pending().battery, [point(2610, 0)]);
});

test('invalid, future, stale and late car SOC cannot overwrite finalized history', () => {
  const sampler = createCarSocSampler();
  sampler.record(point(810, 50), at(870));
  for (const candidate of [point(820, -1), point(820, 101), point(820, NaN), point(820, Infinity),
    point(880, 99), { at: '2026-02-30T12:00:00Z', value: 99 }]) sampler.record(candidate, at(870));
  sampler.finalize(at(900));
  sampler.record(point(850, 99), at(930));
  sampler.record(point(950, 99), at(1770));
  sampler.finalize(at(1800));
  assert.deepEqual(sampler.pending().battery, [point(810, 50)]);
});

test('a restored finalized watermark prevents clock rollback from reopening old SOC quarters', () => {
  const sampler = createCarSocSampler();
  sampler.record(point(810, 50), at(870)); sampler.finalize(at(900));
  const restored = createCarSocSampler({ state: sampler.pending().state });
  restored.record(point(850, 99), at(870)); restored.finalize(at(900));
  assert.deepEqual(restored.pending().battery, []);
  restored.record(point(1710, 60), at(1770)); restored.finalize(at(1800));
  assert.deepEqual(restored.pending().battery, [point(1710, 60)]);
});

test('Tesla SOC extraction preserves cached timestamps and valid zero without contacting the car', () => {
  const car: CarTelemetry = { status: 'asleep', vehicleName: 'Tesla', socPercent: 0,
    chargeLimitPercent: 80, observedAt: at(30).toISOString(), chargingState: null, error: null };
  assert.deepEqual(carSocObservation(car), point(30, 0));
  for (const change of [{ socPercent: null }, { socPercent: 101 }, { socPercent: NaN }, { observedAt: null }]) {
    assert.equal(carSocObservation({ ...car, ...change }), null);
  }
});
