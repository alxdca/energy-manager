import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnergyCollector, createObservationCollector } from '../src/energy-collector.js';
import { createObservationSampler } from '../src/observation-sampler.js';
import { createBatteryOrigin } from '../src/battery-origin.js';
import type { Telemetry } from '../src/status.js';

const origin = Date.parse('2026-10-24T12:00:00Z');
const telemetry: Telemetry = {
  status: 'online', observedAt: new Date(origin).toISOString(), error: null,
  solarKw: 2, householdKw: 1, gridImportKw: 0, gridExportKw: 1,
  batterySocPercent: 50, batteryChargeKw: 0, batteryDischargeKw: 0,
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function scheduler() {
  let clock = origin;
  let nextId = 0;
  const tasks = new Map<number, { callback: () => void; due: number }>();
  return {
    now: () => new Date(clock),
    pending: () => tasks.size,
    timers: {
      setTimeout(callback: () => void, delay: number) {
        const id = ++nextId;
        tasks.set(id, { callback, due: clock + delay });
        return id;
      },
      clearTimeout(handle: unknown) { tasks.delete(handle as number); },
    },
    advance(ms: number) {
      clock += ms;
      for (const [id, task] of [...tasks]) if (task.due <= clock) {
        tasks.delete(id);
        task.callback();
      }
    },
  };
}
function harness() {
  const time = scheduler();
  const records: { telemetry: Telemetry; at: Date | undefined }[] = [];
  const errors: unknown[] = [];
  const checkpoints: number[] = [];
  let reads = 0;
  const options = {
    ...time,
    onError: (error: unknown) => { errors.push(error); },
    readTelemetry: async () => { reads++; return { ...telemetry }; },
    store: {
      record: (value: Telemetry, at?: Date) => { records.push({ telemetry: value, at }); },
      flush: async () => { checkpoints.push(time.now().getTime()); },
    },
  };
  return { time, records, errors, checkpoints, options, reads: () => reads };
}

test('explicit start samples without a browser, checkpoints immediately and polls after completion', async () => {
  const h = harness();
  const collector = createEnergyCollector(h.options);
  assert.equal(h.reads(), 0);
  assert.equal(h.time.pending(), 0);
  collector.start();
  collector.start();
  await settle();
  assert.equal(h.reads(), 1);
  assert.deepEqual(h.records[0], { telemetry, at: new Date(origin) });
  assert.deepEqual(h.checkpoints, [origin]);
  assert.equal(h.time.pending(), 1);
  h.time.advance(4999);
  await settle();
  assert.equal(h.reads(), 1);
  h.time.advance(1);
  await settle();
  assert.equal(h.reads(), 2);
  assert.equal(h.checkpoints.length, 1);
  await collector.stop();
  assert.equal(h.time.pending(), 0);
});

test('slow reads and checkpoints cannot overlap samples or create catch-up polling', async () => {
  const h = harness();
  const reading = deferred<Telemetry>();
  const writing = deferred<void>();
  let calls = 0;
  const collector = createEnergyCollector({ ...h.options,
    readTelemetry: () => { calls++; return reading.promise; },
    store: { ...h.options.store, flush: () => writing.promise },
  });
  collector.start();
  h.time.advance(60_000);
  await settle();
  assert.equal(calls, 1);
  assert.equal(h.time.pending(), 0);
  reading.resolve(telemetry);
  await settle();
  h.time.advance(60_000);
  await settle();
  assert.equal(calls, 1);
  assert.equal(h.time.pending(), 0);
  writing.resolve();
  await settle();
  assert.equal(h.time.pending(), 1);
  h.time.advance(4999);
  await settle();
  assert.equal(calls, 1);
  h.time.advance(1);
  await settle();
  assert.equal(calls, 2);
  await collector.stop();
});

test('polling aligns to clock boundaries instead of drifting by read and checkpoint duration', async () => {
  const h = harness();
  const started: number[] = [];
  const collector = createEnergyCollector({ ...h.options, readTelemetry: async () => {
    started.push(h.time.now().getTime());
    h.time.advance(1200);
    return { ...telemetry, observedAt: h.time.now().toISOString() };
  } });
  h.time.advance(17 * 60_000 + 2300);
  collector.start();
  await settle();
  h.time.advance(1499);
  await settle();
  assert.equal(started.length, 1);
  h.time.advance(1);
  await settle();
  assert.equal(started[1], origin + 17 * 60_000 + 5000);
  h.time.advance(3800);
  await settle();
  assert.equal(started[2], origin + 17 * 60_000 + 10_000);
  await collector.stop();
});

test('successful checkpoints occur every thirty seconds rather than every sample', async () => {
  const h = harness();
  const collector = createEnergyCollector(h.options);
  collector.start();
  await settle();
  for (let i = 0; i < 6; i++) { h.time.advance(5000); await settle(); }
  assert.equal(h.reads(), 7);
  assert.deepEqual(h.checkpoints, [origin, origin + 30_000]);
  await collector.stop();
  assert.deepEqual(h.checkpoints, [origin, origin + 30_000, origin + 30_000]);
});

test('read errors break the integration segment and recover on the next poll', async () => {
  const h = harness();
  const failure = new Error('controller unavailable');
  let calls = 0;
  const collector = createEnergyCollector({ ...h.options, readTelemetry: async () => {
    if (++calls === 2) throw failure;
    return { ...telemetry };
  } });
  collector.start();
  await settle();
  h.time.advance(5000);
  await settle();
  assert.deepEqual(h.errors, [failure]);
  assert.equal(h.records[1].telemetry.status, 'offline');
  assert.equal(h.records[1].telemetry.observedAt, null);
  assert.equal(h.records[1].telemetry.solarKw, null);
  assert.equal(h.records[1].telemetry.householdKw, null);
  assert.equal(h.records[1].at?.getTime(), origin + 5000);
  h.time.advance(5000);
  await settle();
  assert.equal(h.records[2].telemetry.status, 'online');
  await collector.stop();
});

test('failed persistence is reported, retried next poll and does not stop collection', async () => {
  const h = harness();
  const failure = new Error('disk full');
  let attempts = 0;
  const collector = createEnergyCollector({ ...h.options,
    store: { ...h.options.store, flush: async () => {
      attempts++;
      if (attempts <= 2) throw failure;
      h.checkpoints.push(h.time.now().getTime());
    } },
  });
  collector.start();
  await settle();
  for (let i = 0; i < 3; i++) { h.time.advance(5000); await settle(); }
  assert.equal(h.reads(), 4);
  assert.equal(attempts, 3);
  assert.deepEqual(h.errors, [failure, failure]);
  assert.deepEqual(h.checkpoints, [origin + 10_000]);
  await collector.stop();
});

test('stop waits for a pending read, records it, flushes once and never rearms', async () => {
  const h = harness();
  const reading = deferred<Telemetry>();
  const writing = deferred<void>();
  let flushes = 0;
  const collector = createEnergyCollector({ ...h.options,
    readTelemetry: () => reading.promise,
    store: { ...h.options.store, flush: () => { flushes++; return writing.promise; } },
  });
  collector.start();
  const stopped = collector.stop();
  assert.equal(collector.stop(), stopped);
  let completed = false;
  void stopped.then(() => { completed = true; });
  await settle();
  assert.equal(completed, false);
  assert.equal(flushes, 0);
  reading.resolve(telemetry);
  await settle();
  assert.equal(h.records.length, 1);
  assert.equal(flushes, 1);
  assert.equal(completed, false);
  assert.equal(h.time.pending(), 0);
  writing.resolve();
  await stopped;
  collector.start();
  h.time.advance(100_000);
  await settle();
  assert.equal(h.records.length, 1);
  assert.equal(flushes, 1);
  assert.equal(h.time.pending(), 0);
});

test('stop clears idle polling, handles final flush/reporting errors and is safe before start', async () => {
  const h = harness();
  let flushes = 0;
  const collector = createEnergyCollector({ ...h.options,
    onError: () => { throw new Error('logging also failed'); },
    store: { ...h.options.store, flush: async () => { flushes++; throw new Error('storage unavailable'); } },
  });
  collector.start();
  await settle();
  assert.equal(h.time.pending(), 1);
  await collector.stop();
  await collector.stop();
  h.time.advance(5000);
  await settle();
  assert.equal(h.reads(), 1);
  assert.equal(flushes, 2);
  assert.equal(h.time.pending(), 0);
  const idle = harness();
  const neverStarted = createEnergyCollector(idle.options);
  await neverStarted.stop();
  neverStarted.start();
  assert.equal(idle.reads(), 0);
  assert.equal(idle.checkpoints.length, 1);
  assert.equal(idle.time.pending(), 0);
});

test('invalid intervals fail synchronously without starting reads or timers', () => {
  const h = harness();
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => createEnergyCollector({ ...h.options, pollIntervalMs: value }));
    assert.throws(() => createEnergyCollector({ ...h.options, checkpointIntervalMs: value }));
  }
  assert.equal(h.reads(), 0);
  assert.equal(h.time.pending(), 0);
});

test('observation candidates run every thirty seconds while provenance retains its faster continuity', async () => {
  const time = scheduler();
  const originLedger = createBatteryOrigin({ capacityKwh: 60, now: time.now });
  const sampler = createObservationSampler({ now: time.now });
  let powerReads = 0, observationReads = 0, persistedRows = 0;
  const fast = createEnergyCollector({ ...time,
    readTelemetry: async () => { powerReads++; return { ...telemetry, observedAt: time.now().toISOString(),
      gridImportKw: 0, batteryChargeKw: 1, batteryDischargeKw: 0 }; },
    store: { record: (value, at) => originLedger.record(value, at), async flush() {} },
  });
  const observations = createObservationCollector({ ...time,
    readSample: async () => { observationReads++; return {
      battery: { at: time.now().toISOString(), value: 50 }, solar: null, household: null,
    }; },
    store: { record: sampler.record, async flush() {
      sampler.finalize();
      const completed = sampler.pending();
      persistedRows += completed.battery.length + completed.solar.length + completed.household.length;
      sampler.acknowledge(completed);
    } },
  });
  fast.start(); observations.start();
  await settle();
  for (let tick = 0; tick < 6; tick++) { time.advance(5000); await settle(); }
  assert.equal(powerReads, 7);
  assert.equal(observationReads, 2);
  assert.equal(persistedRows, 0, 'intermediate thirty-second candidates never become persisted observations');
  assert.ok(originLedger.snapshot().available);
  assert.ok((originLedger.snapshot().solarStoredKwh ?? 0) > 0, 'five-second provenance avoids the thirty-second continuity gap');
  await Promise.all([fast.stop(), observations.stop()]);
  assert.equal(persistedRows, 0, 'shutdown cannot persist an unfinished target');
});
