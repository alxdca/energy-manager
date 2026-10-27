import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatteryOrigin } from '../src/battery-origin.js';
import type { Telemetry } from '../src/status.js';

const initial = Date.parse('2026-10-25T12:00:00.000Z');
const efficiency = Math.sqrt(.95);
function fixture(checkpoint?: unknown) {
  let current = initial;
  const origin = createBatteryOrigin({ now: () => new Date(current), checkpoint });
  function record(seconds: number, changes: Partial<Telemetry> = {}) {
    current = initial + seconds * 1000;
    origin.record({ status: 'online', observedAt: new Date(current).toISOString(), error: null,
      solarKw: 8, householdKw: 2, gridImportKw: 0, gridExportKw: 0,
      batterySocPercent: 50, batteryChargeKw: 6, batteryDischargeKw: 0, ...changes }, new Date(current));
    return origin.snapshot();
  }
  return { origin, record, at: (seconds: number) => origin.snapshot(new Date(initial + seconds * 1000)) };
}
function near(actual: number | null, expected: number) {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} expected ${expected}`);
}

test('initial stored energy has unknown origin, including already full batteries', () => {
  for (const soc of [0, 50, 100]) {
    const f = fixture();
    const state = f.record(0, { batterySocPercent: soc });
    assert.equal(state.available, true);
    near(state.storedKwh, soc * .6);
    near(state.solarStoredKwh, 0);
  }
});

test('power integration earns solar storage through flat quantized SOC readings', () => {
  const f = fixture();
  f.record(0);
  near(f.record(5).solarStoredKwh, 6 * 5 / 3600 * efficiency);
  near(f.record(10).solarStoredKwh, 6 * 10 / 3600 * efficiency);
  near(f.at(10).storedKwh, 30);
  // A changed SOC reconciles the flow estimate; the upward SOC jump itself earns nothing.
  near(f.record(15, { batterySocPercent: 51 }).solarStoredKwh, 6 * 15 / 3600 * efficiency);
  near(f.at(15).storedKwh, 30 + 6 * 15 / 3600 * efficiency);
});

test('grid-origin energy is never credited, even before subsequent solar charging', () => {
  const f = fixture();
  f.record(0, { gridImportKw: 6 });
  near(f.record(5, { gridImportKw: 6 }).solarStoredKwh, 0);
  near(f.record(10).solarStoredKwh, 0);
  near(f.record(15).solarStoredKwh, 6 * 5 / 3600 * efficiency);
});

test('mixed charging attributes all grid import to the battery first and bounds by PV presence', () => {
  const f = fixture();
  f.record(0, { gridImportKw: 4 });
  near(f.record(5, { gridImportKw: 4 }).solarStoredKwh, 2 * 5 / 3600 * efficiency);
  const noPv = fixture();
  noPv.record(0, { solarKw: 0 });
  near(noPv.record(5, { solarKw: 0 }).solarStoredKwh, 0);
  const bounded = fixture();
  bounded.record(0, { solarKw: 1 });
  near(bounded.record(5, { solarKw: 1 }).solarStoredKwh, 5 / 3600 * efficiency);
});

test('household and export discharge both debit solar first including losses', () => {
  for (const gridExportKw of [0, 4]) {
    const f = fixture();
    for (let seconds = 0; seconds <= 30; seconds += 5) f.record(seconds);
    const earned = f.at(30).solarStoredKwh!;
    near(f.record(35, { batteryChargeKw: 0, batteryDischargeKw: 3, gridExportKw }).solarStoredKwh,
      earned - 3 * 5 / 3600 / efficiency);
    near(f.record(40, { batteryChargeKw: 0, batteryDischargeKw: 3, gridExportKw }).solarStoredKwh,
      earned - 3 * 10 / 3600 / efficiency);
  }
});

test('unexplained positive SOC adds no credit, negative correction consumes it', () => {
  const f = fixture();
  for (let seconds = 0; seconds <= 30; seconds += 5) f.record(seconds);
  const before = f.at(30).solarStoredKwh!;
  near(f.record(35, { batterySocPercent: 90, batteryChargeKw: 0 }).solarStoredKwh, before);
  near(f.record(40, { batterySocPercent: 60, batteryChargeKw: 0 }).solarStoredKwh, 0);
});

test('fully charged battery cannot gain solar credit from spurious charge power', () => {
  const f = fixture();
  f.record(0, { batterySocPercent: 100 });
  near(f.record(5, { batterySocPercent: 100 }).solarStoredKwh, 0);
});

test('flat SOC cannot mask unlimited integrated charge', () => {
  const f = fixture();
  for (let seconds = 0; seconds <= 1800; seconds += 5) f.record(seconds);
  assert.ok(f.at(1800).solarStoredKwh! <= .6 + 1e-10);
  near(f.at(1800).storedKwh, 30);
});

test('missing/offline readings and long gaps debit maximum possible discharge and break credit integration', () => {
  for (const changes of [{ status: 'offline' as const }, { batterySocPercent: null }, { gridImportKw: null },
    { solarKw: null }, { batteryChargeKw: null }, { batteryDischargeKw: null }]) {
    const f = fixture();
    for (let seconds = 0; seconds <= 30; seconds += 5) f.record(seconds);
    const earned = f.at(30).solarStoredKwh!;
    assert.equal(f.record(35, changes).available, false);
    near(f.record(40).solarStoredKwh, Math.max(0, earned - 7 * 10 / 3600 / efficiency));
  }
  const f = fixture();
  for (let seconds = 0; seconds <= 30; seconds += 5) f.record(seconds);
  near(f.record(60).solarStoredKwh, 0);
});

test('duplicates and out-of-order samples never create credit', () => {
  const f = fixture();
  f.record(0);
  const earned = f.record(5).solarStoredKwh!;
  assert.equal(f.record(5).available, false);
  near(f.record(10).solarStoredKwh, Math.max(0, earned - 7 * 5 / 3600 / efficiency));
  const g = fixture();
  g.record(0); g.record(5);
  assert.equal(g.record(10, { observedAt: new Date(initial + 1000).toISOString() }).available, false);
  near(g.record(15).solarStoredKwh, 0);
});

test('snapshots reserve possible unobserved discharge and stale data become unavailable', () => {
  const f = fixture();
  for (let seconds = 0; seconds <= 30; seconds += 5) f.record(seconds);
  const earned = f.at(30).solarStoredKwh!;
  near(f.at(35).solarStoredKwh, earned - 7 * 5 / 3600 / efficiency);
  assert.equal(f.at(61).available, false);
  assert.equal(f.at(61).solarStoredKwh, null);
});

test('restart debits all possible consumption since checkpoint and does not bridge credit', () => {
  const f = fixture();
  for (let seconds = 0; seconds <= 30; seconds += 5) f.record(seconds);
  const checkpoint = f.origin.checkpoint();
  assert.equal(checkpoint.night, null, 'a daytime checkpoint explicitly records no night context');
  const origin = createBatteryOrigin({ checkpoint, now: () => new Date(initial + 35_000) });
  assert.equal(origin.snapshot().available, false);
  const next = { status: 'online' as const, observedAt: new Date(initial + 40_000).toISOString(), error: null,
    solarKw: 8, householdKw: 2, gridImportKw: 0, gridExportKw: 0, batterySocPercent: 50,
    batteryChargeKw: 6, batteryDischargeKw: 0 };
  origin.record(next, new Date(initial + 40_000));
  near(origin.snapshot(new Date(initial + 40_000)).solarStoredKwh,
    Math.max(0, checkpoint.solarStoredKwh - 7 * 10 / 3600 / efficiency));
  const late = createBatteryOrigin({ checkpoint, now: () => new Date(initial + 3600_000) });
  near(late.checkpoint().solarStoredKwh, 0);
});

test('malformed/mismatched checkpoints, invalid timestamps and backwards clocks grant no source credit', () => {
  for (const checkpoint of [{ version: 1, solarStoredKwh: 20 }, { version: 2 }, [], 'bad']) {
    const f = fixture(checkpoint);
    near(f.record(0).solarStoredKwh, 0);
  }
  const f = fixture();
  f.record(0); f.record(5);
  assert.equal(f.record(10, { observedAt: '2026-02-30T12:00:00.000Z' }).available, false);
  near(f.record(15).solarStoredKwh, 0);
  f.record(20);
  assert.equal(f.record(10).available, false);
  near(f.record(25).solarStoredKwh, 0);
});

function nightFixture(start = '2026-10-25T21:59:55.000Z') {
  const beginning = Date.parse(start);
  let current = beginning - 5000;
  const checkpoint = { version: 1, capacityKwh: 60, maxPowerKw: 7, solarStoredKwh: 20,
    modeledStoredKwh: 20, measuredStoredKwh: 20, observedAt: new Date(current).toISOString(),
    accountedAt: new Date(current).toISOString(), night: null };
  const origin = createBatteryOrigin({ checkpoint, now: () => new Date(current) });
  function record(seconds: number, changes: Partial<Telemetry> = {}) {
    current = beginning + seconds * 1000;
    origin.record({ status: 'online', observedAt: new Date(current).toISOString(), error: null,
      solarKw: 0, householdKw: 2, gridImportKw: 0, gridExportKw: 0, batterySocPercent: 20 / .6,
      batteryChargeKw: 0, batteryDischargeKw: 0, ...changes }, new Date(current));
    return origin.snapshot(new Date(current));
  }
  return { origin, record, beginning, now: () => current };
}

test('night authorization freezes before charging and grid deposits cannot raise its baseline', () => {
  const f = nightFixture();
  assert.equal(f.record(0).night, null);
  const night = f.record(5).night!;
  assert.equal(night.id, '2026-10-26T06:00:00.000Z');
  assert.equal(night.valid, true);
  near(night.solarAtStartKwh, 20 - 7 * 10 / 3600 / efficiency);
  near(night.storedAtStartKwh, night.solarAtStartKwh);
  for (let step = 1; step <= 2500; step++) {
    f.record(5 + step * 5, { gridImportKw: 6, batteryChargeKw: 6,
      batterySocPercent: (20 + step * 6 * 5 / 3600 * efficiency) / .6 });
  }
  const current = f.origin.snapshot(new Date(f.now()));
  assert.ok(current.storedKwh! > 40, 'grid charging raised current storage above the protected 30 kWh example');
  assert.deepEqual(current.night, night, 'neither storage increase nor grid deposits replenish the night baseline');
  assert.ok(current.night!.storedAtStartKwh < 30, 'a 30 kWh protected reserve still allows no night assist');
});

test('all night discharge and unseen consumption spend one cumulative allowance despite later grid charging', () => {
  const f = nightFixture();
  f.record(0);
  const baseline = f.record(5).night!;
  const unit = 3 * 5 / 3600 / efficiency;
  near(f.record(10, { batteryDischargeKw: 3 }).night!.dischargedKwh, unit);
  near(f.record(15, { batteryChargeKw: 6, gridImportKw: 6 }).night!.dischargedKwh, 2 * unit);
  near(f.record(20, { batteryChargeKw: 6, gridImportKw: 6 }).night!.dischargedKwh, 2 * unit);
  const current = f.record(25, { batteryDischargeKw: 3 });
  near(current.night!.dischargedKwh, 3 * unit);
  near(current.night!.storedAtStartKwh, baseline.storedAtStartKwh);
  near(f.origin.snapshot(new Date(f.now() + 5000)).night!.dischargedKwh, 3 * unit + 7 * 5 / 3600 / efficiency);
});

test('same-night restart preserves frozen authorization and debits its unknown interval', () => {
  const f = nightFixture();
  f.record(0); f.record(5); f.record(10, { batteryDischargeKw: 3 });
  const saved = f.origin.checkpoint();
  const restored = createBatteryOrigin({ checkpoint: saved, now: () => new Date(f.now() + 5000) });
  assert.equal(restored.snapshot().night!.valid, true);
  near(restored.snapshot().night!.dischargedKwh, saved.night!.dischargedKwh + 7 * 5 / 3600 / efficiency);
  near(restored.snapshot().night!.storedAtStartKwh, saved.night!.storedAtStartKwh);
  // Checkpoint values are immutable copies, not a reference to the live night counter.
  near(saved.night!.dischargedKwh, 3 * 5 / 3600 / efficiency);
});

test('checkpoints without night context reset source balances and grant no night authority', () => {
  const f = nightFixture();
  f.record(0); f.record(5);
  const saved = f.origin.checkpoint() as unknown as Record<string, unknown>;
  delete saved.night;
  const restored = createBatteryOrigin({ checkpoint: saved, now: () => new Date(f.now()) });
  const before = restored.snapshot().night!;
  assert.equal(before.valid, false);
  near(before.storedAtStartKwh, 0);
  assert.equal(restored.snapshot().available, false);
  assert.equal(restored.checkpoint().solarStoredKwh, 0);
  assert.equal(restored.checkpoint().modeledStoredKwh, null);
  assert.equal(restored.checkpoint().measuredStoredKwh, null);
  assert.equal(restored.checkpoint().observedAt, null);
  restored.record({ status: 'online', observedAt: new Date(f.now() + 5000).toISOString(), error: null,
    solarKw: 0, householdKw: 2, gridImportKw: 6, gridExportKw: 0, batterySocPercent: 70,
    batteryChargeKw: 6, batteryDischargeKw: 0 }, new Date(f.now() + 5000));
  assert.equal(restored.snapshot(new Date(f.now() + 5000)).night!.valid, false);
  assert.equal(restored.snapshot(new Date(f.now() + 5000)).solarStoredKwh, 0, 'grid charging cannot restore discarded source credit');
  const fresh = createBatteryOrigin({ now: () => new Date(f.now()) });
  assert.equal(fresh.snapshot().night!.valid, false);
});

test('night gaps spend maximum discharge, lost boundary observations invalidate authorization', () => {
  const f = nightFixture();
  f.record(0); f.record(5);
  near(f.record(35).night!.dischargedKwh, 7 * 30 / 3600 / efficiency);
  const lost = nightFixture();
  lost.record(0);
  assert.equal(lost.record(5, { status: 'offline' }).night!.valid, false);
  assert.equal(lost.record(10).night!.valid, false);
});

test('night identity follows Zurich DST and daytime clears context', () => {
  for (const [start, end] of [
    ['2026-10-24T20:59:55.000Z', '2026-10-25T06:00:00.000Z'],
    ['2026-03-28T21:59:55.000Z', '2026-03-29T05:00:00.000Z'],
  ]) {
    const f = nightFixture(start);
    f.record(0);
    assert.equal(f.record(5).night!.id, end);
    assert.equal(f.origin.snapshot(new Date(end)).night, null);
    f.record((Date.parse(end) - f.beginning) / 1000);
    assert.equal(f.origin.checkpoint().night, null);
  }
});
