import test from 'node:test';
import assert from 'node:assert/strict';
const data = await import(new URL('../public/history-data.js', import.meta.url).href);
const { requestHistoryJson, renderHistoryChart } = await import(new URL('../public/history.js', import.meta.url).href);
const { historyGroups, allHistorySelection, defaultHistorySelection, historyTable, formatHistoryValue, validHistoryDate, shiftHistoryDate, todayInZurich } = data;
const minuteMs = 60000;
const quarterMs = 15 * minuteMs;
const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} must equal ${expected}`);
function fixture(periodStart = '2026-01-14T23:00:00.000Z', periodEnd = '2026-01-15T23:00:00.000Z') {
  const start = Date.parse(periodStart), end = Date.parse(periodEnd);
  const at = (offset: number) => new Date(start + offset * quarterMs).toISOString();
  const metric = (energyKwh: number | null, coverageSeconds = 900) => ({ energyKwh, coverageSeconds, firstCoveredAt: periodStart, lastCoveredAt: at(1) });
  const intervals = Array.from({ length: (end - start) / quarterMs }, (_, index) => ({ start: at(index), end: at(index + 1) }));
  return { date: todayInZurich(new Date(start)), timeZone: 'Europe/Zurich', periodStart, periodEnd,
    observations: { method: 'counter_differences' as const,
      solar: intervals.map(interval => ({ at: interval.start, value: 1000 })),
      household: intervals.map(interval => ({ at: interval.start, value: 250 })) },
    dailyEnergy: { firstObservationAt: periodStart, solar: metric(999), household: metric(999) },
    measurements: { hours: [{ start: periodStart, end: at(4), solar: metric(999), household: metric(999) }] },
    battery: { points: [] as Array<{ at: string; socPercent: number }> },
    historicalEstimated: { points: intervals.map(interval => ({ at: interval.end, socPercent: 75 })) },
    energyEstimates: intervals.map(interval => ({ ...interval, estimatedConsumptionKwh: .5 })),
    solarEstimates: intervals.map(interval => ({ ...interval, estimatedProductionKwh: 2 })) };
}

test('chart aligns energy totals and latest SOC at the same period-end timestamp', t => {
  class Element {
    children: Element[] = [];
    attributes = new Map<string, string>();
    textContent = ''; hidden = false;
    constructor(public tagName: string) {}
    append(child: Element) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  }
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElementNS: (_namespace: string, tag: string) => new Element(tag),
  } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  t.mock.method(Date, 'now', () => Date.parse('2026-10-27T12:00:00Z'));
  const day = fixture('2026-10-26T23:00:00.000Z', '2026-10-27T23:00:00.000Z');
  const at = (quarter: number) => new Date(Date.parse('2026-10-27T09:00:00Z') + quarter * quarterMs).toISOString();
  const observedAt = (quarter: number) => new Date(Date.parse(at(quarter + 1)) - 30000).toISOString();
  day.observations.solar = [300, 300, 300, 334].map((value, i) => ({ at: observedAt(i), value }));
  day.observations.household = [400, 400, 400, 696].map((value, i) => ({ at: observedAt(i), value }));
  Object.assign(day.observations, { car: [{ at: at(0), value: 200 }] });
  Object.assign(day, { carEstimates: [{ start: at(0), end: at(1), estimatedChargingKwh: .15 }] });
  day.solarEstimates = [0, 1, 2, 3].map(i => ({ start: at(i), end: at(i + 1), estimatedProductionKwh: 2.475 / 4 }));
  day.energyEstimates = [{ start: at(0), end: at(1), estimatedConsumptionKwh: .260 }];
  day.battery.points = [50, 51, 52, 53].map((socPercent, i) => ({ at: observedAt(i), socPercent }));
  day.historicalEstimated.points = [60, 61, 62, 63].map((socPercent, i) => ({ at: at(i + 1), socPercent }));
  const chart = new Element('div'), svg = new Element('svg'), status = new Element('p');
  const series = (name: string) => svg.children.filter(node => node.attributes.get('class') === name);
  renderHistoryChart(day, chart, svg, status, 'hour');
  assert.match(series('chart-car-measured-point')[0].children[0].textContent, /11:00.*Recharge voiture.*200 Wh/);
  assert.equal(historyTable(day, ['carMeasured'], 'hour').rows[10].values.carMeasured, .2);
  assert.equal(historyTable(day, ['carEstimated'], 'hour').rows[10].values.carEstimated, .15);
  assert.match(series('chart-car-estimated-point')[0].children[0].textContent, /Recharge voiture prévue.*150 Wh/);
  assert.match(series('chart-car-estimated-point')[0].children[0].textContent, /1 sur 4 tranches/);
  const house = series('chart-demand-measured-point')[0], solar = series('chart-solar-measured')[0];
  const tableRow = historyTable(day, allHistorySelection, 'hour').rows[10];
  assert.equal(tableRow.label, '11:00');
  assert.equal(house.children[0].textContent, `11:00 · Maison relevée : ${formatHistoryValue(tableRow.values.houseMeasured, { unit: 'Wh' })} Wh`);
  assert.equal(solar.children[0].textContent, `11:00 · Solaire relevé : ${formatHistoryValue(tableRow.values.solarMeasured, { unit: 'Wh' })} Wh`);
  assert.match(house.children[0].textContent, /1[  '’]896 Wh/);
  assert.match(solar.children[0].textContent, /1[  '’]234 Wh/);
  assert.equal(series('chart-demand-measured-point').length, 1);
  assert.equal(Number(house.attributes.get('cx')), Number(solar.attributes.get('x')) + Number(solar.attributes.get('width')) / 2);
  assert.ok(Number(house.attributes.get('cy')) < Number(solar.attributes.get('y')), 'Higher house consumption must appear above measured solar production');
  assert.match(series('chart-demand-point')[0].children[0].textContent, /11:00.*260 Wh/);
  assert.match(series('chart-solar')[0].children[0].textContent, /11:00.*2[  '’]475 Wh/);
  assert.match(svg.children.find(node => node.tagName === 'desc')!.textContent, /Maison par heure/);
  assert.match(svg.children.find(node => node.tagName === 'desc')!.textContent, /Batterie par heure/);
  assert.equal(series('chart-battery-measured-point').length, 1);
  assert.equal(series('chart-battery-estimated-point').length, 1);
  assert.match(series('chart-battery-measured-point')[0].children[0].textContent, /^11:00 · Batterie relevée : 53 %\n.*10:59:30/);
  assert.match(series('chart-battery-estimated-point')[0].children[0].textContent, /^11:00 · Batterie prévue : 63 %\n/);
  assert.equal(series('chart-battery-measured-point')[0].attributes.get('cx'), house.attributes.get('cx'));
  assert.equal(series('chart-battery-estimated-point')[0].attributes.get('cx'), house.attributes.get('cx'));

  renderHistoryChart(day, chart, svg, status, 'quarter');
  assert.equal(series('chart-demand-measured-point').length, 4);
  assert.equal(series('chart-solar-measured').length, 4);
  assert.equal(series('chart-battery-measured-point').length, 4);
  assert.equal(series('chart-battery-estimated-point').length, 4);
  assert.match(series('chart-demand-measured-point')[0].children[0].textContent, /10:15.*400 Wh/);
  assert.match(series('chart-solar-measured')[0].children[0].textContent, /10:15.*300 Wh/);
  const quarter = historyTable(day).rows.find((row: any) => row.label === '10:30');
  assert.equal(quarter.rangeLabel, '10:15–10:30');
  assert.equal(quarter.values.batteryMeasured, 51);
  near(quarter.values.solarMeasured, .3);
  near(quarter.values.houseMeasured, .4);
  assert.match(quarter.notes.batteryMeasured, /10:29:30/);
  assert.match(quarter.notes.solarMeasured, /10:29:30/);
  for (const [index, point] of series('chart-battery-measured-point').entries()) {
    assert.equal(point.attributes.get('cx'), series('chart-demand-measured-point')[index].attributes.get('cx'));
    assert.equal(point.attributes.get('cx'), series('chart-battery-estimated-point')[index].attributes.get('cx'));
  }
});

test('the joined table exposes separate car charging alongside household values from quarter-hour history without timestamps or source versions', () => {
  assert.deepEqual(historyGroups.map((group: any) => [group.id, group.label]), [['solar', 'Solaire'], ['house', 'Maison'], ['battery', 'Batterie'], ['car', 'Voiture']]);
  assert.deepEqual(allHistorySelection, ['solarEstimated', 'solarMeasured', 'houseEstimated', 'houseMeasured', 'batteryEstimated', 'batteryMeasured', 'carEstimated', 'carMeasured']);
  assert.deepEqual(defaultHistorySelection, allHistorySelection);
  const day = fixture(), original = structuredClone(day);
  const table = historyTable(day, allHistorySelection);
  assert.equal(table.rows.length, 96);
  assert.equal(table.rows[0].label, '00:15');
  assert.equal(table.rows.at(-1).label, '24:00');
  assert.equal(table.columns.length, 8);
  assert.deepEqual(table.columns.map((column: any) => column.label), ['Prévu', 'Mesuré', 'Prévu', 'Mesuré', 'Prévu', 'Mesuré', 'Prévu', 'Mesuré']);
  assert.equal(table.hasData, true);
  near(table.rows[0].values.houseMeasured, .25);
  near(table.rows[0].values.houseEstimated, .5);
  near(table.rows[0].values.solarMeasured, 1);
  near(table.rows[0].values.solarEstimated, 2);
  assert.equal(table.rows[0].values.batteryEstimated, 75);
  assert.doesNotMatch(table.rows[0].notes.batteryEstimated, /calculée|génér/);
  assert.deepEqual(day, original);
  const selected = historyTable(day, ['houseMeasured', 'solarEstimated']);
  assert.deepEqual(selected.groups.map((group: any) => [group.label, group.columns.length]), [['Solaire', 1], ['Maison', 1]]);
  assert.equal(historyTable(day, []).hasData, false);
  assert.deepEqual(historyTable(day, new Set(['houseMeasured'])).columns.map((column: any) => column.key), ['houseMeasured']);
});

test('quarter measurements preserve zero and absent channels without extrapolation', () => {
  const day = fixture();
  day.observations = { method: 'counter_differences', solar: [{ at: day.periodStart, value: 0 }], household: [] };
  const table = historyTable(day, ['houseMeasured', 'solarMeasured']);
  assert.equal(table.rows[0].values.houseMeasured, null);
  assert.equal(table.rows[0].values.solarMeasured, 0);
  assert.equal(table.rows[1].values.solarMeasured, null);
  assert.match(table.rows[0].notes.solarMeasured, /1 relevés/);
  day.observations.solar = [];
  assert.equal(historyTable(day, ['houseMeasured', 'solarMeasured']).hasData, false);
});

test('fallback predictions are labeled in quarter and hourly notes without filling measurement gaps', () => {
  const day = fixture();
  const householdPredictions = day.energyEstimates.map((p, i) => ({ ...p, source: i === 0 ? 'recent_average' : 'configured_baseline' }));
  const observed = { ...day, householdPredictions, observations: { ...day.observations, household: [] } };
  const quarter = historyTable(observed);
  assert.match(quarter.rows[0].notes.houseEstimated, /Secours : moyenne récente/);
  assert.match(quarter.rows[1].notes.houseEstimated, /Secours : base configurée/);
  assert.equal(quarter.rows[0].values.houseMeasured, null);
  const hour = historyTable(observed, allHistorySelection, 'hour');
  assert.match(hour.rows[0].notes.houseEstimated, /moyenne récente \(1 tranches\)/);
  assert.match(hour.rows[0].notes.houseEstimated, /base configurée \(3 tranches\)/);
});

test('invalid readings stay unknown, duplicate observations count once and overlapping estimates remain unknown', () => {
  const day = fixture();
  day.observations.household.push(structuredClone(day.observations.household[0]));
  day.observations.solar[0].value = -1;
  day.observations.solar.push({ at: 'invalid', value: 1000 });
  day.energyEstimates.push(structuredClone(day.energyEstimates[0]));
  day.solarEstimates[0].end = new Date(Date.parse(day.periodStart) + 3600000).toISOString();
  const table = historyTable(day, allHistorySelection);
  near(table.rows[0].values.houseMeasured, .25);
  assert.equal(table.rows[0].values.solarMeasured, null);
  assert.equal(table.rows[0].values.houseEstimated, null);
  assert.equal(table.rows[0].values.solarEstimated, null);
  near(table.rows[1].values.houseEstimated, .5);
});

test('battery measurement uses the last valid dedicated observation within a quarter without filling gaps', () => {
  const day = fixture(), at = (seconds: number) => new Date(Date.parse(day.periodStart) + seconds * 1000).toISOString();
  day.battery.points = [{ at: at(55), socPercent: 62 }, { at: at(899), socPercent: 80 }, { at: at(899.5), socPercent: 101 }, { at: at(1800), socPercent: 0 }];
  const table = historyTable(day, ['batteryMeasured']);
  assert.equal(table.rows[0].values.batteryMeasured, 80);
  assert.equal(table.rows[1].values.batteryMeasured, null);
  assert.equal(table.rows[2].values.batteryMeasured, 0);
});

test('battery predictions need an exact interval-end target and no generation timestamp', () => {
  const day = fixture();
  day.historicalEstimated.points = [{ at: new Date(Date.parse(day.periodStart) + 300000).toISOString(), socPercent: 90 }, day.historicalEstimated.points[1]];
  const table = historyTable(day, ['batteryEstimated']);
  assert.equal(table.rows[0].values.batteryEstimated, null);
  assert.equal(table.rows[1].values.batteryEstimated, 75);
  day.historicalEstimated.points = [];
  assert.equal(historyTable(day, ['batteryEstimated']).hasData, false);
});

test('latest pre-target battery snapshots compare with the prediction for that target', () => {
  const day = fixture(), start = Date.parse(day.periodStart);
  day.battery.points = [{ at: new Date(start + quarterMs - 30000).toISOString(), socPercent: 0 },
    { at: new Date(start + 2 * quarterMs - 30000).toISOString(), socPercent: 41 }];
  day.historicalEstimated.points = [{ at: new Date(start + quarterMs).toISOString(), socPercent: 0 },
    { at: new Date(start + 2 * quarterMs).toISOString(), socPercent: 40 }];
  const rows = historyTable(day, ['batteryMeasured', 'batteryEstimated']).rows;
  assert.equal(rows[0].values.batteryMeasured, 0);
  assert.equal(rows[0].values.batteryEstimated, 0);
  assert.equal(rows[1].values.batteryMeasured, 41);
  assert.equal(rows[1].values.batteryEstimated, 40);
  assert.equal(rows[2].values.batteryEstimated, null);
  assert.match(rows[0].notes.batteryEstimated, /fin.*00:15/);
});

test('hour and day SOC aggregates include their exact end targets and exclude their start targets', () => {
  const day = fixture(), start = Date.parse(day.periodStart);
  day.historicalEstimated.points = [{ at: day.periodStart, socPercent: 10 },
    { at: new Date(start + 3 * quarterMs).toISOString(), socPercent: 20 },
    { at: new Date(start + 4 * quarterMs).toISOString(), socPercent: 30 },
    { at: new Date(Date.parse(day.periodEnd) - quarterMs).toISOString(), socPercent: 40 },
    { at: day.periodEnd, socPercent: 99 }];
  const hours = historyTable(day, ['batteryEstimated'], 'hour').rows;
  assert.equal(hours[0].values.batteryEstimated, 30);
  assert.equal(hours[1].values.batteryEstimated, null);
  assert.equal(hours[2].values.batteryEstimated, null);
  assert.equal(hours.at(-1).values.batteryEstimated, 99);
  assert.equal(historyTable([day], ['batteryEstimated'], 'day').rows[0].values.batteryEstimated, 99);
});

test('real-timestamp Wh observations sum whole values with honest timestamps and no invented coverage', () => {
  const day = fixture(), start = Date.parse(day.periodStart);
  day.observations = { method: 'counter_differences', solar: [
    { at: new Date(start + quarterMs - 31000).toISOString(), value: 125 },
    { at: new Date(start + 2 * quarterMs - 30000).toISOString(), value: 375 },
  ], household: [{ at: new Date(start + quarterMs - 30000).toISOString(), value: 0 }] };
  const rows = historyTable(day, ['solarMeasured', 'houseMeasured']).rows;
  near(rows[0].values.solarMeasured, .125);
  near(rows[1].values.solarMeasured, .375);
  assert.equal(rows[2].values.solarMeasured, null);
  assert.equal(rows[0].values.houseMeasured, 0);
  assert.match(rows[0].notes.solarMeasured, /00:14:29/);
  assert.doesNotMatch(rows[0].notes.solarMeasured, /900.*mesurées/);
  const hour = historyTable(day, ['solarMeasured'], 'hour').rows[0];
  near(hour.values.solarMeasured, .5);
  assert.match(hour.notes.solarMeasured, /2 relevés/);
  assert.equal(formatHistoryValue(rows[0].values.solarMeasured, { unit: 'Wh' }), '125');
});

test('real energy points are not redistributed into the next day', () => {
  const day = fixture(), start = Date.parse(day.periodStart), end = Date.parse(day.periodEnd);
  day.observations = { method: 'counter_differences', solar: [
    { at: new Date(start + 2 * quarterMs - 30000).toISOString(), value: 500 },
    { at: new Date(end + 30000).toISOString(), value: 900 },
  ], household: [] };
  near(historyTable(day, ['solarMeasured'], 'hour').rows[0].values.solarMeasured, .5);
  near(historyTable([day], ['solarMeasured'], 'day').rows[0].values.solarMeasured, .5);
});

test('the UTC quarter calendar covers DST days and disambiguates repeated local labels', () => {
  for (const [start, end, quarters] of [['2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 92], ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 100]] as const) {
    const table = historyTable(fixture(start, end), allHistorySelection);
    assert.equal(table.rows.length, quarters);
    assert.equal(table.rows[0].start, start); assert.equal(table.rows.at(-1).end, end);
    assert.equal(table.rows[0].label, '00:15'); assert.equal(table.rows.at(-1).label, '24:00');
    assert.equal(table.rows[0].rangeLabel, '00:00–00:15');
    assert.equal(table.rows.at(-1).rangeLabel, '23:45–24:00');
    if (quarters === 92) assert.ok(table.rows.some((row: any) => row.rangeLabel === '01:45–03:00'));
    if (quarters === 100) assert.ok(table.rows.some((row: any) => row.rangeLabel === '02:45–02:00'));
    assert.ok(table.rows.every((row: any) => !/UTC|Zurich|GMT|[+]0[12]/.test(row.label)));
    if (quarters === 100) assert.deepEqual(table.rows.filter((row: any) => row.label.startsWith('02:00')).map((row: any) => row.label), ['02:00 (1)', '02:00 (2)']);
  }
});

test('repeated autumn pre-target snapshots match their own quarter-end predictions', () => {
  const day = fixture('2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z');
  day.historicalEstimated.points = [{ at: '2026-10-25T00:15:00.000Z', socPercent: 50 },
    { at: '2026-10-25T01:15:00.000Z', socPercent: 60 }];
  day.battery.points = [{ at: '2026-10-25T00:14:30.500Z', socPercent: 51 },
    { at: '2026-10-25T01:14:30.500Z', socPercent: 61 }];
  const rows = historyTable(day, ['batteryMeasured', 'batteryEstimated']).rows.filter((row: any) => row.label.startsWith('02:15'));
  assert.deepEqual(rows.map((row: any) => [row.label, row.values.batteryMeasured, row.values.batteryEstimated]), [
    ['02:15 (1)', 51, 50], ['02:15 (2)', 61, 60],
  ]);
  assert.deepEqual(rows.map((row: any) => row.rangeLabel), ['02:00–02:15 (1)', '02:00–02:15 (2)']);
});

test('numeric and date formatting stays concise with missing values distinct from zero and no timezone text', () => {
  assert.equal(formatHistoryValue(8.913652195, { type: 'number', unit: 'kW' }), '8,914');
  assert.equal(formatHistoryValue(62.450000763, { type: 'number', unit: '%' }), '62,45');
  assert.equal(formatHistoryValue(.25, { type: 'number', unit: 'Wh' }), '250');
  assert.equal(formatHistoryValue(.012345, { type: 'number', unit: 'Wh' }), '12');
  assert.equal(formatHistoryValue(.0015, { type: 'number', unit: 'Wh' }), '2');
  assert.equal(formatHistoryValue(0, { type: 'number', unit: 'Wh' }), '0');
  assert.equal(formatHistoryValue(null, { type: 'number', unit: 'Wh' }), '—');
  assert.equal(formatHistoryValue(null, { type: 'number', unit: '%' }), '—');
  assert.equal(formatHistoryValue(Infinity, { type: 'number', unit: '%' }), '—');
  assert.equal(formatHistoryValue('2026-10-25T00:30:00Z', { type: 'time' }), '02:30:00');
  assert.doesNotMatch(formatHistoryValue('2026-10-25T00:30:00Z', { type: 'timestamp' }), /UTC|GMT|Zurich/);
  assert.equal(shiftHistoryDate('2026-10-25', 1), '2026-10-26');
  assert.equal(validHistoryDate('2026-02-30'), false);
  assert.equal(todayInZurich(new Date('2026-10-24T22:30:00Z')), '2026-10-25');
});

test('history requests use a bounded deadline and report sanitized read failures', async t => {
  const seen: any[] = [];
  t.mock.method(globalThis, 'fetch', (async (_input: unknown, options: any) => {
    seen.push(options);
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('annulée', 'AbortError'))));
  }) as any);
  let deadline = 0;
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, milliseconds: number) => {
    deadline = milliseconds; queueMicrotask(callback); return 123;
  }) as any);
  t.mock.method(globalThis, 'clearTimeout', (() => {}) as any);
  await assert.rejects(requestHistoryJson('/api/history/day?date=2026-10-25', new AbortController().signal), /trop de temps/);
  assert.equal(deadline, 12000);
  assert.equal(seen[0].cache, 'no-store');
  assert.equal(seen[0].signal.aborted, true);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', (async () => Response.json({ error: 'private connection details' }, { status: 503 })) as any);
  await assert.rejects(requestHistoryJson('/api/history/day?date=2026-10-25'), /momentanément indisponible/);
});

test('native fetch failures use French feedback while cancellation remains distinguishable', async t => {
  let failure: Error = new TypeError('Failed to fetch private details');
  t.mock.method(globalThis, 'fetch', (async () => { throw failure; }) as any);
  await assert.rejects(requestHistoryJson('/api/history/day?date=2026-10-25'), { message: 'L’historique est momentanément indisponible.' });
  failure = new DOMException('The operation was aborted', 'AbortError');
  await assert.rejects(requestHistoryJson('/api/history/day?date=2026-10-25'), (error: unknown) => error === failure);
  const controller = new AbortController(); controller.abort();
  failure = new Error('cancelled by caller');
  await assert.rejects(requestHistoryJson('/api/history/day?date=2026-10-25', controller.signal), (error: unknown) => error === failure);
});

test('hourly view sums quarter energies and keeps the last in-period battery values', () => {
  const day = fixture(), start = Date.parse(day.periodStart);
  day.battery.points = [
    { at: new Date(start + 1000).toISOString(), socPercent: 30 },
    { at: new Date(start + 3599000).toISOString(), socPercent: 60 },
  ];
  day.historicalEstimated.points[3].socPercent = 80;
  const original = structuredClone(day);
  const table = historyTable(day, allHistorySelection, 'hour');
  assert.equal(table.rows.length, 24);
  assert.equal(table.rows[0].label, '01:00');
  assert.equal(table.rows.at(-1).label, '24:00');
  assert.equal(table.rows[0].end, new Date(start + 3600000).toISOString());
  near(table.rows[0].values.houseMeasured, 1);
  near(table.rows[0].values.solarMeasured, 4);
  near(table.rows[0].values.houseEstimated, 2);
  near(table.rows[0].values.solarEstimated, 8);
  assert.equal(table.rows[0].values.batteryMeasured, 60);
  assert.equal(table.rows[0].values.batteryEstimated, 80);
  assert.equal(table.rows[1].values.batteryMeasured, null, 'SOC is not carried into the next hour');
  assert.match(table.rows[0].notes.houseMeasured, /4 relevés/);
  assert.match(table.rows[0].notes.houseEstimated, /4 sur 4/);
  assert.match(table.rows[0].notes.batteryMeasured, /Dernier relevé/);
  assert.deepEqual(day, original);
});

test('hourly aggregates preserve real zero and partial subtotals and expose missing forecast slots', () => {
  const day = fixture();
  day.observations.solar = [{ at: day.periodStart, value: 0 }];
  day.observations.household = [day.observations.household[0]];
  day.energyEstimates = [{ ...day.energyEstimates[1], estimatedConsumptionKwh: 0 }];
  day.solarEstimates = [];
  day.historicalEstimated.points = [day.historicalEstimated.points[1]];
  const rows = historyTable(day, allHistorySelection, 'hour').rows;
  assert.equal(rows[0].values.solarMeasured, 0);
  assert.equal(rows[0].values.houseEstimated, 0);
  assert.equal(rows[0].values.solarEstimated, null);
  assert.equal(rows[0].values.batteryEstimated, 75, 'last available forecast within the hour survives');
  assert.equal(rows[1].values.batteryEstimated, null, 'missing hours never inherit SOC forecasts');
  assert.match(rows[0].notes.solarMeasured, /1 relevés/);
  assert.match(rows[0].notes.houseEstimated, /1 sur 4.*Sous-total/);
  assert.equal(rows[1].values.houseMeasured, null);
  assert.equal(rows[1].values.houseEstimated, null);
});

test('hourly aggregates count duplicate readings once and leave duplicate estimates unknown', () => {
  const day = fixture();
  day.observations.household.push(structuredClone(day.observations.household[0]));
  day.energyEstimates.push(structuredClone(day.energyEstimates[0]));
  const row = historyTable(day, allHistorySelection, 'hour').rows[0];
  near(row.values.houseMeasured, 1);
  near(row.values.houseEstimated, 1.5);
  assert.match(row.notes.houseEstimated, /3 sur 4/);
});

test('hourly and daily aggregation preserve Zurich DST durations and repeated hour labels', () => {
  for (const [start, end, hours] of [['2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z', 23], ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 25]] as const) {
    const day = fixture(start, end);
    const hourly = historyTable(day, allHistorySelection, 'hour');
    const daily = historyTable([day], allHistorySelection, 'day');
    assert.equal(hourly.rows.length, hours);
    assert.equal(daily.rows.length, 1);
    assert.equal(daily.rows[0].start, start);
    assert.equal(daily.rows[0].end, end);
    near(daily.rows[0].values.houseMeasured, hours);
    near(daily.rows[0].values.solarEstimated, hours * 8);
    assert.match(daily.rows[0].notes.houseEstimated, new RegExp(`${hours * 4} sur ${hours * 4}`));
    assert.match(daily.rows[0].notes.houseMeasured, new RegExp(`${hours * 4} relevés`));
    near(hourly.rows.reduce((sum: number, row: any) => sum + row.values.houseMeasured, 0), daily.rows[0].values.houseMeasured);
    if (hours === 25) assert.deepEqual(hourly.rows.filter((row: any) => row.label.startsWith('02:00')).map((row: any) => row.label), ['02:00 (1)', '02:00 (2)']);
    else assert.ok(hourly.rows.every((row: any) => !row.label.startsWith('02:00')));
  }
});

test('daily view shows fourteen dated rows including empty days and uses the last SOC without averaging', () => {
  const start = Date.parse('2026-01-01T23:00:00.000Z');
  const days = Array.from({ length: 14 }, (_, index) => fixture(new Date(start + index * 86400000).toISOString(), new Date(start + (index + 1) * 86400000).toISOString()));
  days[0].battery.points = [{ at: days[0].periodStart, socPercent: 20 }, { at: new Date(start + 86000000).toISOString(), socPercent: 0 }];
  days[0].historicalEstimated.points.at(-1)!.socPercent = 90;
  days[1].observations = { method: 'counter_differences', solar: [], household: [] };
  days[1].energyEstimates = []; days[1].solarEstimates = []; days[1].historicalEstimated.points = [];
  const table = historyTable(days, allHistorySelection, 'day');
  assert.equal(table.rows.length, 14);
  assert.equal(table.rows[0].label, '02.01.2026');
  assert.equal(table.rows.at(-1).label, '15.01.2026');
  near(table.rows[0].values.houseMeasured, 24);
  assert.equal(table.rows[0].values.batteryMeasured, 0);
  assert.equal(table.rows[0].values.batteryEstimated, 90);
  assert.ok(Object.values(table.rows[1].values).every(value => value === null));
  assert.equal(table.hasData, true);
  assert.deepEqual(historyTable(days, ['solarMeasured'], 'day').columns.map((column: any) => column.key), ['solarMeasured']);
});

test('history future limit uses seven Zurich calendar days across DST and year boundaries', () => {
  for (const [at, expected] of [
    ['2026-03-28T23:30:00Z', '2026-04-05'], ['2026-10-24T22:30:00Z', '2026-11-01'],
    ['2026-12-31T23:30:00Z', '2027-01-08'],
  ]) assert.equal(data.latestHistoryDate(new Date(at)), expected);
});

test('history explains unavailable or passive battery forecasts without warning on past days', async () => {
  const { batteryForecastMessage } = await import(new URL('../public/history.js', import.meta.url).href);
  const date = todayInZurich();
  const projection = { status: 'unavailable', reason: 'soc_unavailable', assumption: 'automatic_planning' };
  assert.match(batteryForecastMessage({ date, historicalEstimated: { projection } }), /niveau de charge récent/);
  assert.equal(batteryForecastMessage({ date: '2020-01-01', historicalEstimated: { projection } }), '');
  assert.match(batteryForecastMessage({ date, historicalEstimated: { projection: {
    status: 'available', reason: null, assumption: 'passive_operation',
  } } }), /sans recharge programmée/);
});
