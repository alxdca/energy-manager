import test from 'node:test';
import assert from 'node:assert/strict';
import { solarIntervals } from '../src/solar-intervals.js';
import { forecastLoadSegments } from '../src/car-load.js';
import { planBatteryCharge, type AutomationConfig, type EnergyForecast } from '../src/automation-plan.js';
import { projectBatterySoc } from '../src/battery-projection.js';
import { buildPlannerDetails } from '../src/planner-details.js';
import { estimateConsumption } from '../src/consumption.js';
import { emptySolarForecast } from '../src/forecast.js';
import type { AutomationControllerState, AutomationStatus } from '../src/automation.js';
import type { Telemetry } from '../src/status.js';

const hourMs = 3_600_000, quarterMs = 900_000;
const config: AutomationConfig = { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5,
  energyBufferPercent: 0, minimumEnergyBufferKwh: 0, afternoonTargetSocPercent: 0 };
const control: AutomationControllerState = { available: true, mode: 'auto', powerKw: null, targetSocPercent: null,
  limits: { maxPowerKw: 6, maxSocPercent: 100, reserveSocPercent: 5 }, revertTimeoutSeconds: 30, error: null };
const automatic: AutomationStatus = { enabled: true, status: 'idle', lastEvaluatedAt: null, nextEvaluationAt: null,
  targetSocPercent: null, holdUntil: null, reason: 'awaiting_evaluation', plan: null, error: null };
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function observation(at: Date, soc = 50): Telemetry {
  return { status: 'online', observedAt: at.toISOString(), error: null, solarKw: 0, householdKw: 1,
    gridImportKw: 1, gridExportKw: 0, batterySocPercent: soc, batteryChargeKw: 0, batteryDischargeKw: 0 };
}
function fixture(date = '2026-01-15', at = new Date('2026-01-15T12:00:00Z')): EnergyForecast {
  const consumption = estimateConsumption(date, { baselinePowerW: 1000 });
  const hourly = consumption.hourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: 0, temperatureC: null }));
  return { ...emptySolarForecast(date, null), status: 'online', fetchedAt: at.toISOString(), estimatedProductionKwh: 0,
    consumption, hourly,
    quarterHourly: hourly.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
      start: new Date(Date.parse(hour.start) + index * quarterMs).toISOString(),
      end: new Date(Date.parse(hour.start) + (index + 1) * quarterMs).toISOString(),
      estimatedProductionKwh: 0, temperatureC: null,
    }))) };
}
function setHour(data: EnergyForecast, start: string, energies: number[]) {
  for (const [index, value] of energies.entries()) data.quarterHourly!.find(slot => Date.parse(slot.start) === Date.parse(start) + index * quarterMs)!.estimatedProductionKwh = value;
  data.hourly!.find(hour => hour.start === start)!.estimatedProductionKwh = energies.reduce((sum, value) => sum + value, 0);
  data.estimatedProductionKwh = Math.round(data.hourly!.reduce((sum, hour) => sum + hour.estimatedProductionKwh, 0) * 10) / 10;
}

test('native solar quarters preserve independent energies and actual overlap when making load segments', () => {
  const data = fixture();
  setHour(data, '2026-01-15T12:00:00.000Z', [.1, .2, .3, .4]);
  const start = Date.parse('2026-01-15T12:00:00Z');
  const segments = forecastLoadSegments(data, start, start + hourMs)!;
  assert.deepEqual(segments.map(segment => segment.solarKwh), [.1, .2, .3, .4]);
  assert.deepEqual(segments.map(segment => segment.loadKwh), [.25, .25, .25, .25]);
  close(forecastLoadSegments(data, start + quarterMs / 2, start + quarterMs)![0].solarKwh, .05);
  const incomplete = { ...data, quarterHourly: undefined };
  assert.equal(solarIntervals(incomplete), null);
  assert.equal(forecastLoadSegments(incomplete, start, start + quarterMs), null);
});

test('malformed native quarter profiles fail closed in helper, planner, projection and detail totals', () => {
  const at = new Date('2026-01-15T12:00:00Z');
  for (const mutate of [
    (data: EnergyForecast) => { data.quarterHourly!.pop(); },
    (data: EnergyForecast) => { data.quarterHourly![0].start = data.quarterHourly![0].start.slice(0, -1); },
    (data: EnergyForecast) => { data.quarterHourly![1].start = data.quarterHourly![0].start; },
    (data: EnergyForecast) => { data.quarterHourly![0].estimatedProductionKwh = -1; },
    (data: EnergyForecast) => { data.quarterHourly![0].estimatedProductionKwh = 1; },
    (data: EnergyForecast) => { data.quarterHourly![0].end = data.quarterHourly![1].end; },
  ]) {
    const data = fixture(undefined, at); mutate(data);
    assert.equal(solarIntervals(data), null);
    assert.equal(forecastLoadSegments(data, +at, +at + hourMs), null);
    assert.equal(planBatteryCharge(at, observation(at), data, config, control.limits).action, 'blocked');
    assert.equal(projectBatterySoc(at, observation(at), control, automatic, [data], config).status, 'unavailable');
    assert.equal(buildPlannerDetails(at, observation(at), control, automatic, data, config).highTariff.estimatedProductionKwh, null);
  }
});

test('battery trajectory and required charge respond to quarter chronology despite equal hourly totals', () => {
  const at = new Date('2026-01-15T16:00:00Z'); //17:00 Zurich; high tariff.
  const early = fixture(undefined, at), late = fixture(undefined, at);
  setHour(early, at.toISOString(), [.5, .5, 0, 0]);
  setHour(late, at.toISOString(), [0, 0, .5, .5]);
  const until = new Date(+at + 2 * quarterMs);
  const earlyProjection = projectBatterySoc(at, observation(at), control, { ...automatic, status: 'blocked' }, [early], config, until);
  const lateProjection = projectBatterySoc(at, observation(at), control, { ...automatic, status: 'blocked' }, [late], config, until);
  assert.ok(earlyProjection.points.at(-1)!.socPercent > 50);
  assert.ok(lateProjection.points.at(-1)!.socPercent < 50);
  assert.equal(early.estimatedProductionKwh, late.estimatedProductionKwh);
  const planningAt = new Date('2026-01-15T12:00:00Z');
  early.fetchedAt = late.fetchedAt = planningAt.toISOString();
  for (const data of [early, late]) {
    for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = hour.start === at.toISOString() ? 1 : 0;
    for (const quarter of data.consumption.quarterHourly) quarter.estimatedConsumptionKwh =
      quarter.start >= at.toISOString() && quarter.start < new Date(+at + hourMs).toISOString() ? .25 : 0;
    data.consumption.estimatedConsumptionKwh = 1;
  }
  const earlyPlan = planBatteryCharge(planningAt, observation(planningAt, 5), early, config, control.limits);
  const latePlan = planBatteryCharge(planningAt, observation(planningAt, 5), late, config, control.limits);
  assert.equal(earlyPlan.action, 'charge');
  assert.equal(latePlan.action, 'charge');
  assert.ok(earlyPlan.requiredStoredKwh! < latePlan.requiredStoredKwh!, 'early surplus can fund the preceding demand while late surplus cannot');
});

test('remaining solar detail totals use the real remaining quarters rather than an hourly mean', () => {
  const at = new Date('2026-01-15T16:30:00Z');
  const data = fixture(undefined, at);
  setHour(data, '2026-01-15T16:00:00.000Z', [.1, .2, .3, .4]);
  const result = buildPlannerDetails(at, observation(at), control, automatic, data, config).highTariff;
  close(result.estimatedProductionKwh, 1);
  close(result.remainingProductionKwh, .7);
});

test('native quarters cover92 or100 distinct UTC intervals across Zurich DST changes', () => {
  for (const [date, count] of [['2026-03-29', 92], ['2026-10-25', 100]] as const) {
    const data = fixture(date);
    assert.equal(solarIntervals(data)!.length, count);
    assert.equal(new Set(solarIntervals(data)!.map(interval => interval.start)).size, count);
    const start = Date.parse(data.hourly![0].start), end = Date.parse(data.hourly!.at(-1)!.end);
    const segments = forecastLoadSegments(data, start, end)!;
    assert.equal(segments.length, count);
    close(segments.reduce((sum, segment) => sum + segment.loadKwh, 0), count / 4);
  }
});
