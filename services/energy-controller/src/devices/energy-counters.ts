export interface EnergyCounterPoint { at: string; value: number; source: string; components?: Record<string, number> }
export interface EnergyCounterSnapshot {
  status: 'online' | 'offline';
  error: string | null;
  solar: EnergyCounterPoint | null;
  household: EnergyCounterPoint | null;
  battery?: { at: string; value: number } | null;
}
interface CounterOptions { baseUrl: string; fetch?: typeof globalThis.fetch; now?: () => Date }
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const enabled = (attributes: RecordValue) => attributes['[ENABLE]'] === true || attributes['[ENABLE]'] === 'true' || attributes['[ENABLE]'] === '1';
const disabled = (attributes: RecordValue) => Object.hasOwn(attributes, '[ENABLE]') && !enabled(attributes)
  || Object.hasOwn(attributes, '[VISIBLE]') && !enabled({ '[ENABLE]': attributes['[VISIBLE]'] });
const unavailable = (error: string): EnergyCounterSnapshot => ({ status: 'offline', error, solar: null, household: null, battery: null });

function freshTimestamp(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const at = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now + 5000 || at < now - 40_000
    || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return new Date(at).toISOString();
}

function parseCounters(body: unknown, now: Date): EnergyCounterSnapshot {
  if (!object(body) || !object(body.Head) || !freshTimestamp(body.Head.Timestamp, now.getTime())
    || !object(body.Body) || !object(body.Body.Data)
    || body.Head.Status !== undefined && (!object(body.Head.Status) || body.Head.Status.Code !== 0)) return unavailable('Invalid or stale GEN24 energy-counter response.');
  const components = Object.entries(body.Body.Data).flatMap(([id, value]) => {
    if (!object(value) || !object(value.attributes) || !object(value.channels) || disabled(value.attributes)) return [];
    const stamp = value.channels.COMPONENTS_TIME_STAMP_U64;
    const date = nonnegative(stamp) ? new Date(stamp * 1000) : null;
    const at = date && Number.isFinite(date.getTime()) ? freshTimestamp(date.toISOString(), now.getTime()) : null;
    return at ? [{ id, attributes: value.attributes, channels: value.channels, at }] : [];
  });
  const inverters = components.filter(value => /fronius/i.test(String(value.attributes.manufacturer))
    && /gen24/i.test(String(value.attributes.model)));
  const inverter = inverters.length === 1 ? inverters[0] : null;
  const storage = components.filter(value => enabled(value.attributes) && value.attributes['device-class'] === 'Storage');
  const soc = storage.length === 1 ? storage[0].channels.BAT_VALUE_STATE_OF_CHARGE_RELATIVE_F32 : null;
  const battery = nonnegative(soc) && soc <= 100 ? { at: storage[0].at, value: soc } : null;
  const sum = (channels: RecordValue, keys: string[]) => {
    const values = keys.map(key => channels[key]);
    if (!values.every(nonnegative)) return null;
    const total = values.reduce((result, value) => result + value, 0);
    return Number.isFinite(total) ? total : null;
  };
  // Inverter component energy counters are Ws; Smart Meter absolute counters are already Wh.
  const pvKeys = ['PV_ENERGYACTIVE_ACTIVE_SUM_01_U64', 'PV_ENERGYACTIVE_ACTIVE_SUM_02_U64'];
  const pv = inverter ? sum(inverter.channels, pvKeys) : null;
  const phases = ['01', '02', '03'];
  const produced = inverter ? sum(inverter.channels, phases.map(phase => `ACBRIDGE_ENERGYACTIVE_PRODUCED_SUM_${phase}_U64`)) : null;
  const consumed = inverter ? sum(inverter.channels, phases.map(phase => `ACBRIDGE_ENERGYACTIVE_ACTIVECONSUMED_SUM_${phase}_U64`)) : null;
  const solar = !inverter || pv === null ? null : { at: inverter.at, value: pv / 3600, source: `GEN24_PV_DC:${inverter.id}`,
    components: Object.fromEntries(pvKeys.map((key, index) => [`pv${index + 1}Wh`, (inverter.channels[key] as number) / 3600])) };
  const meters = components.filter(value => enabled(value.attributes) && String(value.attributes['meter-location']) === '0'
    && /fronius/i.test(String(value.attributes.manufacturer)) && /smart\s*meter/i.test(String(value.attributes.model)));
  let household: EnergyCounterPoint | null = null;
  if (inverter && meters.length === 1 && produced !== null && consumed !== null) {
    const meter = meters[0];
    const imported = meter.channels.SMARTMETER_ENERGYACTIVE_ABSOLUT_PLUS_F64;
    const exported = meter.channels.SMARTMETER_ENERGYACTIVE_ABSOLUT_MINUS_F64;
    if (nonnegative(imported) && nonnegative(exported) && Math.abs(Date.parse(inverter.at) - Date.parse(meter.at)) <= 5000) {
      const value = (produced - consumed) / 3600 + imported - exported;
      // A composite reading cannot predate any of its inputs, especially across a quarter target.
      if (Number.isFinite(value)) household = { at: inverter.at > meter.at ? inverter.at : meter.at, value,
        source: `GEN24_HOUSE_AC:${inverter.id}:${meter.id}`,
        components: { ...Object.fromEntries(phases.flatMap(phase => [
          [`acProduced${phase}Wh`, (inverter.channels[`ACBRIDGE_ENERGYACTIVE_PRODUCED_SUM_${phase}_U64`] as number) / 3600],
          [`acConsumed${phase}Wh`, (inverter.channels[`ACBRIDGE_ENERGYACTIVE_ACTIVECONSUMED_SUM_${phase}_U64`] as number) / 3600],
        ])), gridImportWh: imported, gridExportWh: exported },
      };
    }
  }
  return { status: solar || household || battery ? 'online' : 'offline', solar, household, battery,
    error: solar && household && battery ? null : 'Some GEN24 observations are unavailable or stale.' };
}

/** Dedicated read-only acquisition. Coalesce only in-flight requests; never serve a cached reading as new. */
export function createEnergyCounterReader(options: CounterOptions) {
  const endpoint = new URL('/components/readable', options.baseUrl);
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let pending: Promise<EnergyCounterSnapshot> | null = null;
  async function refresh(): Promise<EnergyCounterSnapshot> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await request(endpoint, { method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal,
            headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`GEN24 energy counters returned HTTP ${response.status}.`);
          return parseCounters(await response.json(), now());
        })(),
        new Promise<EnergyCounterSnapshot>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('GEN24 energy-counter request timed out.'));
        }, 2500); }),
      ]);
    } catch (error) { return unavailable(error instanceof Error ? error.message : 'GEN24 energy counters are unavailable.'); }
    finally { clearTimeout(timer); }
  }
  return async (): Promise<EnergyCounterSnapshot> => {
    if (!pending) pending = refresh();
    const current = pending;
    try { return structuredClone(await current); }
    finally { if (pending === current) pending = null; }
  };
}
