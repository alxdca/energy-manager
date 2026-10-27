import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { buildPlannerDetails } from '../src/planner-details.js';
import { emptySolarForecast } from '../src/forecast.js';
import { estimateConsumption } from '../src/consumption.js';
import { loadAutomationConfig } from '../src/automation-config.js';
import type { AutomationStatus, AutomationControllerState } from '../src/automation.js';
import type { EstimateReader } from '../src/estimate-service.js';

function fixture() {
  const origin = '2026-10-24T13:00:00.000Z';
  const now = () => new Date(origin);
  let soc = 30;
  const calls: string[] = [];
  const config = loadAutomationConfig({ AUTOMATION_ENABLED: 'true' });
  const automation: AutomationStatus = { enabled: true, status: 'charging', reason: 'energy_shortfall',
    lastEvaluatedAt: origin, nextEvaluationAt: '2026-10-24T13:15:00.000Z', targetSocPercent: 40,
    holdUntil: null, plan: null, error: null };
  const telemetry = () => ({ status: 'online' as const, observedAt: origin, error: null, solarKw: 0,
    householdKw: 1, gridImportKw: 7, gridExportKw: 0, batterySocPercent: soc, batteryChargeKw: 6, batteryDischargeKw: 0 });
  const control: AutomationControllerState = { available: true, mode: 'manual', powerKw: 6, targetSocPercent: 40,
    limits: { maxPowerKw: 6, maxSocPercent: 90, reserveSocPercent: 5 }, revertTimeoutSeconds: 30, error: null };
  const consumption = estimateConsumption('2026-10-24', { baselinePowerW: 1000 });
  const solar = { ...emptySolarForecast('2026-10-24', null), status: 'online' as const, fetchedAt: origin,
    estimatedProductionKwh: 0, consumption,
    hourly: consumption.hourly.map(({ start, end }) => ({ start, end, estimatedProductionKwh: 0, temperatureC: 10 })),
    quarterHourly: consumption.quarterHourly.map(({ start, end }) => ({ start, end, estimatedProductionKwh: 0, temperatureC: 10 })) };
  // The writer calculates this once; the API receives only its published reader.
  const published = buildPlannerDetails(now(), telemetry(), control, automation, solar, config);
  let available = true;
  const estimates: EstimateReader = {
    planner: () => available ? structuredClone(published) : null,
    projection: () => ({ status: 'unavailable', reason: 'disabled', assumption: 'automatic_planning', observedAt: null, points: [] }),
    status: () => ({ calculatedAt: origin, nextEvaluationAt: '2026-10-24T13:15:00.000Z' }),
  };
  const api = createApi({ controllerUrl: 'http://controller.test', now, automationConfig: config,
    automationStatus: () => automation, estimates, telemetryReader: async () => telemetry(), displayTelemetryReader: async () => telemetry(),
    forecastStore: { async readForecast() { throw new Error('Planner GET must not read or calculate forecasts'); } },
    fetch: async (input, init) => {
      assert.equal(init?.method, 'GET', 'Planner reads must not command the controller');
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/wattpilot/status') return Response.json({ success: true, wattpilot: {
        status: 'not_configured', configured: false, connected: false, ready: false, stale: false,
        observedAt: null, powerObservedAt: null, error: null, controlEnabled: false, mode: 'unknown',
        carConnected: null, charging: null, allowedCharging: null, currentAmps: null, powerWatts: null,
        sessionEnergyWh: null, totalEnergyWh: null, limits: { minCurrentAmps: 6, maxCurrentAmps: null }, deviceLeaseSupported: false,
      } });
      assert.equal(path, '/inverter/control-status');
      return Response.json({ success: true, control: { enabled: true, active: true, watts: 6000,
        targetSocPercent: 40, expiresAt: '2026-10-24T13:10:00.000Z' },
      capabilities: { automationCharge: true, automationHold: true },
      limits: { maxPowerWatts: 6000, minSocPercent: 0, maxSocPercent: 90, reserveSocPercent: 5, revertTimeoutSeconds: 30 } });
    },
  });
  return { api, published, calls, setSoc: (value: number) => { soc = value; }, invalidate: () => { available = false; } };
}

test('planner returns the published calculation and refreshes only measured battery state', async () => {
  const f = fixture();
  const first = await (await f.api.request('/api/planner')).json();
  assert.deepEqual(first.planner.highTariff, f.published.highTariff);
  assert.deepEqual(first.planner.chargeBreakdown, f.published.chargeBreakdown);
  assert.equal(first.planner.battery.socPercent, 30);
  assert.equal(first.planner.battery.storedKwh, 18);
  assert.equal(first.planner.battery.targetSocPercent, 40);
  f.setSoc(40);
  const response = await f.api.request('/api/planner');
  const later = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(later.planner.battery.socPercent, 40);
  assert.deepEqual(later.planner.highTariff, first.planner.highTariff);
  assert.deepEqual(later.planner.chargeBreakdown, first.planner.chargeBreakdown);
  assert.deepEqual(f.calls, ['/inverter/control-status', '/wattpilot/status']);
  assert.equal(later.automation.lastEvaluatedAt, '2026-10-24T13:00:00.000Z');
  assert.equal((await f.api.request('/api/planner', { method: 'POST' })).status, 404);
});

test('manual invalidation removes the published plan without calculating a replacement', async () => {
  const f = fixture(); f.invalidate();
  const body = await (await f.api.request('/api/planner')).json();
  assert.equal(body.planner.calculation.plan, null);
  assert.equal(body.planner.highTariff, undefined);
  assert.equal(body.planner.chargeBreakdown, undefined);
  assert.equal(body.planner.battery.socPercent, 30);
});

test('planner without a published reader stays unknown and never invokes provider fallbacks', async () => {
  let reads = 0;
  const api = createApi({ controllerUrl: null,
    forecast: { config: null, fetch: async () => { reads++; throw new Error('No fallback weather'); } },
    forecastStore: { async readForecast() { reads++; throw new Error('No unpublished planner calculation'); } },
  });
  const body = await (await api.request('/api/planner')).json();
  assert.equal(body.planner.calculation.plan, null);
  assert.equal(body.planner.highTariff, undefined);
  assert.equal(reads, 0);
});
