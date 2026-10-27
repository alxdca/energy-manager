import type { Telemetry } from './status.js';

const empty = {
  observedAt: null, solarKw: null, householdKw: null, gridImportKw: null, gridExportKw: null,
  batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null,
};
const unavailable = 'Les mesures moyennes sont indisponibles';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const power = (value: unknown): number | null => finite(value) && value >= 0 ? value : null;
const soc = (value: unknown): number | null => finite(value) && value >= 0 && value <= 100 ? value : null;
const mean = (values: Array<number | null>): number | null => values.some(value => value === null)
  ? null : values.reduce<number>((sum, value) => sum + value! / values.length, 0);

function observedTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!finite(parsed)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day ? parsed : null;
}

/** Display-only smoothing; callers performing control or recording history keep the raw reader. */
export function createDisplayTelemetryReader(
  readTelemetry: () => Promise<Telemetry>,
  options: { now?: () => Date; wait?: (milliseconds: number) => Promise<void> } = {},
): () => Promise<Telemetry> {
  const now = options.now ?? (() => new Date());
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastGood: Telemetry | null = null;
  let pending: Promise<Telemetry> | null = null;

  function failed(error: string): Telemetry {
    return lastGood ? { ...lastGood, status: 'stale', error } : { ...empty, status: 'offline', error };
  }

  async function collect(): Promise<Telemetry> {
    const samples: Array<Telemetry | null> = [];
    for (let index = 0; index < 3; index++) {
      const started = now().getTime();
      let sample: Telemetry | null = null;
      try { sample = { ...await readTelemetry() }; } catch { /* Keep all three attempts; never average a partial batch. */ }
      if (index === 0 && sample?.status === 'not_configured') return { ...empty, status: 'not_configured', error: sample.error };
      samples.push(sample);
      if (index < 2) {
        const elapsed = now().getTime() - started;
        await wait(finite(elapsed) ? Math.max(0, 1100 - Math.max(0, elapsed)) : 0);
      }
    }
    const finished = now().getTime();
    const times = samples.map(sample => observedTime(sample?.observedAt));
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const time = times[index];
      if (!sample || sample.status !== 'online') return failed(sample?.error || unavailable);
      if (!finite(finished) || time === null || finished - time > 30_000 || time - finished > 5000) {
        return failed('Les mesures moyennes sont trop anciennes ou leur horodatage est invalide');
      }
    }
    const readings = samples as Telemetry[];
    const signedMean = (positive: keyof Telemetry, negative: keyof Telemetry) => mean(readings.map(sample => {
      const a = power(sample[positive]), b = power(sample[negative]);
      return a === null || b === null ? null : a - b;
    }));
    const grid = signedMean('gridImportKw', 'gridExportKw');
    const battery = signedMean('batteryDischargeKw', 'batteryChargeKw');
    lastGood = {
      status: 'online', observedAt: new Date(Math.max(...times as number[])).toISOString(), error: null,
      solarKw: mean(readings.map(sample => power(sample.solarKw))),
      householdKw: mean(readings.map(sample => power(sample.householdKw))),
      batterySocPercent: mean(readings.map(sample => soc(sample.batterySocPercent))),
      gridImportKw: grid === null ? null : Math.max(0, grid),
      gridExportKw: grid === null ? null : Math.max(0, -grid),
      batteryDischargeKw: battery === null ? null : Math.max(0, battery),
      batteryChargeKw: battery === null ? null : Math.max(0, -battery),
    };
    return { ...lastGood };
  }

  return () => {
    if (!pending) pending = collect().catch(() => failed(unavailable)).finally(() => { pending = null; });
    return pending;
  };
}
