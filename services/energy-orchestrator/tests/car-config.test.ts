import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCarAutomationConfig } from '../src/car-config.js';

test('car defaults preserve the75kWh estimate and bounded supervision/wake intervals', () => {
  assert.deepEqual(loadCarAutomationConfig({}), { capacityKwh: 75, chargingEfficiency: .9, maxCurrentAmps: 16,
    socFreshnessMs: 600_000, leaseSeconds: 90, wakeCooldownMs: 900_000 });
  assert.equal(loadCarAutomationConfig({ CAR_AUTOMATION_MAX_CURRENT_AMPS: '10' }).maxCurrentAmps, 10);
});

test('invalid capacities, loss factors, currents and supervision bounds are rejected', () => {
  for (const [key, values] of [
    ['CAR_AUTOMATION_CAPACITY_KWH', ['0', '-1', 'Infinity', '250.1', '0x20']],
    ['CAR_AUTOMATION_EFFICIENCY', ['0', '1.01', 'NaN']],
    ['CAR_AUTOMATION_MAX_CURRENT_AMPS', ['5', '17', '6.5']],
    ['CAR_AUTOMATION_SOC_FRESHNESS_SECONDS', ['29', '601']],
    ['CAR_AUTOMATION_LEASE_SECONDS', ['0', '121']],
    ['CAR_AUTOMATION_WAKE_COOLDOWN_SECONDS', ['0', '899']],
  ] as const) for (const value of values) assert.throws(() => loadCarAutomationConfig({ [key]: value }), new RegExp(key));
});
