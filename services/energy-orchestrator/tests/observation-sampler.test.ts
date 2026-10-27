import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationSampler } from '../src/observation-sampler.js';
import type { ObservationSample } from '../src/observation-types.js';

const origin = Date.parse('2026-01-15T12:00:00.000Z');
const iso = (seconds: number) => new Date(origin + seconds * 1000).toISOString();
const instant = (seconds: number) => new Date(origin + seconds * 1000);
function sample(seconds: number, solar = 1000, household = -5000, battery = 50, source = 'device-1'): ObservationSample {
  const at = iso(seconds);
  return { battery: { at, value: battery }, solar: { at, value: solar, source }, household: { at, value: household, source } };
}

test('30-second readings stay volatile and targets retain only the latest raw sample without averaging', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(0, 1000, -5000, 10), instant(0));
  sampler.record(sample(30, 1200, -4800, 20), instant(30));
  sampler.record(sample(870, 2000, -4000, 60), instant(870));
  assert.deepEqual(sampler.pending(), { battery: [], solar: [], household: [], householdIntervals: [],
    state: { version: 1, finalizedThrough: iso(0), solar: null, household: null } });
  sampler.finalize(instant(900));
  const first = sampler.pending();
  assert.deepEqual(first.battery, [{ at: iso(870), value: 60 }]);
  assert.deepEqual(first.solar, [], 'the first counter establishes a baseline, never invented energy');
  assert.deepEqual(first.household, []);
  assert.deepEqual(first.state.solar, { target: iso(900), sample: { at: iso(870), value: 2000, source: 'device-1' } });
  sampler.record(sample(1770, 2300, -3500, 70), instant(1770));
  sampler.finalize(instant(1800));
  assert.deepEqual(sampler.pending().solar, [{ at: iso(1770), value: 300 }]);
  assert.deepEqual(sampler.pending().household, [{ at: iso(1770), value: 500 }]);
  assert.deepEqual(sampler.pending().battery.at(-1), { at: iso(1770), value: 70 });
});

test('record finalizes before accepting input: exact-boundary samples belong to the next target', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(870, 1000, 2000, 20), instant(870));
  sampler.record(sample(900, 1100, 2200, 40), instant(900));
  assert.deepEqual(sampler.pending().battery, [{ at: iso(870), value: 20 }]);
  assert.deepEqual(sampler.pending().state.solar?.sample.value, 1000);
  sampler.record(sample(899, 9999, 9999, 99), instant(901));
  assert.equal(sampler.pending().battery[0].value, 20, 'late input cannot revise an already finalized target');
  sampler.finalize(instant(1800));
  assert.deepEqual(sampler.pending().battery.at(-1), { at: iso(900), value: 40 });
  assert.deepEqual(sampler.pending().solar, [{ at: iso(900), value: 100 }]);
});

test('future clock skew does not overwrite the prior window candidate', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(870, 1000, 1000, 10), instant(870));
  sampler.record(sample(901, 1200, 1200, 20), instant(898));
  sampler.finalize(instant(900));
  assert.deepEqual(sampler.pending().battery, [{ at: iso(870), value: 10 }]);
  sampler.finalize(instant(1800));
  assert.deepEqual(sampler.pending().battery.at(-1), { at: iso(901), value: 20 });
});

test('missed targets advance without repeating stale samples or turning multi-quarter counter changes into quarter energy', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(870), instant(870));
  sampler.finalize(instant(3600));
  assert.equal(sampler.pending().state.finalizedThrough, iso(3600));
  assert.equal(sampler.pending().battery.length, 1);
  sampler.record(sample(4470, 5000), instant(4470));
  sampler.finalize(instant(4500));
  assert.deepEqual(sampler.pending().solar, [], 'a missed baseline interval requires rebaselining');
  sampler.record(sample(5370, 5400), instant(5370));
  sampler.finalize(instant(5400));
  assert.deepEqual(sampler.pending().solar, [{ at: iso(5370), value: 400 }]);
  sampler.finalize(new Date('2099-01-01T00:00:00Z'));
  assert.equal(sampler.pending().battery.length, 3, 'downtime never creates artificial target observations');
});

test('counter resets and source changes establish a new baseline independently for each channel', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(870, 1000, -1000), instant(870)); sampler.finalize(instant(900));
  sampler.record(sample(1770, 100, -800), instant(1770)); sampler.finalize(instant(1800));
  assert.deepEqual(sampler.pending().solar, []);
  assert.deepEqual(sampler.pending().household, [{ at: iso(1770), value: 200 }]);
  sampler.record(sample(2670, 150, -600, 50, 'replacement'), instant(2670)); sampler.finalize(instant(2700));
  assert.equal(sampler.pending().household.length, 1, 'source changes cannot produce a cross-device delta');
  sampler.record(sample(3570, 150, -600, 0, 'replacement'), instant(3570)); sampler.finalize(instant(3600));
  assert.deepEqual(sampler.pending().solar, [{ at: iso(3570), value: 0 }]);
  assert.deepEqual(sampler.pending().household.at(-1), { at: iso(3570), value: 0 });
  assert.deepEqual(sampler.pending().battery.at(-1), { at: iso(3570), value: 0 });
});

test('restart restores finalized counter baselines while discarding mid-quarter candidates', () => {
  const first = createObservationSampler();
  first.record(sample(870, 1000), instant(870)); first.finalize(instant(900));
  first.record(sample(1200, 1100, -4000, 99), instant(1200));
  const state = first.pending().state;
  const noFurtherSample = createObservationSampler({ state });
  noFurtherSample.finalize(instant(1800));
  assert.deepEqual(noFurtherSample.pending().battery, []);
  assert.deepEqual(noFurtherSample.pending().solar, []);
  const resumed = createObservationSampler({ state });
  resumed.record(sample(1770, 1250), instant(1770)); resumed.finalize(instant(1800));
  assert.deepEqual(resumed.pending().solar, [{ at: iso(1770), value: 250 }]);
  assert.equal(resumed.pending().battery[0].value, 50);
});

test('native components detect resets hidden by rising derived household or aggregate solar counters', () => {
  const sampler = createObservationSampler();
  const first = sample(870, 1000, 100);
  first.household!.components = { pv: 1000, gridImport: 500, gridExport: 1400 };
  first.solar!.components = { string1: 900, string2: 100 };
  sampler.record(first, instant(870)); sampler.finalize(instant(900));
  const reset = sample(1770, 1100, 1600);
  reset.household!.components = { pv: 1100, gridImport: 600, gridExport: 100 };
  reset.solar!.components = { string1: 10, string2: 1090 };
  sampler.record(reset, instant(1770)); sampler.finalize(instant(1800));
  assert.deepEqual(sampler.pending().household, [], 'a reset in the subtractive export counter cannot create a large positive energy delta');
  assert.deepEqual(sampler.pending().solar, [], 'an increasing aggregate must not hide a reset in one PV string');
  const next = sample(2670, 1300, 1800);
  next.household!.components = { gridExport: 150, gridImport: 650, pv: 1300 };
  next.solar!.components = { string2: 1190, string1: 110 };
  sampler.record(next, instant(2670)); sampler.finalize(instant(2700));
  assert.deepEqual(sampler.pending().household, [{ at: iso(2670), value: 200 }]);
  assert.deepEqual(sampler.pending().solar, [{ at: iso(2670), value: 200 }]);
});

test('adding, removing or changing native component identities requires rebaselining', () => {
  for (const [before, after] of [[undefined, { total: 1000 }], [{ total: 900 }, undefined],
    [{ total: 900 }, { replacement: 1000 }], [{ one: 400, two: 500 }, { one: 1000 }]] as const) {
    const sampler = createObservationSampler();
    const first = sample(870, 900), next = sample(1770, 1000);
    if (before) first.solar!.components = { ...before };
    if (after) next.solar!.components = { ...after };
    sampler.record(first, instant(870)); sampler.finalize(instant(900));
    sampler.record(next, instant(1770)); sampler.finalize(instant(1800));
    assert.deepEqual(sampler.pending().solar, []);
    assert.deepEqual(sampler.pending().state.solar!.sample.components, after);
  }
});

test('native component maps are cloned and only finalized maps enter persistent state', () => {
  const sampler = createObservationSampler();
  const first = sample(870); first.solar!.components = { total: 1000 };
  sampler.record(first, instant(870)); first.solar!.components.total = 9999;
  assert.equal(sampler.pending().state.solar, null);
  sampler.finalize(instant(900));
  assert.deepEqual(sampler.pending().state.solar!.sample.components, { total: 1000 });
  const state = sampler.pending().state;
  const restored = createObservationSampler({ state });
  state.solar!.sample.components!.total = 8888;
  assert.deepEqual(restored.pending().state.solar!.sample.components, { total: 1000 });
  const second = sample(1770, 1100); second.solar!.components = { total: 1100 };
  restored.record(second, instant(1770));
  assert.deepEqual(restored.pending().state.solar!.sample.components, { total: 1000 });
  restored.finalize(instant(1800));
  assert.deepEqual(restored.pending().solar, [{ at: iso(1770), value: 100 }]);
});

test('acknowledging a snapshot removes only its rows and cannot drop newer finalized observations or rewind state', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(870), instant(870)); sampler.finalize(instant(900));
  const saved = sampler.pending();
  sampler.record(sample(1770, 1200), instant(1770)); sampler.finalize(instant(1800));
  sampler.acknowledge(saved);
  assert.deepEqual(sampler.pending().battery, [{ at: iso(1770), value: 50 }]);
  assert.deepEqual(sampler.pending().solar, [{ at: iso(1770), value: 200 }]);
  assert.equal(sampler.pending().state.finalizedThrough, iso(1800));
  sampler.acknowledge(saved);
  const latest = sampler.pending(); sampler.acknowledge(latest);
  assert.deepEqual(sampler.pending().battery, []);
  assert.deepEqual(sampler.pending().state, latest.state);
});

test('inputs and pending snapshots do not expose mutable candidate, queue or baseline state', () => {
  const sampler = createObservationSampler();
  const input = sample(870, 1000, 2000, 10);
  sampler.record(input, instant(870)); input.battery!.value = 99; input.solar!.value = 9999;
  sampler.finalize(instant(900));
  const copy = sampler.pending(); copy.battery[0].value = 88; copy.state.solar!.sample.value = 8888;
  assert.equal(sampler.pending().battery[0].value, 10);
  assert.equal(sampler.pending().state.solar!.sample.value, 1000);
  const state = sampler.pending().state;
  const restored = createObservationSampler({ state }); state.solar!.sample.value = 7777;
  assert.equal(restored.pending().state.solar!.sample.value, 1000);
});

test('freshness, validity and monotonic latest selection apply independently to each channel', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(870, 0, -100, 0), instant(870));
  for (const seconds of [829, 876]) sampler.record(sample(seconds, 9999, 9999, 99), instant(870));
  const invalid = sample(871, -1, NaN, 101); sampler.record(invalid, instant(871));
  sampler.record(sample(869, 9999, 9999, 99), instant(872));
  sampler.finalize(instant(900));
  assert.deepEqual(sampler.pending().battery, [{ at: iso(870), value: 0 }]);
  assert.equal(sampler.pending().state.solar!.sample.value, 0);
  assert.equal(sampler.pending().state.household!.sample.value, -100);
});

test('clock rollback neither reopens finalized targets nor changes already queued values', () => {
  const sampler = createObservationSampler();
  sampler.record(sample(870), instant(870)); sampler.finalize(instant(900));
  const previous = sampler.pending();
  sampler.finalize(instant(0)); sampler.record(sample(860, 9999), instant(860));
  assert.deepEqual(sampler.pending(), previous);
  const restarted = createObservationSampler({ state: previous.state });
  restarted.record(sample(860, 9999), instant(860)); restarted.finalize(instant(900));
  assert.equal(restarted.pending().state.solar!.sample.value, 1000);
  assert.deepEqual(restarted.pending().battery, []);
});

test('UTC quarter targets preserve real timestamps across Zurich DST transitions', () => {
  for (const first of ['2026-03-29T00:59:30.000Z', '2026-10-25T00:59:30.000Z']) {
    const sampler = createObservationSampler();
    const start = Date.parse(first);
    for (const [index, value] of [100, 125].entries()) {
      const at = new Date(start + index * 900_000).toISOString();
      sampler.record({ battery: { at, value: 50 + index }, solar: { at, value, source: 'pv' }, household: null }, new Date(at));
      sampler.finalize(new Date(start + index * 900_000 + 30_000));
    }
    assert.deepEqual(sampler.pending().solar, [{ at: new Date(start + 900_000).toISOString(), value: 25 }]);
    assert.equal(new Set(sampler.pending().battery.map(point => point.at)).size, 2);
  }
});

test('persistent state rejects malformed metadata, targets and baselines rather than silently resetting', () => {
  const sampler = createObservationSampler(); sampler.record(sample(870), instant(870)); sampler.finalize(instant(900));
  const good = sampler.pending().state;
  const bad: unknown[] = [null, {}, { ...good, version: 2 }, { ...good, extra: true }, { ...good, finalizedThrough: iso(901) },
    { ...good, finalizedThrough: null }, { ...good, solar: { ...good.solar, target: iso(1800) } },
    { ...good, solar: { target: iso(900), sample: { at: iso(900), value: 1, source: 'x' } } },
    { ...good, solar: { target: iso(900), sample: { at: iso(870), value: -1, source: 'x' } } },
    { ...good, household: { target: iso(900), sample: { at: iso(870), value: NaN, source: 'x' } } },
    ...[{}, { total: -1 }, { total: NaN }, { total: '100' }, []].map(components => ({ ...good,
      solar: { target: iso(900), sample: { at: iso(870), value: 1000, source: 'x', components } } }))];
  for (const state of bad) assert.throws(() => createObservationSampler({ state }), /Invalid observation sampler state/);
});
