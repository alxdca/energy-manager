import type { PublishedForecast } from './forecast-publication.js';
import type { HouseholdForecast } from './household-model.js';
import { getCalendarDayBounds } from './policy.js';

/** A daily total is known only with complete, ordered quarter-hour coverage. */
function total(rows: unknown, key: string, start: number, end: number): number | null {
  if (!Array.isArray(rows) || rows.length !== (end - start) / 900_000) return null;
  let sum = 0;
  for (const [index, row] of rows.entries()) {
    if (Date.parse(row?.start) !== start + index * 900_000 || Date.parse(row?.end) !== start + (index + 1) * 900_000
      || typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0) return null;
    sum += row[key];
  }
  return Number.isFinite(sum) ? sum : null;
}

export function summarizeForecast(date: string, publication: PublishedForecast | null, household: HouseholdForecast | null | undefined,
  projectionCurrent: boolean) {
  if (publication?.forecast.date !== date) publication = null;
  const bounds = getCalendarDayBounds(new Date(`${date}T00:00:00Z`));
  const start = bounds.start.getTime(), end = bounds.end.getTime();
  const forecast = publication?.forecast.date === date ? publication.forecast : null;
  const productionKwh = forecast && ['online', 'stale'].includes(forecast.status)
    ? total(forecast.quarterHourly, 'estimatedProductionKwh', start, end) : null;
  const consumption = household === undefined ? forecast?.consumption : household;
  const consumptionKwh = consumption?.date === date && (!('scope' in consumption) || consumption.scope === 'household_total')
    ? total('slots' in consumption ? consumption.slots : consumption.quarterHourly, 'estimatedConsumptionKwh', start, end) : null;
  const points = projectionCurrent && publication?.projection.status === 'available'
    ? publication.projection.points.filter(p => Date.parse(p.at) >= start && Date.parse(p.at) <= end
      && Number.isFinite(p.socPercent) && p.socPercent >= 0 && p.socPercent <= 100) : [];
  // Never label a partial day's last point as an end-of-day forecast.
  const endPoint = points.find(p => Date.parse(p.at) === end);
  const completeBattery = points.some(p => Date.parse(p.at) === start) && endPoint !== undefined;
  return { date, productionKwh, consumptionKwh,
    consumptionSource: consumption?.source ?? null,
    solarStatus: forecast?.status ?? 'offline', weatherModel: forecast?.weatherModel ?? null,
    batteryEndSocPercent: completeBattery ? endPoint.socPercent : null,
    batteryMinSocPercent: completeBattery ? Math.min(...points.map(p => p.socPercent)) : null,
    calculatedAt: publication?.calculatedAt ?? null };
}
