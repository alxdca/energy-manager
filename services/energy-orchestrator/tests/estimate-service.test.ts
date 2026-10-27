import { forecastDayOffsets, type ForecastDayOffset } from '../src/forecast-horizon.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimateService } from '../src/estimate-service.js';
import type { AutomationConfig, EnergyForecast } from '../src/automation-plan.js';
import type { AutomationControllerState, AutomationStatus } from '../src/automation.js';
import type { BatteryProjection } from '../src/battery-projection.js';
import type { ForecastBatch } from '../src/forecast-publication.js';
import type { BatteryChargeEstimate } from '../src/charge-estimate.js';
import type { ConsumptionConfig } from '../src/consumption.js';
import { emptySolarForecast, type ForecastConfig, type SolarForecast } from '../src/forecast.js';
import { getCalendarDayBounds, getLocalDate } from '../src/policy.js';
import { energyEstimatePoints, type EnergyEstimatePoint, type SolarEstimatePoint } from '../src/energy-estimate-history.js';

const hourMs = 3_600_000;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('consumption history receives quarter-hour batches with the shared retained solar estimates', async () => {
  const captures: Array<{ forecasts: EnergyForecast[]; at: string }> = [];
  const h = fixture('2026-10-25T12:07:00Z', undefined, undefined, (forecasts, at) => {
    captures.push({ forecasts, at: at.toISOString() });
  });
  await h.service.recalculate();
  h.setTime('2026-10-25T12:15:00Z');
  await h.service.recalculate();
  h.setTime('2026-10-25T12:30:00Z');
  await h.service.recalculate();
  assert.equal(captures.length, 3);
  assert.equal(h.calls.solar.length, 9, 'all target dates share the startup weather refresh');
  assert.deepEqual(captures.map(value => value.at), ['2026-10-25T12:07:00.000Z', '2026-10-25T12:15:00.000Z', '2026-10-25T12:30:00.000Z']);
  assert.ok(captures.every(capture => capture.forecasts.length === 9 && capture.forecasts.every(value => value.consumption.hourly.length > 0)));
  assert.equal(captures[2].forecasts[0].fetchedAt, captures[0].forecasts[0].fetchedAt);
  h.state.solarLevel = 9;
  h.setTime('2026-10-25T13:00:00Z');
  await h.service.recalculate();
  assert.equal(captures.length, 4);
  assert.equal(captures[3].forecasts[0].hourly!.find(hour => hour.start === '2026-10-25T12:00:00.000Z')!.estimatedProductionKwh, 3);
  assert.deepEqual(captures[3].forecasts[0].hourly, h.forecast(0)!.hourly);
  assert.deepEqual(h.service.planningForecast(0).hourly, h.forecast(0)!.hourly);
  h.forecast(0);
  h.service.planningForecast(0);
  assert.equal(captures.length, 4, 'GET readers never capture another estimate');
  assert.equal(Object.keys(h.forecast(0)!.consumption!).some(key => key.startsWith('heatPump')), false,
    'retained consumption snapshots must not reintroduce the removed heating model');
});

test('energy capture uses actual generation time and cannot mutate planning inputs', async () => {
  const times: string[] = [];
  const h = fixture('2026-10-25T12:16:00Z', undefined, undefined, (forecasts, at) => {
    times.push(at.toISOString());
    forecasts[0].hourly![0].estimatedProductionKwh = 999;
    forecasts[0].consumption.hourly[0].estimatedConsumptionKwh = 999;
  });
  await h.service.recalculate(new Date('2026-10-25T12:15:00Z'));
  assert.deepEqual(times, ['2026-10-25T12:16:00.000Z']);
  const input = h.service.planningForecast(0);
  assert.notEqual(input.hourly![0].estimatedProductionKwh, 999);
  assert.equal(input.consumption.hourly[0].estimatedConsumptionKwh, 1);
});

test('a failed publication rejects without exposing a new batch, and retries coherently', async () => {
  const h = fixture();
  h.state.failPublication = true;
  await assert.rejects(h.service.recalculate(), /forecast publication unavailable/);
  assert.equal(h.forecast(0), null);
  assert.equal(h.service.status().calculatedAt, null);
  assert.equal(h.service.planner(), null);
  assert.equal(h.service.projection().status, 'unavailable');
  h.state.failPublication = false;
  await h.service.recalculate();
  const previous = { forecast: h.forecast(0), planner: h.service.planner(),
    projection: h.service.projection(), calculatedAt: h.service.status().calculatedAt };
  h.setTime('2026-10-25T13:00:00Z'); h.state.solarLevel = 9; h.consumption.baselinePowerW = 2000;
  h.state.failPublication = true;
  await assert.rejects(h.service.recalculate(), /forecast publication unavailable/);
  assert.deepEqual(h.forecast(0), previous.forecast);
  assert.deepEqual(h.service.planner(), previous.planner);
  assert.deepEqual(h.service.projection(), previous.projection);
  assert.equal(h.service.status().calculatedAt, previous.calculatedAt);
  h.state.failPublication = false;
  await h.service.recalculate();
  assert.equal(h.service.status().calculatedAt, h.now().toISOString());
  assert.equal(h.forecast(0)!.hourly!.find(point => point.start === '2026-10-25T13:00:00.000Z')!.estimatedProductionKwh, 7.5);
  assert.equal(h.forecast(0)!.consumption.baselinePowerW, 2000);
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(origin = '2026-10-25T12:07:00Z', prepareCarForecasts?: Parameters<typeof createEstimateService>[0]['prepareCarForecasts'],
  captureSolar?: (forecasts: SolarForecast[], at: Date) => void | Promise<void>,
  captureEnergy?: (forecasts: EnergyForecast[], at: Date) => void | Promise<void>,
  readSolarHistory?: (date: string) => Promise<SolarEstimatePoint[]>,
  readEnergyHistory?: (date: string) => Promise<EnergyEstimatePoint[]>,
  readSavedSolarForecast?: (date: string) => Promise<SolarForecast | null>) {
  let clock = new Date(origin);
  const forecastConfig: ForecastConfig = { latitude: 12.34, longitude: 56.78, locationName: 'Test',
    arrayPowerKw: 8.5, performanceRatio: .85, panelTiltDegrees: 15, eastFraction: .5 };
  const automationConfig: AutomationConfig = { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5,
    energyBufferPercent: 5, minimumEnergyBufferKwh: 1, afternoonTargetSocPercent: 80 };
  const consumption: ConsumptionConfig = { baselinePowerW: 1000 };
  const automation: AutomationStatus = { enabled: true, status: 'idle', lastEvaluatedAt: null,
    nextEvaluationAt: null, targetSocPercent: null, holdUntil: null, reason: 'outside_charging_window', plan: null, error: null };
  const control: AutomationControllerState & { automated?: boolean; chargeEstimate?: BatteryChargeEstimate } = { available: true, mode: 'auto', powerKw: null,
    targetSocPercent: null, limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: 5 },
    revertTimeoutSeconds: 30, error: null };
  const calls = { solar: [] as Array<{ offset: ForecastDayOffset; at: string }>, evaluate: 0, telemetry: 0, control: 0, publish: 0 };
  const errors: unknown[] = [];
  const sourceObjects: SolarForecast[] = [];
  const records: Array<{ projection: BatteryProjection; at: string }> = [];
  let published: ForecastBatch | null = null;
  const gates: { evaluate?: ReturnType<typeof deferred>; telemetry?: ReturnType<typeof deferred>; publish?: ReturnType<typeof deferred> } = {};
  const state = { quarterSolar: false, soc: 60, solarLevel: 3, temperature: 10, failSolar: false, failSolarOffsets: new Set<number>(), failTelemetry: false, failControl: false, failPublication: false };
  const date = (offset = 0) => new Date(Date.parse(`${getLocalDate(clock)}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const now = () => new Date(clock);
  const service = createEstimateService({
    forecastConfig, automationConfig, consumption, now, prepareCarForecasts, readSolarHistory, readEnergyHistory, readSavedSolarForecast,
    async readSolar(offset) {
      calls.solar.push({ offset, at: clock.toISOString() });
      if (state.failSolar || state.failSolarOffsets.has(offset)) throw new Error('weather unavailable');
      const bounds = getCalendarDayBounds(new Date(`${date(offset)}T00:00:00Z`));
      const hourly = Array.from({ length: (bounds.end.getTime() - bounds.start.getTime()) / hourMs }, (_, index) => {
        const start = new Date(bounds.start.getTime() + index * hourMs);
        return { start: start.toISOString(), end: new Date(start.getTime() + hourMs).toISOString(),
          estimatedProductionKwh: start.getUTCHours() >= 9 && start.getUTCHours() < 15 ? state.solarLevel : 0,
          temperatureC: state.temperature };
      });
      const value: SolarForecast = { ...emptySolarForecast(date(offset), forecastConfig), status: 'online', error: null,
        fetchedAt: clock.toISOString(), hourly,
        estimatedProductionKwh: Math.round(hourly.reduce((sum, hour) => sum + hour.estimatedProductionKwh, 0) * 10) / 10,
        temperatureMinC: state.temperature, temperatureMeanC: state.temperature, temperatureMaxC: state.temperature,
        productionPeriodStart: bounds.start.toISOString(), productionPeriodEnd: bounds.end.toISOString() };
      value.quarterHourly = hourly.flatMap(hour => (state.quarterSolar ? [1, 2, 3, 4] : [2.5, 2.5, 2.5, 2.5]).map((weight, index) => ({
        start: new Date(Date.parse(hour.start) + index * 900000).toISOString(),
        end: new Date(Date.parse(hour.start) + (index + 1) * 900000).toISOString(),
        estimatedProductionKwh: hour.estimatedProductionKwh * weight / 10, temperatureC: hour.temperatureC,
      })));
      sourceObjects.push(value);
      return value;
    },
    async readTelemetry() {
      calls.telemetry++;
      await gates.telemetry?.promise;
      if (state.failTelemetry) throw new Error('telemetry unavailable');
      return { status: 'online' as const, observedAt: clock.toISOString(), error: null,
        solarKw: 0, householdKw: 1, gridImportKw: 0, gridExportKw: 0,
        batterySocPercent: state.soc, batteryChargeKw: 0, batteryDischargeKw: 1 };
    },
    async readControl() { calls.control++; if (state.failControl) throw new Error('control unavailable'); return control; },
    readAutomation: () => automation,
    async evaluateAutomation() { calls.evaluate++; await gates.evaluate?.promise; },
    async publishForecasts(batch) {
      calls.publish++;
      const committed = structuredClone(batch);
      records.push({ projection: structuredClone(batch.projection), at: batch.calculatedAt });
      await gates.publish?.promise;
      if (state.failPublication) throw new Error('forecast publication unavailable');
      await captureSolar?.(structuredClone(batch.forecasts), new Date(batch.calculatedAt));
      await captureEnergy?.(structuredClone(batch.forecasts), new Date(batch.calculatedAt));
      published = committed;
    },
    onError: error => { errors.push(error); },
  });
  const forecast = (offset: ForecastDayOffset) => structuredClone(published?.forecasts.find(value => value.date === date(offset)) ?? null);
  return { service, forecast, calls, state, sourceObjects, errors, records, gates, consumption, date, automation, control,
    now, setTime(value: string) { clock = new Date(value); } };
}

test('construction waits for an explicit first calculation, which initializes both days immediately', async () => {
  const h = fixture();
  assert.equal(h.forecast(0), null);
  assert.equal(h.forecast(1), null);
  assert.equal(h.service.planner(), null);
  assert.equal(h.service.projection().status, 'unavailable');
  assert.deepEqual(h.service.status(), { calculatedAt: null, nextEvaluationAt: '2026-10-25T12:15:00.000Z' });
  assert.equal(h.calls.solar.length + h.calls.evaluate + h.calls.telemetry + h.calls.publish, 0);
  await h.service.recalculate();
  assert.equal(h.forecast(0)!.date, '2026-10-25');
  assert.equal(h.forecast(1)!.date, '2026-10-26');
  assert.equal(h.service.status().calculatedAt, '2026-10-25T12:07:00.000Z');
  assert.equal(h.calls.evaluate, 1);
  assert.equal(h.calls.publish, 1);
});

test('car allocation is prepared before battery evaluation and published once without changing household forecasts', async () => {
  let prepared = 0;
  const h = fixture('2026-10-25T12:07:00Z', async (forecasts, at) => {
    assert.equal(h.calls.evaluate, prepared);
    prepared++;
    return forecasts.map((forecast, index) => ({ status: 'available' as const, date: forecast.date,
      calculatedAt: at.toISOString(), socObservedAt: at.toISOString(), slots: index === 0 ? [{
        start: '2026-10-25T12:15:00.000Z', end: '2026-10-25T12:45:00.000Z',
        powerKw: 6, energyKwh: 3, source: 'grid' as const, required: true, batteryChargeAllowed: false,
      }] : [] }));
  });
  await h.service.recalculate();
  const firstHousehold = h.forecast(0)!.consumption!;
  close(firstHousehold.estimatedConsumptionKwh, 25);
  assert.equal(firstHousehold.excludesCar, true);
  assert.equal(h.forecast(0)!.carCharging!.slots.length, 1);
  assert.equal(h.service.planningForecast(0).carChargingContext!.length, 9);
  for (let index = 0; index < 3; index++) { h.forecast(0); h.service.planner(); h.service.projection(); }
  assert.equal(prepared, 1);
  h.setTime('2026-10-25T12:15:00Z');
  await h.service.recalculate();
  assert.equal(prepared, 2);
  close(h.forecast(0)!.consumption!.estimatedConsumptionKwh, 25);
  assert.equal(h.forecast(0)!.carCharging!.slots.length, 1);
  close(h.forecast(0)!.carCharging!.slots[0].energyKwh, 3);
});

test('failed car allocation does not become a zero-load automatic battery promise', async () => {
  const h = fixture('2026-10-25T12:07:00Z', async () => { throw new Error('car allocation unavailable'); });
  await h.service.recalculate();
  assert.equal(h.forecast(0)!.carCharging!.status, 'unavailable');
  assert.equal(h.service.projection().status, 'unavailable');
  assert.equal(h.service.projection().reason, 'car_forecast_unavailable');
  assert.equal(h.errors.length, 1);
  close(h.forecast(0)!.consumption!.estimatedConsumptionKwh, 25);
});

test('public reads and controller forecast reads never recalculate after the live SOC changes', async () => {
  const h = fixture();
  await h.service.recalculate();
  const before = { today: h.forecast(0), tomorrow: h.forecast(1),
    planner: h.service.planner(), projection: h.service.projection(), planning: h.service.planningForecast(0) };
  const counts = structuredClone(h.calls);
  h.state.soc = 20;
  h.setTime('2026-10-25T12:14:59Z');
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(h.forecast(0), before.today);
    assert.deepEqual(h.forecast(1), before.tomorrow);
    assert.deepEqual(h.service.planner(), before.planner);
    assert.deepEqual(h.service.projection(), before.projection);
    assert.deepEqual(h.service.planningForecast(0), before.planning);
  }
  assert.deepEqual(h.calls, counts);
});

test('closing either charge window immediately selects the prepared next period without recalculating', async () => {
  for (const [capturedAt, closesAt, start, end, deadline] of [
    ['2026-10-25T05:45:00Z', '2026-10-25T05:55:00Z', '2026-10-25T11:05:00.000Z', '2026-10-25T15:55:00.000Z', '2026-10-25T15:55:00.000Z'],
    ['2026-10-25T15:45:00Z', '2026-10-25T15:55:00Z', '2026-10-25T22:05:00.000Z', '2026-10-26T05:55:00.000Z', '2026-10-26T15:55:00.000Z'],
  ]) {
    const h = fixture(capturedAt);
    h.state.solarLevel = 0;
    await h.service.recalculate();
    const active = h.service.planner()!;
    assert.equal(active.calculation!.charging.allowed, true);
    assert.equal(active.upcomingPlan, null);
    const counts = structuredClone(h.calls);
    h.setTime(new Date(Date.parse(closesAt) - 1).toISOString());
    assert.deepEqual(h.service.planner(), active);
    h.setTime(closesAt);
    h.state.soc = 10;
    const next = h.service.planner()!;
    assert.equal(next.calculation!.charging.allowed, false);
    assert.equal(next.upcomingPlan!.start, start);
    assert.equal(next.upcomingPlan!.end, end);
    assert.ok(next.upcomingPlan!.estimatedSocPercent! > 0);
    close(next.upcomingPlan!.plan.storedKwh!, next.upcomingPlan!.estimatedSocPercent! / 100 * 60);
    assert.equal(next.upcomingPlan!.plan.afternoonTargetAt, deadline);
    assert.equal(next.afternoonEstimate!.at, deadline);
    assert.equal(next.chargeBreakdown!.end, deadline);
    assert.equal(next.chargeBreakdown!.start, new Date(capturedAt).toISOString());
    close(next.chargeBreakdown!.storedKwh, 36);
    assert.equal(h.service.status().calculatedAt, new Date(capturedAt).toISOString());
    for (let index = 0; index < 3; index++) assert.deepEqual(h.service.planner(), next);
    assert.deepEqual(h.calls, counts, 'selecting the next period must not read inputs, evaluate or archive');
    h.service.invalidateBattery();
    assert.equal(h.service.planner(), null, 'manual authority also invalidates the prepared next plan');
  }
});

test('quarter batches refresh household and battery estimates while solar is fetched only at initialization and the full hour', async () => {
  const h = fixture();
  await h.service.recalculate();
  const initialSolar = h.forecast(0)!.fetchedAt;
  for (const [index, time] of ['12:15', '12:30', '12:45', '13:00'].entries()) {
    h.setTime(`2026-10-25T${time}:00Z`);
    h.state.soc = 50 - index;
    h.consumption.baselinePowerW = 1100 + index * 100;
    await h.service.recalculate();
    assert.equal(h.calls.evaluate, index + 2);
    assert.equal(h.calls.publish, index + 2);
    assert.equal(h.calls.solar.length, time === '13:00' ? 18 : 9);
    assert.equal(h.service.projection().points[0].socPercent, h.state.soc);
    const nextHour = h.forecast(0)!.consumption!.hourly.find(hour => hour.start === '2026-10-25T14:00:00.000Z')!;
    close(nextHour.estimatedConsumptionKwh, h.consumption.baselinePowerW / 1000);
    assert.equal(h.forecast(0)!.fetchedAt, time === '13:00' ? h.now().toISOString() : initialSolar);
  }
  assert.deepEqual(h.calls.solar.map(call => call.at), [
    ...Array(9).fill('2026-10-25T12:07:00.000Z'), ...Array(9).fill('2026-10-25T13:00:00.000Z'),
  ]);
});

test('solar sources refresh hourly while native profiles and consumption captures keep quarter resolution', async () => {
  const solarCaptures: SolarForecast[][] = [];
  const energyCaptures: EnergyForecast[][] = [];
  const h = fixture(undefined, undefined,
    forecasts => { solarCaptures.push(forecasts); },
    forecasts => { energyCaptures.push(forecasts); });
  await h.service.recalculate();
  const before = [h.forecast(0)!, h.forecast(1)!];
  h.state.solarLevel = 9;
  h.state.temperature = -5;
  for (const [index, time] of ['12:15', '12:30', '12:45'].entries()) {
    h.setTime(`2026-10-25T${time}:00Z`);
    h.consumption.baselinePowerW = 1500 + index * 500;
    await h.service.recalculate();
    for (const offset of [0, 1] as const) {
      const forecast = h.forecast(offset)!;
      assert.deepEqual(forecast.hourly, before[offset].hourly);
      assert.equal(forecast.estimatedProductionKwh, before[offset].estimatedProductionKwh);
      assert.equal(forecast.fetchedAt, before[offset].fetchedAt);
    }
    assert.equal(solarCaptures.length, index + 2);
    assert.equal(h.calls.solar.length, 9);
    assert.equal(energyCaptures.length, index + 2);
    assert.equal(energyCaptures.at(-1)![0].fetchedAt, before[0].fetchedAt);
    assert.deepEqual(energyCaptures.at(-1)![0].hourly, solarCaptures[0][0].hourly);
    assert.equal(h.service.planningForecast(0).consumption.baselinePowerW, h.consumption.baselinePowerW);
  }
  h.setTime('2026-10-25T13:00:00Z');
  await h.service.recalculate();
  assert.equal(solarCaptures.length, 5);
  assert.equal(energyCaptures.length, 5);
  assert.equal(h.calls.solar.length, 18);
  assert.equal(h.forecast(0)!.fetchedAt, h.now().toISOString());
  assert.equal(h.forecast(0)!.hourly!.find(hour => hour.start === '2026-10-25T13:00:00.000Z')!.estimatedProductionKwh, 7.5);
});

test('solar archival captures the published estimates without revising elapsed hours', async () => {
  const captures: Array<{ forecasts: SolarForecast[]; at: string }> = [];
  const h = fixture(undefined, undefined, (forecasts, at) => {
    assert.equal(h.calls.evaluate, captures.length + 1);
    captures.push({ forecasts, at: at.toISOString() });
  });
  await h.service.recalculate();
  for (const time of ['12:15', '12:30', '12:45']) {
    h.setTime(`2026-10-25T${time}:00Z`);
    await h.service.recalculate();
  }
  assert.equal(captures.length, 4);
  h.state.solarLevel = 9;
  h.setTime('2026-10-25T13:00:00Z');
  await h.service.recalculate();
  assert.equal(captures.length, 5);
  assert.deepEqual(captures.map(capture => capture.at), ['2026-10-25T12:07:00.000Z', '2026-10-25T12:15:00.000Z', '2026-10-25T12:30:00.000Z', '2026-10-25T12:45:00.000Z', '2026-10-25T13:00:00.000Z']);
  assert.deepEqual(captures[4].forecasts.map(forecast => forecast.date), forecastDayOffsets.map(offset => h.date(offset)));
  const elapsed = '2026-10-25T09:00:00.000Z';
  assert.equal(captures[4].forecasts[0].hourly!.find(hour => hour.start === elapsed)!.estimatedProductionKwh, 3);
  assert.equal(h.forecast(0)!.hourly!.find(hour => hour.start === elapsed)!.estimatedProductionKwh, 3);
  assert.deepEqual(h.service.planningForecast(0).hourly, h.forecast(0)!.hourly);
  assert.deepEqual(captures[4].forecasts[0].hourly, h.forecast(0)!.hourly);
  assert.equal(h.sourceObjects[forecastDayOffsets.length].hourly!.find(hour => hour.start === elapsed)!.estimatedProductionKwh, 9);
  assert.equal(captures[0].forecasts[0].hourly!.find(hour => hour.start === elapsed)!.estimatedProductionKwh, 3);
  h.forecast(0); h.service.planningForecast(0); h.service.planner();
  assert.equal(captures.length, 5);
});

test('startup restores started solar quarters from history and leaves only future quarters fresh', async () => {
  const reads: string[] = [];
  const h = fixture('2026-10-25T12:07:00Z', undefined, undefined, undefined, async date => {
    reads.push(date);
    return [9, 11, 12, 13].flatMap(hour => Array.from({ length: 4 }, (_, quarter) => ({
      start: new Date(Date.UTC(2026, 9, 25, hour, quarter * 15)).toISOString(),
      end: new Date(Date.UTC(2026, 9, 25, hour, (quarter + 1) * 15)).toISOString(),
      estimatedProductionKwh: hour === 9 ? 0 : 1,
    })));
  });
  await h.service.recalculate();
  const today = h.forecast(0)!;
  const value = (hour: number) => today.hourly!.find(row => row.start === `2026-10-25T${hour.toString().padStart(2, '0')}:00:00.000Z`)!.estimatedProductionKwh;
  assert.equal(value(9), 0, 'saved zero is preserved');
  assert.equal(value(11), 4, 'the last completed hour is restored');
  assert.equal(value(12), 3.25, 'the started quarter is restored while later quarters use the new forecast');
  assert.equal(value(13), 3, 'future hours use the new forecast');
  assert.deepEqual(h.service.planningForecast(0).hourly, today.hourly);
  close(today.estimatedProductionKwh!, Math.round(today.hourly!.reduce((sum, hour) => sum + hour.estimatedProductionKwh, 0) * 10) / 10);
  assert.deepEqual(reads, forecastDayOffsets.map(offset => h.date(offset)));
  h.setTime('2026-10-25T13:00:00Z');
  h.state.solarLevel = 9;
  await h.service.recalculate();
  assert.deepEqual(reads, forecastDayOffsets.map(offset => h.date(offset)), 'later batches retain the restored snapshot');
  assert.equal(h.forecast(0)!.hourly!.find(row => row.start === '2026-10-25T11:00:00.000Z')!.estimatedProductionKwh, 4);
});

test('solar freezing and capture use actual time when a scheduled batch runs after an hour ends', async () => {
  const captures: string[] = [];
  const h = fixture('2026-10-25T13:00:00Z', undefined, (_forecasts, at) => { captures.push(at.toISOString()); },
    undefined, async () => Array.from({ length: 4 }, (_, quarter) => ({
      start: new Date(Date.UTC(2026, 9, 25, 12, quarter * 15)).toISOString(),
      end: new Date(Date.UTC(2026, 9, 25, 12, (quarter + 1) * 15)).toISOString(), estimatedProductionKwh: .25,
    })));
  await h.service.recalculate(new Date('2026-10-25T12:59:59Z'));
  assert.deepEqual(captures, ['2026-10-25T13:00:00.000Z']);
  assert.equal(h.forecast(0)!.hourly!.find(hour => hour.start === '2026-10-25T12:00:00.000Z')!.estimatedProductionKwh, 1);
});

test('failed history restoration does not publish revised past values and can retry the solar batch', async () => {
  let attempts = 0;
  const failure = new Error('history temporarily unavailable');
  const h = fixture(undefined, undefined, undefined, undefined, async () => {
    if (++attempts === 1) throw failure;
    return [];
  });
  await assert.rejects(h.service.recalculate(), failure);
  assert.equal(h.forecast(0), null);
  await h.service.recalculate();
  assert.equal(attempts, 18);
  assert.equal(h.forecast(0)!.status, 'online');
});

test('weather recovery after an offline startup restores saved completed hours before publishing', async () => {
  let reads = 0;
  const h = fixture(undefined, undefined, undefined, undefined, async () => {
    reads++;
    return Array.from({ length: 4 }, (_, quarter) => ({
      start: new Date(Date.UTC(2026, 9, 25, 12, quarter * 15)).toISOString(),
      end: new Date(Date.UTC(2026, 9, 25, 12, (quarter + 1) * 15)).toISOString(), estimatedProductionKwh: .25,
    }));
  });
  h.state.failSolar = true;
  await h.service.recalculate();
  assert.equal(h.forecast(0)!.status, 'offline');
  assert.equal(reads, 0);
  h.state.failSolar = false;
  h.setTime('2026-10-25T13:00:00Z');
  await h.service.recalculate();
  assert.equal(reads, 9);
  assert.equal(h.forecast(0)!.hourly!.find(hour => hour.start === '2026-10-25T12:00:00.000Z')!.estimatedProductionKwh, 1);
});

test('solar archive callbacks receive isolated snapshots and cannot mutate forecast inputs or batch time', async () => {
  const h = fixture(undefined, undefined, (forecasts, at) => {
    forecasts[0].estimatedProductionKwh = 999;
    forecasts[0].hourly![0].estimatedProductionKwh = 999;
    forecasts.length = 0;
    at.setUTCFullYear(2000);
  });
  await h.service.recalculate();
  assert.notEqual(h.forecast(0)!.estimatedProductionKwh, 999);
  assert.equal(h.forecast(0)!.hourly![0].estimatedProductionKwh, 0);
  assert.equal(h.service.planningForecast(0).hourly![0].estimatedProductionKwh, 0);
  assert.equal(h.sourceObjects[0].hourly![0].estimatedProductionKwh, 0);
  assert.equal(h.service.status().calculatedAt, '2026-10-25T12:07:00.000Z');
});

test('publication includes unavailable solar and preserves retained source timestamps during outages', async () => {
  const captures: SolarForecast[][] = [];
  const h = fixture(undefined, undefined, forecasts => { captures.push(forecasts); });
  h.state.failSolar = true;
  await h.service.recalculate();
  assert.equal(captures.length, 1);
  assert.ok(captures[0].every(forecast => forecast.status === 'offline'));
  h.state.failSolar = false;
  h.setTime('2026-10-25T13:00:00Z');
  await h.service.recalculate();
  h.state.failSolar = true;
  h.setTime('2026-10-25T14:00:00Z');
  await h.service.recalculate();
  assert.equal(captures.length, 3);
  assert.ok(captures[2].every(forecast => forecast.status === 'stale' && forecast.fetchedAt === '2026-10-25T13:00:00.000Z'));
});

test('each projection carries SOC through seven future days including the final night planning hour', async () => {
  const h = fixture('2026-10-25T18:15:00Z');
  await h.service.recalculate();
  const projection = h.service.projection();
  assert.equal(projection.status, 'available');
  assert.equal(projection.reason, null);
  assert.equal(projection.points[0].at, h.now().toISOString());
  const todayEnd = getCalendarDayBounds(new Date('2026-10-25T00:00:00Z')).end.toISOString();
  const weekEnd = getCalendarDayBounds(new Date('2026-11-01T00:00:00Z')).end.toISOString();
  assert.ok(projection.points.some(point => point.at === todayEnd));
  assert.equal(projection.points.at(-1)!.at, weekEnd);
  assert.ok(projection.points.every(point => point.at >= h.now().toISOString() && point.at <= weekEnd));
  assert.deepEqual(h.calls.solar.map(call => call.offset), [...forecastDayOffsets]);
});

test('a batch is published atomically after automation, live capture and archival have completed', async () => {
  const h = fixture();
  await h.service.recalculate();
  const old = { status: h.service.status().calculatedAt, forecast: h.forecast(0), projection: h.service.projection() };
  h.setTime('2026-10-25T12:15:00Z');
  h.state.soc = 30;
  h.consumption.baselinePowerW = 2000;
  h.gates.evaluate = deferred();
  h.gates.telemetry = deferred();
  h.gates.publish = deferred();
  const pending = h.service.recalculate();
  assert.equal(h.service.recalculate(), pending, 'simultaneous requests share one batch');
  await settle();
  const unchanged = () => {
    assert.equal(h.service.status().calculatedAt, old.status);
    assert.deepEqual(h.forecast(0), old.forecast);
    assert.deepEqual(h.service.projection(), old.projection);
  };
  unchanged();
  assert.equal(h.service.planningForecast(0).consumption.baselinePowerW, 2000, 'automation can consume prepared inputs before publication');
  h.gates.evaluate.resolve();
  await settle();
  unchanged();
  h.gates.telemetry.resolve();
  await settle();
  unchanged();
  h.gates.publish.resolve();
  await pending;
  assert.equal(h.service.status().calculatedAt, h.now().toISOString());
  assert.equal(h.forecast(0)!.consumption!.baselinePowerW, 2000);
  assert.equal(h.service.projection().points[0].socPercent, 30);
  assert.equal(h.calls.evaluate, 2);
  assert.equal(h.calls.publish, 2);
});

test('archival records each completed projection once and never records in response to reads', async () => {
  const h = fixture();
  await h.service.recalculate();
  const first = structuredClone(h.records[0]);
  for (let index = 0; index < 8; index++) {
    h.forecast(0); h.forecast(1); h.service.planner(); h.service.projection(); h.service.status();
  }
  assert.equal(h.calls.publish, 1);
  assert.deepEqual(h.records[0], first);
  h.setTime('2026-10-25T12:15:00Z');
  await h.service.recalculate();
  assert.equal(h.calls.publish, 2);
  assert.equal(h.records[1].at, '2026-10-25T12:15:00.000Z');
});

test('failed hourly solar requests are not retried at the following three quarter batches', async () => {
  const h = fixture();
  await h.service.recalculate();
  const previous = structuredClone(h.forecast(0)!);
  h.state.failSolar = true;
  h.setTime('2026-10-25T13:00:00Z');
  await h.service.recalculate();
  assert.equal(h.calls.solar.length, 18);
  assert.equal(h.errors.length, 9);
  assert.equal(h.forecast(0)!.status, 'stale');
  assert.equal(h.forecast(0)!.fetchedAt, previous.fetchedAt);
  assert.ok(h.forecast(0)!.error);
  for (const time of ['13:15', '13:30', '13:45']) {
    h.setTime(`2026-10-25T${time}:00Z`);
    await h.service.recalculate();
    assert.equal(h.calls.solar.length, 18);
    assert.equal(h.forecast(0)!.estimatedProductionKwh, previous.estimatedProductionKwh);
    assert.equal(h.service.projection().status, 'available');
  }
  h.state.failSolar = false;
  h.setTime('2026-10-25T14:00:00Z');
  await h.service.recalculate();
  assert.equal(h.calls.solar.length, 27);
  assert.equal(h.forecast(0)!.status, 'online');
  assert.equal(h.service.projection().status, 'available');
});

test('scheduled batches retain the last complete solar inputs throughout a prolonged outage', async () => {
  const h = fixture('2026-10-25T06:00:00Z');
  await h.service.recalculate();
  const previous = structuredClone(h.forecast(0)!);
  h.state.failSolar = true;
  h.setTime('2026-10-25T14:00:00Z');
  await h.service.recalculate();
  const retained = h.forecast(0)!;
  assert.equal(retained.status, 'stale');
  assert.equal(retained.fetchedAt, previous.fetchedAt);
  assert.deepEqual(retained.hourly, previous.hourly);
  assert.equal(h.service.planningForecast(0).status, 'stale');
  assert.equal(h.service.projection().status, 'available');
});

test('an outage across midnight reuses forecasts for their original dates from the preceding batch', async () => {
  const h = fixture('2026-10-25T22:45:00Z');
  await h.service.recalculate();
  const tomorrow = structuredClone(h.forecast(1)!);
  h.state.failSolar = true;
  h.setTime('2026-10-25T23:00:00Z');
  await h.service.recalculate();
  const today = h.forecast(0)!;
  assert.equal(today.date, tomorrow.date);
  assert.equal(today.status, 'stale');
  assert.equal(today.fetchedAt, tomorrow.fetchedAt);
  assert.deepEqual(today.hourly, tomorrow.hourly);
  assert.equal(h.service.projection().status, 'available');
});

test('an outage without a previous forecast keeps solar production and battery predictions unknown', async () => {
  const h = fixture();
  h.state.failSolar = true;
  await h.service.recalculate();
  assert.equal(h.forecast(0)!.status, 'offline');
  assert.equal(h.forecast(0)!.estimatedProductionKwh, null);
  assert.equal(h.service.projection().status, 'unavailable');
});

test('telemetry failure still publishes the new household batch with an unavailable battery estimate', async () => {
  const h = fixture();
  await h.service.recalculate();
  h.setTime('2026-10-25T12:15:00Z');
  h.consumption.baselinePowerW = 2000;
  h.state.failTelemetry = true;
  await h.service.recalculate();
  assert.equal(h.service.status().calculatedAt, h.now().toISOString());
  assert.equal(h.forecast(0)!.status, 'online');
  assert.equal(h.forecast(0)!.consumption!.baselinePowerW, 2000);
  assert.equal(h.service.projection().status, 'unavailable');
  assert.equal(h.calls.publish, 2, 'unavailable SOC is committed in the same batch as the new energy forecasts');
  assert.equal(h.records[1].projection.status, 'unavailable');
});

test('control failure still publishes household estimates and a clearly passive battery projection', async () => {
  const h = fixture();
  await h.service.recalculate();
  h.setTime('2026-10-25T12:15:00Z');
  h.consumption.baselinePowerW = 2000;
  h.state.failControl = true;
  await h.service.recalculate();
  assert.equal(h.service.status().calculatedAt, h.now().toISOString());
  assert.equal(h.forecast(0)!.consumption!.baselinePowerW, 2000);
  assert.equal(h.service.projection().status, 'available');
  assert.equal(h.service.projection().assumption, 'passive_operation');
  assert.equal(h.service.planner()!.chargeBreakdown, null);
});

test('household updates freeze every started quarter while refreshing future quarters and all of tomorrow', async () => {
  const h = fixture();
  await h.service.recalculate();
  const currentHour = '2026-10-25T12:00:00.000Z';
  const pastHour = '2026-10-25T11:00:00.000Z';
  const futureHour = '2026-10-25T13:00:00.000Z';
  for (const [time, powerW, currentValue] of [['12:15', 2000, 1.5], ['12:30', 3000, 1.75]] as const) {
    h.setTime(`2026-10-25T${time}:00Z`);
    h.consumption.baselinePowerW = powerW;
    await h.service.recalculate();
    const today = h.forecast(0)!.consumption!;
    const value = (start: string) => today.hourly.find(hour => hour.start === start)!;
    close(value(pastHour).estimatedConsumptionKwh, 1);
    close(value(currentHour).estimatedConsumptionKwh, currentValue);
    close(value(futureHour).estimatedConsumptionKwh, powerW / 1000);
    close(today.estimatedConsumptionKwh, today.hourly.reduce((sum, hour) => sum + hour.estimatedConsumptionKwh, 0));
    assert.equal('minConsumptionKwh' in today, false);
    assert.equal('maxConsumptionKwh' in today, false);
    assert.ok(today.hourly.every(hour => !('minConsumptionKwh' in hour) && !('maxConsumptionKwh' in hour)));
    assert.ok(h.forecast(1)!.consumption!.hourly.every(hour => hour.estimatedConsumptionKwh === powerW / 1000));
  }
});

test('consumption quarters, chart totals, planning and saved predictions share the same frozen series', async () => {
  const saved = new Map<string, EnergyEstimatePoint>();
  const capture = (forecasts: EnergyForecast[], at: Date) => {
    for (const point of energyEstimatePoints(forecasts, at)) saved.set(point.start, point);
  };
  const h = fixture('2026-10-25T12:00:00Z', undefined, undefined, capture);
  await h.service.recalculate();
  h.setTime('2026-10-25T12:15:00Z'); h.consumption.baselinePowerW = 2000;
  await h.service.recalculate();
  h.setTime('2026-10-25T12:30:00Z'); h.consumption.baselinePowerW = 3000;
  await h.service.recalculate();
  const consumption = h.forecast(0)!.consumption!;
  const quarters = consumption.quarterHourly!.filter(point => point.start.startsWith('2026-10-25T12:'));
  assert.deepEqual(quarters.map(point => point.estimatedConsumptionKwh), [.25, .25, .5, .75]);
  close(consumption.hourly.find(hour => hour.start === '2026-10-25T12:00:00.000Z')!.estimatedConsumptionKwh, 1.75);
  assert.deepEqual(h.service.planningForecast(0).consumption, consumption);
  assert.deepEqual(quarters.map(point => point.estimatedConsumptionKwh), quarters.map(point => saved.get(point.start)!.estimatedConsumptionKwh));
  h.setTime('2026-10-25T13:00:00Z'); h.consumption.baselinePowerW = 9000;
  await h.service.recalculate();
  assert.deepEqual(h.forecast(0)!.consumption!.quarterHourly!.filter(point => point.start.startsWith('2026-10-25T12:')), quarters);
});

test('consumption startup restores every started quarter, including zero, and refreshes only future quarters', async () => {
  const reads: string[] = [];
  const h = fixture('2026-10-25T12:37:00Z', undefined, undefined, undefined, undefined, async date => {
    reads.push(date);
    return [11, 12].flatMap(hour => Array.from({ length: 4 }, (_, quarter) => ({
      start: new Date(Date.UTC(2026, 9, 25, hour, quarter * 15)).toISOString(),
      end: new Date(Date.UTC(2026, 9, 25, hour, (quarter + 1) * 15)).toISOString(),
      estimatedConsumptionKwh: quarter === 0 ? 0 : .5,
    })));
  });
  h.consumption.baselinePowerW = 4000;
  await h.service.recalculate();
  const today = h.forecast(0)!.consumption!;
  assert.deepEqual(today.quarterHourly!.filter(point => point.start.startsWith('2026-10-25T12:')).map(point => point.estimatedConsumptionKwh), [0, .5, .5, 1]);
  close(today.hourly.find(hour => hour.start === '2026-10-25T11:00:00.000Z')!.estimatedConsumptionKwh, 1.5);
  assert.deepEqual(h.service.planningForecast(0).consumption, today);
  assert.deepEqual(reads, forecastDayOffsets.map(offset => h.date(offset)));
  h.setTime('2026-10-25T13:00:00Z'); h.consumption.baselinePowerW = 8000;
  await h.service.recalculate();
  close(h.forecast(0)!.consumption!.hourly.find(hour => hour.start === '2026-10-25T12:00:00.000Z')!.estimatedConsumptionKwh, 2);
  assert.deepEqual(reads, forecastDayOffsets.map(offset => h.date(offset)));
});

test('consumption restoration failures keep the previous published batch and can retry safely', async () => {
  let attempts = 0;
  const failure = new Error('consumption history temporarily unavailable');
  const h = fixture(undefined, undefined, undefined, undefined, undefined, async () => {
    if (++attempts === 1) throw failure;
    return [];
  });
  await assert.rejects(h.service.recalculate(), failure);
  assert.equal(h.forecast(0), null);
  await h.service.recalculate();
  assert.equal(attempts, 18);
  assert.ok(h.forecast(0)!.consumption!.quarterHourly!.length);
});

test('consumption restart restoration keeps the two repeated Zurich autumn hours distinct', async () => {
  const h = fixture('2026-10-25T02:00:00Z', undefined, undefined, undefined, undefined, async () => [0, 1].flatMap(hour =>
    Array.from({ length: 4 }, (_, quarter) => ({
      start: new Date(Date.UTC(2026, 9, 25, hour, quarter * 15)).toISOString(),
      end: new Date(Date.UTC(2026, 9, 25, hour, (quarter + 1) * 15)).toISOString(), estimatedConsumptionKwh: hour + .25,
    }))));
  await h.service.recalculate();
  const value = h.forecast(0)!.consumption!;
  assert.equal(value.quarterHourly!.length, 100);
  assert.equal(new Set(value.quarterHourly!.map(point => point.start)).size, 100);
  close(value.hourly.find(hour => hour.start === '2026-10-25T00:00:00.000Z')!.estimatedConsumptionKwh, 1);
  close(value.hourly.find(hour => hour.start === '2026-10-25T01:00:00.000Z')!.estimatedConsumptionKwh, 5);
});

test('history I/O crossing a quarter boundary uses one cutoff for consumption retention and capture', async () => {
  const captured: string[] = [];
  const h = fixture('2026-10-25T12:14:59Z', undefined, undefined, (_forecasts, at) => { captured.push(at.toISOString()); },
    undefined, async date => {
      if (date !== '2026-10-25') return [];
      h.setTime('2026-10-25T12:15:01Z');
      return [{ start: '2026-10-25T12:15:00.000Z', end: '2026-10-25T12:30:00.000Z', estimatedConsumptionKwh: .25 }];
    });
  h.consumption.baselinePowerW = 2000;
  await h.service.recalculate();
  assert.deepEqual(captured, ['2026-10-25T12:15:01.000Z']);
  const consumption = h.forecast(0)!.consumption!;
  close(consumption.quarterHourly!.find(point => point.start === '2026-10-25T12:15:00.000Z')!.estimatedConsumptionKwh, .25);
  assert.deepEqual(h.service.planningForecast(0).consumption, consumption);
});

test('history I/O crossing midnight refreshes the new day current quarter at the actual cutoff', async () => {
  const h = fixture('2026-10-25T23:59:59+01:00', undefined, undefined, undefined, undefined, async date => {
    if (date === '2026-10-25') h.setTime('2026-10-26T00:00:01+01:00');
    return date === '2026-10-26'
      ? [{ start: '2026-10-25T23:00:00.000Z', end: '2026-10-25T23:15:00.000Z', estimatedConsumptionKwh: .125 }] : [];
  });
  h.consumption.baselinePowerW = 2000;
  await h.service.recalculate();
  assert.equal(h.forecast(0)!.date, '2026-10-26');
  close(h.forecast(0)!.consumption!.quarterHourly![0].estimatedConsumptionKwh, .125);
});

test('future battery use keeps the started quarter from the shared consumption series', async () => {
  const h = fixture('2026-10-25T18:07:00Z');
  await h.service.recalculate();
  h.setTime('2026-10-25T18:15:00Z');
  h.consumption.baselinePowerW = 2000;
  await h.service.recalculate();
  const displayedHour = h.forecast(0)!.consumption!.hourly.find(hour => hour.start === '2026-10-25T18:00:00.000Z')!;
  close(displayedHour.estimatedConsumptionKwh, 1.5);
  const points = h.service.projection().points;
  assert.equal(points[0].at, '2026-10-25T18:15:00.000Z');
  assert.equal(points[1].at, '2026-10-25T18:20:00.000Z');
  const storedEnergyUsed = (points[0].socPercent - points[1].socPercent) / 100 * 60;
  close(storedEnergyUsed, 1 / Math.sqrt(.95) * 5 / 60);
});

test('hourly solar refreshes preserve the started quarter and replace future production for both forecast days', async () => {
  const h = fixture();
  await h.service.recalculate();
  const before = h.forecast(0)!;
  h.state.solarLevel = 5;
  h.setTime('2026-10-25T13:00:00Z');
  await h.service.recalculate();
  const today = h.forecast(0)!;
  assert.equal(today.hourly!.find(hour => hour.start === '2026-10-25T11:00:00.000Z')!.estimatedProductionKwh,
    before.hourly!.find(hour => hour.start === '2026-10-25T11:00:00.000Z')!.estimatedProductionKwh);
  assert.equal(today.hourly!.find(hour => hour.start === '2026-10-25T13:00:00.000Z')!.estimatedProductionKwh, 4.5);
  assert.equal(h.forecast(1)!.hourly!.find(hour => hour.start === '2026-10-26T11:00:00.000Z')!.estimatedProductionKwh, 5);
  close(today.estimatedProductionKwh!, Math.round(today.hourly!.reduce((sum, hour) => sum + hour.estimatedProductionKwh, 0) * 10) / 10);
});

test('Zurich midnight and DST batches retain correct calendar dates, interval counts and complete horizons', async () => {
  for (const [origin, currentDate, nextDate, count] of [
    ['2026-03-29T00:15:00+01:00', '2026-03-29', '2026-03-30', 23],
    ['2026-10-25T02:15:00+02:00', '2026-10-25', '2026-10-26', 25],
    ['2026-10-25T02:15:00+01:00', '2026-10-25', '2026-10-26', 25],
    ['2027-01-01T00:00:00+01:00', '2027-01-01', '2027-01-02', 24],
  ] as const) {
    const h = fixture(origin);
    await h.service.recalculate();
    assert.equal(h.forecast(0)!.date, currentDate);
    assert.equal(h.forecast(1)!.date, nextDate);
    assert.equal(h.forecast(0)!.hourly!.length, count);
    assert.equal(h.forecast(0)!.consumption!.dayHours, count);
    const finalDay = new Date(Date.parse(`${currentDate}T00:00:00Z`) + 7 * 86_400_000);
    assert.equal(h.service.projection().points.at(-1)!.at, getCalendarDayBounds(finalDay).end.toISOString());
  }
});

test('a midnight batch maps the former tomorrow to today and exposes a newly refreshed tomorrow', async () => {
  const h = fixture('2026-10-25T23:45:00+01:00');
  await h.service.recalculate();
  h.setTime('2026-10-26T00:00:00+01:00');
  await h.service.recalculate();
  assert.equal(h.forecast(0)!.date, '2026-10-26');
  assert.equal(h.forecast(1)!.date, '2026-10-27');
  assert.equal(h.forecast(0)!.hourly![0].start, '2026-10-25T23:00:00.000Z');
  assert.equal(h.calls.solar.length, 18);
});

test('returned public and controller snapshots cannot mutate the published batch', async () => {
  const h = fixture();
  await h.service.recalculate();
  const before = { forecast: h.forecast(0), projection: h.service.projection(), planner: h.service.planner(), planning: h.service.planningForecast(0) };
  h.forecast(0)!.hourly![0].estimatedProductionKwh = 999;
  h.forecast(0)!.consumption!.hourly[0].estimatedConsumptionKwh = 999;
  h.service.projection().points[0].socPercent = 0;
  h.service.planner()!.battery.socPercent = 0;
  h.service.planningForecast(0).hourly![0].estimatedProductionKwh = 999;
  assert.deepEqual(h.forecast(0), before.forecast);
  assert.deepEqual(h.service.projection(), before.projection);
  assert.deepEqual(h.service.planner(), before.planner);
  assert.deepEqual(h.service.planningForecast(0), before.planning);
});

test('mutating a provider response cannot change retained controller inputs between scheduled batches', async () => {
  const h = fixture();
  await h.service.recalculate();
  const planning = h.service.planningForecast(0);
  const published = h.forecast(0);
  h.sourceObjects[0].hourly![0].estimatedProductionKwh = 999;
  h.sourceObjects[0].temperatureMeanC = -20;
  assert.deepEqual(h.service.planningForecast(0), planning);
  assert.deepEqual(h.forecast(0), published);
});

test('battery invalidation clears predictions immediately and returning to auto waits for the next batch', async () => {
  const h = fixture();
  await h.service.recalculate();
  const household = h.forecast(0);
  const counts = structuredClone(h.calls);
  assert.equal(h.service.projection().status, 'available');
  assert.notEqual(h.service.planner(), null);
  h.automation.status = 'manual_override';
  h.service.invalidateBattery();
  assert.equal(h.service.planner(), null);
  assert.equal(h.service.projection().status, 'unavailable');
  assert.deepEqual(h.forecast(0), household);
  h.automation.status = 'idle';
  assert.equal(h.service.planner(), null);
  assert.equal(h.service.projection().status, 'unavailable');
  assert.deepEqual(h.calls, counts, 'invalidation and return-to-auto must not calculate on demand');
  h.setTime('2026-10-25T12:15:00Z');
  await h.service.recalculate();
  assert.equal(h.service.projection().status, 'available');
  assert.notEqual(h.service.planner(), null);
});

test('manual charging projections publish on the scheduled batch while automatic plans remain hidden', async () => {
  const h = fixture();
  await h.service.recalculate();
  h.automation.status = 'manual_override';
  Object.assign(h.control, { mode: 'manual', powerKw: 3, targetSocPercent: 80 });
  assert.equal(h.service.projection().status, 'unavailable', 'old automatic assumptions cannot survive a manual takeover');
  h.service.invalidateBattery();
  const before = structuredClone(h.calls);
  assert.equal(h.service.projection().status, 'unavailable');
  assert.equal(h.service.planner(), null);
  assert.deepEqual(h.calls, before, 'manual projections also wait for a scheduled calculation');
  h.setTime('2026-10-25T12:15:00Z');
  await h.service.recalculate();
  assert.equal(h.service.projection().status, 'available');
  assert.equal(h.service.projection().assumption, 'manual_charging');
  assert.deepEqual(h.records.at(-1)!.projection, h.service.projection());
  assert.equal(h.service.planner(), null, 'a manual forecast never enables the automatic planner');
  const manual = h.service.projection();
  h.control.powerKw = 2;
  h.service.invalidateBattery();
  assert.equal(h.service.projection().status, 'unavailable', 'changed manual power invalidates the captured curve');
  h.setTime('2026-10-25T12:30:00Z');
  await h.service.recalculate();
  assert.equal(h.service.projection().assumption, 'manual_charging');
  assert.notDeepEqual(h.service.projection(), manual);
  h.automation.status = 'idle';
  assert.equal(h.service.projection().status, 'unavailable', 'old manual assumptions cannot survive a return to auto');
});

test('confirmed manual charging forecasts remain readable when battery automation is disabled', async () => {
  const h = fixture();
  h.automation.enabled = false;
  h.automation.status = 'disabled';
  Object.assign(h.control, { mode: 'manual', powerKw: 3, targetSocPercent: 80 });
  await h.service.recalculate();
  assert.equal(h.service.projection().status, 'available');
  assert.equal(h.service.projection().assumption, 'manual_charging');
  assert.equal(h.service.planner(), null);
});

test('manual invalidation during publication cannot revive an already-captured battery prediction', async () => {
  const h = fixture();
  await h.service.recalculate();
  h.setTime('2026-10-25T12:15:00Z');
  h.gates.publish = deferred();
  const pending = h.service.recalculate();
  await settle();
  assert.equal(h.calls.publish, 2, 'the new projection has been captured and is waiting for archival');
  h.automation.status = 'manual_override';
  h.service.invalidateBattery();
  h.automation.status = 'idle';
  h.gates.publish.resolve();
  await pending;
  assert.equal(h.service.projection().status, 'unavailable');
  assert.equal(h.service.planner(), null);
  assert.equal(h.forecast(0)!.date, '2026-10-25', 'household publication remains available');
  h.setTime('2026-10-25T12:30:00Z');
  await h.service.recalculate();
  assert.equal(h.service.projection().status, 'available');
});

test('charge completion estimates are frozen per batch, isolated from live mutation, and validated against captured control', async () => {
  const h = fixture();
  Object.assign(h.control, { mode: 'manual', powerKw: 6, targetSocPercent: 80,
    automated: true, automationOwner: 'test-owner', automationMode: 'charge' });
  const initial: BatteryChargeEstimate = { status: 'available', targetSocPercent: 80, remainingMinutes: 83,
    observedAt: h.now().toISOString(), estimatedCompletionAt: '2026-10-25T13:30:00.000Z', method: 'soc_trend' };
  h.control.chargeEstimate = structuredClone(initial);
  await h.service.recalculate();
  const captured = h.service.chargeEstimate!(h.control);
  assert.deepEqual(captured, initial);
  h.control.chargeEstimate.remainingMinutes = 60;
  assert.deepEqual(h.service.chargeEstimate!(h.control), initial, 'new live ETA data waits for the next batch');
  captured!.remainingMinutes = 1;
  assert.deepEqual(h.service.chargeEstimate!(h.control), initial, 'public ETA objects are isolated');
  for (const changed of [
    { available: false }, { mode: 'auto' as const }, { powerKw: 5 }, { targetSocPercent: 90 }, { automationOwner: 'replacement-owner' },
  ]) assert.equal(h.service.chargeEstimate!({ ...h.control, ...changed }), null);
  h.service.invalidateBattery();
  assert.equal(h.service.chargeEstimate!(h.control), null);
  h.setTime('2026-10-25T12:15:00Z');
  await h.service.recalculate();
  assert.equal(h.service.chargeEstimate!(h.control)!.remainingMinutes, 60);
});

test('independent solar quarters refresh hourly and freeze started quarters in displays and archives', async () => {
  const captures: SolarForecast[][] = [];
  const h = fixture('2026-10-25T12:07:00Z', undefined, forecasts => { captures.push(forecasts); });
  h.state.quarterSolar = true;
  await h.service.recalculate();
  const before = h.forecast(0)!;
  const hour = (forecast: SolarForecast, at: string) => forecast.quarterHourly!.filter(point => point.start >= at
    && point.start < new Date(Date.parse(at) + 3600000).toISOString()).map(point => point.estimatedProductionKwh);
  assert.deepEqual(hour(before, '2026-10-25T12:00:00.000Z'), [.3, .6, .9, 1.2]);
  h.state.solarLevel = 9;
  for (const time of ['12:15', '12:30', '12:45']) {
    h.setTime(`2026-10-25T${time}:00Z`); await h.service.recalculate();
    assert.deepEqual(h.forecast(0)!.quarterHourly, before.quarterHourly);
  }
  assert.equal(h.calls.solar.length, 9);
  assert.equal(captures.length, 4);
  h.setTime('2026-10-25T13:00:00Z'); await h.service.recalculate();
  const after = h.forecast(0)!;
  assert.deepEqual(hour(after, '2026-10-25T12:00:00.000Z'), [.3, .6, .9, 1.2]);
  const next = hour(after, '2026-10-25T13:00:00.000Z');
  for (const [index, value] of [.3, 1.8, 2.7, 3.6].entries()) close(next[index], value);
  assert.equal(h.calls.solar.length, 18);
  assert.deepEqual(captures[4][0].quarterHourly, after.quarterHourly);
  close(after.estimatedProductionKwh!, Math.round(after.quarterHourly!.reduce((sum, point) => sum + point.estimatedProductionKwh, 0) * 10) / 10);
});

test('startup restores each started native solar quarter without flattening the current hour', async () => {
  const h = fixture('2026-10-25T12:37:00Z', undefined, undefined, undefined, async () => [
    { start: '2026-10-25T12:00:00.000Z', end: '2026-10-25T12:15:00.000Z', estimatedProductionKwh: 0 },
    { start: '2026-10-25T12:15:00.000Z', end: '2026-10-25T12:30:00.000Z', estimatedProductionKwh: .7 },
    { start: '2026-10-25T12:30:00.000Z', end: '2026-10-25T12:45:00.000Z', estimatedProductionKwh: .8 },
  ]);
  h.state.quarterSolar = true;
  await h.service.recalculate();
  const values = h.forecast(0)!.quarterHourly!.filter(point => point.start.startsWith('2026-10-25T12:'));
  for (const [index, value] of [0, .7, .8, 1.2].entries()) close(values[index].estimatedProductionKwh, value);
  close(h.forecast(0)!.hourly!.find(point => point.start === '2026-10-25T12:00:00.000Z')!.estimatedProductionKwh, 2.7);
});

test('startup restores the active solar quarter during the first quarter of a Zurich day', async () => {
  const h = fixture('2026-10-25T23:07:00Z', undefined, undefined, undefined, async date => date === '2026-10-26' ? [
    { start: '2026-10-25T23:00:00.000Z', end: '2026-10-25T23:15:00.000Z', estimatedProductionKwh: .42 },
  ] : []);
  h.state.quarterSolar = true;
  await h.service.recalculate();
  close(h.forecast(0)!.quarterHourly![0].estimatedProductionKwh, .42);
});

test('restart restores saved future solar days when individual provider reads fail, preserving the battery horizon', async () => {
  const first = fixture('2026-10-27T12:07:00Z'); await first.service.recalculate();
  const restored: string[] = [];
  const next = fixture('2026-10-27T13:00:00Z', undefined, undefined, undefined, undefined, undefined, async date => {
    restored.push(date);
    return first.forecast(forecastDayOffsets.find(offset => first.date(offset) === date)!);
  });
  for (const offset of [2, 3, 4]) next.state.failSolarOffsets.add(offset);
  await next.service.recalculate();
  assert.deepEqual(restored.sort(), ['2026-10-29', '2026-10-30', '2026-10-31']);
  for (const offset of [2, 3, 4] as const) {
    assert.equal(next.forecast(offset)!.status, 'stale');
    assert.equal(next.forecast(offset)!.fetchedAt, first.forecast(offset)!.fetchedAt);
    assert.deepEqual(next.forecast(offset)!.quarterHourly, first.forecast(offset)!.quarterHourly);
  }
  assert.equal(next.service.projection().status, 'available');
  assert.equal(next.service.projection().reason, null);
  assert.equal(next.service.projection().points.at(-1)!.at, getCalendarDayBounds(new Date(`${next.date(7)}T00:00:00Z`)).end.toISOString());
});

test('disabled automation still publishes passive battery forecasts without enabling the planner', async () => {
  const h = fixture(); h.automation.enabled = false; h.automation.status = 'disabled';
  await h.service.recalculate();
  assert.equal(h.service.projection().status, 'available');
  assert.equal(h.service.projection().assumption, 'passive_operation');
  assert.equal(h.service.planner(), null);
  assert.ok(h.records.at(-1)!.projection.points.length > 0);
});

test('a failed saved-solar read aborts the batch instead of publishing missing future days', async () => {
  const h = fixture(undefined, undefined, undefined, undefined, undefined, undefined, async () => {
    throw new Error('saved forecast unavailable');
  });
  h.state.failSolarOffsets.add(2);
  await assert.rejects(h.service.recalculate(), /saved forecast unavailable/);
  assert.equal(h.calls.publish, 0);
  assert.equal(h.service.status().calculatedAt, null);
});

test('missing 29–31 October solar retries next quarter while 1 November stays intact and battery coverage recovers', async () => {
  const h = fixture('2026-10-27T12:07:00Z');
  for (const offset of [2, 3, 4]) h.state.failSolarOffsets.add(offset);
  await h.service.recalculate();
  for (const offset of [2, 3, 4] as const) assert.equal(h.forecast(offset)!.status, 'offline');
  const later = h.forecast(5)!;
  assert.equal(later.date, '2026-11-01'); assert.equal(later.status, 'online');
  assert.equal(h.service.projection().reason, 'forecast_unavailable');
  h.state.failSolarOffsets.clear(); h.setTime('2026-10-27T12:15:00Z');
  await h.service.recalculate();
  assert.deepEqual(h.calls.solar.slice(9).map(call => call.offset), [2, 3, 4]);
  for (const offset of [2, 3, 4] as const) assert.equal(h.forecast(offset)!.status, 'online');
  assert.deepEqual(h.forecast(5), later);
  assert.equal(h.service.projection().status, 'available'); assert.equal(h.service.projection().reason, null);
  assert.equal(h.service.projection().points.at(-1)!.at, '2026-11-03T23:00:00.000Z');
});
