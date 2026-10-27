import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlsService } from '../src/controls.js';
import { loadAutomationConfig } from '../src/automation-config.js';
import { createApi } from '../src/api.js';
import { unavailableWattpilot } from '../src/wattpilot.js';
import type { BatteryChargeEstimate } from '../src/charge-estimate.js';

const now = () => new Date('2026-10-24T13:30:00Z');
const owner = 'test-owner';

test('scheduled ETA publication retains learned progress across unchanged automatic charge renewals', async () => {
  const origin = now().getTime();
  let clock = origin;
  let target = 80;
  let powerKw = 6;
  let acknowledged = true;
  let published: BatteryChargeEstimate | null = null;
  const service = createControlsService({ controllerUrl: 'http://controller.test', now: () => new Date(clock),
    readPublishedChargeEstimate: () => published,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/control-status')) return Response.json({ success: true,
        control: { enabled: true, active: true, watts: powerKw * 1000, targetSocPercent: target,
          automationOwner: owner, automationMode: 'charge' },
        capabilities: { automationCharge: true, automationHold: true },
        limits: { maxPowerWatts: 6000, minSocPercent: 0, maxSocPercent: 100, reserveSocPercent: 5 } });
      assert.equal(path, '/inverter/automation-charge');
      const body = JSON.parse(String(init?.body));
      target = body.targetSocPercent;
      powerKw = body.powerWatts / 1000;
      return Response.json({ success: acknowledged, control: { active: true, automationOwner: owner } });
    },
  }, async () => ({ status: 'online', observedAt: new Date(clock).toISOString(), error: null,
    solarKw: 0, householdKw: 1, gridImportKw: 7, gridExportKw: 0,
    batterySocPercent: 40 + (clock - origin) / 60_000 * .1, batteryChargeKw: powerKw, batteryDischargeKw: 0 }));
  const sample = () => service.readStatus({ includeCar: false });
  const calculate = async () => (await service.readStatus({ liveEstimate: true, includeCar: false })).battery.chargeEstimate;
  const renew = (nextTarget = target, nextPower = powerKw) => service.automationController.charge(
    owner, nextTarget, new Date(clock + 16 * 60_000).toISOString(), () => true, nextPower);

  published = await calculate();
  assert.equal(published.status, 'estimating');
  for (let quarter = 1; quarter <= 2; quarter++) {
    for (let second = 5; second <= 900; second += 5) {
      clock = origin + ((quarter - 1) * 900 + second) * 1000;
      await sample();
    }
    // The estimate coordinator renews automation before capturing its publication.
    await renew();
    published = await calculate();
    assert.equal(published.status, 'available');
    assert.ok(published.remainingMinutes! > 0);
    assert.ok(Date.parse(published.estimatedCompletionAt!) > clock);
    assert.deepEqual((await sample()).battery.chargeEstimate, published);
  }

  await renew(85);
  assert.equal((await calculate()).status, 'estimating', 'A new target restarts learning');
  for (let second = 5; second <= 120; second += 5) { clock += 5000; await sample(); }
  assert.equal((await calculate()).status, 'available');
  await renew(target, 5);
  assert.equal((await calculate()).status, 'estimating', 'A new power restarts learning');
  for (let second = 5; second <= 120; second += 5) { clock += 5000; await sample(); }
  assert.equal((await calculate()).status, 'available');
  acknowledged = false;
  await assert.rejects(renew());
  assert.equal((await calculate()).status, 'estimating', 'A failed renewal retires the learned trend');
});

function fixture() {
  const calls: Array<{ path: string; body: any }> = [];
  const overrides: boolean[] = [];
  let active: Record<string, unknown> = {};
  let limit = 6000;
  let grid = 1000;
  let timestamp = now().toISOString();
  let acknowledged = true;
  const service = createControlsService({ controllerUrl: 'http://controller.test', now,
    automation: { enabled: () => true, owns: value => value === owner,
      async setManualOverride(value) { overrides.push(value); } },
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      if (path.endsWith('/wattpilot/status')) return Response.json({ success: true, wattpilot: unavailableWattpilot() });
      if (path.endsWith('control-status')) return Response.json({ success: true,
        control: { enabled: true, active: false, ...active }, capabilities: { automationCharge: true, automationHold: true },
        limits: { maxPowerWatts: limit, minSocPercent: 0, maxSocPercent: 90, revertTimeoutSeconds: 30, reserveSocPercent: 5 } });
      if (path.endsWith('system/status')) return Response.json({ success: true, timestamp, site: { P_Grid: grid, P_Akku: 0, P_Load: -grid }, battery: null });
      return Response.json({ success: acknowledged, control: { active: true, automationOwner: owner,
        automationMode: path.endsWith('automation-hold') ? 'hold' : 'charge' } });
    },
  });
  return { service, calls, overrides, setActive(value: Record<string, unknown>) { active = value; },
    setLimit(value: number) { limit = value; }, setGrid(value: number) { grid = value; },
    setTimestamp(value: string) { timestamp = value; }, setAck(value: boolean) { acknowledged = value; },
    post(body: unknown) { return service.api.request('/battery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } };
}

test('automation config requires explicit enablement and validates capacity/reserve', () => {
  assert.deepEqual(loadAutomationConfig({}), { enabled: false, socCapacityKwh: 60, reserveSocPercent: 5, energyBufferPercent: 5, minimumEnergyBufferKwh: 1, afternoonTargetSocPercent: 80 });
  assert.equal(loadAutomationConfig({ AUTOMATION_ENABLED: 'true' }).enabled, true);
  for (const value of [0, 80, 100]) assert.equal(loadAutomationConfig({ AUTOMATION_AFTERNOON_TARGET_SOC_PERCENT: String(value) }).afternoonTargetSocPercent, value);
  assert.equal(loadAutomationConfig({ AUTOMATION_ENERGY_BUFFER_PERCENT: '10' }).energyBufferPercent, 10);
  assert.equal(loadAutomationConfig({ AUTOMATION_ENERGY_BUFFER_MIN_KWH: '1.5' }).minimumEnergyBufferKwh, 1.5);
  for (const [key, values] of [
    ['AUTOMATION_ENERGY_BUFFER_PERCENT', ['-1', 'NaN', 'Infinity', '101']],
    ['AUTOMATION_AFTERNOON_TARGET_SOC_PERCENT', ['-1', 'NaN', 'Infinity', '101']],
    ['AUTOMATION_ENERGY_BUFFER_MIN_KWH', ['-1', 'NaN', 'Infinity', '61']],
  ] as const) {
    for (const value of values) assert.throws(() => loadAutomationConfig({ [key]: value }));
  }
  for (const reserve of ['0', '4']) {
    assert.equal(loadAutomationConfig({ AUTOMATION_RESERVE_SOC_PERCENT: reserve }).reserveSocPercent, 5);
  }
  assert.equal(loadAutomationConfig({ AUTOMATION_RESERVE_SOC_PERCENT: '10' }).reserveSocPercent, 10);
  for (const env of [{ AUTOMATION_ENABLED: 'yes' }, { AUTOMATION_SOC_CAPACITY_KWH: '0' },
    { AUTOMATION_SOC_CAPACITY_KWH: 'NaN' }, { AUTOMATION_SOC_CAPACITY_KWH: '1e4' },
    { AUTOMATION_RESERVE_SOC_PERCENT: '-1' }, { AUTOMATION_RESERVE_SOC_PERCENT: '100' }]) assert.throws(() => loadAutomationConfig(env));
});

test('internal automation sends a guarded owned 6 kW lease after fresh limits and grid checks', async () => {
  const f = fixture();
  const expiresAt = '2026-10-24T13:46:00.000Z';
  await f.service.automationController.charge(owner, 35, expiresAt, () => true);
  assert.deepEqual(f.calls.map(call => call.path), ['/inverter/control-status', '/system/status', '/wattpilot/status', '/inverter/automation-charge']);
  assert.deepEqual(f.calls.at(-1)!.body, { powerWatts: 6000, targetSocPercent: 35, expiresAt, owner });
  assert.deepEqual(f.overrides, []);
});

test('an owned charge can reduce power above the site ceiling without releasing control', async () => {
  const f = fixture();
  const expiresAt = '2026-10-24T13:46:00.000Z';
  f.setActive({ active: true, watts: 6000, automationOwner: owner, automationMode: 'charge' });
  f.setGrid(17_000);
  await f.service.automationController.charge(owner, 35, expiresAt, () => true, 3.2);
  assert.deepEqual(f.calls.map(call => call.path), ['/inverter/control-status', '/inverter/automation-charge']);
  assert.deepEqual(f.calls.at(-1)!.body, { powerWatts: 3200, targetSocPercent: 35, expiresAt, owner });
  assert.deepEqual(f.overrides, []);
});

test('a reduced-power command cannot take over manual or foreign battery control', async () => {
  for (const automationOwner of [undefined, 'another-owner']) {
    const f = fixture();
    f.setActive({ active: true, watts: 6000, automationOwner, automationMode: 'charge' });
    f.setGrid(17_000);
    await assert.rejects(f.service.automationController.charge(owner, 35,
      '2026-10-24T13:46:00.000Z', () => true, 3.2), /commande manuelle/);
    assert.ok(f.calls.every(call => call.body === null));
  }
});

test('power increases and charge-from-hold still require fresh site headroom', async () => {
  for (const [watts, automationMode] of [[3000, 'charge'], [0, 'hold']] as const) {
    const f = fixture();
    f.setActive({ active: true, watts, automationOwner: owner, automationMode });
    f.setGrid(17_000);
    await assert.rejects(f.service.automationController.charge(owner, 35,
      '2026-10-24T13:46:00.000Z', () => true, 3.2), /16 kW/);
    assert.ok(f.calls.some(call => call.path === '/system/status'));
    assert.ok(f.calls.every(call => call.body === null));
  }
});

test('automatic charging rejects zero, above-ceiling and fractional-watt power before writing', async () => {
  for (const powerKw of [0, -1, 6.001, .1005, NaN, Infinity]) {
    const f = fixture();
    f.setActive({ active: true, watts: 6000, automationOwner: owner, automationMode: 'charge' });
    await assert.rejects(f.service.automationController.charge(owner, 35,
      '2026-10-24T13:46:00.000Z', () => true, powerKw), /puissance automatique/);
    assert.ok(f.calls.every(call => call.body === null));
  }
});

test('preserving energy uses an owned hold without a forced charging setpoint or six-kilowatt headroom', async () => {
  const f = fixture();
  f.setGrid(12_000);
  await f.service.automationController.hold(owner, '2026-10-24T13:46:00.000Z', () => true);
  assert.deepEqual(f.calls.map(call => call.path), ['/inverter/control-status', '/system/status', '/inverter/automation-hold']);
  assert.deepEqual(f.calls.at(-1)!.body, { expiresAt: '2026-10-24T13:46:00.000Z', owner });
  assert.deepEqual(f.overrides, []);
});

test('an owned supply can become a protective hold even when raw site telemetry is unavailable', async () => {
  const f = fixture();
  f.setActive({ active: true, watts: -2000, automationOwner: owner, automationMode: 'supply', minimumSocPercent: 50 });
  f.setTimestamp('invalid');
  await f.service.automationController.hold(owner, '2026-10-24T13:46:00.000Z', () => true);
  assert.deepEqual(f.calls.map(call => call.path), ['/inverter/control-status', '/inverter/automation-hold']);
});

test('hold cannot replace manual control, exceed grid headroom or apply an obsolete decision', async () => {
  for (const kind of ['manual', 'grid', 'obsolete']) {
    const f = fixture();
    if (kind === 'manual') f.setActive({ active: true, watts: 3000 });
    if (kind === 'grid') f.setGrid(17_000);
    await assert.rejects(f.service.automationController.hold(owner, '2026-10-24T13:46:00.000Z', () => kind !== 'obsolete'));
    assert.ok(f.calls.every(call => call.body === null));
  }
});

test('internal automation rejects foreign control, insufficient headroom, stale data and obsolete plans', async () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => f.setActive({ active: true, watts: 3000 }),
    (f: ReturnType<typeof fixture>) => f.setLimit(5000),
    (f: ReturnType<typeof fixture>) => f.setGrid(10_500),
    (f: ReturnType<typeof fixture>) => f.setTimestamp('2026-10-24T13:29:40Z'),
  ];
  for (const setup of cases) {
    const f = fixture(); setup(f);
    await assert.rejects(f.service.automationController.charge(owner, 35, '2026-10-24T13:46:00.000Z', () => true));
    assert.ok(f.calls.every(call => call.body === null));
  }
  const f = fixture();
  await assert.rejects(f.service.automationController.charge(owner, 35, '2026-10-24T13:46:00.000Z', () => false));
  assert.ok(f.calls.every(call => call.body === null));
});

test('manual commands pause automation, while only acknowledged Auto resumes it', async () => {
  const f = fixture();
  assert.equal((await f.post({ mode: 'manual', powerKw: 3 })).status, 200);
  assert.deepEqual(f.overrides, [true]);
  f.setAck(false);
  assert.equal((await f.post({ mode: 'auto' })).status, 502);
  assert.deepEqual(f.overrides, [true]);
  f.setAck(true);
  const result = await f.post({ mode: 'auto' });
  assert.equal(result.status, 200);
  assert.match((await result.json()).message, /automatique.*repris/);
  assert.deepEqual(f.overrides, [true, false]);
});

test('owned automation remains distinct from manual control in API snapshots', async () => {
  const f = fixture();
  f.setActive({ active: true, watts: 6000, targetSocPercent: 35, automationOwner: owner, expiresAt: '2026-10-24T13:46:00.000Z' });
  const status = await f.service.readStatus();
  assert.equal(status.battery.automated, true);
  assert.equal(status.automationEnabled, true);
  assert.equal(status.battery.automationSupported, true);
  assert.equal(status.battery.revertTimeoutSeconds, 30);
});

test('health and status expose an injected running planner without starting another loop', async () => {
  const state = { enabled: true, status: 'charging' as const, lastEvaluatedAt: now().toISOString(),
    nextEvaluationAt: '2026-10-24T13:45:00Z', targetSocPercent: 35, reason: 'energy_shortfall', plan: null, error: null, holdUntil: null };
  const api = createApi({ controllerUrl: null, forecast: { config: null }, automationStatus: () => state });
  assert.equal((await (await api.request('/health')).json()).automationEnabled, true);
  const status = await (await api.request('/api/status')).json();
  assert.deepEqual(status.automation, state);
  assert.equal(status.integrations.planner, 'active');
});
