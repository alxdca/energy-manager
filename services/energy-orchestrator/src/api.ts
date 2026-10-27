import { forecastDays } from './forecast-horizon.js';
import { summarizeForecast } from './weekly-forecast.js';
import { Hono } from 'hono';
import { createControlsService } from './controls.js';
import { readFile } from 'node:fs/promises';
import { getCarTarget, getLocalDate, getSchedule, policy, timeZone } from './policy.js';
import { createTelemetryReader, type StatusOptions } from './status.js';
import { createDisplayTelemetryReader } from './display-telemetry.js';
import { renderPage, type PageKey } from './pages.js';
import { emptySolarForecast, loadForecastConfig, type ForecastOptions } from './forecast.js';
import type { ForecastStore } from './forecast-publication.js';
import type { BatteryHistorySummary } from './battery-history.js';
import type { AsyncDailyEnergyReader, HistoryReader } from './history-reader.js';
import type { AutomationStatus } from './automation.js';
import type { AutomationConfig } from './automation-plan.js';
import { loadAutomationConfig } from './automation-config.js';
import { buildPlannerBattery } from './planner-details.js';
import { buildBatteryChart } from './battery-chart.js';
import type { EstimateReader } from './estimate-service.js';
import { createTeslaService, type TeslaService, type TeslaOptions } from './tesla.js';
import { createTeslaApi } from './tesla-api.js';
import type { HouseholdService } from './household-service.js';

export interface ApiOptions extends StatusOptions {
  household?: Pick<HouseholdService, 'forecast' | 'train' | 'status'>;
  estimates?: EstimateReader;
  forecast?: ForecastOptions;
  forecastStore?: Pick<ForecastStore, 'readForecast'>;
  batteryHistory?: { summary(date: string, now?: Date): BatteryHistorySummary | Promise<BatteryHistorySummary> };
  telemetryReader?: ReturnType<typeof createTelemetryReader>;
  displayTelemetryReader?: ReturnType<typeof createDisplayTelemetryReader>;
  dailyEnergyStore?: AsyncDailyEnergyReader;
  historyReader?: HistoryReader;
  controlsService?: ReturnType<typeof createControlsService>;
  automationStatus?: () => AutomationStatus;
  automationConfig?: AutomationConfig;
  tesla?: TeslaOptions;
  teslaService?: TeslaService;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function createApi(options: ApiOptions = {}) {
  const app = new Hono();
  const telemetry = options.telemetryReader ?? createTelemetryReader(options);
  const now = options.now ?? (() => new Date());
  const displayTelemetry = options.displayTelemetryReader ?? createDisplayTelemetryReader(telemetry, { now });
  const forecastConfig = options.forecast?.config === undefined ? loadForecastConfig() : options.forecast.config;
  const controls = options.controlsService ?? createControlsService(options, telemetry);
  const tesla = options.teslaService ?? createTeslaService(options.tesla);
  const automationConfig = options.automationConfig ?? loadAutomationConfig();
  const automationStatus = (): AutomationStatus => options.automationStatus?.() ?? {
    enabled: false, status: 'disabled', lastEvaluatedAt: null, nextEvaluationAt: null,
    targetSocPercent: null, reason: 'disabled', plan: null, error: null,
    holdUntil: null,
  };
  app.route('/api/controls', controls.api);
  app.route('/api/tesla', createTeslaApi(tesla));
  app.get('/api/household/training', c => {
    c.header('Cache-Control', 'no-store');
    return options.household ? c.json(options.household.status())
      : c.json({ error: 'L’apprentissage maison n’est pas configuré.' }, 503);
  });
  app.post('/api/household/training', c => {
    const origin = c.req.header('Origin');
    if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin !== undefined && origin !== new URL(c.req.url).origin) {
      return c.json({ error: 'Origine non autorisée.' }, 403);
    }
    if (!options.household) return c.json({ error: 'L’apprentissage maison n’est pas configuré.' }, 503);
    void options.household.train().catch(() => {});
    c.header('Cache-Control', 'no-store');
    return c.json({ ...options.household.status(), accepted: true }, 202);
  });
  app.get('/api/household/forecast', async c => {
    c.header('Cache-Control', 'no-store');
    const date = c.req.query('date') ?? getLocalDate(now());
    if (!validDate(date)) return c.json({ error: 'Date de prévision invalide.' }, 400);
    if (!options.household) return c.json({ error: 'Les prévisions maison ne sont pas configurées.' }, 503);
    try { return c.json({ forecast: await options.household.forecast(date) }); }
    catch { return c.json({ error: 'Les prévisions maison enregistrées sont indisponibles.' }, 503); }
  });

  app.get('/health', c => c.json({
    service: 'energy-orchestrator',
    status: 'ready',
    automationEnabled: automationStatus().enabled,
  }));

  async function readSnapshot() {
    const [observation, controlStatus, car] = await Promise.all([displayTelemetry(), controls.readStatus(), tesla.readStatus()]);
    const current = now();
    const carTarget = getCarTarget(current);
    return { batteryControl: controlStatus.battery, snapshot: {
      updatedAt: current.toISOString(), timeZone,
      automation: { ...automationStatus(), ...(options.estimates ? {
        lastEvaluatedAt: options.estimates.status().calculatedAt,
        nextEvaluationAt: options.estimates.status().nextEvaluationAt,
      } : {}) },
      ...(options.estimates ? { estimates: options.estimates.status() } : {}),
      ...getSchedule(current),
      policy: { ...policy, carMorningMinimumSocPercent: carTarget.minimumSocPercent },
      carTarget, car, carAutomation: controlStatus.carAutomation, wattpilot: controlStatus.wattpilot, telemetry: observation, batteryChargeEstimate: controlStatus.battery.chargeEstimate,
      dailyEnergy: await options.dailyEnergyStore?.summary(getLocalDate(current), current) ?? null,
      integrations: { tesla: car.status === 'not_configured' ? 'not_connected' : car.status,
        wattpilot: controlStatus.wattpilot.status,
        weather: forecastConfig ? 'configured' : 'not_connected', planner: automationStatus().enabled ? 'active' : 'disabled' },
    } };
  }
  app.get('/api/status', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json((await readSnapshot()).snapshot);
  });
  app.get('/api/planner', async c => {
    c.header('Cache-Control', 'no-store');
    const { snapshot, batteryControl } = await readSnapshot();
    const planner = options.estimates?.planner() ?? { calculation: { charging: getSchedule(now()).charging, plan: null } };
    return c.json({ ...snapshot, planner: { ...planner, battery: buildPlannerBattery(now(),
      snapshot.telemetry, batteryControl, snapshot.automation, automationConfig) } });
  });
  app.get('/api/energy/today', async c => {
    c.header('Cache-Control', 'no-store');
    const current = now();
    const date = getLocalDate(current);
    return c.json(await options.dailyEnergyStore?.summary(date, current) ?? {
      status: 'not_configured', date, timeZone, method: 'power_integration',
      error: 'La collecte des mesures journalières n’est pas configurée.',
    });
  });
  app.get('/api/energy/days', async c => {
    c.header('Cache-Control', 'no-store');
    const value = c.req.query('limit') ?? '31';
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 366) {
      return c.json({ error: 'La limite doit être comprise entre 1 et 366 jours.' }, 400);
    }
    const before = c.req.query('before');
    if (before !== undefined && !validDate(before)) return c.json({ error: 'La date de pagination est invalide.' }, 400);
    try {
      const days = await options.dailyEnergyStore?.days(Number(value), now(), before) ?? [];
      return c.json({ timeZone, days, nextBefore: days.length === Number(value) ? days.at(-1)!.date : null });
    } catch {
      return c.json({ error: 'L’historique des mesures est indisponible.' }, 503);
    }
  });
  app.get('/api/history/day', async c => {
    c.header('Cache-Control', 'no-store');
    const date = c.req.query('date') ?? '';
    if (!validDate(date)) return c.json({ error: 'La date doit être une date valide au format AAAA-MM-JJ.' }, 400);
    if (!options.historyReader) return c.json({ error: 'L’historique des mesures n’est pas configuré.' }, 503);
    try { return c.json(await options.historyReader.day(date, now())); }
    catch { return c.json({ error: 'L’historique des mesures est indisponible.' }, 503); }
  });
  app.get('/api/forecast/week', async c => {
    c.header('Cache-Control', 'no-store');
    const today = getLocalDate(now());
    const runtime = options.estimates?.projection();
    const calculatedAt = options.estimates?.status().calculatedAt;
    const days = await Promise.all(Array.from({ length: forecastDays }, async (_, index) => {
      const date = new Date(Date.parse(`${today}T00:00:00Z`) + (index + 1) * 86_400_000).toISOString().slice(0, 10);
      const [saved, house] = await Promise.allSettled([
        Promise.resolve().then(() => options.forecastStore?.readForecast(date) ?? null),
        Promise.resolve().then(() => options.household?.forecast(date) ?? null),
      ]);
      const publication = saved.status === 'fulfilled' ? saved.value : null;
      const household = options.household ? house.status === 'fulfilled' ? house.value : null : undefined;
      return summarizeForecast(date, publication, household,
        runtime?.status === 'available' && calculatedAt === publication?.calculatedAt);
    }));
    return c.json({ timeZone, days });
  });
  for (const path of ['/api/forecast', '/api/forecast/today']) {
    app.get(path, async c => {
      c.header('Cache-Control', 'no-store');
      const requestedDate = getLocalDate(now());
      const date = path === '/api/forecast/today' ? requestedDate
        : new Date(Date.parse(`${requestedDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      try {
        const publication = await options.forecastStore?.readForecast(date) ?? null;
        if (publication && publication.forecast.date !== date) throw new Error('Date de prévision incohérente.');
        const current = now();
        const solar = publication?.forecast ?? { ...emptySolarForecast(date, forecastConfig ?? null), consumption: null };
        const runtimeProjection = options.estimates?.projection();
        const canShowProjection = publication && runtimeProjection?.status === 'available'
          && options.estimates?.status().calculatedAt === publication.calculatedAt;
        const projection = canShowProjection ? publication.projection : {
          status: 'unavailable' as const, reason: runtimeProjection?.reason ?? 'awaiting_evaluation',
          assumption: runtimeProjection?.assumption ?? 'automatic_planning' as const,
          observedAt: null, points: [],
        };
        const history = options.batteryHistory;
        const observed = history ? await Promise.resolve().then(() => history.summary(date, current)).catch(() => null) : null;
        return c.json({ ...solar,
          ...(options.household ? { householdForecast: await options.household.forecast(date), householdTraining: options.household.status() } : {}),
          estimates: { calculatedAt: publication?.calculatedAt ?? null,
            nextEvaluationAt: options.estimates?.status().nextEvaluationAt
              ?? new Date((Math.floor(current.getTime() / 900_000) + 1) * 900_000).toISOString() },
          measurements: await options.dailyEnergyStore?.hourly?.(date, current) ?? null,
          dailyEnergy: await options.dailyEnergyStore?.summary(date, current) ?? null,
          battery: buildBatteryChart(date, projection, observed),
        });
      } catch {
        return c.json({ error: 'Les prévisions enregistrées sont indisponibles.' }, 503);
      }
    });
  }
  const pageRoutes: [string, PageKey][] = [
    ['/', 'accueil'], ['/dashboard', 'accueil'], ['/pilotage', 'pilotage'],
    ['/tarifs', 'tarifs'], ['/appareils', 'appareils'], ['/planification', 'planification'],
    ['/donnees', 'donnees'],
  ];
  for (const [path, page] of pageRoutes) {
    app.get(path, async c => c.html(await renderPage(page)));
  }
  for (const path of ['/previsions', '/historique']) {
    app.get(path, c => {
      const url = new URL(c.req.url);
      return c.redirect(`/donnees${url.search}`, 308);
    });
  }
  app.get('/dashboard.css', async c => c.body(await readFile(new URL('../public/dashboard.css', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/dashboard.js', async c => c.body(await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/controls.js', async c => c.body(await readFile(new URL('../public/controls.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/theme.js', async c => c.body(await readFile(new URL('../public/theme.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/forecast.js', async c => c.body(await readFile(new URL('../public/forecast.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/tesla.js', async c => c.body(await readFile(new URL('../public/tesla.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/history.js', async c => c.body(await readFile(new URL('../public/history.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/history-data.js', async c => c.body(await readFile(new URL('../public/history-data.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  app.get('/history.css', async c => c.body(await readFile(new URL('../public/history.css', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get('/household.js', async c => c.body(await readFile(new URL('../public/household.js', import.meta.url), 'utf8'), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  return app;
}

export default createApi();
