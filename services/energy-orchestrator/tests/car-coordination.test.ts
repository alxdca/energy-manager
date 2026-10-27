import test from 'node:test';
import assert from 'node:assert/strict';
import { createCarBatteryCoordinator } from '../src/car-coordination.js';
import type { AutomationControllerState } from '../src/automation.js';
import type { CarPlan } from '../src/car-types.js';

const plan = (allowBatteryCharge = true) => ({ source: 'grid', allowBatteryCharge,
  windowEndsAt: '2026-10-26T05:55:00.000Z' }) as CarPlan;
function fixture() {
  let evaluations = 0;
  let control: AutomationControllerState = { available: true, mode: 'manual', powerKw: 6, targetSocPercent: 80,
    automationMode: 'charge', automationOwner: 'owner', limits: { maxPowerKw: 7, maxSocPercent: 90 }, error: null };
  const coordinator = createCarBatteryCoordinator({
    readControl: async () => control, owns: owner => owner === 'owner', evaluate: async () => { evaluations++; },
  });
  return { coordinator, get evaluations() { return evaluations; },
    set(value: Partial<AutomationControllerState>) { control = { ...control, ...value }; } };
}
test('unchanged car safety ticks do not repeatedly evaluate or renew the battery plan', async () => {
  const f = fixture();
  for (let tick = 0; tick < 20; tick++) await f.coordinator.coordinate(plan(), () => true);
  assert.equal(f.evaluations, 1);
  f.set({ automationMode: 'hold', powerKw: 0 });
  await f.coordinator.coordinate(plan(false), () => true);
  assert.equal(f.evaluations, 2);
  for (let tick = 0; tick < 20; tick++) await f.coordinator.coordinate(plan(false), () => true);
  assert.equal(f.evaluations, 2);
  await f.coordinator.release();
  assert.equal(f.evaluations, 3);
});
test('missing preparation and external/manual ownership cannot be treated as a ready allocation', async () => {
  const f = fixture();
  f.set({ automationOwner: 'manual-other-owner' });
  await assert.rejects(f.coordinator.coordinate(plan(), () => true), /batterie maison/);
  assert.equal(f.evaluations, 1);
  f.set({ automationOwner: 'owner', mode: 'auto' });
  await assert.rejects(f.coordinator.coordinate(plan(), () => true), /batterie maison/);
  f.set({ mode: 'manual', automationMode: 'hold', powerKw: 0 });
  await f.coordinator.coordinate(plan(false), () => true);
});
test('an obsolete plan cannot force evaluation after a delayed control read', async () => {
  let current = true;
  let evaluated = false;
  const coordinator = createCarBatteryCoordinator({
    readControl: async () => { current = false; return {} as AutomationControllerState; },
    owns: () => true, evaluate: async () => { evaluated = true; },
  });
  await assert.rejects(coordinator.coordinate(plan(), () => current), /remplacé/);
  assert.equal(evaluated, false);
});

test('Eco night guard prepares bounded supply without confusing its power cap with forced charging', async () => {
  let evaluations = 0;
  let constraint = { active: true, allowCharge: false, until: '2026-10-26T06:00:00.000Z', guardNight: true,
    supply: { minimumSocPercent: 55, maxDischargeKw: 3 } as { minimumSocPercent: number; maxDischargeKw: number } | undefined };
  let control = { available: true, mode: 'manual', automationOwner: 'owner', automationMode: 'supply',
    powerKw: -3, minimumSocPercent: 55 } as AutomationControllerState;
  const coordinator = createCarBatteryCoordinator({ readConstraint: () => constraint,
    readControl: async () => control, evaluate: async () => { evaluations++; }, owns: value => value === 'owner' });
  const eco = { ...plan(false), source: 'eco' as const, action: 'eco' as const };
  await coordinator.coordinate(eco, () => true);
  for (let i = 0; i < 10; i++) await coordinator.coordinate(eco, () => true);
  assert.equal(evaluations, 1);
  constraint = { ...constraint, supply: undefined };
  control = { ...control, automationMode: 'hold', powerKw: 0 };
  await coordinator.coordinate(eco, () => true);
  assert.equal(evaluations, 2);
});
