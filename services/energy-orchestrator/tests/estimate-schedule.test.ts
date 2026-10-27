import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimateSchedule } from '../src/estimate-schedule.js';

const quarterMs = 15 * 60_000;
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(instant = '2026-10-25T19:07:00Z') {
  let clock = Date.parse(instant), nextId = 0;
  const runs: string[] = [], errors: unknown[] = [];
  const tasks = new Map<number, { callback: () => void; due: number }>();
  const options = {
    now: () => new Date(clock),
    run: async (at: Date) => { runs.push(at.toISOString()); },
    onError: (error: unknown) => { errors.push(error); },
    timers: {
      setTimeout(callback: () => void, delay: number) {
        assert.ok(delay > 0, 'Timers must always move forward');
        const id = ++nextId;
        tasks.set(id, { callback, due: clock + delay });
        return id;
      },
      clearTimeout(handle: unknown) { tasks.delete(handle as number); },
    },
  };
  function fireDue() {
    for (const [id, task] of [...tasks]) if (task.due <= clock) { tasks.delete(id); task.callback(); }
  }
  return { options, runs, errors, get pendingTimers() { return tasks.size; },
    get nextAt() { return [...tasks.values()][0]?.due; },
    advance(ms: number) { clock += ms; fireDue(); },
    setClock(instant: string) { clock = Date.parse(instant); },
    fireTimerEarly() {
      const [id, task] = [...tasks.entries()][0];
      tasks.delete(id); task.callback();
    },
  };
}

test('start waits for the next aligned quarter and subsequent runs stay at :15, :30, :45 and :00', async () => {
  const h = harness();
  const schedule = createEstimateSchedule(h.options);
  assert.equal(h.pendingTimers, 0);
  schedule.start(); schedule.start();
  assert.deepEqual(h.runs, []);
  h.advance(8 * 60_000 - 1); await settle();
  assert.deepEqual(h.runs, []);
  h.advance(1); await settle();
  for (let index = 0; index < 3; index++) { h.advance(quarterMs); await settle(); }
  assert.deepEqual(h.runs, ['2026-10-25T19:15:00.000Z', '2026-10-25T19:30:00.000Z',
    '2026-10-25T19:45:00.000Z', '2026-10-25T20:00:00.000Z']);
  await schedule.stop();
});

test('start exactly at a boundary runs immediately without creating a duplicate cycle', async () => {
  const h = harness('2026-10-25T19:15:00Z');
  const schedule = createEstimateSchedule(h.options);
  schedule.start(); schedule.start(); await settle();
  assert.deepEqual(h.runs, ['2026-10-25T19:15:00.000Z']);
  assert.equal(h.nextAt, Date.parse('2026-10-25T19:30:00Z'));
  await schedule.stop();
});

test('an explicit initialization runs immediately but the next run returns to the wall-clock boundary', async () => {
  const h = harness();
  const schedule = createEstimateSchedule({ ...h.options, initializeImmediately: true });
  schedule.start(); await settle();
  assert.deepEqual(h.runs, ['2026-10-25T19:07:00.000Z']);
  h.advance(8 * 60_000); await settle();
  assert.equal(h.runs[1], '2026-10-25T19:15:00.000Z');
  await schedule.stop();
});

test('slow work skips missed quarters without overlapping or completion-relative drift', async () => {
  const h = harness('2026-10-25T19:15:00Z');
  const first = deferred();
  let active = 0, maxActive = 0;
  const schedule = createEstimateSchedule({ ...h.options, run: async at => {
    h.runs.push(at.toISOString()); active++; maxActive = Math.max(maxActive, active);
    if (h.runs.length === 1) await first.promise;
    active--;
  } });
  schedule.start();
  h.advance(40 * 60_000); await settle();
  assert.equal(h.runs.length, 1);
  assert.equal(h.pendingTimers, 0);
  first.resolve(); await settle();
  assert.equal(h.nextAt, Date.parse('2026-10-25T20:00:00Z'));
  h.advance(5 * 60_000); await settle();
  assert.deepEqual(h.runs, ['2026-10-25T19:15:00.000Z', '2026-10-25T20:00:00.000Z']);
  assert.equal(maxActive, 1);
  await schedule.stop();
});

test('a delayed timer uses the actual time and does not replay skipped boundaries', async () => {
  const h = harness();
  const schedule = createEstimateSchedule(h.options);
  schedule.start();
  h.advance(63 * 60_000 + 4000); await settle();
  assert.deepEqual(h.runs, ['2026-10-25T20:10:04.000Z']);
  assert.equal(h.nextAt, Date.parse('2026-10-25T20:15:00Z'));
  await schedule.stop();
});

test('clock rollback never reruns a completed slot or pulls work before its boundary', async () => {
  const h = harness('2026-10-25T19:15:00Z');
  const schedule = createEstimateSchedule(h.options);
  schedule.start(); await settle();
  h.setClock('2026-10-25T18:45:00Z'); h.fireTimerEarly(); await settle();
  assert.equal(h.runs.length, 1);
  assert.equal(h.nextAt, Date.parse('2026-10-25T19:30:00Z'));
  h.advance(45 * 60_000); await settle();
  assert.deepEqual(h.runs, ['2026-10-25T19:15:00.000Z', '2026-10-25T19:30:00.000Z']);
  await schedule.stop();
});

test('failed runs and failed error reporting do not prevent the next cycle', async () => {
  const h = harness('2026-10-25T19:15:00Z');
  const failure = new Error('calculation unavailable');
  const schedule = createEstimateSchedule({ ...h.options,
    run: async at => { h.runs.push(at.toISOString()); if (h.runs.length === 1) throw failure; },
    onError: error => { h.errors.push(error); throw new Error('reporter unavailable'); },
  });
  schedule.start(); await settle();
  assert.deepEqual(h.errors, [failure]);
  h.advance(quarterMs); await settle();
  assert.equal(h.runs.length, 2);
  await schedule.stop();
});

test('stop clears pending timers and permanently prevents a later start', async () => {
  const h = harness();
  const schedule = createEstimateSchedule(h.options);
  schedule.start();
  const stopped = schedule.stop();
  assert.equal(schedule.stop(), stopped);
  await stopped;
  schedule.start(); h.advance(quarterMs); await settle();
  assert.equal(h.pendingTimers, 0);
  assert.deepEqual(h.runs, []);
  const neverStarted = createEstimateSchedule(h.options);
  await neverStarted.stop(); neverStarted.start();
  assert.equal(h.pendingTimers, 0);
});

test('stop waits for an in-flight run and never rearms after it completes', async () => {
  const h = harness('2026-10-25T19:15:00Z');
  const work = deferred();
  const schedule = createEstimateSchedule({ ...h.options, run: async () => work.promise });
  schedule.start();
  let finished = false;
  const stopped = schedule.stop().then(() => { finished = true; });
  await settle();
  assert.equal(finished, false);
  work.resolve(); await stopped;
  assert.equal(finished, true);
  assert.equal(h.pendingTimers, 0);
});
