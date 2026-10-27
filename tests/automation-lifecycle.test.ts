import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation, type AutomationOptions } from '../services/energy-orchestrator/src/automation.js';
import { createControlsService } from '../services/energy-orchestrator/src/controls.js';
import { estimateConsumption } from '../services/energy-orchestrator/src/consumption.js';
import { getCalendarDayBounds, getLocalDate } from '../services/energy-orchestrator/src/policy.js';
import type { Telemetry } from '../services/energy-orchestrator/src/status.js';
import { unavailableWattpilot } from '../services/energy-orchestrator/src/wattpilot.js';
import type { CarBatteryConstraint } from '../services/energy-orchestrator/src/car-types.js';
import { FroniusInverter } from '../services/energy-controller/src/devices/fronius-inverter.js';
import { FroniusModbus } from '../services/energy-controller/src/devices/fronius-modbus.js';
import { FakeTransport, STORAGE, control } from '../services/energy-controller/tests/helpers/fake-fronius.js';

async function fixture(origin: string, soc = 72.79, latency = { readMs: 0, writeMs: 0 }) {
  let clock = Date.parse(origin);
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const setTimer = (callback: () => void, delay: number) => {
    const id = ++nextId;
    timers.set(id, { at: clock + delay, callback });
    return id;
  };
  const clearTimer = (id: unknown) => { timers.delete(id as number); };
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const now = () => new Date(clock);
  const transport = new FakeTransport();
  const writes: { at: number; address: number; value: number }[] = [];
  const writeRegister = transport.writeRegister.bind(transport);
  transport.writeRegister = async (address, value) => {
    writes.push({ at: clock, address, value });
    await writeRegister(address, value);
  };
  transport.memory.set(STORAGE + 7, 500);
  transport.memory.set(STORAGE + 8, Math.round(soc * 100));
  const policy = { ...control, maxPowerWatts: 6000 };
  const modbus = new FroniusModbus('offline.invalid', 502, 1, 'int', {
    client: transport, control: policy, now: () => clock,
  });
  const inverter = new FroniusInverter('offline.invalid', 80, {
    modbus, readSiteLoadWatts: async () => 1000, now: () => clock, setTimer, clearTimer,
  });
  const commands: { path: string; at: number; expiresAt?: string }[] = [];
  const telemetry = async (): Promise<Telemetry> => ({
    status: 'online', observedAt: now().toISOString(), error: null, solarKw: 0, householdKw: 1,
    gridImportKw: inverter.getControlStatus().automationMode === 'charge' ? 7 : 1,
    gridExportKw: 0, batterySocPercent: soc,
    batteryChargeKw: inverter.getControlStatus().automationMode === 'charge' ? 6 : 0, batteryDischargeKw: 0,
  });
  const controls = createControlsService({ controllerUrl: 'http://controller.invalid', now,
    fetch: async (input, init) => {
      const { origin, pathname } = new URL(String(input));
      assert.equal(origin, 'http://controller.invalid', 'all device I/O must use the fake transport');
      const delay = init?.method === 'POST' ? latency.writeMs : latency.readMs;
      if (delay) await new Promise<void>(resolve => setTimer(resolve, delay));
      if (pathname === '/wattpilot/status') return Response.json({ success: true, wattpilot: unavailableWattpilot() });
      if (pathname === '/inverter/control-status') {
        const reserveSocPercent = await inverter.getAutomationReserve();
        return Response.json({ success: true, control: inverter.getControlStatus(),
          capabilities: { automationCharge: true, automationHold: true },
          limits: { maxPowerWatts: 6000, minSocPercent: 0, maxSocPercent: 90, revertTimeoutSeconds: 30, reserveSocPercent } });
      }
      if (pathname === '/system/status') {
        const charging = inverter.getControlStatus().automationMode === 'charge';
        return Response.json({ success: true, timestamp: now().toISOString(),
          site: { P_Grid: charging ? 7000 : 1000, P_Akku: charging ? -6000 : 0, P_Load: -1000 } });
      }
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      commands.push({ path: pathname, at: clock, expiresAt: body.expiresAt });
      if (pathname === '/inverter/automation-charge') await inverter.setAutomationCharge(body.powerWatts, body.targetSocPercent, body.expiresAt, body.owner);
      else if (pathname === '/inverter/automation-hold') await inverter.setAutomationHold(body.expiresAt, body.owner);
      else if (pathname === '/inverter/automation-stop') await inverter.stopAutomationCharge(body.owner);
      else assert.fail(`Unexpected controller command: ${pathname}`);
      return Response.json({ success: true, control: inverter.getControlStatus() });
    },
  }, telemetry);
  const state: AutomationOptions['state'] = { owner: 'lifecycle-test', manualOverride: false, error: null,
    async setManualOverride(value) { Object.assign(state, { manualOverride: value }); },
  };
  let carConstraint: CarBatteryConstraint = { active: false, allowCharge: true, until: null };
  const runner = createAutomation({
    config: { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5,
      energyBufferPercent: 5, minimumEnergyBufferKwh: 1, afternoonTargetSocPercent: 80 },
    state, controller: controls.automationController, now, setTimer, clearTimer, readTelemetry: telemetry,
    readCarConstraint: () => carConstraint,
    async readForecast(offset) {
      const at = new Date(clock + offset * 24 * 3_600_000);
      const date = getLocalDate(at);
      const { start, end } = getCalendarDayBounds(at);
      return { status: 'online', date, fetchedAt: now().toISOString(), estimatedProductionKwh: 0,
        locationName: 'Test', weatherCode: 0, temperatureMinC: 10, temperatureMaxC: 10, temperatureMeanC: 10,
        source: 'Open-Meteo', model: 'east_west_tilted_radiation', arrayPowerKw: 8.5, performanceRatio: 0.85,
        panelTiltDegrees: 15, eastFraction: 0.5, weatherModel: 'meteoswiss_icon_ch2',
        productionPeriodStart: start.toISOString(), productionPeriodEnd: end.toISOString(), error: null,
        hourly: Array.from({ length: (+end - +start) / 3_600_000 }, (_, index) => ({
          start: new Date(+start + index * 3_600_000).toISOString(),
          end: new Date(+start + (index + 1) * 3_600_000).toISOString(), estimatedProductionKwh: 0, temperatureC: 10,
        })),
        quarterHourly: Array.from({ length: (+end - +start) / 900_000 }, (_, index) => ({
          start: new Date(+start + index * 900_000).toISOString(),
          end: new Date(+start + (index + 1) * 900_000).toISOString(), estimatedProductionKwh: 0, temperatureC: 10,
        })),
        consumption: estimateConsumption(date, { baselinePowerW: 500 }),
      };
    },
  });
  runner.start();
  await settle();
  async function advanceTo(instant: string) {
    const end = Date.parse(instant);
    assert.ok(end >= clock);
    while (timers.size) {
      const [id, task] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (task.at > end) break;
      timers.delete(id);
      clock = task.at;
      task.callback();
      await settle();
    }
    clock = end;
    await settle();
  }
  return { runner, inverter, transport, writes, commands, advanceTo,
    setCarConstraint(value: CarBatteryConstraint) { carConstraint = value; },
    async cleanup() {
      latency.readMs = 0;
      latency.writeMs = 0;
      const stopping = runner.stop();
      await settle();
      await advanceTo(new Date(clock + 60_000).toISOString());
      await stopping;
      await inverter.disconnect();
    },
  };
}

test('required car allocation yields an owned battery charge to hold and resumes charging when sharing becomes feasible', async t => {
  const f = await fixture('2026-10-25T16:40:00+01:00', 50);
  t.after(() => f.cleanup());
  assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
  f.setCarConstraint({ active: true, allowCharge: false, until: '2026-10-25T15:55:00.000Z' });
  await f.runner.evaluate();
  assert.equal(f.inverter.getControlStatus().automationMode, 'hold');
  assert.equal(f.runner.status().reason, 'car_priority');
  f.setCarConstraint({ active: true, allowCharge: true, until: '2026-10-25T15:55:00.000Z' });
  await f.runner.evaluate();
  assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
  assert.equal(f.inverter.getControlStatus().automationOwner, 'lifecycle-test');
  await f.advanceTo('2026-10-25T16:55:00+01:00');
  assert.equal(f.inverter.getControlStatus().active, false);
});

test('invalid battery telemetry blocks the planner and recovers automatically when complete safety readings become healthy', async t => {
  const f = await fixture('2026-10-27T15:30:00.000Z', 50);
  t.after(() => f.cleanup());
  assert.equal(f.runner.status().status, 'charging');
  f.transport.memory.set(STORAGE + 2, 0);
  await f.advanceTo('2026-10-27T15:30:10Z');
  assert.equal(f.inverter.getControlStatus().active, false);
  assert.match(f.inverter.getControlStatus().error!, /maxPowerWatts=0/);
  assert.equal(f.runner.status().status, 'blocked');
  assert.equal(f.runner.status().reason, 'controller_unavailable');
  assert.equal(f.transport.memory.get(STORAGE + 5), 0);
  const commands = f.commands.length;
  await f.advanceTo('2026-10-27T15:30:20Z');
  assert.equal(f.runner.status().status, 'blocked');
  assert.equal(f.commands.length, commands, 'invalid readings never authorize a new command');

  f.transport.memory.set(STORAGE + 2, 10000);
  await f.advanceTo('2026-10-27T15:30:30Z');
  assert.equal(f.inverter.getControlStatus().error, undefined);
  assert.notEqual(f.runner.status().status, 'blocked');
  assert.notEqual(f.runner.status().status, 'error');
  await f.runner.evaluate();
  assert.equal(f.runner.status().status, 'charging');
  assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
  assert.equal(f.inverter.getControlStatus().automationOwner, 'lifecycle-test');
});

test('real controller charges until 16:55:00 and releases at that exact instant', async () => {
  const f = await fixture('2026-10-25T15:45:00.052Z');
  try {
    assert.equal(f.runner.status().status, 'charging');
    assert.equal(f.inverter.getControlStatus().expiresAt, '2026-10-25T15:55:05.000Z');
    await f.advanceTo('2026-10-25T15:54:59.999Z');
    assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
    assert.equal(f.runner.status().status, 'charging');
    assert.equal(f.inverter.getControlStatus().error, undefined);
    assert.equal(f.transport.memory.get(STORAGE + 5), 3, 'owned control remains active through the transition');
    await f.advanceTo('2026-10-25T15:55:00Z');
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.equal(f.writes.find(write => write.address === STORAGE + 5 && write.value === 0)!.at,
      Date.parse('2026-10-25T15:55:00Z'));
    await f.advanceTo('2026-10-25T15:55:10Z');
    assert.equal(f.inverter.getControlStatus().error, undefined);
    assert.equal(f.runner.status().status, 'idle');
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.equal(f.commands.filter(command => command.path === '/inverter/automation-charge').length, 1);
  } finally { await f.cleanup(); }
});

test('failed cutoff writes are retried after 16:55 until normal operation is confirmed', async () => {
  const f = await fixture('2026-10-25T15:54:00Z');
  try {
    await f.advanceTo('2026-10-25T15:54:59.999Z');
    assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
    f.transport.failWrite = STORAGE + 5;
    await f.advanceTo('2026-10-25T15:55:11Z');
    const cutoff = Date.parse('2026-10-25T15:55:00Z');
    assert.ok(f.writes.some(write => write.at === cutoff && write.address === STORAGE + 5 && write.value === 0));
    assert.equal(f.transport.memory.get(STORAGE + 5), 3);
    f.transport.failWrite = undefined;
    await f.advanceTo('2026-10-25T15:55:45Z');
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.runner.status().status, 'idle');
    assert.equal(f.inverter.getControlStatus().error, undefined);
    assert.equal(f.commands.filter(command => command.path === '/inverter/automation-charge').length, 1);
    assert.equal(f.writes.some(write => write.at >= cutoff && write.address === STORAGE + 5 && write.value === 3), false);
  } finally { await f.cleanup(); }
});

test('late afternoon starts can still charge until 16:55', async () => {
  const f = await fixture('2026-10-25T15:54:12Z');
  try {
    assert.equal(f.runner.status().status, 'charging');
    assert.equal(f.commands.some(command => command.path === '/inverter/automation-charge'), true);
    await f.advanceTo('2026-10-25T15:55:10Z');
    assert.equal(f.runner.status().status, 'idle');
    assert.equal(f.inverter.getControlStatus().error, undefined);
  } finally { await f.cleanup(); }
});

test('real intermediate renewals keep charging continuously for more than sixteen minutes', async () => {
  const f = await fixture('2026-10-25T15:30:00.052Z');
  try {
    await f.advanceTo('2026-10-25T15:47:00Z');
    assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
    assert.equal(f.runner.status().status, 'charging');
    assert.ok(f.commands.filter(command => command.path === '/inverter/automation-charge').length >= 2);
    assert.equal(f.commands.some(command => command.path === '/inverter/automation-hold'), false);
    assert.equal(f.writes.some(write => write.address === STORAGE + 5 && write.value === 0), false);
    await f.advanceTo('2026-10-25T15:54:59.999Z');
    assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
    await f.advanceTo('2026-10-25T15:55:00Z');
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
  } finally { await f.cleanup(); }
});

test('the morning cutoff also starts stopping at exactly 06:55 on both DST transition dates', async () => {
  for (const [origin, cutoff] of [
    ['2026-10-25T05:54:00.052Z', '2026-10-25T05:55:00.000Z'],
    ['2026-03-29T04:54:00.052Z', '2026-03-29T04:55:00.000Z'],
  ]) {
    const f = await fixture(origin, 40);
    try {
      await f.advanceTo(new Date(Date.parse(cutoff) - 1).toISOString());
      assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
      assert.equal(f.writes.some(write => write.address === STORAGE + 5 && write.value === 0), false);
      await f.advanceTo(cutoff);
      assert.equal(f.transport.memory.get(STORAGE + 5), 0);
      assert.equal(f.writes.find(write => write.address === STORAGE + 5 && write.value === 0)!.at, Date.parse(cutoff));
    } finally { await f.cleanup(); }
  }
});

test('a charge arriving after cutoff cannot activate even within the cleanup deadline', async () => {
  const f = await fixture('2026-10-25T15:54:50Z', 72.79, { readMs: 2900, writeMs: 6000 });
  try {
    await f.advanceTo('2026-10-25T15:55:15Z');
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.writes.some(write => write.address === STORAGE + 5 && write.value === 3), false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
  } finally { await f.cleanup(); }
});

test('controller stops at 16:55 independently of slow orchestrator requests', async () => {
  const f = await fixture('2026-10-25T15:45:00.052Z', 72.79, { readMs: 2900, writeMs: 6000 });
  try {
    await f.advanceTo('2026-10-25T15:45:20Z');
    assert.equal(f.runner.status().status, 'charging');
    await f.advanceTo('2026-10-25T15:54:59.999Z');
    assert.equal(f.inverter.getControlStatus().automationMode, 'charge');
    await f.advanceTo('2026-10-25T15:55:00Z');
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.transport.memory.get(STORAGE + 5), 0);
  } finally { await f.cleanup(); }
});

test('a normally expiring final hold cannot latch an error or block the next charging window', async () => {
  const f = await fixture('2026-10-25T15:54:59Z', 85);
  try {
    assert.equal(f.runner.status().status, 'holding');
    assert.equal(f.inverter.getControlStatus().expiresAt, '2026-10-25T15:55:05.000Z');
    await f.advanceTo('2026-10-25T15:55:10Z');
    assert.equal(f.runner.status().status, 'idle');
    assert.equal(f.inverter.getControlStatus().active, false);
    assert.equal(f.inverter.getControlStatus().error, undefined);
    await f.advanceTo('2026-10-25T22:05:10Z');
    assert.notEqual(f.runner.status().status, 'blocked');
    assert.equal(f.inverter.getControlStatus().active, true);
    assert.equal(f.inverter.getControlStatus().error, undefined);
  } finally { await f.cleanup(); }
});
