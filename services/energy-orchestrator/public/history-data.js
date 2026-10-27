const zone = 'Europe/Zurich';
const quarterMs = 900000;
const numberFormat = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 9 });
const unitFormats = Object.fromEntries([['Wh', 0], ['kW', 3], ['%', 2], ['°C', 2], ['°', 2], ['s', 3]].map(([unit, digits]) => [unit, new Intl.NumberFormat('fr-CH', { maximumFractionDigits: digits })]));
const clockFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric' });
const finiteEnergy = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validSoc = value => finiteEnergy(value) && value <= 100;
const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;

export const historyGroups = [
  { id: 'solar', label: 'Solaire', columns: [{ key: 'solarEstimated', label: 'Prévu', unit: 'Wh' }, { key: 'solarMeasured', label: 'Mesuré', unit: 'Wh' }] },
  { id: 'house', label: 'Maison', columns: [{ key: 'houseEstimated', label: 'Prévu', unit: 'Wh' }, { key: 'houseMeasured', label: 'Mesuré', unit: 'Wh' }] },
  { id: 'battery', label: 'Batterie', columns: [{ key: 'batteryEstimated', label: 'Prévu', unit: '%' }, { key: 'batteryMeasured', label: 'Mesuré', unit: '%' }] },
];
export const allHistorySelection = historyGroups.flatMap(group => group.columns.map(column => column.key));
export const defaultHistorySelection = [...allHistorySelection];

function recordedObservations(day, channel) {
  const result = new Map();
  for (const point of day?.observations?.method === 'counter_differences' && Array.isArray(day.observations[channel]) ? day.observations[channel] : []) {
    const at = instant(point?.at);
    if (Number.isFinite(at) && at <= Date.now() + 5000 && finiteEnergy(point.value)) result.set(at, point.value / 1000);
  }
  return [...result].sort((a, b) => a[0] - b[0]);
}
function measuredEnergy(start, end, recorded) {
  let value = null, count = 0, firstObservedAt = null, lastObservedAt = null;
  for (const [at, energyKwh] of recorded) {
    if (at < start || at >= end) continue;
    value = (value ?? 0) + energyKwh;
    count++;
    firstObservedAt ??= at; lastObservedAt = at;
  }
  return { value: Number.isFinite(value) ? value : null, count, firstObservedAt, lastObservedAt };
}
function estimatedIntervals(values, key) {
  const result = new Map();
  for (const row of Array.isArray(values) ? values : []) {
    const start = instant(row?.start), end = instant(row?.end);
    if (!Number.isFinite(start) || end - start !== quarterMs || start % quarterMs !== 0) continue;
    result.set(start, result.has(start) ? null : finiteEnergy(row[key]) ? row[key] : null);
  }
  return result;
}
function estimatedEnergy(intervals, start, end) {
  let value = null, count = 0;
  for (let at = start; at < end; at += quarterMs) {
    const energy = intervals.get(at);
    if (!finiteEnergy(energy)) continue;
    value = (value ?? 0) + energy;
    count++;
  }
  return { value: Number.isFinite(value) ? value : null, count, expected: (end - start) / quarterMs };
}
function estimatedNote(estimate) {
  const coverage = `${estimate.count} sur ${estimate.expected} tranches de 15 min`;
  return estimate.value === null ? `Aucune estimation enregistrée (${coverage}).`
    : `Somme de ${coverage}.${estimate.count < estimate.expected ? ' Sous-total enregistré ; les périodes manquantes ne sont pas extrapolées.' : ''}`;
}
function batteryObservations(day) {
  return (Array.isArray(day?.battery?.points) ? day.battery.points : [])
    .map(point => ({ at: instant(point?.at), value: point?.socPercent }))
    .filter(point => Number.isFinite(point.at) && validSoc(point.value)).sort((a, b) => a.at - b.at);
}
function batteryPredictions(day) {
  const points = new Map();
  for (const point of Array.isArray(day?.historicalEstimated?.points) ? day.historicalEstimated.points : []) {
    const at = instant(point?.at);
    if (!Number.isFinite(at) || at % quarterMs !== 0 || !validSoc(point.socPercent)) continue;
    points.set(at, points.has(at) ? null : point.socPercent);
  }
  return points;
}
function timeText(at, seconds = false) {
  const parts = Object.fromEntries(clockFormat.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return `${parts.hour}:${parts.minute}${seconds ? `:${parts.second}` : ''}`;
}
function measuredNote(readings) {
  if (readings.value === null) return 'Aucune énergie mesurée enregistrée dans cette tranche.';
  const range = readings.firstObservedAt === readings.lastObservedAt ? `à ${timeText(readings.firstObservedAt, true)}`
    : `de ${timeText(readings.firstObservedAt, true)} à ${timeText(readings.lastObservedAt, true)}`;
  return `Somme de ${readings.count} relevés d’énergie conservés, sans moyenne. Relevés horodatés ${range}.`;
}

/** Aggregate only within each real Zurich day; missing periods remain unknown. */
export function historyTable(dayOrDays, selection = defaultHistorySelection, aggregation = 'quarter') {
  if (aggregation !== 'day') return dayTable(dayOrDays, selection, aggregation);
  const days = Array.isArray(dayOrDays) ? dayOrDays : [dayOrDays];
  const model = dayTable(undefined, selection);
  model.rows = days.flatMap(day => dayTable(day, selection, 'day').rows);
  model.hasData = model.rows.some(row => model.columns.some(column => row.values[column.key] !== null));
  return model;
}

function dayTable(day, selection, aggregation = 'quarter') {
  const selected = new Set(selection && typeof selection[Symbol.iterator] === 'function' ? selection : defaultHistorySelection);
  const groups = historyGroups.map(group => ({ ...group, columns: group.columns.filter(column => selected.has(column.key))
    .map(column => ({ ...column, groupId: group.id, groupLabel: group.label })) })).filter(group => group.columns.length > 0);
  const columns = groups.flatMap(group => group.columns);
  const start = instant(day?.periodStart), end = instant(day?.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || start % quarterMs !== 0 || end % quarterMs !== 0) return { groups, columns, rows: [], hasData: false };
  const recordedSolar = recordedObservations(day, 'solar'), recordedHouse = recordedObservations(day, 'household');
  const consumption = estimatedIntervals(day?.householdPredictions ?? day?.energyEstimates, 'estimatedConsumptionKwh');
  const production = estimatedIntervals(day?.solarEstimates, 'estimatedProductionKwh');
  const observations = batteryObservations(day), predictions = batteryPredictions(day);
  const rows = [];
  let observedIndex = 0;
  const stepMs = aggregation === 'day' ? end - start : aggregation === 'hour' ? 3600000 : quarterMs;
  for (let from = start; from < end; from += stepMs) {
    const to = Math.min(from + stepMs, end);
    const house = measuredEnergy(from, to, recordedHouse), pv = measuredEnergy(from, to, recordedSolar);
    const houseEstimate = estimatedEnergy(consumption, from, to), solarEstimate = estimatedEnergy(production, from, to);
    let observed = null;
    while (observedIndex < observations.length && observations[observedIndex].at < to) {
      if (observations[observedIndex].at >= from) observed = observations[observedIndex];
      observedIndex++;
    }
    let predicted = null, predictedAt = null;
    for (let at = from + quarterMs; at <= to; at += quarterMs) {
      const value = predictions.get(at);
      if (validSoc(value)) { predicted = value; predictedAt = at; }
    }
    const values = { houseMeasured: house.value, houseEstimated: houseEstimate.value,
      batteryMeasured: observed?.value ?? null, batteryEstimated: predicted ?? null,
      solarMeasured: pv.value, solarEstimated: solarEstimate.value };
    const notes = {
      houseMeasured: measuredNote(house),
      solarMeasured: measuredNote(pv),
      houseEstimated: aggregation !== 'quarter' ? estimatedNote(houseEstimate) : values.houseEstimated === null ? 'Aucune estimation enregistrée pour cette tranche.' : 'Estimation enregistrée pour cette tranche de 15 min.',
      solarEstimated: aggregation !== 'quarter' ? estimatedNote(solarEstimate) : values.solarEstimated === null ? 'Aucune estimation solaire enregistrée pour cette tranche.' : 'Prévision solaire enregistrée pour cette tranche de 15 min.',
      batteryMeasured: observed ? `${aggregation === 'quarter' ? 'Relevé de la tranche' : 'Dernier relevé dans la période'} à ${timeText(observed.at, true)}. Le niveau de charge n’est pas moyenné.${aggregation !== 'quarter' ? ' Les tranches sans relevé restent inconnues ; aucun report hors de cette période.' : ''}` : 'Aucun niveau de batterie mesuré dans cette tranche.',
      batteryEstimated: predicted !== null && predicted !== undefined ? aggregation === 'quarter' ? `Prévision pour la fin de la tranche à ${timeText(to)}.` : `Dernière prévision enregistrée pour une cible de cette période, à ${timeText(predictedAt)}. Le niveau de charge n’est pas moyenné ; les cibles manquantes ne sont pas interpolées.`
        : aggregation === 'quarter' ? 'Aucune prévision enregistrée à la fin exacte de cette tranche. Le niveau de charge n’est pas interpolé.' : 'Aucune prévision enregistrée pour les cibles de cette période. Le niveau de charge n’est pas interpolé.',
    };
    rows.push({ start: new Date(from).toISOString(), end: new Date(to).toISOString(), label: aggregation === 'day' ? formatHistoryValue(day.date, { type: 'date' }) : timeText(from), values, notes });
  }
  const counts = new Map(), occurrences = new Map();
  for (const row of rows) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
  for (const row of rows) if (counts.get(row.label) > 1) {
    const label = row.label, count = (occurrences.get(label) ?? 0) + 1;
    occurrences.set(label, count); row.label = `${label} (${count})`;
  }
  return { groups, columns, rows, hasData: rows.some(row => columns.some(column => row.values[column.key] !== null)) };
}

export function formatHistoryValue(value, field = {}) {
  if (value === null || value === undefined || typeof value === 'number' && !Number.isFinite(value)) return '—';
  // Energy aggregation stays in kWh; convert only at the display boundary.
  if (!field.type || field.type === 'number') return typeof value === 'number'
    ? (unitFormats[field.unit] ?? numberFormat).format(field.unit === 'Wh' ? value * 1000 : value) : '—';
  if (field.type === 'boolean') return typeof value === 'boolean' ? value ? 'Oui' : 'Non' : '—';
  if (field.type === 'time' || field.type === 'timestamp') {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) return '—';
    if (field.type === 'time') return timeText(at.getTime(), true);
    const parts = Object.fromEntries(dateFormat.formatToParts(at).map(part => [part.type, part.value]));
    return `${parts.day}.${parts.month}.${parts.year} ${timeText(at.getTime(), true)}`;
  }
  if (field.type === 'date') return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('.') : '—';
  return typeof value === 'string' ? value : '—';
}
export function validHistoryDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}
export function shiftHistoryDate(value, offset) {
  return validHistoryDate(value) ? new Date(Date.parse(`${value}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10) : null;
}
export function todayInZurich(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
