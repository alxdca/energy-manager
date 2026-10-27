import { readFile } from 'node:fs/promises';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { FroniusInverter, isAutomationFence } from '../devices/fronius-inverter.js';
import { Battery } from '../devices/battery.js';
import { Wattpilot } from '../devices/wattpilot.js';
import { createWattpilotAutomation, type WattpilotAutomation } from '../devices/wattpilot-automation.js';
import { BatteryMode } from '../types/common.js';
import { config, type SystemConfig } from '../config/index.js';

interface ApiOptions {
  settings?: SystemConfig;
  createInverter?: () => FroniusInverter;
  createBattery?: (inverter: FroniusInverter) => Battery;
  createWattpilot?: () => Pick<Wattpilot, 'readStatus' | 'setControl' | 'disconnect'>;
  wattpilotJournalPath?: string | null;
}

export function createApi(options: ApiOptions = {}) {
  const settings = options.settings ?? config;
  const app = new Hono();
  let devices: { inverter: FroniusInverter; battery: Battery } | undefined;
  let initializing: Promise<NonNullable<typeof devices>> | undefined;
  let stopping = false;
  let started = false;
  let shutdownPromise: Promise<void> | undefined;
  let wattpilot: Pick<Wattpilot, 'readStatus' | 'setControl' | 'disconnect'> | undefined;
  let wattpilotAutomation: WattpilotAutomation | undefined;
  type Overview = Awaited<ReturnType<FroniusInverter['getSystemOverview']>>;
  let reading: Promise<{ overview: Overview; timestamp: string }> | undefined;

  function assertRunning() {
    if (stopping) throw new HTTPException(503, { message: 'Server is shutting down' });
  }

  function charger() {
    assertRunning();
    return wattpilot ??= options.createWattpilot?.() ?? new Wattpilot(settings.wattpilot);
  }
  function chargerAutomation() {
    assertRunning();
    return wattpilotAutomation ??= createWattpilotAutomation({ device: charger,
      journalPath: options.wattpilotJournalPath === undefined ? settings.wattpilotJournalPath : options.wattpilotJournalPath });
  }

  async function ensureInitialized() {
    assertRunning();
    if (devices) return devices;
    if (!initializing) {
      initializing = (async () => {
        const inverter = options.createInverter?.() ?? new FroniusInverter();
        try {
          await inverter.initialize();
          const battery = options.createBattery?.(inverter) ?? new Battery(inverter);
          await battery.initialize();
          devices = { inverter, battery };
          if (started && !stopping && settings.fronius.control.enabled) inverter.startSitePowerSupervision();
          return devices;
        } catch (error) {
          await inverter.disconnect().catch(() => {});
          const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
          throw new HTTPException(503, { message: `Device initialization failed${detail}`, cause: error });
        }
      })().finally(() => { initializing = undefined; });
    }
    const ready = await initializing;
    assertRunning();
    return ready;
  }

  async function telemetry() {
    if (!reading) {
      reading = (async () => {
        const { inverter } = await ensureInitialized();
        const overview = await inverter.getSystemOverview();
        if (!overview.solar && !overview.grid && !overview.battery) {
          throw new HTTPException(503, { message: 'Inverter telemetry is unavailable' });
        }
        return { overview, timestamp: new Date().toISOString() };
      })().finally(() => { reading = undefined; });
    }
    return reading;
  }

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (stopping) return c.json({ error: 'Server is shutting down' }, 503);
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (c.req.path.startsWith('/inverter/') && (!settings.fronius.control.enabled || !settings.fronius.control.maxPowerWatts)) {
        return c.json({ error: 'Inverter control is disabled; configure explicit control limits' }, 503);
      }
      if (c.req.path.startsWith('/wattpilot/') && !settings.wattpilot.controlEnabled) {
        return c.json({ error: 'Wattpilot control is disabled; configure explicit current limits' }, 503);
      }
      if (c.req.raw.signal.aborted) return c.json({ error: 'Request was cancelled before control started' }, 409);
    }
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'Request body is too large' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    const status = (error as Error & { statusCode?: number }).statusCode;
    const safeStatus = status === 400 || status === 403 || status === 409 || status === 503 || status === 504 ? status : 502;
    const outcome = (error as Error & { outcome?: string }).outcome;
    return c.json({ error: error.message || 'Device operation failed', ...(outcome === 'unknown' ? { outcome } : {}) }, safeStatus);
  });

  async function body(c: Context): Promise<Record<string, unknown>> {
    let value: unknown;
    try { value = await c.req.json(); } catch (error) {
      if (error instanceof Error && error.name === 'BodyLimitError') throw error;
      throw new HTTPException(400, { message: 'A valid JSON object is required' });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPException(400, { message: 'A JSON object is required' });
    return value as Record<string, unknown>;
  }
  function power(value: unknown, positive = false): number {
    const ceiling = settings.fronius.control.maxPowerWatts;
    if (typeof value !== 'number' || !Number.isFinite(value) || ceiling === null || Math.abs(value) > ceiling || (positive && value <= 0)) {
      throw new HTTPException(400, { message: 'Power must be finite and within the configured limit' });
    }
    return value;
  }

  app.get('/wattpilot/status', async c => c.json({ success: true, wattpilot: await chargerAutomation().readStatus() }));
  app.post('/wattpilot/set-control', async c => {
    const request = await body(c);
    const { mode, currentAmps, phases } = request;
    if (Object.keys(request).some(key => !['mode', 'currentAmps', 'phases'].includes(key))
      || (mode !== 'pause' && mode !== 'eco' && mode !== 'normal')
      || ('phases' in request && phases !== 1 && phases !== 3)
      || (mode === 'pause' ? 'currentAmps' in request || 'phases' in request
        : typeof currentAmps !== 'number' || !Number.isInteger(currentAmps) || currentAmps < 6
          || settings.wattpilot.maxCurrentAmps === null || currentAmps > settings.wattpilot.maxCurrentAmps)) {
      throw new HTTPException(400, { message: 'Choose pause, or eco/normal with an integer currentAmps within configured limits; no other fields are accepted' });
    }
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, { message: 'Request was cancelled before control started' });
    const status = await chargerAutomation().manual({ mode, ...(mode === 'pause' ? {} : { currentAmps: currentAmps as number,
      ...(phases === undefined ? {} : { phases: phases as 1 | 3 }) }) }, c.req.raw.signal);
    return c.json({ success: true, wattpilot: status });
  });
  for (const [path, operation] of [
    ['automation-epoch', 'establish'], ['automation-control', 'control'],
    ['automation-renew', 'renew'], ['automation-stop', 'stop'],
  ] as const) {
    app.post(`/wattpilot/${path}`, async c => {
      const request = await body(c);
      if (operation === 'control' && (typeof request.currentAmps !== 'number' || !Number.isInteger(request.currentAmps)
        || request.currentAmps < 6 || settings.wattpilot.maxCurrentAmps === null || request.currentAmps > settings.wattpilot.maxCurrentAmps)) {
        throw new HTTPException(400, { message: 'Automatic current must be within the configured Wattpilot limit' });
      }
      const supervisor = chargerAutomation();
      const status = operation === 'control' ? await supervisor.control(request, c.req.raw.signal)
        : await supervisor[operation](request);
      return c.json({ success: true, wattpilot: status });
    });
  }

  app.post('/inverter/set-charge-power', async c => {
    const request = await body(c);
    const watts = power(request.powerWatts);
    const target = request.targetSocPercent;
    if ('targetSocPercent' in request && (watts <= 0 || typeof target !== 'number' || !Number.isFinite(target)
      || target <= 0 || target > settings.fronius.control.maxSocPercent)) {
      throw new HTTPException(400, { message: 'Target SOC requires positive charging power and must be within the configured safety limits' });
    }
    const { battery } = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, { message: 'Request was cancelled before control started' });
    await battery.setChargePower(watts, target as number | undefined);
    return c.json({ success: true, powerWatts: watts, ...(target === undefined ? {} : { targetSocPercent: target }), message: watts > 0
      ? `Charging power applied until ${target ?? 100}% SOC or an explicit stop; zero restores normal operation`
      : watts === 0 ? 'Normal operation restored' : 'Bounded discharge power applied; zero restores normal operation' });
  });
  app.post('/inverter/automation-charge', async c => {
    const request = await body(c);
    const watts = power(request.powerWatts, true);
    const target = request.targetSocPercent;
    const expiresAt = request.expiresAt;
    const deadline = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    const owner = request.owner;
    if (Object.keys(request).some(key => !['powerWatts', 'targetSocPercent', 'expiresAt', 'owner'].includes(key))
      || !Number.isInteger(watts) || watts > 6000 || typeof target !== 'number' || !Number.isFinite(target) || target <= 0 || target > settings.fronius.control.maxSocPercent
      || typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)
      || typeof expiresAt !== 'string' || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== expiresAt
      || deadline <= Date.now() || deadline > Date.now() + 16 * 60_000) {
      throw new HTTPException(400, { message: 'Automation requires integer power from 1 to 6000 W within configured limits, a safe SOC target, an owner and a UTC expiry within 16 minutes' });
    }
    const { battery, inverter } = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, { message: 'Request was cancelled before control started' });
    await battery.setAutomationCharge(watts, target, expiresAt, owner);
    return c.json({ success: true, control: inverter.getControlStatus() });
  });
  app.post('/inverter/automation-hold', async c => {
    const request = await body(c);
    const {expiresAt, owner} = request;
    const deadline = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (Object.keys(request).some(key => !['expiresAt', 'owner'].includes(key))
      || typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)
      || typeof expiresAt !== 'string' || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== expiresAt
      || deadline <= Date.now() || deadline > Date.now() + 16 * 60_000) {
      throw new HTTPException(400, {message: 'Automation hold requires an owner and a UTC expiry within 16 minutes'});
    }
    power(6000, true);
    const {battery, inverter} = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, {message: 'Request was cancelled before control started'});
    await battery.setAutomationHold(expiresAt, owner);
    return c.json({success: true, control: inverter.getControlStatus()});
  });
  app.post('/inverter/automation-supply', async c => {
    const request = await body(c);
    const watts = power(request.maxPowerWatts, true);
    const {minimumSocPercent, owner, expiresAt, automationFence, authorizationExpiresAt} = request;
    const deadline = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    const authorizationDeadline = typeof authorizationExpiresAt === 'string' ? Date.parse(authorizationExpiresAt) : NaN;
    if (Object.keys(request).some(key => !['maxPowerWatts', 'minimumSocPercent', 'owner', 'expiresAt', 'automationFence', 'authorizationExpiresAt'].includes(key))
      || !isAutomationFence(automationFence)
      || typeof authorizationExpiresAt !== 'string' || !Number.isFinite(authorizationDeadline)
      || new Date(authorizationDeadline).toISOString() !== authorizationExpiresAt || authorizationDeadline > Date.now() + 10_000
      || watts > 7000 || typeof minimumSocPercent !== 'number' || !Number.isFinite(minimumSocPercent)
      || minimumSocPercent < 0 || minimumSocPercent >= 100
      || typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(owner)
      || typeof expiresAt !== 'string' || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== expiresAt
      || deadline <= Date.now() || deadline > Date.now() + 16 * 60_000) {
      throw new HTTPException(400, {message: 'Automation supply requires a safe discharge cap, SOC floor, owner and UTC expiry within 16 minutes'});
    }
    if (authorizationDeadline <= Date.now()) throw new HTTPException(409, {message: 'Automation supply source authorization expired; a fresh plan is required'});
    const {battery, inverter} = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, {message: 'Request was cancelled before control started'});
    await battery.setAutomationSupply(watts, minimumSocPercent, expiresAt, owner, automationFence, authorizationExpiresAt);
    return c.json({success: true, control: inverter.getControlStatus()});
  });
  app.post('/inverter/automation-stop', async c => {
    const request = await body(c);
    if (Object.keys(request).some(key => key !== 'owner') || typeof request.owner !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.owner)) {
      throw new HTTPException(400, { message: 'A valid automation owner is required' });
    }
    const { battery, inverter } = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, { message: 'Request was cancelled before control started' });
    await battery.stopAutomationCharge(request.owner);
    return c.json({ success: true, control: inverter.getControlStatus() });
  });
  app.post('/inverter/charge-battery', async c => {
    const request = await body(c);
    const watts = power(request.chargePowerWatts, true);
    const target = request.targetSocPercent;
    if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0 || target > settings.fronius.control.maxSocPercent) {
      throw new HTTPException(400, { message: 'Target SOC must be within the configured safety limits' });
    }
    const { battery } = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, { message: 'Request was cancelled before control started' });
    await battery.chargeToTarget(watts, target, c.req.raw.signal);
    return c.json({ success: true, message: 'Target charging completed and normal operation restored', targetSocPercent: target });
  });
  app.post('/inverter/set-mode', async c => {
    if ((await body(c)).mode !== BatteryMode.NORMAL) {
      throw new HTTPException(400, { message: 'Only normal mode is supported; use explicit signed powerWatts for bounded charging/discharging' });
    }
    const { battery } = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, { message: 'Request was cancelled before control started' });
    await battery.setMode(BatteryMode.NORMAL);
    return c.json({ success: true, mode: BatteryMode.NORMAL });
  });
  app.post('/inverter/standby', async c => {
    const { battery } = await ensureInitialized();
    assertRunning();
    if (c.req.raw.signal.aborted) throw new HTTPException(409, { message: 'Request was cancelled before control started' });
    await battery.setStandby();
    return c.json({ success: true, message: 'Temporary zero charge/discharge window applied; inverter safety controls retain priority' });
  });
  app.get('/inverter/control-status', async c => {
    const { inverter } = await ensureInitialized();
    const { maxPowerWatts, maxSocPercent, revertTimeoutSeconds } = settings.fronius.control;
    const reserveSocPercent = settings.fronius.control.enabled ? await inverter.getAutomationReserve?.().catch(() => null) ?? null : null;
    // Retain the charging-target bounds contract; discharge uses the inverter's reserve.
    return c.json({ success: true, control: inverter.getControlStatus(), automationFence: inverter.getAutomationFence(), capabilities: { automationCharge: true, automationHold: true, automationSupply: true }, limits: { maxPowerWatts, minSocPercent: 0, maxSocPercent, revertTimeoutSeconds, reserveSocPercent } });
  });
  app.get('/system/status', async c => {
    const { overview, timestamp } = await telemetry();
    return c.json({ success: true, ...overview, timestamp });
  });
  app.get('/system/energy-counters', async c => {
    const { inverter } = await ensureInitialized();
    return c.json(await inverter.getEnergyCounters());
  });
  app.get('/battery/status', async c => {
    const { overview, timestamp } = await telemetry();
    const battery = overview.battery;
    return c.json({ success: true, batteryInfo: battery, socPercent: battery?.socPercent ?? null, capacityKwh: battery?.capacityKwh ?? null, currentChargeKwh: battery?.currentChargeKwh ?? null, timestamp });
  });
  app.get('/', c => c.redirect('/dashboard'));
  app.get('/dashboard', c => c.redirect('/public/dashboard.html'));
  app.get('/public/dashboard.html', async c => c.html(await readFile(new URL('../../public/dashboard.html', import.meta.url), 'utf8')));

  function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      stopping = true;
      shutdownPromise = (async () => {
        const results = await Promise.allSettled([
          (async () => {
            if (initializing) await initializing.catch(() => {});
            await devices?.battery.cleanup();
          })(),
          wattpilotAutomation ? wattpilotAutomation.shutdown() : wattpilot?.disconnect(),
        ]);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
      })();
    }
    return shutdownPromise;
  }
  return { app, shutdown, start: async () => {
    started = true;
    await chargerAutomation().start();
    if (settings.fronius.control.enabled) {
      void ensureInitialized().then(({inverter}) => inverter.startSitePowerSupervision())
        .catch(() => { /* A later successful initialization starts protection; Wattpilot stays available. */ });
    }
  } };
}

const runtime = createApi();
export const shutdownApi = runtime.shutdown;
export const startApi = runtime.start;
export default runtime.app;
