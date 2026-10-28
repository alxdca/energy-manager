import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCarAutomationState } from '../src/car-automation-state.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'car-planning-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'car.json');
}

test('first deployment is private manual mode and only a persisted session can enable Auto', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  assert.equal(state.manualOverride, true);
  assert.equal(state.epoch, null);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(state.setManualOverride(false), /session/);
  await state.setSession('test-epoch', 0);
  await state.setManualOverride(false);
  await state.setSession('test-epoch', 2);
  const restored = await createCarAutomationState(path);
  assert.equal(restored.owner, state.owner);
  assert.equal(restored.manualOverride, false);
  assert.equal(restored.epoch, 'test-epoch');
  assert.equal(restored.revision, 2);
  await assert.rejects(state.setSession('test-epoch', 1), /Session/);
});

test('manual intent changes memory synchronously and serialized writes preserve the latest decision', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  await state.setSession('epoch', 0);
  const auto = state.setManualOverride(false);
  const manual = state.setManualOverride(true);
  assert.equal(state.manualOverride, true);
  await Promise.all([auto, manual]);
  assert.equal((await createCarAutomationState(path)).manualOverride, true);
});

test('targets/checkpoints survive restart and getters do not expose mutable state', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  await state.setTargetOverride({ deadline: '2026-10-26T05:00:00.000Z', targetSocPercent: 70 });
  await state.setCheckpoint({ date: '2026-10-25', targetSocPercent: 60, observedSocPercent: 55,
    result: 'missed', recordedAt: '2026-10-25T06:00:00.000Z', kind: 'morning' });
  state.targetOverride!.targetSocPercent = 10;
  state.lastCheckpoint!.result = 'met';
  const restored = await createCarAutomationState(path);
  assert.equal(restored.targetOverride!.targetSocPercent, 70);
  assert.equal(restored.lastCheckpoint!.result, 'missed');
  await assert.rejects(state.setCheckpoint({ date: '2026-02-30', targetSocPercent: 60, observedSocPercent: null,
    result: 'unknown', recordedAt: '2026-10-25T06:00:00.000Z', kind: 'morning' }), /Bilan/);
});

test('completed targets survive restart, remain private copies and can be cleared for a full recharge', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  const completed = { deadline: '2026-10-27T05:55:00.000Z', targetSocPercent: 50 };
  await state.setCompletedTarget(completed);
  completed.targetSocPercent = 10;
  state.completedTarget!.targetSocPercent = 20;
  const restored = await createCarAutomationState(path);
  assert.equal(restored.completedTarget?.targetSocPercent, 50);
  await assert.rejects(restored.setCompletedTarget({ ...completed, targetSocPercent: NaN }), /invalide/);
  await restored.setCompletedTarget(null);
  assert.equal((await createCarAutomationState(path)).completedTarget, null);
});

test('existing version-1 state loads without completion tracking and persists the new field', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  await state.setSession('epoch', 2);
  await state.setManualOverride(false);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.completedTarget;
  await writeFile(path, JSON.stringify(saved));
  const restored = await createCarAutomationState(path);
  assert.equal(restored.error, null);
  assert.equal(restored.manualOverride, false);
  assert.equal(restored.revision, 2);
  assert.equal(restored.completedTarget, null);
  await restored.setCompletedTarget({ deadline: '2026-10-27T05:55:00.000Z', targetSocPercent: 50 });
  assert.equal((await createCarAutomationState(path)).completedTarget?.targetSocPercent, 50);
});

test('invalid persisted completion tracking blocks automatic state', async t => {
  const path = await fixture(t);
  await createCarAutomationState(path);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.completedTarget = { deadline: 'invalid', targetSocPercent: 50 };
  const bytes = JSON.stringify(saved);
  await writeFile(path, bytes);
  const restored = await createCarAutomationState(path);
  assert.ok(restored.error);
  assert.equal(restored.manualOverride, true);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('corrupt state is preserved and cannot invent automatic ownership', async t => {
  const path = await fixture(t);
  const corrupt = '{"version":99,"manualOverride":false}';
  await writeFile(path, corrupt);
  const state = await createCarAutomationState(path);
  assert.ok(state.error);
  assert.equal(state.manualOverride, true);
  await assert.rejects(state.setSession('epoch', 0), /persistant/);
  assert.equal(await readFile(path, 'utf8'), corrupt);
});

test('morning and afternoon checkpoint kinds persist across restart', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  await state.setCheckpoint({ date: '2026-10-26', targetSocPercent: 60, observedSocPercent: 60,
    result: 'met', recordedAt: '2026-10-26T06:00:00.000Z', kind: 'morning' });
  assert.equal((await createCarAutomationState(path)).lastCheckpoint?.kind, 'morning');
  await state.setCheckpoint({ date: '2026-10-26', targetSocPercent: 30, observedSocPercent: 30,
    result: 'met', recordedAt: '2026-10-26T15:55:00.000Z', kind: 'afternoon' });
  const restored = await createCarAutomationState(path);
  assert.equal(restored.lastCheckpoint?.kind, 'afternoon');
  assert.equal(restored.lastCheckpoint?.targetSocPercent, 30);
  await assert.rejects(state.setCheckpoint({ ...restored.lastCheckpoint!, kind: 'night' as 'morning' }), /Bilan/);
});

test('checkpoints require an explicit kind for writes and persisted state', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  await state.setSession('epoch', 0);
  await state.setManualOverride(false);
  await state.setCheckpoint({ date: '2026-10-26', targetSocPercent: 60, observedSocPercent: 60,
    result: 'met', recordedAt: '2026-10-26T06:00:00.000Z', kind: 'morning' });
  const saved = await readFile(path, 'utf8');
  const invalid = JSON.parse(saved);
  delete invalid.lastCheckpoint.kind;
  await assert.rejects(state.setCheckpoint(invalid.lastCheckpoint), /Bilan/);
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.equal(state.lastCheckpoint?.kind, 'morning');

  const bytes = JSON.stringify(invalid);
  await writeFile(path, bytes);
  const restored = await createCarAutomationState(path);
  assert.ok(restored.error);
  assert.equal(restored.manualOverride, true);
  assert.equal(restored.epoch, null);
  assert.equal(restored.lastCheckpoint, null);
  await assert.rejects(restored.setSession('epoch', 0), /persistant/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('persistence failures block automatic state without rejecting the immediate manual intent', async t => {
  const path = await fixture(t);
  const state = await createCarAutomationState(path);
  await rm(path);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path);
  const pending = state.setManualOverride(true);
  assert.equal(state.manualOverride, true);
  await assert.rejects(pending, /persistant/);
  assert.ok(state.error);
});
