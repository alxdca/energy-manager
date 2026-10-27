import { resolveControllerUrl, type StatusOptions } from './status.js';
import type { EnergyCounterPoint, EnergyCounterSnapshot, ObservationPoint } from './observation-types.js';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const unavailable = (error: string): EnergyCounterSnapshot => ({ status: 'offline', error, solar: null, household: null });

function timestamp(value: unknown, now: Date): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const at = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(at) || !Number.isFinite(now.getTime()) || at > now.getTime() + 5000 || at < now.getTime() - 40_000
    || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return new Date(at).toISOString();
}

function batteryPoint(value: unknown, now: Date): ObservationPoint | null {
  if (!object(value) || typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0 || value.value > 100) return null;
  const at = timestamp(value.at, now);
  return at ? { at, value: value.value } : null;
}

function point(value: unknown, now: Date, solar: boolean): EnergyCounterPoint | null {
  if (!object(value) || typeof value.value !== 'number' || !Number.isFinite(value.value)
    || solar && value.value < 0 || typeof value.source !== 'string' || !value.source.trim() || value.source.length > 1000) return null;
  const at = timestamp(value.at, now);
  if (!at) return null;
  let components: Record<string, number> | undefined;
  if (value.components !== undefined) {
    const raw = value.components;
    const phases = ['01', '02', '03'];
    const keys = solar ? ['pv1Wh', 'pv2Wh'] : [...phases.flatMap(phase => [`acProduced${phase}Wh`, `acConsumed${phase}Wh`]), 'gridImportWh', 'gridExportWh'];
    if (!object(raw) || Object.keys(raw).length !== keys.length
      || !keys.every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0)) return null;
    components = Object.fromEntries(keys.map(key => [key, raw[key] as number]));
    const total = solar ? components.pv1Wh + components.pv2Wh
      : phases.reduce((sum, phase) => sum + components![`acProduced${phase}Wh`] - components![`acConsumed${phase}Wh`], 0)
        + components.gridImportWh - components.gridExportWh;
    if (!Number.isFinite(total) || Math.abs(total - value.value) > 1e-6) return null;
  }
  return { at, value: value.value, source: value.source, ...(components ? { components } : {}) };
}

/** Read actual cumulative counters independently of fast power/control telemetry. */
export function createEnergyCounterReader(options: StatusOptions = {}) {
  const endpoint = resolveControllerUrl(options);
  if (endpoint) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/system/energy-counters`;
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let pending: Promise<EnergyCounterSnapshot> | null = null;
  async function refresh(): Promise<EnergyCounterSnapshot> {
    if (!endpoint) return unavailable('Energy-counter collection is not configured.');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await request(endpoint, { method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal,
            headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`Energy-counter request returned HTTP ${response.status}.`);
          const body: unknown = await response.json();
          if (!object(body) || body.status !== 'online' || !(body.error === null || typeof body.error === 'string')) {
            return unavailable('Energy-counter response is unavailable or invalid.');
          }
          const current = now();
          const solar = point(body.solar, current, true), household = point(body.household, current, false);
          const battery = batteryPoint(body.battery, current);
          return { status: solar || household || battery ? 'online' as const : 'offline' as const, solar, household,
            ...(body.battery !== undefined ? { battery } : {}),
            error: solar && household ? null : typeof body.error === 'string' ? body.error : 'Some energy counters are unavailable or stale.' };
        })(),
        new Promise<EnergyCounterSnapshot>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('Energy-counter request timed out.'));
        }, 3000); }),
      ]);
    } catch (error) { return unavailable(error instanceof Error ? error.message : 'Energy-counter request failed.'); }
    finally { clearTimeout(timer); }
  }
  return async (): Promise<EnergyCounterSnapshot> => {
    if (!pending) pending = refresh();
    const current = pending;
    try { return structuredClone(await current); }
    finally { if (pending === current) pending = null; }
  };
}
