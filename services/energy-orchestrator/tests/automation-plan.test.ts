import test from 'node:test';
import assert from 'node:assert/strict';
import { nextNightHighTariffReserve, planBatteryCharge, type AutomationConfig, type EnergyForecast } from '../src/automation-plan.js';
import { estimateConsumption, loadConsumptionConfig } from '../src/consumption.js';
import { getCalendarDayBounds } from '../src/policy.js';
import type { Telemetry } from '../src/status.js';

const config: AutomationConfig = { enabled: true, socCapacityKwh: 60, reserveSocPercent: 5, energyBufferPercent: 0, minimumEnergyBufferKwh: 0, afternoonTargetSocPercent: 0 };
const limits = { maxPowerKw: 6, maxSocPercent: 100 };
const legEfficiency = Math.sqrt(0.95);
const afternoon = new Date('2026-10-24T12:00:00Z'); // 14:00 Zurich
function telemetry(now = afternoon, soc = 10): Telemetry {
  return { status: 'online', observedAt: now.toISOString(), error: null, solarKw: 0, householdKw: 1,
    gridImportKw: 1, gridExportKw: 0, batterySocPercent: soc, batteryChargeKw: 0, batteryDischargeKw: 0 };
}
function forecast(date = '2026-10-24', now = afternoon): EnergyForecast {
  const consumption = estimateConsumption(date, { ...loadConsumptionConfig({}), baselinePowerW: 1000 });
  const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  return { status: 'online', date, locationName: 'Installation de démonstration', estimatedProductionKwh: 0,
    quarterHourly: consumption.quarterHourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: 0, temperatureC: 10 })),
    hourly: consumption.hourly.map(hour => ({ start: hour.start, end: hour.end, estimatedProductionKwh: 0, temperatureC: 10 })),
    weatherCode: 0, temperatureMinC: 10, temperatureMaxC: 10, temperatureMeanC: 10,
    fetchedAt: now.toISOString(), source: 'Open-Meteo', model: 'east_west_tilted_radiation', arrayPowerKw: 8.5,
    performanceRatio: 0.85, panelTiltDegrees: 15, eastFraction: 0.5, weatherModel: 'meteoswiss_icon_ch2',
    productionPeriodStart: bounds.start.toISOString(), productionPeriodEnd: bounds.end.toISOString(), error: null, consumption };
}
function reconcile(data: EnergyForecast): EnergyForecast {
  syncQuarters(data);
  data.estimatedProductionKwh = Math.round(data.hourly!.reduce((sum, hour) => sum + hour.estimatedProductionKwh, 0) * 10) / 10;
  data.consumption.estimatedConsumptionKwh = data.consumption.hourly.reduce((sum, hour) => sum + hour.estimatedConsumptionKwh, 0);
  return data;
}
function plan(now = afternoon, data = forecast(), settings = config, soc = 10) {
  return planBatteryCharge(now, telemetry(now, soc), data, settings, limits);
}
function close(actual: number | null | undefined, expected: number) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
}

function syncQuarters(data: EnergyForecast) {
  data.quarterHourly = data.hourly!.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(),
    estimatedProductionKwh: hour.estimatedProductionKwh / 4, temperatureC: hour.temperatureC,
  })));
  data.consumption.quarterHourly = data.consumption.hourly.flatMap(hour => Array.from({ length: 4 }, (_, index) => ({
    start: new Date(Date.parse(hour.start) + index * 900_000).toISOString(),
    end: new Date(Date.parse(hour.start) + (index + 1) * 900_000).toISOString(),
    estimatedConsumptionKwh: hour.estimatedConsumptionKwh / 4,
  })));
}

test('afternoon target covers the entire 17–23 high tariff at exactly 6 kW', () => {
  const result = plan();
  assert.equal(result.action, 'charge');
  assert.equal(result.powerKw, 6);
  assert.equal(result.window, 'afternoon');
  assert.equal(result.windowEndsAt, '2026-10-24T14:55:00.000Z');
  close(result.requiredStoredKwh, 3 + (6 + 1/12) / legEfficiency);
  assert.equal(result.targetSocPercent, 15.5);
  assert.equal(result.unmetKwh, 0);
});

test('a narrow usable-energy margin triggers a 6 kW top-up for the minimum 1 kWh buffer', () => {
  const data = forecast();
  // After discharge losses, this evening needs exactly 10.1 kWh from storage.
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 10.1 * legEfficiency / (6 + 1/12);
  reconcile(data);
  const soc = (3 + 10.6) / 60 * 100;
  const unbuffered = plan(afternoon, data, config, soc);
  assert.equal(unbuffered.action, 'hold');
  const result = plan(afternoon, data, { ...config, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 }, soc);
  assert.equal(result.action, 'charge');
  assert.equal(result.powerKw, 6);
  assert.equal(result.energyBufferKwh, 1);
  close(result.requiredStoredKwh, 3 + 10.1 + 1);
  assert.equal(result.targetSocPercent, 23.5);
  close(result.shortfallKwh, .5); // Rounded up to 0.1% SOC.
});

test('the energy buffer is added once after solar credit during overnight planning', () => {
  const at = new Date('2026-01-14T22:15:00Z');
  const data = forecast('2026-01-15', at);
  for (let index = 10; index < 15; index++) data.hourly![index].estimatedProductionKwh = 4;
  reconcile(data);
  const baseline = plan(at, data);
  const buffered = plan(at, data, { ...config, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 });
  close(buffered.requiredStoredKwh, baseline.requiredStoredKwh! + 1);
  assert.equal(buffered.energyBufferKwh, 1);
});

test('buffer scales at 5% above 20 kWh and excludes reserve and cheap-tariff demand', () => {
  const settings = { ...config, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 };
  for (const [needs, expected] of [[10.1, 1], [20, 1], [30, 1.5], [40, 2]]) {
    const data = forecast();
    for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = needs * legEfficiency / 6;
    // A large cheap-tariff demand must not inflate the percentage of the 17–23 period.
    data.consumption.hourly.find(hour => hour.start === '2026-10-24T14:00:00.000Z')!.estimatedConsumptionKwh = 40;
    reconcile(data);
    const result = plan(afternoon, data, settings);
    close(result.energyBufferKwh, expected);
    close(result.requiredStoredKwh, plan(afternoon, data).requiredStoredKwh! + expected);
  }
});

test('solar offsets the percentage basis and overnight margins fund the larger high-tariff period', () => {
  const at = new Date('2026-01-14T22:15:00Z');
  const data = forecast('2026-01-15', at);
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 6;
  reconcile(data);
  const settings = { ...config, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 };
  close(plan(at, data, settings).energyBufferKwh, 36 / legEfficiency * .05);
  for (const hour of data.hourly!) hour.estimatedProductionKwh = 4;
  reconcile(data);
  close(plan(at, data, settings).energyBufferKwh, 1);
});

test('buffered targets retain SOC and time caps and report any unmet margin', () => {
  const settings = { ...config, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 };
  const capped = planBatteryCharge(afternoon, telemetry(), forecast(), settings, { ...limits, maxSocPercent: 15 });
  assert.equal(capped.targetSocPercent, 15);
  close(capped.unmetKwh, 3 + (6 + 1/12) / legEfficiency + 1 - 9);
  const at = new Date('2026-10-24T14:54:00Z');
  const timed = plan(at, forecast('2026-10-24', at), settings, 5);
  close(timed.unmetKwh, timed.requiredStoredKwh! - 3 - 6 / 60 * legEfficiency);
  assert.equal(timed.powerKw, 6);
});

test('a zero-demand forecast still retains the usable buffer above reserve', () => {
  const data = forecast();
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 0;
  const result = plan(afternoon, reconcile(data), { ...config, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 }, 5);
  assert.equal(result.action, 'charge');
  close(result.requiredStoredKwh, 4);
  assert.equal(result.targetSocPercent, 6.7);
  for (const change of [{ minimumEnergyBufferKwh: -1 }, { minimumEnergyBufferKwh: NaN }, { minimumEnergyBufferKwh: Infinity }, { minimumEnergyBufferKwh: 61 }, { energyBufferPercent: -1 }, { energyBufferPercent: NaN }, { energyBufferPercent: 101 }]) {
    assert.equal(plan(afternoon, data, { ...config, ...change }).reason, 'invalid_configuration');
  }
});

test('preserving the battery keeps the afternoon target constant until the charging cutoff', () => {
  const targets = ['12:15:00', '15:00:00', '16:54:59'].map(wall => {
    const now = new Date(`2026-10-24T${wall}+02:00`);
    return plan(now, forecast('2026-10-24', now));
  });
  for (const result of targets) {
    close(result.requiredStoredKwh, 3 + (6 + 1/12) / legEfficiency);
    assert.equal(result.targetSocPercent, targets[0].targetSocPercent);
  }
});

test('remaining daytime solar lowers the intermediate target without changing the evening goal', () => {
  const data = forecast();
  for (let index = 0; index < data.hourly!.length; index++) {
    if (Date.parse(data.hourly![index].end) <= Date.parse('2026-10-24T14:00:00Z')) {
      data.hourly![index].estimatedProductionKwh = 20;
      data.consumption.hourly[index].estimatedConsumptionKwh = 1;
    }
  }
  const result = plan(afternoon, reconcile(data));
  close(result.requiredStoredKwh, 3);
  assert.equal(result.afternoonTargetSocPercent, 15.5);
});

test('only the last five minutes of the 16–17 hour contribute to evening needs', () => {
  const data = forecast();
  data.hourly!.find(hour => hour.start === '2026-10-24T14:00:00.000Z')!.estimatedProductionKwh = 0.8;
  close(plan(afternoon, reconcile(data)).requiredStoredKwh, 3 + (6 + .2/12) / legEfficiency);
});

test('solar chronology cannot fund an earlier deficit with later sunshine', () => {
  const data = forecast();
  data.hourly!.find(hour => hour.start === '2026-10-24T20:00:00.000Z')!.estimatedProductionKwh = 50;
  const result = plan(afternoon, reconcile(data));
  close(result.requiredStoredKwh, 3 + (5 + 1/12) / legEfficiency);
});

test('afternoon consumes all six evening hours and ignores demand after 23:00', () => {
  const data = forecast();
  data.consumption.hourly.at(-1)!.estimatedConsumptionKwh = 100;
  close(plan(afternoon, reconcile(data)).requiredStoredKwh, 3 + (6 + 1/12) / legEfficiency);
});

test('night funds morning use and the afternoon evening-coverage goal across normal and DST days', () => {
  for (const [date, start] of [
    ['2026-01-15', '2026-01-14T23:15:00+01:00'],
    ['2026-03-29', '2026-03-28T23:15:00+01:00'],
    ['2026-10-25', '2026-10-24T23:15:00+02:00'],
  ]) {
    const now = new Date(start);
    const result = plan(now, forecast(date, now));
    assert.equal(result.window, 'night');
    assert.equal(result.forecastDate, date);
    close(result.requiredStoredKwh, 3 + (11 + 1/6) / legEfficiency);
    assert.equal(result.targetSocPercent, 24.1);
    assert.equal(result.powerKw, 6);
    assert.equal(result.action, 'charge');
  }
});

test('large daytime surpluses never remove the protected morning floor', () => {
  const now = new Date('2026-01-14T22:15:00Z');
  const data = forecast('2026-01-15', now);
  const start = Date.parse('2026-01-15T06:00:00+01:00');
  const end = Date.parse('2026-01-15T12:00:00+01:00');
  for (let index = 0; index < data.hourly!.length; index++) {
    const hour = data.hourly![index];
    if (Date.parse(hour.end) <= start || Date.parse(hour.start) >= end) {
      hour.estimatedProductionKwh = 20;
      data.consumption.hourly[index].estimatedConsumptionKwh = 1;
    }
  }
  close(plan(now, reconcile(data)).requiredStoredKwh, 3 + (5 + 1/12) / legEfficiency);
});

test('only the last five minutes of the 06–07 hour contribute to morning needs', () => {
  const now = new Date('2026-01-14T22:15:00Z');
  const data = forecast('2026-01-15', now);
  const index = data.hourly!.findIndex(hour => Date.parse(hour.start) === Date.parse('2026-01-15T06:00:00+01:00'));
  data.consumption.hourly[index].estimatedConsumptionKwh = 4;
  data.hourly![index].estimatedProductionKwh = .8;
  close(plan(now, reconcile(data)).requiredStoredKwh, 3 + (11 + 4.2/12) / legEfficiency);
});

test('late morning sunshine cannot fund the earlier morning deficit', () => {
  const now = new Date('2026-01-14T22:15:00Z');
  const data = forecast('2026-01-15', now);
  data.hourly!.find(hour => Date.parse(hour.start) === Date.parse('2026-01-15T11:00:00+01:00'))!.estimatedProductionKwh = 50;
  close(plan(now, reconcile(data)).requiredStoredKwh, 3 + (10 + 1/6) / legEfficiency - 6 * legEfficiency);
});

test('every charging calculation protects at least 5% even when configured below that floor', () => {
  const night = new Date('2026-01-14T22:15:00Z');
  for (const [at, date] of [
    [afternoon, '2026-10-24'],
    [night, '2026-01-15'],
  ] as const) {
    const settings = config;
    const expected = plan(at, forecast(date, at), settings);
    for (const reserveSocPercent of [0, 4]) {
      const result = plan(at, forecast(date, at), { ...settings, reserveSocPercent });
      close(result.requiredStoredKwh, expected.requiredStoredKwh!);
      assert.equal(result.targetSocPercent, expected.targetSocPercent);
      close(result.shortfallKwh, expected.shortfallKwh!);
    }
  }
  const blocked = planBatteryCharge(afternoon, telemetry(), forecast(), { ...config, reserveSocPercent: 0 },
    { ...limits, maxSocPercent: 5 });
  assert.equal(blocked.reason, 'controller_limits');
});

test('after-midnight plan expects today and preserves the same afternoon goal', () => {
  const now = new Date('2026-01-15T02:00:00Z'); // 03:00
  const data = forecast('2026-01-15', now);
  close(plan(now, data).requiredStoredKwh, 3 + (11 + 1/6) / legEfficiency);
  assert.equal(plan(now, forecast('2026-01-16', now)).reason, 'forecast_wrong_date');
});

test('the solar-adjusted night target stays constant throughout the night charging window', () => {
  for (const wall of ['2026-01-14T23:15:00', '2026-01-15T00:00:00', '2026-01-15T03:00:00', '2026-01-15T06:54:59']) {
    const now = new Date(`${wall}+01:00`);
    const result = plan(now, forecast('2026-01-15', now));
    close(result.requiredStoredKwh, 3 + (11 + 1/6) / legEfficiency);
    assert.equal(result.targetSocPercent, 24.1);
    assert.equal(result.windowEndsAt, '2026-01-15T05:55:00.000Z');
  }
});

test('the required forecast date changes at Zurich midnight', () => {
  for (const iso of ['2026-12-31T22:30:00Z', '2026-12-31T23:30:00Z']) {
    const now = new Date(iso);
    const result = plan(now, forecast('2027-01-01', now));
    assert.equal(result.forecastDate, '2027-01-01');
    assert.notEqual(result.action, 'blocked');
  }
});

test('opening 15-minute and closing 5-minute tariff buffers prohibit charging, with exact inclusive start and exclusive end', () => {
  for (const [wall, allowed] of [['06:54:59', true], ['06:45:00', true], ['06:55:00', false], ['07:00:00', false],
    ['12:00:00', false], ['12:04:59', false], ['12:05:00', true], ['16:54:59', true],
    ['16:45:00', true], ['16:55:00', false], ['17:00:00', false], ['23:00:00', false], ['23:04:59', false], ['23:05:00', true]] as const) {
    const now = new Date(`2026-01-15T${wall}+01:00`);
    const data = forecast(wall.startsWith('23') ? '2026-01-16' : '2026-01-15', now);
    assert.equal(plan(now, data).window !== null, allowed, wall);
    if (!allowed) assert.equal(plan(now, data).reason, 'outside_charging_window');
  }
});

test('spring and autumn DST days accept complete 23- and 25-hour forecasts', () => {
  for (const [date, iso, hours] of [['2026-03-29', '2026-03-28T22:15:00Z', 23], ['2026-10-25', '2026-10-24T21:15:00Z', 25]] as const) {
    const now = new Date(iso);
    const data = forecast(date, now);
    assert.equal(data.hourly!.length, hours);
    assert.equal(plan(now, data).action, 'charge');
    close(plan(now, data).requiredStoredKwh, 3 + (11 + 1/6) / legEfficiency);
  }
});

test('partial, shifted, duplicate and invalid energy hours are blocked', () => {
  const mutations: Array<(data: EnergyForecast) => void> = [
    data => { data.hourly = null; }, data => { data.hourly!.pop(); },
    data => { data.hourly![0] = data.hourly![1]; },
    data => { data.consumption.hourly[0].end = '2026-10-24T02:00:00Z'; },
    data => { data.hourly![0].estimatedProductionKwh = NaN; },
    data => { data.consumption.hourly[0].estimatedConsumptionKwh = -1; },
  ];
  for (const mutate of mutations) {
    const data = forecast(); mutate(data);
    assert.equal(plan(afternoon, data).reason, 'hourly_forecast_unavailable');
  }
});

test('offline, missing, invalid and future forecasts never trigger a charge', () => {
  for (const change of [{ status: 'offline' }, { status: 'not_configured' },
    { fetchedAt: 'invalid' }, { fetchedAt: '2026-10-24T12:00:06Z' }, { fetchedAt: null }] as const) {
    assert.equal(plan(afternoon, { ...forecast(), ...change }).reason, 'forecast_unavailable');
  }
});

test('wrong dates and invalid daily consumption are blocked', () => {
  assert.equal(plan(afternoon, forecast('2026-10-25')).reason, 'forecast_wrong_date');
  const data = forecast(); data.consumption.date = '2026-10-25';
  assert.equal(plan(afternoon, data).reason, 'forecast_wrong_date');
  for (const value of [NaN, Infinity, -1]) {
    const invalid = forecast(); invalid.consumption.estimatedConsumptionKwh = value;
    assert.equal(plan(afternoon, invalid).reason, 'consumption_unavailable');
  }
});

test('stale telemetry, missing SOC and invalid SOC fail closed', () => {
  for (const change of [{ status: 'offline' }, { status: 'stale' }, { observedAt: null },
    { observedAt: '2026-10-24T11:59:29Z' }, { observedAt: '2026-10-24T12:00:06Z' }] as const) {
    assert.equal(planBatteryCharge(afternoon, { ...telemetry(), ...change }, forecast(), config, limits).reason, 'telemetry_unavailable');
  }
  for (const batterySocPercent of [null, NaN, Infinity, -1, 101]) {
    assert.equal(planBatteryCharge(afternoon, { ...telemetry(), batterySocPercent }, forecast(), config, limits).reason, 'soc_unavailable');
  }
});

test('target reached holds and threshold avoids SOC rounding chatter', () => {
  const target = plan().targetSocPercent!;
  assert.equal(plan(afternoon, forecast(), config, target).reason, 'target_reached');
  assert.equal(plan(afternoon, forecast(), config, target - 0.01).action, 'hold');
  assert.equal(plan(afternoon, forecast(), config, target - 0.03).action, 'charge');
});

test('controller power limit blocks rather than quietly substituting another power', () => {
  const result = planBatteryCharge(afternoon, telemetry(), forecast(), config, { ...limits, maxPowerKw: 5.9 });
  assert.equal(result.reason, 'controller_limits');
  assert.equal(result.action, 'blocked');
  assert.equal(result.powerKw, 6);
});

test('SOC cap reports missing energy instead of claiming coverage', () => {
  const result = planBatteryCharge(afternoon, telemetry(), forecast(), config, { ...limits, maxSocPercent: 15 });
  assert.equal(result.targetSocPercent, 15);
  assert.equal(result.action, 'charge');
  close(result.unmetKwh, 3 + (6 + 1/12) / legEfficiency - 9);
  assert.equal(result.reason, 'charging_insufficient_capacity_or_time');
});

test('insufficient time reports unmet energy but keeps power fixed', () => {
  const now = new Date('2026-10-24T14:54:00Z'); // 16:54
  const result = plan(now, forecast('2026-10-24', now), config, 5);
  assert.equal(result.action, 'charge');
  assert.equal(result.powerKw, 6);
  close(result.unmetKwh, result.requiredStoredKwh! - 3 - 6 / 60 * legEfficiency);
});

test('a saturated intermediate solar surplus cannot fund an impossible later demand', () => {
  const data = forecast();
  data.hourly!.find(hour => hour.start === '2026-10-24T16:00:00.000Z')!.estimatedProductionKwh = 20;
  data.consumption.hourly.find(hour => hour.start === '2026-10-24T20:00:00.000Z')!.estimatedConsumptionKwh = 100;
  const result = plan(afternoon, reconcile(data), config, 100);
  assert.equal(result.action, 'hold');
  assert.ok(result.unmetKwh > 90);
  assert.equal(result.reason, 'target_reached_capacity_limited');
});

test('credited solar storage respects the 6 kW charge rate even with enormous irradiance', () => {
  const data = forecast();
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 2;
  data.hourly!.find(hour => hour.start === '2026-10-24T15:00:00.000Z')!.estimatedProductionKwh = 20;
  const result = plan(afternoon, reconcile(data));
  close(result.requiredStoredKwh, 3 + (10 + 2/12) / legEfficiency - 6 * legEfficiency);
  assert.ok(result.targetSocPercent! > 5, 'a one-hour surplus cannot erase the full evening deficit');
});

test('limited headroom discards excess solar and reports an unavoidable later energy gap', () => {
  const data = forecast();
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 0;
  // Two six-kWh evening deficits are individually below the discharge rate limit,
  // but exceed this deliberately small battery's combined storage capacity.
  data.consumption.hourly.find(hour => hour.start === '2026-10-24T19:00:00.000Z')!.estimatedConsumptionKwh = 6;
  data.consumption.hourly.find(hour => hour.start === '2026-10-24T20:00:00.000Z')!.estimatedConsumptionKwh = 6;
  for (const start of ['2026-10-24T16:00:00.000Z', '2026-10-24T17:00:00.000Z', '2026-10-24T18:00:00.000Z']) {
    data.hourly!.find(hour => hour.start === start)!.estimatedProductionKwh = 20;
  }
  const result = plan(afternoon, reconcile(data), { ...config, socCapacityKwh: 10 }, 5);
  assert.equal(result.targetSocPercent, 5, 'extra initial storage above reserve would be displaced by midday surplus');
  close(result.unmetKwh, 12 / legEfficiency - 9.5);
  assert.equal(result.reason, 'target_reached_capacity_limited');
});

test('demand beyond the 7 kW discharge limit remains unmet even with sufficient stored energy', () => {
  const data = forecast();
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 0;
  data.consumption.hourly.find(hour => hour.start === '2026-10-24T19:00:00.000Z')!.estimatedConsumptionKwh = 10;
  const result = plan(afternoon, reconcile(data), config, 100);
  close(result.requiredStoredKwh, 3 + 7);
  close(result.unmetKwh, 10 / legEfficiency - 7);
  close(result.nextHighTariffUnmetKwh, 10 / legEfficiency - 7);
  assert.equal(result.action, 'hold');
  assert.equal(result.powerKw, 6);
});

test('complete hourly arrays must reconcile with daily totals', () => {
  const data = forecast();
  data.consumption.estimatedConsumptionKwh = 100;
  assert.equal(plan(afternoon, data).reason, 'hourly_forecast_unavailable');
  const solar = forecast();
  solar.estimatedProductionKwh = 1;
  assert.equal(plan(afternoon, solar).reason, 'hourly_forecast_unavailable');
  const rounded = forecast();
  rounded.hourly![0].estimatedProductionKwh = 0.049;
  syncQuarters(rounded);
  assert.notEqual(plan(afternoon, rounded).action, 'blocked');
  rounded.hourly![0].estimatedProductionKwh = 0.06;
  assert.equal(plan(afternoon, rounded).reason, 'hourly_forecast_unavailable');
});

test('zero demand and zero solar are valid and keep only the reserve', () => {
  const data = forecast();
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 0;
  data.consumption.estimatedConsumptionKwh = 0;
  const result = plan(afternoon, reconcile(data));
  assert.equal(result.action, 'hold');
  assert.equal(result.targetSocPercent, 5);
  assert.equal(result.unmetKwh, 0);
});

test('invalid configuration, limits and clock fail closed; disabled performs no planning', () => {
  for (const invalid of [{ socCapacityKwh: 0 }, { socCapacityKwh: NaN }, { reserveSocPercent: 100 },
    { reserveSocPercent: -1 }, { afternoonTargetSocPercent: -1 }, { afternoonTargetSocPercent: 101 },
    { afternoonTargetSocPercent: NaN }]) {
    assert.equal(plan(afternoon, forecast(), { ...config, ...invalid }).reason, 'invalid_configuration');
  }
  assert.equal(planBatteryCharge(new Date(NaN), telemetry(), forecast(), config, limits).reason, 'invalid_clock');
  assert.equal(plan(afternoon, forecast(), { ...config, enabled: false }).reason, 'disabled');
  for (const maxSocPercent of [0, 5, 101, NaN]) {
    assert.equal(planBatteryCharge(afternoon, telemetry(), forecast(), config, { ...limits, maxSocPercent }).reason, 'controller_limits');
  }
});


const eightyPercent = { ...config, afternoonTargetSocPercent: 80 };
function atLocalHour(data: EnergyForecast, hour: number) {
  // New strategy fixtures use the normal winter date, where Zurich is UTC+1.
  const start = Date.parse(`${data.date}T${String(hour).padStart(2, '0')}:00:00+01:00`);
  return data.hourly!.findIndex(slot => Date.parse(slot.start) === start);
}

test('80% is the actual 16:55 goal without an extra five-minute retention budget', () => {
  const now = new Date('2026-01-15T12:15:00+01:00');
  const result = plan(now, forecast('2026-01-15', now), eightyPercent, 50);
  assert.equal(result.afternoonTargetAt, '2026-01-15T15:55:00.000Z');
  assert.equal(result.afternoonTargetSocPercent, 80);
  assert.equal(result.targetSocPercent, 80);
  close(result.requiredStoredKwh, 48);
  assert.equal(result.unmetKwh, 0);
});

test('night prepares 80% plus morning use while afternoon can rescue a time-limited night', () => {
  const now = new Date('2026-01-14T23:15:00+01:00');
  const result = plan(now, forecast('2026-01-15', now), eightyPercent, 10);
  close(result.requiredStoredKwh, 48 + (5 + 1/12) / legEfficiency);
  assert.equal(result.targetSocPercent, 88.7);
  assert.equal(result.afternoonTargetSocPercent, 80);
  const fullNightGain = 6 * (7 + 40/60) * legEfficiency;
  assert.ok(6 + fullNightGain < result.requiredStoredKwh!, 'night alone cannot meet its preferred intermediate target');
  assert.equal(result.unmetKwh, 0, 'afternoon can finish the residual instead of falsely declaring the goal impossible');
});

test('overnight solar headroom credits only surplus after household demand', () => {
  const now = new Date('2026-01-14T23:15:00+01:00');
  const data = forecast('2026-01-15', now);
  for (const hour of [12, 13, 14, 15]) data.hourly![atLocalHour(data, hour)].estimatedProductionKwh = 5;
  const result = plan(now, reconcile(data), eightyPercent, 10);
  close(result.requiredStoredKwh, 48 + (5 + 1/12) / legEfficiency - 16 * legEfficiency);
  assert.ok(result.targetSocPercent! < 70);
  assert.equal(result.afternoonTargetSocPercent, 80);
  const allConsumed = forecast('2026-01-15', now);
  for (const hour of [12, 13, 14, 15]) allConsumed.hourly![atLocalHour(allConsumed, hour)].estimatedProductionKwh = 1;
  close(plan(now, reconcile(allConsumed), eightyPercent).requiredStoredKwh, 48 + (5 + 1/12) / legEfficiency);
});

test('abundant afternoon sunshine never funds the earlier morning high tariff or its buffer', () => {
  const now = new Date('2026-01-14T23:15:00+01:00');
  const data = forecast('2026-01-15', now);
  for (const hour of [12, 13, 14, 15, 16]) data.hourly![atLocalHour(data, hour)].estimatedProductionKwh = 20;
  const result = plan(now, reconcile(data), { ...eightyPercent, socCapacityKwh: 30, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 });
  close(result.requiredStoredKwh, 1.5 + (5 + 1/12) / legEfficiency + 1);
  assert.ok(result.targetSocPercent! > 25);
  assert.equal(result.afternoonTargetSocPercent, 80);
});

test('afternoon intermediate target credits remaining PV and converges to 80% at the cutoff', () => {
  const at = new Date('2026-01-15T12:15:00+01:00');
  const data = forecast('2026-01-15', at);
  for (const hour of [12, 13, 14, 15, 16]) data.hourly![atLocalHour(data, hour)].estimatedProductionKwh = 3;
  reconcile(data);
  const early = plan(at, data, eightyPercent, 65);
  close(early.requiredStoredKwh, 48 - 2 * (4 + 40/60) * legEfficiency);
  assert.equal(early.action, 'hold', 'energy above the intermediate target stays held for sunshine');
  const lateAt = new Date('2026-01-15T16:54:00+01:00');
  const late = plan(lateAt, { ...data, fetchedAt: lateAt.toISOString() }, eightyPercent, 79);
  close(late.requiredStoredKwh, 48); // One minute is too short; keep charging through the cutoff.
  assert.ok(late.targetSocPercent! > early.targetSocPercent!);
  assert.equal(late.afternoonTargetSocPercent, 80);
  const lastAt = new Date('2026-01-15T16:54:59+01:00');
  assert.equal(plan(lastAt, { ...data, fetchedAt: lastAt.toISOString() }, eightyPercent, 79).targetSocPercent, 80);
});

test('evening needs can exceed 80% when a higher protected reserve is required', () => {
  const at = new Date('2026-01-15T12:15:00+01:00');
  const data = forecast('2026-01-15', at);
  for (const hour of [17, 18, 19, 20, 21, 22]) data.consumption.hourly[atLocalHour(data, hour)].estimatedConsumptionKwh = 7 * legEfficiency;
  reconcile(data);
  const settings = { ...eightyPercent, reserveSocPercent: 10, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 };
  const result = plan(at, data, settings, 90);
  const required = 6 + 42 + (1/12) / legEfficiency + 2.1;
  assert.equal(result.afternoonTargetSocPercent, 83.7);
  close(result.requiredStoredKwh, required);
  close(result.energyBufferKwh, 2.1);
  assert.equal(result.unmetKwh, 0);
  const capped = planBatteryCharge(at, telemetry(at, 80), data, settings, { ...limits, maxSocPercent: 80 });
  assert.equal(capped.targetSocPercent, 80);
  assert.equal(capped.afternoonTargetSocPercent, 83.7);
  close(capped.unmetKwh, required - 48);
  const impossible = plan(at, data, { ...settings, socCapacityKwh: 40 }, 100);
  assert.equal(impossible.afternoonTargetSocPercent, 100, 'the displayed desired SOC remains a physical percentage');
  assert.ok(impossible.unmetKwh > 0, 'uncapped energy needs are still reported as unmet');
});

test('controller caps and the night time budget leave residual afternoon work, not impossible morning promises', () => {
  const at = new Date('2026-01-15T06:54:00+01:00');
  const result = plan(at, forecast('2026-01-15', at), eightyPercent, 5);
  assert.equal(result.targetSocPercent, 88.7);
  assert.ok(result.unmetKwh > 20, 'one night minute and the full afternoon are insufficient');
  assert.equal(result.powerKw, 6);
  const enoughForMorning = plan(at, forecast('2026-01-15', at), eightyPercent, 50);
  assert.equal(enoughForMorning.unmetKwh, 0, 'afternoon can finish the goal once morning consumption is funded');
});

test('forced grid charge and PV share one 6 kW battery limit in feasibility calculations', () => {
  const at = new Date('2026-01-15T15:55:00+01:00');
  const data = forecast('2026-01-15', at);
  for (const hour of [15, 16]) data.hourly![atLocalHour(data, hour)].estimatedProductionKwh = 5;
  const result = plan(at, reconcile(data), eightyPercent, 60);
  close(result.unmetKwh, 48 - 36 - 6 * legEfficiency);
});

test('forecast total headroom counts only the remaining five-kilowatt afternoon charging capacity', () => {
  const at = new Date('2026-01-15T15:55:00+01:00');
  const data = forecast('2026-01-15', at);
  for (const hour of [15, 16]) data.consumption.hourly[atLocalHour(data, hour)].estimatedConsumptionKwh = 11;
  const result = plan(at, reconcile(data), eightyPercent, 60);
  close(result.unmetKwh, 12 + 11 / 12 / legEfficiency - 7 / 12 - 5 * legEfficiency);
  assert.equal(result.targetSocPercent, 80);
});

test('controller fallback timeout does not shorten current or future charging budgets', () => {
  const at = new Date('2026-01-15T15:55:00+01:00');
  const data = forecast('2026-01-15', at);
  const guarded = { ...limits, revertTimeoutSeconds: 30 };
  const result = planBatteryCharge(at, telemetry(at, 60), data, eightyPercent, guarded);
  close(result.unmetKwh, 12 - 6 * legEfficiency);
  const nightAt = new Date('2026-01-15T06:53:00+01:00');
  const nightData = forecast('2026-01-15', nightAt);
  const unguardedNight = plan(nightAt, nightData, eightyPercent, 30);
  const guardedNight = planBatteryCharge(nightAt, telemetry(nightAt, 30), nightData, eightyPercent, guarded);
  close(guardedNight.unmetKwh, unguardedNight.unmetKwh);
});


test('the final 80% deadline remains 16:55 local time on both DST transition days', () => {
  for (const [date, start, cutoff] of [
    ['2026-03-29', '2026-03-28T23:15:00+01:00', '2026-03-29T14:55:00.000Z'],
    ['2026-10-25', '2026-10-24T23:15:00+02:00', '2026-10-25T15:55:00.000Z'],
  ]) {
    const now = new Date(start);
    const result = plan(now, forecast(date, now), eightyPercent, 20);
    assert.equal(result.afternoonTargetAt, cutoff);
    assert.equal(result.afternoonTargetSocPercent, 80);
    assert.equal(result.targetSocPercent, 88.7);
    assert.equal(result.unmetKwh, 0);
  }
});


test('afternoon issued target does not double-credit PV collected during forced charging', () => {
  const at = new Date('2026-01-15T16:45:00+01:00');
  const data = forecast('2026-01-15', at);
  data.hourly![atLocalHour(data, 16)].estimatedProductionKwh = 3;
  const result = planBatteryCharge(at, telemetry(at, 78.51), reconcile(data),
    { ...eightyPercent, energyBufferPercent: 5, minimumEnergyBufferKwh: 1 },
    { ...limits, maxSocPercent: 90, revertTimeoutSeconds: 30 });
  assert.equal(result.afternoonTargetSocPercent, 80);
  assert.equal(result.targetSocPercent, 80, '79.5% would stop too early and leave the final goal short');
  assert.equal(result.unmetKwh, 0);
  const stored = 47.106;
  const duration = 10 / 60;
  const chargeHours = Math.min(duration, (result.targetSocPercent! / 100 * 60 - stored) / (6 * legEfficiency));
  const final = stored + 6 * legEfficiency * chargeHours + 2 * legEfficiency * (duration - chargeHours);
  assert.ok(final >= 48, `issued charge-then-hold trajectory ends at ${final}, below 80%`);
  const oldTargetHours = (79.5 / 100 * 60 - stored) / (6 * legEfficiency);
  const oldFinal = stored + 6 * legEfficiency * oldTargetHours + 2 * legEfficiency * (duration - oldTargetHours);
  assert.ok(oldFinal < 48, 'fixture detects the previous all-future-PV double credit');
});

test('charge-then-hold target still leaves headroom for solar after forced charging stops', () => {
  const at = new Date('2026-01-15T14:55:00+01:00');
  const data = forecast('2026-01-15', at);
  for (const hour of [14, 15, 16]) data.hourly![atLocalHour(data, hour)].estimatedProductionKwh = 3;
  const result = plan(at, reconcile(data), eightyPercent, 70);
  assert.ok(result.targetSocPercent! < 80, 'the fix must not blindly charge to the final goal immediately');
  const forcedHours = (result.targetSocPercent! / 100 * 60 - 42) / (6 * legEfficiency);
  const final = 42 + forcedHours * 6 * legEfficiency + (2 - forcedHours) * 2 * legEfficiency;
  assert.ok(final >= 48);
  assert.ok(result.targetSocPercent! > 75, 'PV during forced charging cannot also fund the later held interval');
});

test('useful overnight PV remains available independently of the controller fallback timeout', () => {
  const at = new Date('2026-01-15T06:53:00+01:00');
  const data = forecast('2026-01-15', at);
  data.hourly![atLocalHour(data, 6)].estimatedProductionKwh = 7;
  reconcile(data);
  const unguarded = plan(at, data, eightyPercent, 30);
  const guarded = planBatteryCharge(at, telemetry(at, 30), data, eightyPercent, { ...limits, revertTimeoutSeconds: 30 });
  close(guarded.unmetKwh, unguarded.unmetKwh);
});


test('an unreachable afternoon SOC goal does not warn when the next high tariff is covered', () => {
  const now = new Date('2026-10-24T14:54:00Z');
  const result = plan(now, forecast('2026-10-24', now), { ...config, afternoonTargetSocPercent: 80 }, 20);
  assert.ok(result.unmetKwh > 30);
  close(result.nextHighTariffUnmetKwh, 0);
  assert.equal(result.reason, 'energy_shortfall');
});

test('an unmet forecast cushion alone does not mean limited high-tariff coverage', () => {
  const now = new Date('2026-10-24T14:54:00Z');
  const data = forecast('2026-10-24', now);
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = .5;
  const result = plan(now, reconcile(data), { ...config, minimumEnergyBufferKwh: 1 }, 11);
  assert.ok(result.unmetKwh > 0);
  close(result.nextHighTariffUnmetKwh, 0);
  assert.equal(result.reason, 'energy_shortfall');
});

test('night coverage warnings concern the next morning rather than an impossible later evening', () => {
  const now = new Date('2026-10-23T21:05:00Z');
  const data = forecast('2026-10-24', now);
  data.consumption.hourly.find(hour => hour.start === '2026-10-24T19:00:00.000Z')!.estimatedConsumptionKwh = 100;
  const result = plan(now, reconcile(data), config, 100);
  assert.ok(result.unmetKwh > 0);
  close(result.nextHighTariffUnmetKwh, 0);
  assert.equal(result.reason, 'target_reached');
});

test('limited charging time warns only about the actual next high-tariff energy gap', () => {
  const now = new Date('2026-10-24T14:54:00Z');
  const result = plan(now, forecast('2026-10-24', now), config, 5);
  assert.ok(result.nextHighTariffUnmetKwh! > 6);
  assert.equal(result.reason, 'charging_insufficient_capacity_or_time');
});

test('next-period solar covers consumption even when the preferred SOC cannot be reached', () => {
  const now = new Date('2026-10-24T14:54:00Z');
  const data = forecast('2026-10-24', now);
  for (const hour of data.hourly!) {
    if (hour.start >= '2026-10-24T15:00:00.000Z') hour.estimatedProductionKwh = 2;
  }
  const result = plan(now, reconcile(data), { ...config, afternoonTargetSocPercent: 80 }, 5);
  assert.ok(result.unmetKwh > 0);
  close(result.nextHighTariffUnmetKwh, 0);
  assert.equal(result.reason, 'energy_shortfall');
});

test('later solar cannot hide an earlier next-period deficit', () => {
  const now = new Date('2026-10-24T14:54:00Z');
  const data = forecast('2026-10-24', now);
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = 0;
  data.consumption.hourly.find(hour => hour.start === '2026-10-24T15:00:00.000Z')!.estimatedConsumptionKwh = 2;
  data.hourly!.find(hour => hour.start === '2026-10-24T16:00:00.000Z')!.estimatedProductionKwh = 20;
  const result = plan(now, reconcile(data), config, 5);
  assert.ok(result.nextHighTariffUnmetKwh! > 1.9);
  assert.equal(result.reason, 'charging_insufficient_capacity_or_time');
});


test('the next morning warns when night charging and morning solar cannot cover its demand', () => {
  for (const [date, origin] of [
    ['2026-01-15', '2026-01-15T06:54:00+01:00'],
    ['2026-03-29', '2026-03-29T06:54:00+02:00'],
    ['2026-10-25', '2026-10-25T06:54:00+01:00'],
  ]) {
    const now = new Date(origin);
    const data = forecast(date, now);
    const result = plan(now, data, config, 5);
    assert.ok(result.nextHighTariffUnmetKwh! > 5);
    assert.ok(result.nextHighTariffChargeNeededKwh! > 5);
    assert.equal(result.reason, 'charging_insufficient_capacity_or_time');
    const sunny = plan(now, reconcile({ ...data, hourly: data.hourly!.map(hour => ({ ...hour, estimatedProductionKwh: 2 })) }), config, 5);
    close(sunny.nextHighTariffUnmetKwh, 0);
    close(sunny.nextHighTariffChargeNeededKwh, 0);
  }
});

test('unavailable coverage remains unknown when forecasting is blocked', () => {
  const result = plan(afternoon, { ...forecast(), status: 'offline' });
  assert.equal(result.action, 'blocked');
  assert.equal(result.nextHighTariffUnmetKwh, null);
});

test('charging for the preferred SOC is distinct from charging needed for the next high tariff', () => {
  for (const [instant, date, sufficientSoc, lowSoc] of [
    ['2026-10-24T12:00:00Z', '2026-10-24', 40, 10],
    ['2026-10-23T21:05:00Z', '2026-10-24', 30, 6],
  ] as const) {
    const at = new Date(instant);
    const data = forecast(date, at);
    const settings = { ...config, afternoonTargetSocPercent: 80 };
    const reserve = plan(at, data, settings, sufficientSoc);
    const necessary = plan(at, data, settings, lowSoc);
    assert.equal(reserve.action, 'charge');
    assert.equal(necessary.action, 'charge');
    close(reserve.nextHighTariffChargeNeededKwh, 0);
    assert.ok(necessary.nextHighTariffChargeNeededKwh! > 0);
    close(necessary.nextHighTariffUnmetKwh, 0);
    assert.equal(reserve.afternoonTargetSocPercent, 80);
    assert.equal(reserve.powerKw, 6);
    assert.equal(necessary.powerKw, 6);
  }
});

test('the need for charging credits solar before and during the next high tariff in chronological order', () => {
  const at = new Date('2026-10-24T12:00:00Z');
  const settings = { ...config, afternoonTargetSocPercent: 80 };
  const beforePeak = forecast('2026-10-24', at);
  for (const hour of beforePeak.hourly!) {
    if (hour.start >= '2026-10-24T12:00:00.000Z' && hour.start < '2026-10-24T15:00:00.000Z') hour.estimatedProductionKwh = 5;
  }
  const covered = plan(at, reconcile(beforePeak), settings, 5);
  assert.equal(covered.action, 'charge');
  close(covered.nextHighTariffChargeNeededKwh, 0);
  const duringPeak = forecast('2026-10-24', at);
  for (const hour of duringPeak.hourly!) {
    if (hour.start >= '2026-10-24T15:00:00.000Z') hour.estimatedProductionKwh = 2;
  }
  close(plan(at, reconcile(duringPeak), settings, 5).nextHighTariffChargeNeededKwh, 0);
  const lateSolar = forecast('2026-10-24', at);
  lateSolar.hourly!.find(hour => hour.start === '2026-10-24T16:00:00.000Z')!.estimatedProductionKwh = 20;
  assert.ok(plan(at, reconcile(lateSolar), settings, 5).nextHighTariffChargeNeededKwh! > 0);
});

test('a forecast cushion alone does not make charging necessary and unavailable need stays unknown', () => {
  const data = forecast();
  for (const hour of data.consumption.hourly) hour.estimatedConsumptionKwh = .5;
  const buffered = plan(afternoon, reconcile(data), { ...config, minimumEnergyBufferKwh: 2 }, 12);
  assert.equal(buffered.action, 'charge');
  close(buffered.nextHighTariffChargeNeededKwh, 0);
  assert.equal(plan(afternoon, { ...data, status: 'offline' }).nextHighTariffChargeNeededKwh, null);
});


test('retained forecasts keep charge targets and next-morning reserves after failed refreshes', () => {
  const retained = forecast();
  retained.status = 'stale';
  retained.fetchedAt = new Date(afternoon.getTime() - 12 * 3_600_000).toISOString();
  retained.error = 'Les prévisions météo sont indisponibles.';
  assert.deepEqual(plan(afternoon, retained), plan());
  const night = new Date('2026-10-24T21:15:00Z');
  const tomorrow = forecast('2026-10-25', night);
  const expected = nextNightHighTariffReserve(night, tomorrow, config, limits);
  assert.ok(expected !== null);
  tomorrow.status = 'stale';
  tomorrow.fetchedAt = new Date(night.getTime() - 12 * 3_600_000).toISOString();
  assert.equal(nextNightHighTariffReserve(night, tomorrow, config, limits), expected);
  tomorrow.date = '2026-10-24';
  assert.equal(nextNightHighTariffReserve(night, tomorrow, config, limits), null);
});
