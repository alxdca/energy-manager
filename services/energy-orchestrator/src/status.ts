export interface Telemetry {
  status: 'online' | 'stale' | 'offline' | 'not_configured';
  observedAt: string | null;
  error: string | null;
  solarKw: number | null;
  householdKw: number | null;
  gridImportKw: number | null;
  gridExportKw: number | null;
  batterySocPercent: number | null;
  batteryChargeKw: number | null;
  batteryDischargeKw: number | null;
}

export interface StatusOptions {
  controllerUrl?: string | null;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

const empty = {
  observedAt: null, solarKw: null, householdKw: null, gridImportKw: null,
  gridExportKw: null, batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null,
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
class ControllerError extends Error {}

function parseTelemetry(body: unknown, now: Date): Telemetry {
  if (!isObject(body) || body.success !== true || typeof body.timestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(body.timestamp)
    || (body.site !== null && !isObject(body.site))
    || (body.battery !== null && !isObject(body.battery))) {
    throw new ControllerError('Le contrôleur a renvoyé une réponse d’état invalide');
  }
  const observed = new Date(body.timestamp);
  const [year, month, day] = body.timestamp.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  // Separate hosts can differ slightly; larger future observations remain invalid.
  if (!Number.isFinite(observed.getTime()) || observed.getTime() > now.getTime() + 5000
    || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new ControllerError('Le contrôleur a renvoyé un horodatage de mesure invalide');
  }
  const site = isObject(body.site) ? body.site : {};
  const battery = isObject(body.battery) ? body.battery : {};
  const solar = finite(site.P_PV);
  const load = finite(site.P_Load);
  const grid = finite(site.P_Grid);
  const batteryPower = finite(site.P_Akku);
  const soc = finite(battery.socPercent);
  return {
    status: now.getTime() - observed.getTime() > 30_000 ? 'stale' : 'online',
    observedAt: observed.toISOString(), error: null,
    solarKw: solar !== null && solar >= 0 ? solar / 1000 : null,
    householdKw: load !== null && load <= 0 ? Math.abs(load) / 1000 : null,
    gridImportKw: grid === null ? null : Math.max(0, grid) / 1000,
    gridExportKw: grid === null ? null : Math.max(0, -grid) / 1000,
    batterySocPercent: soc !== null && soc >= 0 && soc <= 100 && Array.isArray(battery.validValues) && battery.validValues.includes('soc') ? soc : null,
    batteryChargeKw: batteryPower === null ? null : Math.max(0, -batteryPower) / 1000,
    batteryDischargeKw: batteryPower === null ? null : Math.max(0, batteryPower) / 1000,
  };
}

export function resolveControllerUrl(options: StatusOptions = {}): URL | null {
  const configured = options.controllerUrl === undefined
    ? process.env.ENERGY_CONTROLLER_URL ?? 'http://127.0.0.1:3001'
    : options.controllerUrl;
  let endpoint: URL | null = null;
  if (configured?.trim()) {
    try {
      endpoint = new URL(configured);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    } catch {
      throw new Error('ENERGY_CONTROLLER_URL doit être une URL de base HTTP(S) sans identifiants, paramètres ni fragment');
    }
  }
  return endpoint;
}

export function createTelemetryReader(options: StatusOptions = {}) {
  const baseUrl = resolveControllerUrl(options);
  const endpoint = baseUrl ? new URL(baseUrl.toString()) : null;
  if (endpoint) endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/system/status`;
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let lastGood: Telemetry | null = null;
  let error: string | null = null;
  let pending: Promise<void> | null = null;

  async function refresh() {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout'));
      }, 3000);
    });
    try {
      const result = await Promise.race([
        (async () => {
          const response = await request(endpoint!, { method: 'GET', signal: controller.signal, redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } });
          if (!response.ok) throw new ControllerError(`Échec de la demande d’état du contrôleur (HTTP ${response.status})`);
          const body: unknown = await response.json().catch(() => { throw new ControllerError('Le contrôleur a renvoyé du JSON invalide'); });
          return parseTelemetry(body, now());
        })(), timeout,
      ]);
      lastGood = result;
      error = null;
    } catch (failure) {
      error = controller.signal.aborted ? 'La demande d’état du contrôleur a expiré'
        : failure instanceof ControllerError ? failure.message : 'L’état du contrôleur est indisponible';
    } finally {
      clearTimeout(timer);
    }
  }

  return async (): Promise<Telemetry> => {
    if (!endpoint) return { ...empty, status: 'not_configured', error: null };
    if (pending) await pending;
    else {
      pending = refresh();
      try { await pending; } finally { pending = null; }
    }
    if (!lastGood) return { ...empty, status: 'offline', error };
    const stale = error !== null || now().getTime() - new Date(lastGood.observedAt!).getTime() > 30_000;
    return { ...lastGood, status: stale ? 'stale' : 'online', error };
  };
}
