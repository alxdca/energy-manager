import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayTelemetryReader } from '../src/display-telemetry.js';
import type { Telemetry } from '../src/status.js';

const epoch = Date.parse('2026-10-24T17:00:00Z');
function sample(at: number, changes: Partial<Telemetry> = {}): Telemetry {
  return { status: 'online', observedAt: new Date(at).toISOString(), error: null,
    solarKw: 3, householdKw: 1, gridImportKw: 0, gridExportKw: 1,
    batterySocPercent: 50, batteryChargeKw: 1, batteryDischargeKw: 0, ...changes };
}
function fixture(steps: Array<Partial<Telemetry> | Error> = [{}, {}, {}], durations: number[] = []) {
  let clock = epoch;
  const starts: number[] = [], waits: number[] = [];
  let active = 0, maxActive = 0;
  const read = createDisplayTelemetryReader(async () => {
    const index = starts.length;
    starts.push(clock); active++; maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    clock += durations[index] ?? 0;
    active--;
    const step = steps[index % steps.length];
    if (step instanceof Error) throw step;
    return sample(clock, step);
  }, { now: () => new Date(clock), wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; } });
  return { read, starts, waits, get clock() { return clock; }, get maxActive() { return maxActive; } };
}

test('averages three raw samples with 1.1-second start intervals adjusted for read latency', async () => {
  const f = fixture([
    { solarKw: 1, householdKw: .5, batterySocPercent: 60 },
    { solarKw: 2, householdKw: 1, batterySocPercent: 61 },
    { solarKw: 6, householdKw: 1.5, batterySocPercent: 62 },
  ], [200, 250, 100]);
  const result = await f.read();
  assert.equal(result.status, 'online'); assert.equal(result.error, null);
  assert.deepEqual(f.starts.map(time => time - epoch), [0, 1100, 2200]);
  assert.deepEqual(f.waits, [900, 850]);
  assert.equal(f.maxActive, 1);
  assert.equal(result.solarKw, 3); assert.equal(result.householdKw, 1); assert.equal(result.batterySocPercent, 61);
  assert.equal(result.observedAt, new Date(epoch + 2300).toISOString());
});

test('slow raw reads never overlap and never add an unnecessary sampling delay', async () => {
  const f = fixture([{}, {}, {}], [1200, 1500, 100]);
  assert.equal((await f.read()).status, 'online');
  assert.deepEqual(f.starts.map(time => time - epoch), [0, 1200, 2700]);
  assert.deepEqual(f.waits, [0, 0]);
  assert.equal(f.maxActive, 1);
});

test('a backwards wall-clock correction cannot turn sample spacing into an unbounded wait', async () => {
  const f = fixture([{}, {}, {}], [-3_600_000, 0, 0]);
  assert.equal((await f.read()).status, 'online');
  assert.deepEqual(f.waits, [1100, 1100]);
  assert.equal(f.starts.length, 3);
});

test('direction-changing grid and battery power are averaged signed before splitting directions', async () => {
  const f = fixture([
    { gridImportKw: 3, gridExportKw: 0, batteryDischargeKw: 0, batteryChargeKw: 3 },
    { gridImportKw: 0, gridExportKw: 1, batteryDischargeKw: 1, batteryChargeKw: 0 },
    { gridImportKw: 0, gridExportKw: .5, batteryDischargeKw: .5, batteryChargeKw: 0 },
  ]);
  const result = await f.read();
  assert.ok(Math.abs(result.gridImportKw! - .5) < 1e-12); assert.equal(result.gridExportKw, 0);
  assert.ok(Math.abs(result.batteryChargeKw! - .5) < 1e-12); assert.equal(result.batteryDischargeKw, 0);
  const balanced = fixture([
    { gridImportKw: 3, gridExportKw: 0, batteryChargeKw: 3 },
    { gridImportKw: 0, gridExportKw: 3, batteryChargeKw: 0, batteryDischargeKw: 3 },
    { gridImportKw: 0, gridExportKw: 0, batteryChargeKw: 0 },
  ]);
  const zero = await balanced.read();
  assert.equal(zero.gridImportKw, 0); assert.equal(zero.gridExportKw, 0);
  assert.equal(zero.batteryChargeKw, 0); assert.equal(zero.batteryDischargeKw, 0);
});

test('any missing or invalid field stays null instead of becoming zero or a two-sample mean', async () => {
  const cases: Array<Partial<Telemetry>> = [
    { solarKw: null }, { solarKw: NaN }, { solarKw: Infinity }, { solarKw: -1 },
    { householdKw: null }, { householdKw: -1 }, { batterySocPercent: null },
    { batterySocPercent: -1 }, { batterySocPercent: 101 },
    { gridExportKw: null }, { gridImportKw: -1 }, { batteryChargeKw: null }, { batteryDischargeKw: Infinity },
  ];
  for (const change of cases) {
    const result = await fixture([{}, change, {}]).read();
    assert.equal(result.status, 'online');
    for (const key of Object.keys(change) as Array<keyof Telemetry>) {
      if (key === 'gridImportKw' || key === 'gridExportKw') {
        assert.equal(result.gridImportKw, null); assert.equal(result.gridExportKw, null);
      } else if (key === 'batteryChargeKw' || key === 'batteryDischargeKw') {
        assert.equal(result.batteryChargeKw, null); assert.equal(result.batteryDischargeKw, null);
      } else assert.equal(result[key], null, key);
    }
  }
});

test('valid zero power and zero or full SOC remain usable measured values', async () => {
  for (const batterySocPercent of [0, 100]) {
    const f = fixture(Array.from({ length: 3 }, () => ({ solarKw: 0, householdKw: 0, gridImportKw: 0,
      gridExportKw: 0, batteryChargeKw: 0, batteryDischargeKw: 0, batterySocPercent })));
    const result = await f.read();
    assert.equal(result.solarKw, 0); assert.equal(result.householdKw, 0);
    assert.equal(result.batterySocPercent, batterySocPercent);
  }
});

test('all timestamps must still be fresh at batch end and the latest measurement time is retained', async () => {
  const first = new Date(epoch - 29_000).toISOString();
  const expired = fixture([{ observedAt: first }, {}, {}]);
  assert.equal((await expired.read()).status, 'offline', 'first reading expires while collecting the remaining samples');
  assert.equal(expired.starts.length, 3);
  const reordered = fixture([
    { observedAt: new Date(epoch + 2000).toISOString() },
    { observedAt: new Date(epoch + 1000).toISOString() },
    { observedAt: new Date(epoch).toISOString() },
  ]);
  const result = await reordered.read();
  assert.equal(result.status, 'online');
  assert.equal(result.observedAt, new Date(epoch + 2000).toISOString());
  for (const observedAt of [null, 'bad', '2026-02-30T17:00:00Z', new Date(epoch + 8000).toISOString()]) {
    assert.equal((await fixture([{}, { observedAt }, {}]).read()).status, 'offline');
  }
});

test('failed or partial batches never average remaining online samples as online', async () => {
  for (const bad of [new Error('private transport detail'), { status: 'offline' as const, error: 'Contrôleur indisponible' },
    { status: 'stale' as const }, { status: 'not_configured' as const }]) {
    const f = fixture([{}, bad, {}]);
    const result = await f.read();
    assert.equal(result.status, 'offline');
    assert.equal(result.observedAt, null); assert.equal(result.solarKw, null); assert.equal(result.batterySocPercent, null);
    assert.ok(result.error);
    assert.doesNotMatch(result.error!, /private transport detail/);
    assert.equal(f.starts.length, 3, 'transient errors do not skip the final sample');
  }
});

test('only a complete last good average survives failures as stale with its original timestamp', async () => {
  const f = fixture([{ solarKw: 1 }, { solarKw: 2 }, { solarKw: 6 }, {}, new Error('offline'), {}]);
  const good = await f.read();
  const stale = await f.read();
  assert.equal(stale.status, 'stale'); assert.ok(stale.error);
  assert.equal(stale.solarKw, 3); assert.equal(stale.observedAt, good.observedAt);
  assert.equal(f.starts.length, 6);
  const recovered = await f.read();
  assert.equal(recovered.status, 'online'); assert.equal(recovered.error, null);
  assert.ok(Date.parse(recovered.observedAt!) > Date.parse(good.observedAt!));
});

test('concurrent callers share only their in-flight batch and sequential calls always start a new batch', async () => {
  const f = fixture([{ solarKw: 1 }, { solarKw: 1 }, { solarKw: 1 }, { solarKw: 4 }, { solarKw: 4 }, { solarKw: 4 }]);
  const first = f.read(); const second = f.read(); const third = f.read();
  assert.equal(first, second); assert.equal(second, third);
  const results = await Promise.all([first, second, third]);
  assert.ok(results.every(result => result.solarKw === 1));
  assert.equal(f.starts.length, 3);
  const next = await f.read();
  assert.equal(next.solarKw, 4); assert.equal(f.starts.length, 6);
});

test('not-configured first sample returns immediately without waiting or extra reads', async () => {
  const f = fixture([{ status: 'not_configured' }]);
  const result = await f.read();
  assert.equal(result.status, 'not_configured'); assert.equal(result.solarKw, null);
  assert.equal(f.starts.length, 1); assert.deepEqual(f.waits, []);
});

test('returned values cannot mutate the retained last good average', async () => {
  const f = fixture([{}, {}, {}, new Error('offline'), {}, {}]);
  const good = await f.read(); good.solarKw = 999;
  assert.equal((await f.read()).solarKw, 3);
});
