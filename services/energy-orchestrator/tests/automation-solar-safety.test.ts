import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation, type AutomationControllerState } from '../src/automation.js';
import { loadAutomationConfig } from '../src/automation-config.js';
import type { Telemetry } from '../src/status.js';

for (const fails of [false, true]) {
  test(`unknown night telemetry attempts an owned hold without releasing supply${fails ? ' even when hold fails' : ''}`, async t => {
    const now = () => new Date('2026-10-25T23:10:00+01:00');
    const calls: string[] = [];
    let control: AutomationControllerState = { available: true, mode: 'manual', powerKw: -2, targetSocPercent: null,
      automationOwner: 'owner', automationMode: 'supply', minimumSocPercent: 50,
      automationSupported: true, automationHoldSupported: true, automationSupplySupported: true,
      expiresAt: '2026-10-25T22:25:00.000Z', revertTimeoutSeconds: 30,
      limits: { maxPowerKw: 6, maxSocPercent: 90, reserveSocPercent: 5 }, error: null };
    const runner = createAutomation({ now, config: loadAutomationConfig({ AUTOMATION_ENABLED: 'true' }),
      state: { owner: 'owner', manualOverride: false, error: null, async setManualOverride() {} },
      controller: { read: async () => control,
        async hold() {
          calls.push('hold');
          if (fails) throw new Error('Hold is not confirmed');
          control = { ...control, automationMode: 'hold', powerKw: 0 };
        },
        async charge() { assert.fail('Unknown telemetry cannot start charging'); },
        async stop() { calls.push('stop->normal'); control = { ...control, mode: 'auto' }; },
      },
      readTelemetry: async () => ({ status: 'offline', observedAt: null, error: 'meter unavailable',
        solarKw: null, householdKw: null, gridImportKw: null, gridExportKw: null,
        batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null }) as Telemetry,
      readForecast: async () => { throw new Error('Unknown telemetry must be handled before weather planning'); },
      readCarConstraint: () => ({ active: true, allowCharge: false, guardNight: true,
        until: '2026-10-26T06:00:00.000Z', supply: { minimumSocPercent: 50, maxDischargeKw: 2 } }),
      setTimer: () => 1, clearTimer() {},
    });
    t.after(() => runner.stop());
    runner.start();
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['hold']);
    assert.equal(control.automationMode, fails ? 'supply' : 'hold');
    assert.equal(runner.status().reason, fails ? 'protective_hold_unavailable' : 'solar_budget_protected');
  });
}
