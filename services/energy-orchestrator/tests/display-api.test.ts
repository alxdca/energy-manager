import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.js';
import { createTelemetryReader, type Telemetry } from '../src/status.js';

test('dashboard default wiring averages three fresh controller samples and keeps direct reads raw', async () => {
  const samples = [
    { pv: 1, load: -900, grid: 3000, battery: -3000, soc: 20 },
    { pv: 4, load: -1200, grid: -6000, battery: 6000, soc: 23 },
    { pv: 10, load: -1500, grid: 3000, battery: -3000, soc: 26 },
  ];
  const starts: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, options) => {
    assert.equal(options?.method, 'GET');
    if (new URL(String(input)).pathname.endsWith('/control-status')) {
      return Response.json({ success: true, control: { enabled: false, active: false } });
    }
    assert.equal(new URL(String(input)).pathname, '/system/status');
    const sample = samples[Math.min(starts.length, samples.length - 1)];
    starts.push(Date.now());
    return Response.json({ success: true, timestamp: new Date().toISOString(),
      site: { P_PV: sample.pv, P_Load: sample.load, P_Grid: sample.grid, P_Akku: sample.battery },
      battery: { socPercent: sample.soc, validValues: ['soc'] } });
  };
  const telemetry = createTelemetryReader({ controllerUrl: 'http://controller.test', fetch });
  const api = createApi({ controllerUrl: 'http://controller.test', fetch, telemetryReader: telemetry,
    forecast: { config: null } });
  const response = await api.request('/api/status');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { telemetry: average } = await response.json();
  assert.equal(starts.length, 3, 'control and display reads share only the first in-flight sample');
  assert.ok(starts[1] - starts[0] >= 1050 && starts[2] - starts[1] >= 1050,
    'sample starts are separated by 1.1 seconds');
  assert.ok(Math.abs(average.solarKw - 0.005) < 1e-12);
  assert.equal(average.householdKw, 1.2);
  assert.equal(average.batterySocPercent, 23);
  for (const field of ['gridImportKw', 'gridExportKw', 'batteryChargeKw', 'batteryDischargeKw']) {
    assert.equal(average[field], 0, field);
  }
  const raw = await telemetry();
  assert.equal(starts.length, 4);
  assert.equal(raw.solarKw, 0.01);
  assert.equal(raw.batterySocPercent, 26);
});

test('status and planner views use the display reader while controls retain raw telemetry', async () => {
  const timestamp = '2026-10-24T13:00:00.000Z';
  const raw: Telemetry = { status: 'online', observedAt: timestamp, error: null,
    solarKw: 1, householdKw: 2, gridImportKw: 1, gridExportKw: 0,
    batterySocPercent: 80, batteryChargeKw: 0, batteryDischargeKw: 0 };
  let displayReads = 0;
  let rawReads = 0;
  const api = createApi({ controllerUrl: null, now: () => new Date(timestamp), forecast: { config: null },
    telemetryReader: async () => { rawReads++; return raw; },
    displayTelemetryReader: async () => { displayReads++; return { ...raw, solarKw: 3, batterySocPercent: 23 }; },
  });
  const status = await (await api.request('/api/status')).json();
  assert.equal(status.telemetry.solarKw, 3);
  assert.equal(status.telemetry.batterySocPercent, 23);
  const planner = await (await api.request('/api/planner')).json();
  assert.equal(planner.telemetry.batterySocPercent, 23);
  assert.ok(Math.abs(planner.planner.battery.storedKwh - 13.8) < 1e-12);
  assert.equal(displayReads, 2);
  assert.equal(rawReads, 2, 'each controls snapshot reads raw telemetry independently of display smoothing');
  await api.request('/api/controls');
  assert.equal(displayReads, 2, 'control status does not initiate a display sampling batch');
  assert.equal(rawReads, 3);
});
