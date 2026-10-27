import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderPage, type PageKey } from '../src/pages.js';
import { summarizeRecordedEnergy } from '../src/recorded-energy.js';

const script = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
const pageNames: PageKey[] = ['accueil', 'pilotage', 'planification', 'tarifs', 'appareils'];
const pages = Object.fromEntries(await Promise.all(pageNames.map(async page => [page, await renderPage(page)]))) as Record<PageKey, string>;
const html = Object.values(pages).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));

function classes() {
  const values = new Set<string>();
  return {
    add: (name: string) => values.add(name),
    remove: (name: string) => values.delete(name),
    toggle: (name: string, active: boolean) => active ? values.add(name) : values.delete(name),
    contains: (name: string) => values.has(name),
  };
}

function element() {
  return {
    textContent: '', className: '', hidden: false, disabled: false,
    style: {} as Record<string, string>, classList: classes(),
    parentElement: { classList: classes() },
    attributes: new Map<string, string>(),
    listeners: new Map<string, () => unknown>(),
    setAttribute(name: string, value: string) { this.attributes.set(name, value); },
    getAttribute(name: string) { return this.attributes.get(name) ?? null; },
    removeAttribute(name: string) { this.attributes.delete(name); },
    addEventListener(name: string, handler: () => unknown) { this.listeners.set(name, handler); },
  };
}

function browser(page?: PageKey, origin = Date.parse('2026-10-24T10:00:00Z')) {
  const markup = page ? pages[page] : html;
  const elements = new Map([...markup.matchAll(/id="([^"]+)"/g)].map(match => [match[1], element()]));
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  let timerId = 0;
  const events = new Map<string, () => void>();
  const requests: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void; signal: AbortSignal }> = [];
  const document = {
    hidden: false,
    body: { dataset: { page } },
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
  };
  let now = origin;
  const RuntimeDate = class extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return now; }
  };
  vm.runInNewContext(script, {
    document, Intl, Date: RuntimeDate, AbortController,
    setTimeout(callback: () => void, milliseconds: number) { timers.set(++timerId, { callback, milliseconds }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval() { return 0; },
    fetch(url: string, options: { signal: AbortSignal; cache: string }) {
      assert.equal(url, page === 'planification' ? '/api/planner' : '/api/status');
      assert.equal(options.cache, 'no-store');
      return new Promise<Response>((resolve, reject) => {
        requests.push({ resolve, reject, signal: options.signal });
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  });
  const get = (id: string) => {
    const target = document.getElementById(id);
    assert.ok(target, `Missing dashboard element: ${id}`);
    return target;
  };
  const complete = async (body: unknown, index = requests.length - 1) => {
    requests[index].resolve(Response.json(body));
    await tick();
  };
  const fireTimer = (milliseconds: number) => {
    const entry = [...timers].find(([, timer]) => timer.milliseconds === milliseconds);
    assert.ok(entry, `Expected ${milliseconds}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  return { document, get, timers, events, requests, complete, fireTimer, advance: (milliseconds: number) => { now += milliseconds; } };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    carTarget: { date: '2026-01-15', weekday: 'Thursday', minimumSocPercent: 60, deadline: '2026-01-15T06:00:00Z', gridChargingEndsAt: '2026-01-15T05:55:00Z', reason: 'Minimum quotidien' },
    tariff: { kind: 'high', priceCts: 28.29, nextChangeAt: '2026-01-15T11:00:00Z' },
    charging: { allowed: false, phase: 'high_tariff', nextWindow: { label: 'Secours de l’après-midi', start: '2026-01-15T11:05:00Z', end: '2026-01-15T15:55:00Z' } },
    telemetry: { status: 'online', observedAt: '2026-01-15T10:00:00Z', error: null, solarKw: 4.2, householdKw: 1.2, gridImportKw: 0, gridExportKw: 1, batterySocPercent: 62.5, batteryChargeKw: 2, batteryDischargeKw: 0 },
    ...overrides,
  };
}

const carPlanAt = '2026-10-25T22:10:00.000Z';
function carPlan(overrides: Record<string, unknown> = {}) {
  return {
    status: 'available', action: 'charge', reason: 'grid_charge', calculatedAt: carPlanAt,
    target: { date: '2026-10-26', minimumSocPercent: 60, deadline: '2026-10-26T06:00:00.000Z', gridChargingEndsAt: '2026-10-26T05:55:00.000Z' },
    socPercent: 40, observedAt: carPlanAt, requiredStoredKwh: 15, requiredAcKwh: 16.6667,
    solarKwh: 0, gridKwh: 16.6667, unmetKwh: 0, estimatedCompletionAt: '2026-10-26T00:35:00.000Z',
    feasible: true, currentAmps: 10, phases: 3, source: 'grid', requiresBatteryHold: false,
    allowBatteryCharge: true, windowEndsAt: '2026-10-26T05:55:00.000Z', slots: [], ...overrides,
  };
}
function carAutomation(overrides: Record<string, unknown> = {}) {
  return { enabled: true, status: 'charging', reason: 'grid_charge', error: null,
    lastEvaluatedAt: carPlanAt, nextEvaluationAt: '2026-10-25T22:15:00.000Z',
    plan: carPlan(), lastCheckpoint: null, ...overrides };
}

test('Tesla plan card uses the existing snapshot to display target, AC energy and a feasible finish', async () => {
  const b = browser('planification', Date.parse(carPlanAt));
  await b.complete(snapshot({ updatedAt: carPlanAt, carAutomation: carAutomation(),
    car: { status: 'online', socPercent: 40, observedAt: carPlanAt, chargingState: 'Charging', error: null } }));
  assert.equal(b.get('car-planner-status').textContent, 'Auto · en charge');
  assert.equal(b.get('car-planner-reason').textContent, 'Recharge nécessaire en heures creuses');
  assert.match(b.get('car-planner-target').textContent, /60 %.*07:00/);
  assert.equal(b.get('car-planner-soc').textContent, '40,0 %');
  assert.equal(b.get('car-planner-remaining').textContent, '≈ 16,7 kWh');
  assert.equal(b.get('car-planner-solar').textContent, '≈ 0 kWh');
  assert.equal(b.get('car-planner-grid').textContent, '≈ 16,7 kWh');
  assert.match(b.get('car-planner-finish').textContent, /≈ .*01:35/);
  assert.match(b.get('car-planner-next').textContent, /23:15/);
  assert.equal(b.get('car-planner-unmet-row').hidden, true);
  assert.equal(b.requests.length, 1);
});

test('Tesla plan card reports infeasible energy without a finish promise and clears stale or invalid SOC', async () => {
  const b = browser('planification', Date.parse(carPlanAt));
  const incomplete = carPlan({ status: 'blocked', feasible: false, reason: 'deadline_infeasible', unmetKwh: 5.5 });
  await b.complete(snapshot({ updatedAt: carPlanAt,
    carAutomation: carAutomation({ status: 'blocked', reason: 'deadline_infeasible', plan: incomplete }) }));
  assert.equal(b.get('car-planner-status').textContent, 'Bloquée');
  assert.equal(b.get('car-planner-reason').textContent, 'Minimum impossible à atteindre avant le départ');
  assert.equal(b.get('car-planner-unmet-row').hidden, false);
  assert.equal(b.get('car-planner-unmet').textContent, '≈ 5,5 kWh');
  assert.equal(b.get('car-planner-finish').textContent, '—');
  b.fireTimer(10000);
  await b.complete(snapshot({ updatedAt: carPlanAt,
    carAutomation: carAutomation({ reason: 'deadline_infeasible', plan: { ...incomplete, status: 'available' } }) }));
  assert.equal(b.get('car-planner-status').textContent, 'Auto · en charge');
  assert.match(b.get('car-planner-status').className, /warning/);
  assert.equal(b.get('car-planner-finish').textContent, '—');
  assert.equal(b.get('car-planner-unmet-row').hidden, false);
  b.fireTimer(10000);
  await b.complete(snapshot({ updatedAt: '2026-10-25T22:21:00.000Z', carAutomation: carAutomation() }));
  assert.equal(b.get('car-planner-status').textContent, 'Mesure ancienne');
  assert.equal(b.get('car-planner-soc').textContent, '—');
  assert.equal(b.get('car-planner-remaining').textContent, '—');
  assert.equal(b.get('car-planner-finish').textContent, '—');
  assert.equal(b.get('car-planner-unmet-row').hidden, true);
  b.fireTimer(10000);
  await b.complete(snapshot({ updatedAt: carPlanAt,
    carAutomation: carAutomation({ plan: carPlan({ socPercent: 101, observedAt: '2026-02-30T12:00:00Z' }) }) }));
  assert.equal(b.get('car-planner-soc').textContent, '—');
  assert.equal(b.get('car-planner-finish').textContent, '—');
});

test('manual, waking, stopping and error car states never display incompatible charging predictions', async () => {
  const b = browser('planification', Date.parse(carPlanAt));
  for (const state of ['manual', 'waking', 'stopping', 'error']) {
    await b.complete(snapshot({ updatedAt: carPlanAt, carAutomation: carAutomation({
      enabled: state !== 'manual', status: state, reason: state === 'manual' ? 'manual_override' : state,
    }), ...(state === 'waking' ? { car: { status: 'asleep', socPercent: 40, observedAt: carPlanAt } } : {}) }));
    for (const id of ['remaining', 'solar', 'grid', 'finish']) assert.equal(b.get(`car-planner-${id}`).textContent, '—', state);
    assert.equal(b.get('car-planner-unmet-row').hidden, true);
    if (state === 'waking') {
      assert.equal(b.get('car-planner-status').textContent, 'Lecture Tesla');
      assert.equal(b.get('car-planner-soc').textContent, '40,0 %');
    }
    b.fireTimer(10000);
  }
  await b.complete(snapshot({ updatedAt: carPlanAt, carAutomation: carAutomation() }));
  b.document.hidden = true; b.events.get('visibilitychange')!();
  assert.equal(b.get('car-planner-target').textContent, '—');
  assert.equal(b.get('car-planner-finish').textContent, '—');
  b.document.hidden = false; b.events.get('visibilitychange')!();
  await b.complete(snapshot({ updatedAt: carPlanAt, carAutomation: carAutomation() }));
  b.fireTimer(10000); b.requests.at(-1)!.reject(new Error('offline')); await tick();
  assert.equal(b.get('car-planner-status').textContent, 'Indisponible');
  assert.equal(b.get('car-planner-finish').textContent, '—');
});

test('native Eco with unknown or asleep SOC never promises solar-only energy or a finish time', async () => {
  const b = browser('planification', Date.parse(carPlanAt));
  await b.complete(snapshot({ updatedAt: carPlanAt,
    car: { status: 'asleep', socPercent: 40, observedAt: '2026-10-25T20:00:00.000Z' },
    carAutomation: carAutomation({ status: 'eco', reason: 'eco_soc_unavailable', plan: carPlan({ action: 'eco', source: 'eco',
      socPercent: null, observedAt: null, requiredAcKwh: null, solarKwh: 10, gridKwh: 0, feasible: null }) }) }));
  assert.equal(b.get('car-planner-status').textContent, 'Auto · éco');
  assert.equal(b.get('car-planner-reason').textContent, 'Mode éco · niveau de charge Tesla à actualiser');
  assert.equal(b.get('car-planner-soc').textContent, '40,0 %');
  assert.match(b.get('car-planner-soc').getAttribute('title')!, /Dernier niveau connu/);
  assert.equal(b.get('car-planner-solar').textContent, '—');
  assert.equal(b.get('car-planner-grid').textContent, '—');
  assert.equal(b.get('car-planner-finish').textContent, '—');
  assert.equal(b.requests.length, 1);
});

test('car planner keeps dated last-known SOC visible without using it for charging predictions', async () => {
  const b = browser('planification', Date.parse(carPlanAt));
  for (const status of ['asleep', 'offline', 'stale', 'connecting', 'auth_required', 'error', 'online']) {
    await b.complete(snapshot({ updatedAt: carPlanAt,
      car: { status, socPercent: 0, observedAt: '2026-10-24T20:00:00.000Z' },
      carAutomation: carAutomation({ status: 'blocked', plan: carPlan({ socPercent: null, observedAt: null }) }) }));
    assert.equal(b.get('car-planner-soc').textContent, '0,0 %', status);
    assert.match(b.get('car-planner-soc').getAttribute('title')!, /Dernier niveau connu/);
    for (const id of ['remaining', 'solar', 'grid', 'finish']) assert.equal(b.get(`car-planner-${id}`).textContent, '—', status);
    b.fireTimer(10000);
  }
  for (const invalid of [
    { socPercent: null, observedAt: carPlanAt },
    { socPercent: 101, observedAt: carPlanAt },
    { socPercent: 40, observedAt: '2026-02-30T12:00:00Z' },
    { socPercent: 40, observedAt: '2026-10-26T12:00:00Z' },
  ]) {
    await b.complete(snapshot({ updatedAt: carPlanAt, car: { status: 'asleep', ...invalid } }));
    assert.equal(b.get('car-planner-soc').textContent, '—');
    assert.equal(b.get('car-planner-soc').getAttribute('title'), null);
    b.fireTimer(10000);
  }
});

test('afternoon top-up displays the fixed 30% target and returns to an Eco mode display at the floor', async () => {
  const b = browser('planification', Date.parse('2026-10-25T11:15:00.000Z'));
  const at = '2026-10-25T11:15:00.000Z';
  const target = { date: '2026-10-25', minimumSocPercent: 30, kind: 'afternoon',
    deadline: '2026-10-25T15:55:00.000Z', gridChargingEndsAt: '2026-10-25T15:55:00.000Z' };
  const planned = carPlan({ calculatedAt: at, observedAt: at, socPercent: 29, target,
    requiredAcKwh: 0.8333, gridKwh: 0.8333, estimatedCompletionAt: '2026-10-25T11:30:00.000Z' });
  await b.complete(snapshot({ updatedAt: at, carAutomation: carAutomation({ plan: planned }) }));
  assert.equal(b.get('car-planner-target-label').textContent, 'Minimum de l’après-midi');
  assert.match(b.get('car-planner-target').textContent, /30 %.*16:55/);
  assert.equal(b.get('car-planner-soc').textContent, '29,0 %');
  b.fireTimer(10000);
  await b.complete(snapshot({ updatedAt: at, carAutomation: carAutomation({ status: 'eco', reason: 'eco_default',
    plan: { ...planned, action: 'eco', source: 'eco', socPercent: 30, requiredAcKwh: 0, gridKwh: 0 } }) }));
  assert.equal(b.get('car-planner-status').textContent, 'Auto · éco');
  assert.equal(b.get('car-planner-finish').textContent, '—');
});

test('night battery support shows only proven usable solar and keeps unknown provenance distinct from zero', async () => {
  const b = browser('planification', Date.parse(carPlanAt));
  const support = { available: true, solarStoredKwh: 10, protectedStoredKwh: 20, usableStoredKwh: 4,
    minimumSocPercent: 33.3, maxDischargeKw: 4 };
  await b.complete(snapshot({ updatedAt: carPlanAt, carAutomation: carAutomation({ plan: carPlan({ batterySupport: support }) }) }));
  assert.equal(b.get('car-planner-battery-solar-row').hidden, false);
  assert.equal(b.get('car-planner-battery-solar').textContent, '≈ 4 kWh');
  assert.equal(b.get('car-planner-battery-reserve').textContent, '≈ 20 kWh');
  b.fireTimer(10000);
  await b.complete(snapshot({ updatedAt: carPlanAt, carAutomation: carAutomation({ plan: carPlan({
    batterySupport: { ...support, available: false, solarStoredKwh: null, usableStoredKwh: 0, protectedStoredKwh: null },
  }) }) }));
  assert.equal(b.get('car-planner-battery-solar').textContent, '—');
  assert.equal(b.get('car-planner-battery-reserve').textContent, '—');
  b.fireTimer(10000);
  await b.complete(snapshot({ updatedAt: carPlanAt, carAutomation: carAutomation({ plan: carPlan({
    batterySupport: { ...support, solarStoredKwh: 0, usableStoredKwh: 0 },
  }) }) }));
  assert.equal(b.get('car-planner-battery-solar').textContent, '≈ 0 kWh');
  b.document.hidden = true; b.events.get('visibilitychange')!();
  assert.equal(b.get('car-planner-battery-solar-row').hidden, true);
  assert.equal(b.get('car-planner-battery-solar').textContent, '—');
});

test('Appareils lists home-battery SOC and activity and clears unavailable readings', async () => {
  const b = browser('appareils');
  await b.complete(snapshot());
  assert.equal(b.get('battery-state').textContent, 'Connectée');
  assert.match(b.get('battery-detail').textContent, /62[,.]5 % · En charge · 2[,.]00 kW · Via Fronius GEN24/);
  b.fireTimer(10000);
  await b.complete(snapshot({ telemetry: { ...snapshot().telemetry,
    batterySocPercent: 0, batteryChargeKw: 0, batteryDischargeKw: 1.2 } }));
  assert.match(b.get('battery-detail').textContent, /^0[,.]0 % · En décharge · 1[,.]20 kW/);
  b.fireTimer(10000);
  await b.complete(snapshot({ telemetry: { ...snapshot().telemetry, status: 'stale' } }));
  assert.equal(b.get('battery-state').textContent, 'Mesure ancienne');
  assert.doesNotMatch(b.get('battery-detail').textContent, /En charge/);
  b.fireTimer(10000);
  await b.complete(snapshot({ telemetry: { ...snapshot().telemetry, batterySocPercent: null } }));
  assert.equal(b.get('battery-state').textContent, 'Indisponible');
  assert.doesNotMatch(b.get('battery-detail').textContent, /%/);
  b.fireTimer(10000);
  await b.complete(snapshot());
  b.document.hidden = true; b.events.get('visibilitychange')!();
  assert.equal(b.get('battery-state').textContent, 'Indisponible');
  assert.doesNotMatch(b.get('battery-detail').textContent, /%/);
  b.document.hidden = false; b.events.get('visibilitychange')!();
  await b.complete(snapshot());
  b.fireTimer(10000); b.requests.at(-1)!.reject(new Error('offline')); await tick();
  assert.equal(b.get('battery-state').textContent, 'Indisponible');
  assert.doesNotMatch(b.get('battery-detail').textContent, /%/);
});

test('car SOC and Tesla connection show dated measurements and keep power flows unavailable', async () => {
  const b = browser('accueil');
  const updatedAt = '2026-10-25T12:00:00Z';
  const car = { status: 'online', socPercent: 64, observedAt: updatedAt, chargingState: 'Charging', error: null };
  await b.complete(snapshot({ car, updatedAt }));
  assert.match(b.get('flow-car-soc').textContent, /64[,.]0 %/);
  assert.equal(b.get('flow-car-state').textContent, 'En charge');
  assert.equal(b.get('car-line').classList.contains('active'), false);
  assert.equal(b.get('car-line').classList.contains('unavailable'), true);
  assert.match(b.get('flow-car-soc').getAttribute('title')!, /13:00/);
  b.fireTimer(10000);
  await b.complete(snapshot({ car: { ...car, status: 'asleep', chargingState: null }, updatedAt }));
  assert.equal(b.get('flow-car-state').textContent, 'En veille');
  assert.match(b.get('flow-car-soc').textContent, /64[,.]0 %/);
  assert.equal(b.get('flow-car-soc').classList.contains('warning'), true);
  b.document.hidden = true; b.events.get('visibilitychange')!();
  assert.equal(b.get('flow-car-soc').textContent, '—');
});

test('Tesla measurements validate percent and age and clear after dashboard failure', async () => {
  const b = browser('appareils');
  const car = { status: 'online', socPercent: 0, observedAt: '2026-10-25T11:40:00Z', chargingState: 'Charging', error: null };
  await b.complete(snapshot({ car, updatedAt: '2026-10-25T12:00:00Z' }));
  assert.equal(b.get('tesla-state').textContent, 'Mesure ancienne');
  assert.match(b.get('tesla-detail').textContent, /^0[,.]0 %$/);
  assert.equal(b.get('tesla-state').getAttribute('title'), null);
  b.fireTimer(10000);
  await b.complete(snapshot({ car: { ...car, socPercent: 105 }, updatedAt: '2026-10-25T12:00:00Z' }));
  assert.doesNotMatch(b.get('tesla-detail').textContent, /105/);
  b.fireTimer(10000); b.requests.at(-1)!.reject(new Error('offline')); await tick();
  assert.equal(b.get('tesla-state').textContent, 'Indisponible');
  assert.equal(b.get('tesla-detail').textContent, 'Niveau de charge indisponible');
});

test('Tesla connection form stays hidden for a connected account and returns when reconnection is needed', async () => {
  assert.match(pages.appareils, /<details[^>]*id="tesla-connection"[^>]*hidden/);
  const b = browser('appareils');
  await b.complete(snapshot({ car: { status: 'not_configured' } }));
  assert.equal(b.get('tesla-connection').hidden, false);
  for (const status of ['connecting', 'online', 'asleep', 'offline', 'stale']) {
    b.fireTimer(10000);
    await b.complete(snapshot({ car: { status } }));
    assert.equal(b.get('tesla-connection').hidden, true, status);
  }
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('temporary dashboard failure'));
  await tick();
  assert.equal(b.get('tesla-connection').hidden, true);
  for (const status of ['auth_required', 'error', 'not_configured']) {
    b.fireTimer(10000);
    await b.complete(snapshot({ car: { status } }));
    assert.equal(b.get('tesla-connection').hidden, false, status);
  }
});

const chargerAt = '2026-01-15T10:00:00.000Z';
function wattpilot(overrides: Record<string, unknown> = {}) {
  return {
    status: 'online', configured: true, connected: true, ready: true, stale: false,
    observedAt: chargerAt, powerObservedAt: chargerAt, error: null, controlEnabled: true,
    mode: 'normal', carConnected: true, charging: true, allowedCharging: true,
    currentAmps: 6, powerWatts: 4140, sessionEnergyWh: 50, totalEnergyWh: 12345,
    limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false,
    ...overrides,
  };
}

test('Appareils shows the actual Wattpilot connection independently of GEN24 and Tesla', async () => {
  const b = browser('appareils');
  const base = snapshot();
  await b.complete({ ...base, updatedAt: chargerAt, car: { status: 'auth_required' },
    telemetry: { ...base.telemetry, status: 'offline' }, wattpilot: wattpilot({ controlEnabled: false }) });
  assert.equal(b.get('wattpilot-state').textContent, 'Connecté');
  assert.match(b.get('wattpilot-detail').textContent, /Mode normal · 6 A · 4[,.]14 kW · Voiture branchée · Lecture seule/);
  assert.equal(b.get('tesla-state').textContent, 'À reconnecter');
  assert.equal(b.get('tesla-connection').hidden, false);
  assert.equal(b.get('gen24-state').textContent, 'Indisponible');
  assert.equal(b.requests.length, 1, 'Charger display reuses the dashboard snapshot');
  b.fireTimer(10000);
  await b.complete({ ...base, updatedAt: chargerAt, wattpilot: wattpilot({ mode: 'pause', carConnected: false, powerWatts: 0 }) });
  assert.equal(b.get('wattpilot-state').textContent, 'Connecté');
  assert.match(b.get('wattpilot-detail').textContent, /En pause · 6 A · 0 W · Voiture débranchée/);
});

test('Wattpilot states and failed dashboard reads never retain a connected badge', async () => {
  const b = browser('appareils');
  for (const [status, label] of [['not_configured', 'Non configuré'], ['stale', 'Mesures anciennes'], ['offline', 'Hors ligne'], ['error', 'Indisponible']] as const) {
    await b.complete(snapshot({ updatedAt: chargerAt, wattpilot: wattpilot({ status }) }));
    assert.equal(b.get('wattpilot-state').textContent, label);
    assert.equal(b.get('wattpilot-state').className.includes(' online'), false);
    b.fireTimer(10000);
  }
  await b.complete(snapshot({ updatedAt: chargerAt, wattpilot: wattpilot() }));
  assert.equal(b.get('wattpilot-state').textContent, 'Connecté');
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('dashboard unavailable'));
  await tick();
  assert.equal(b.get('wattpilot-state').textContent, 'Indisponible');
  assert.equal(b.get('wattpilot-detail').textContent, 'État de la borne indisponible');
});

test('Appareils reports the configured phase mode without treating it as an active phase measurement', async () => {
  const b = browser('appareils');
  for (const [phaseMode, label] of [[1, '1 phase'], [3, '3 phases'], ['auto', 'Phases auto']] as const) {
    await b.complete(snapshot({ updatedAt: chargerAt, wattpilot: wattpilot({ phaseMode, phaseSwitchingSupported: true }) }));
    assert.ok(b.get('wattpilot-detail').textContent.includes(label));
    assert.equal(b.get('wattpilot-state').textContent, 'Connecté');
    b.fireTimer(10000);
  }
  for (const phaseMode of [null, 2, '1']) {
    await b.complete(snapshot({ updatedAt: chargerAt, wattpilot: wattpilot({ phaseMode }) }));
    assert.doesNotMatch(b.get('wattpilot-detail').textContent, /1 phase|3 phases|Phases auto/);
    b.fireTimer(10000);
  }
});

test('fresh Wattpilot power is shown once and separated from the household flow', async () => {
  const b = browser('accueil');
  const base = snapshot();
  await b.complete({ ...base, updatedAt: chargerAt, car: { status: 'online', socPercent: 60, observedAt: chargerAt },
    telemetry: { ...base.telemetry, gridImportKw: 3, gridExportKw: 0, householdKw: 5.2 }, wattpilot: wattpilot() });
  assert.equal(b.get('flow-car-power').textContent, '4,14 kW');
  assert.equal(b.get('flow-home').textContent, '1,06 kW');
  assert.equal(b.get('car-line').classList.contains('active'), true);
  assert.equal(b.get('car-line').classList.contains('reverse'), true);
  assert.equal(b.get('car-line').classList.contains('unavailable'), false);
  assert.match(b.get('flow-home').getAttribute('title')!, /hors recharge voiture/);
  assert.equal(b.get('flow-car-soc').textContent, '60,0 %');
  b.fireTimer(10000);
  await b.complete({ ...base, updatedAt: chargerAt, wattpilot: wattpilot({ powerWatts: 0, charging: false }) });
  assert.equal(b.get('flow-car-power').textContent, '0 W');
  assert.equal(b.get('flow-home').textContent, '1,20 kW');
  assert.equal(b.get('car-line').classList.contains('active'), false);
  assert.equal(b.get('car-line').classList.contains('unavailable'), false);
});

test('car flow power uses whole watts below 1000 W and exactly two decimals in kW', async () => {
  const b = browser('accueil');
  for (const [powerWatts, expected] of [[999, '999 W'], [1000, '1,00 kW'], [1234, '1,23 kW'], [1236, '1,24 kW']] as const) {
    await b.complete(snapshot({ updatedAt: chargerAt, wattpilot: wattpilot({ powerWatts }) }));
    assert.equal(b.get('flow-car-power').textContent, expected);
    b.fireTimer(10000);
  }
});

test('car and household display balance retains integer-watt precision', async () => {
  const b = browser('accueil');
  const base = snapshot();
  await b.complete({ ...base, updatedAt: chargerAt, wattpilot: wattpilot({ powerWatts: 1000.49 }), telemetry: {
    ...base.telemetry, solarKw: .5005, gridImportKw: .9994, gridExportKw: .1234,
    batteryDischargeKw: .2505, batteryChargeKw: .1005, householdKw: .8,
  } });
  assert.equal(b.get('flow-solar').textContent, '501 W');
  assert.equal(b.get('flow-grid').textContent, '876 W');
  assert.equal(b.get('flow-battery').textContent, '150 W');
  assert.equal(b.get('flow-car-power').textContent, '1,00 kW');
  assert.equal(b.get('flow-home').textContent, '527 W');
});

test('car subtraction uses raw household fallback once and rejects negative remaining demand', async () => {
  const b = browser('accueil');
  const base = snapshot();
  await b.complete({ ...base, updatedAt: chargerAt, wattpilot: wattpilot({ powerWatts: 200 }),
    telemetry: { ...base.telemetry, solarKw: null } });
  assert.equal(b.get('flow-home').textContent, '1,00 kW');
  b.fireTimer(10000);
  await b.complete({ ...base, updatedAt: chargerAt, wattpilot: wattpilot({ powerWatts: 2000 }) });
  assert.equal(b.get('flow-home').textContent, '—');
  assert.equal(b.get('home-line').classList.contains('active'), false);
});

test('old, future, malformed and absent charger readings stay unknown without removing total house load', async () => {
  const b = browser('accueil');
  for (const invalid of [null, {}, wattpilot({ status: 'stale' }), wattpilot({ status: 'offline' }),
    wattpilot({ configured: false }), wattpilot({ ready: false }), wattpilot({ connected: false }), wattpilot({ stale: true }),
    wattpilot({ observedAt: '2026-01-15T09:59:29Z' }), wattpilot({ observedAt: '2026-01-15T10:00:06Z' }),
    wattpilot({ powerObservedAt: '2026-01-15T09:59:29Z' }), wattpilot({ powerObservedAt: '2026-01-15T10:00:06Z' }),
    wattpilot({ powerObservedAt: '2026-02-30T10:00:00Z' }), wattpilot({ powerObservedAt: null }),
    wattpilot({ powerWatts: null }), wattpilot({ powerWatts: -1 }), wattpilot({ powerWatts: '4140' })]) {
    await b.complete(snapshot({ updatedAt: chargerAt, wattpilot: invalid }));
    assert.equal(b.get('flow-car-power').textContent, '—', JSON.stringify(invalid));
    assert.equal(b.get('car-line').classList.contains('active'), false);
    assert.equal(b.get('car-line').classList.contains('unavailable'), true);
    assert.equal(b.get('flow-home').textContent, '1,20 kW');
    assert.match(b.get('flow-home').getAttribute('title')!, /incluant la recharge voiture/);
    b.fireTimer(10000);
  }
});

test('hidden tabs and dashboard failures clear charger power and resume only from a new snapshot', async () => {
  const b = browser('accueil');
  const active = snapshot({ updatedAt: chargerAt, wattpilot: wattpilot({ powerWatts: 200 }) });
  await b.complete(active);
  assert.equal(b.get('car-line').classList.contains('active'), true);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('flow-car-power').textContent, '—');
  assert.equal(b.get('car-line').classList.contains('active'), false);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('flow-car-power').textContent, '—');
  await b.complete(active);
  assert.equal(b.get('car-line').classList.contains('active'), true);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('dashboard unavailable'));
  await tick();
  assert.equal(b.get('flow-car-power').textContent, '—');
  assert.equal(b.get('car-line').classList.contains('active'), false);
});

const chargeEstimate = (overrides: Record<string, unknown> = {}) => ({
  status: 'available', targetSocPercent: 80, remainingMinutes: 135,
  observedAt: '2026-10-24T17:55:00Z', estimatedCompletionAt: '2026-10-24T20:10:00Z',
  method: 'soc_trend', ...overrides,
});

const automation = (overrides: Record<string, unknown> = {}) => ({
  enabled: true, status: 'idle', lastEvaluatedAt: '2026-10-24T12:00:00Z',
  nextEvaluationAt: '2026-10-24T12:15:00Z', targetSocPercent: null,
  reason: 'outside_charging_window', plan: null, error: null, ...overrides,
});

test('expired charging completion forecasts clear at the client clock while reached-target status remains visible', async () => {
  for (const page of ['accueil', 'planification'] as const) {
    const b = browser(page, Date.parse('2026-10-24T20:09:59Z'));
    const active = snapshot({ batteryChargeEstimate: chargeEstimate() });
    await b.complete(active);
    const label = () => page === 'accueil' ? b.get('flow-battery-charge-estimate').textContent : b.get('planner-charge-end').textContent;
    assert.match(label(), /22:10/);
    for (const milliseconds of [1000, 1]) {
      b.advance(milliseconds);
      b.fireTimer(10000);
      await b.complete(active);
      if (page === 'accueil') assert.equal(b.get('flow-battery-charge-estimate').hidden, true);
      else {
        assert.equal(b.get('planner-charge-end').textContent, '—');
        assert.equal(b.get('planner-charge-remaining').textContent, '—');
      }
    }
    b.fireTimer(10000);
    await b.complete(snapshot({ batteryChargeEstimate: chargeEstimate({ status: 'target_reached' }) }));
    if (page === 'accueil') assert.match(b.get('flow-battery-charge-estimate').textContent, /cible 80 % atteinte/);
    else assert.equal(b.get('planner-charge-remaining').textContent, 'Cible atteinte');
  }
});

function plannerDetails() {
  return {
    battery: { socPercent: 24.1, capacityKwh: 60, storedKwh: 14.46, reserveSocPercent: 5, reserveKwh: 3,
      availableKwh: 11.46, targetSocPercent: 30, targetStoredKwh: 18, gapKwh: 3.54,
      powerKw: 6, mode: 'manual', automated: true, targetSource: 'controller' },
    highTariff: { start: '2026-10-24T15:00:00Z', end: '2026-10-24T21:00:00Z', date: '2026-10-24', isCurrent: false,
      forecastStatus: 'online', estimatedConsumptionKwh: 12.5, estimatedProductionKwh: 0.5, netDemandKwh: 12,
      remainingConsumptionKwh: 12.5, remainingProductionKwh: 0.5, remainingNetDemandKwh: 12, consumptionMethod: 'temperature_weighted' },
    assumptions: { coveragePercent: 100, chargePowerKw: 6, roundTripEfficiencyPercent: 95 },
  };
}

test('a cached upcoming-window SOC forecast disappears once its start instant is reached', async () => {
  const b = browser('planification', Date.parse('2026-10-24T21:04:59Z'));
  const charging = { ...snapshot().charging, allowed: false };
  const upcomingPlan = { start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: 14.7,
    plan: { action: 'charge', reason: 'energy_shortfall', targetSocPercent: 90, powerKw: 6 } };
  const active = snapshot({ updatedAt: '2026-10-24T21:00:00Z', planner: { ...plannerDetails(),
    calculation: { charging, plan: null }, upcomingPlan }, automation: automation() });
  await b.complete(active);
  assert.equal(b.get('planner-start-soc-row').hidden, false);
  assert.equal(b.get('planner-start-soc').textContent, '14,7 %');
  for (const milliseconds of [1000, 1]) {
    b.advance(milliseconds);
    b.fireTimer(10000);
    await b.complete(active);
    assert.equal(b.get('planner-start-soc-row').hidden, true);
    assert.equal(b.get('planner-start-soc').textContent, '—');
  }
});

test('a stale afternoon SOC forecast and its energy breakdown clear at the forecast deadline', async () => {
  const b = browser('planification', Date.parse('2026-10-24T14:54:59Z'));
  const target = { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' };
  const active = snapshot({ updatedAt: '2026-10-24T14:45:00Z', automation: automation({ status: 'charging', plan: target }),
    planner: { ...plannerDetails(), afternoonEstimate: { at: target.afternoonTargetAt, socPercent: 67.4 } } });
  await b.complete(active);
  assert.equal(b.get('planner-afternoon-estimate-row').hidden, false);
  assert.equal(b.get('planner-afternoon-estimate').textContent, '67,4 %');
  for (const milliseconds of [1000, 1]) {
    b.advance(milliseconds);
    b.fireTimer(10000);
    await b.complete(active);
    assert.equal(b.get('planner-afternoon-goal-row').hidden, true);
    assert.equal(b.get('planner-afternoon-estimate-row').hidden, true);
    assert.equal(b.get('planner-afternoon-estimate').textContent, '—');
    assert.equal(b.get('planner-gap').textContent, '—');
    assert.equal(b.get('planner-gap-solar').textContent, '—');
  }
});

test('an expired planned completion clears without removing a later afternoon SOC forecast', async () => {
  const b = browser('planification', Date.parse('2026-10-24T21:09:59Z'));
  const upcomingPlan = { start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: 14.7,
    estimatedCompletionAt: '2026-10-24T21:10:00Z',
    plan: { action: 'charge', reason: 'energy_shortfall', targetSocPercent: 90, powerKw: 6,
      afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-25T15:55:00Z' } };
  const active = snapshot({ updatedAt: '2026-10-24T21:00:00Z', planner: { ...plannerDetails(),
    calculation: { charging: { allowed: false }, plan: null }, upcomingPlan,
    afternoonEstimate: { at: '2026-10-25T15:55:00Z', socPercent: 75.8 } }, automation: automation() });
  await b.complete(active);
  assert.equal(b.get('planner-start-soc-row').hidden, true);
  assert.match(b.get('planner-charge-end').textContent, /23:10/);
  for (const milliseconds of [1000, 1]) {
    b.advance(milliseconds);
    b.fireTimer(10000);
    await b.complete(active);
    assert.equal(b.get('planner-charge-end').textContent, '—');
    assert.equal(b.get('planner-afternoon-estimate').textContent, '75,8 %');
    assert.equal(b.get('planner-afternoon-estimate-row').hidden, false);
  }
});

test('solar car-support mode distinguishes a discharge ceiling from live battery power', async () => {
  const support = automation({ status: 'holding', reason: 'solar_battery_support' });
  const details = plannerDetails();
  const plan = browser('planification');
  await plan.complete(snapshot({ automation: support, planner: { ...details, battery: { ...details.battery,
    mode: 'manual', automated: true, automationMode: 'supply', powerKw: -4 } }, batteryChargeEstimate: chargeEstimate() }));
  assert.equal(plan.get('planner-mode').textContent, 'Soutien voiture · solaire');
  assert.equal(plan.get('planner-power-label').textContent, 'Soutien solaire maximal');
  assert.equal(plan.get('planner-power').textContent, '4,00 kW');
  assert.equal(plan.get('planner-charge-end').textContent, '—');
  const base = snapshot();
  const telemetry = { ...base.telemetry, batteryChargeKw: 0, batteryDischargeKw: 2 };
  const home = browser('accueil');
  await home.complete({ ...base, telemetry, automation: support, batteryChargeEstimate: chargeEstimate() });
  assert.equal(home.get('flow-battery-direction').textContent, 'Soutien voiture');
  assert.equal(home.get('flow-battery').textContent, '2,00 kW');
  assert.equal(home.get('flow-battery-charge-estimate').hidden, true);
  const devices = browser('appareils');
  await devices.complete({ ...base, telemetry, automation: support });
  assert.match(devices.get('battery-detail').textContent, /Soutien voiture · 2[,.]00 kW/);
  assert.doesNotMatch(devices.get('battery-detail').textContent, /4[,.]00/);
});

test('outside charge windows the planner displays the upcoming plan and projected starting SOC', async () => {
  const b = browser('planification', Date.parse('2026-10-24T15:00:00Z'));
  const upcomingPlan = { start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: 14.7,
    plan: { action: 'charge', reason: 'energy_shortfall', targetSocPercent: 90, powerKw: 6, shortfallKwh: 45.18,
      afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-25T15:55:00Z' } };
  const active = snapshot({ planner: { ...plannerDetails(), upcomingPlan, chargeBreakdown: { start: '2026-10-24T15:00:00Z', end: '2026-10-25T15:55:00Z', storedKwh: 14.46, gapKwh: 40, consumptionKwh: 6.46, solarKwh: 5, gridKwh: 35, unmetKwh: 0 }, afternoonEstimate: { at: '2026-10-25T15:55:00Z', socPercent: 75.8 } }, automation: automation(),
    batteryChargeEstimate: chargeEstimate() });
  await b.complete(active);
  assert.match(pages.planification, /id="planner-current-heading">Plan batterie<\/h2>/);
  assert.equal(b.get('planner-period').textContent, 'Prochain créneau');
  assert.equal(b.get('planner-window-row').hidden, false);
  assert.equal(b.get('planner-window').textContent, 'sam. 24 oct. · 23:05 → dim. 25 oct. · 06:55');
  assert.equal(b.get('planner-start-soc').textContent, '14,7 %');
  assert.equal(b.get('planner-reason').textContent, 'Charge prévue');
  assert.equal(b.get('planner-power').textContent, '6,00 kW');
  assert.equal(b.get('planner-gap').textContent, '40 kWh');
  assert.equal(b.get('planner-gap-label').textContent, 'À ajouter pour demain 16:55');
  assert.equal(b.get('planner-soc').textContent, '24,1 %');
  assert.equal(b.get('planner-afternoon-goal').textContent, '80 %');
  assert.equal(b.get('planner-afternoon-goal-label').textContent, 'Objectif demain à 16:55');
  assert.equal(b.get('planner-afternoon-estimate-label').textContent, 'Batterie estimée demain à 16:55');
  assert.equal(b.get('planner-afternoon-estimate').textContent, '75,8 %');
  assert.equal(b.get('planner-charge-remaining').textContent, 'En attente du créneau');
  assert.equal(b.get('planner-charge-end').textContent, '—');
  assert.equal(b.requests.length, 1);
  b.fireTimer(10000);
  await b.complete({ ...active, charging: { allowed: true } });
  assert.equal(b.get('planner-period').textContent, 'Créneau en cours');
  assert.equal(b.get('planner-window-row').hidden, true);
  assert.equal(b.get('planner-start-soc-row').hidden, true);
});

test('upcoming battery charge finish is shown before charging starts and clears for incompatible previews', async () => {
  const b = browser('planification', Date.parse('2026-10-24T15:00:00Z'));
  const upcomingPlan = { start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: 50,
    estimatedCompletionAt: '2026-10-25T01:10:00Z',
    plan: { action: 'charge', reason: 'energy_shortfall', targetSocPercent: 90, powerKw: 6 } };
  const active = snapshot({ planner: { ...plannerDetails(), upcomingPlan }, automation: automation(),
    batteryChargeEstimate: chargeEstimate() });
  await b.complete(active);
  assert.equal(b.get('planner-charge-remaining').textContent, 'En attente du créneau');
  assert.equal(b.get('planner-charge-end').textContent, '≈ dim. 25 oct. · 02:10');
  for (const change of [
    { estimatedCompletionAt: null }, { estimatedCompletionAt: 'invalid' },
    { estimatedCompletionAt: '2026-10-24T21:00:00Z' }, { estimatedCompletionAt: '2026-10-25T05:55:01Z' },
    { estimatedSocPercent: null }, { plan: { ...upcomingPlan.plan, action: 'blocked' } },
    { plan: { ...upcomingPlan.plan, action: 'hold' } },
  ]) {
    b.fireTimer(10000);
    await b.complete({ ...active, planner: { ...plannerDetails(), upcomingPlan: { ...upcomingPlan, ...change } } });
    assert.equal(b.get('planner-charge-end').textContent, '—');
  }
  b.fireTimer(10000);
  await b.complete(active);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('planner-charge-end').textContent, '—');
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  await b.complete(active);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('planner-charge-end').textContent, '—');
});

test('upcoming plans show no invented target on missing projections and clear on failure or hidden pages', async () => {
  const b = browser('planification');
  const active = snapshot({ planner: { ...plannerDetails(), upcomingPlan: {
    start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: null,
    plan: { action: 'blocked', reason: 'forecast_unavailable', targetSocPercent: null, shortfallKwh: null },
  } }, automation: automation() });
  await b.complete(active);
  assert.equal(b.get('planner-period').textContent, 'Prochain créneau');
  for (const id of ['planner-start-soc', 'planner-afternoon-estimate', 'planner-gap', 'planner-power']) assert.equal(b.get(id).textContent, '—');
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('network failure'));
  await tick();
  assert.equal(b.get('planner-window-row').hidden, true);
  b.fireTimer(10000);
  await b.complete(active);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('planner-window-row').hidden, true);
  assert.equal(b.get('planner-start-soc-row').hidden, true);
});

test('a captured plan keeps future targets when its start forecast expires and live commands change', async () => {
  const b = browser('planification', Date.parse('2026-10-24T21:00:00Z'));
  const upcomingPlan = { start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: 14.7,
    plan: { action: 'charge', reason: 'energy_shortfall', targetSocPercent: 90, powerKw: 6, shortfallKwh: 45.18,
      afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-25T15:55:00Z' } };
  const planner = { ...plannerDetails(), upcomingPlan,
    calculation: { charging: { allowed: false }, plan: null },
    chargeBreakdown: { start: '2026-10-24T21:00:00Z', end: '2026-10-25T15:55:00Z', storedKwh: 14.46,
      gapKwh: 40, consumptionKwh: 6.46, solarKwh: 5, gridKwh: 35, unmetKwh: 0 },
    afternoonEstimate: { at: '2026-10-25T15:55:00Z', socPercent: 75.8 } };
  await b.complete(snapshot({ planner, automation: automation(), charging: { allowed: false } }));
  assert.equal(b.get('planner-period').textContent, 'Prochain créneau');
  b.advance(5 * 60_000);
  b.fireTimer(10000);
  await b.complete(snapshot({ planner, charging: { allowed: true }, automation: automation({ status: 'charging',
    plan: { afternoonTargetSocPercent: 95, afternoonTargetAt: '2026-10-25T15:55:00Z' } }) }));
  assert.equal(b.get('planner-period').textContent, 'Créneau en cours');
  assert.equal(b.get('planner-start-soc').textContent, '—');
  assert.equal(b.get('planner-start-soc-row').hidden, true);
  assert.equal(b.get('planner-afternoon-goal').textContent, '80 %');
  assert.equal(b.get('planner-afternoon-estimate').textContent, '75,8 %');
  assert.equal(b.get('planner-gap').textContent, '40 kWh');
  assert.equal(b.get('planner-gap-grid').textContent, '≈ 35 kWh');
  b.fireTimer(10000);
  await b.complete(snapshot({ planner, charging: { allowed: true }, automation: automation({ status: 'manual_override',
    plan: upcomingPlan.plan }) }));
  assert.equal(b.get('planner-window-row').hidden, true);
  assert.equal(b.get('planner-afternoon-goal-row').hidden, true);
  assert.equal(b.get('planner-gap').textContent, '—');
});

test('captured active plans and explicit null take precedence over changing live command plans', async () => {
  const b = browser('planification', Date.parse('2026-10-24T12:00:00Z'));
  const capturedPlan = { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' };
  const livePlan = { ...capturedPlan, afternoonTargetSocPercent: 95 };
  await b.complete(snapshot({ planner: { ...plannerDetails(), calculation: { charging: { allowed: true }, plan: capturedPlan } },
    charging: { allowed: false }, automation: automation({ plan: livePlan }) }));
  assert.equal(b.get('planner-afternoon-goal').textContent, '80 %');
  b.fireTimer(10000);
  await b.complete(snapshot({ planner: { ...plannerDetails(), calculation: { charging: { allowed: true }, plan: null } },
    charging: { allowed: true }, automation: automation({ plan: livePlan }) }));
  assert.equal(b.get('planner-afternoon-goal-row').hidden, true);
  assert.equal(b.get('planner-afternoon-goal').textContent, '—');
});

test('planner page uses one dedicated snapshot poll for current battery readings and decisions', async () => {
  const b = browser('planification');
  await b.complete(snapshot({ planner: plannerDetails(), automation: automation({ status: 'charging', reason: 'energy_shortfall', targetSocPercent: 30,
    plan: { window: 'afternoon', forecastDate: '2026-10-24', requiredStoredKwh: 18, energyBufferKwh: 1, storedKwh: 13.2, unmetKwh: 0 } }) }));
  assert.equal(b.requests.length, 1);
  assert.equal((pages.planification.match(/<section class="panel planner-panel(?: car-planner-panel)?"/g) || []).length, 2);
  assert.deepEqual([...pages.planification.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(match => match[1]), ['Plan batterie', 'Plan Tesla']);
  assert.doesNotMatch(pages.planification, /planner-battery-heading/);
  assert.doesNotMatch(pages.planification, /id="planner-(?:gap-note|peak|remaining)(?:["-])|Consommation prévue sur la batterie|Reste de la période/);
  assert.doesNotMatch(pages.planification, /Dernier calcul de charge|planner-calculation|planner-required|planner-assumptions/);
  assert.equal(b.get('planner-mode').textContent, 'Planificateur · charge');
  assert.equal(b.get('planner-reason').textContent, 'Charge prévue');
  assert.equal(b.get('planner-power').textContent, '6,00 kW');
  assert.equal(b.get('planner-soc').textContent, '24,1 %');
  assert.equal(b.get('planner-available').textContent, '11,5 kWh');
  assert.match(pages.planification, /<dt>Énergie disponible<\/dt><dd id="planner-available">/);
  assert.equal(b.get('planner-gap').textContent, '—');
  assert.match(b.get('planner-next').textContent, /14:15/);
  assert.match(b.get('planner-last').textContent, /14:00/);
  assert.doesNotMatch(pages.planification, /src="\/(?:controls|forecast)\.js"|<form|<button(?![^>]*theme-toggle)/);
  assert.match(pages.planification, /href="\/planification" aria-current="page" aria-label="Planification"/);
  assert.equal((pages.planification.match(/class="nav-link/g) || []).length, 7);
  b.fireTimer(10000);
  await b.complete(snapshot({ planner: plannerDetails(), automation: automation() }));
  assert.equal(b.requests.length, 2);
});

test('planner compares the afternoon goal with the estimated SOC at the same deadline', async () => {
  const b = browser('planification', Date.parse('2026-10-24T12:00:00Z'));
  await b.complete(snapshot({ planner: { ...plannerDetails(), afternoonEstimate: { at: '2026-10-24T14:55:00Z', socPercent: 67.4 } }, automation: automation({ status: 'charging',
    targetSocPercent: 30, plan: { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' } }) }));
  assert.equal(b.get('planner-afternoon-goal-row').hidden, false);
  assert.equal(b.get('planner-afternoon-goal-label').textContent, 'Objectif à 16:55');
  assert.equal(b.get('planner-afternoon-goal').textContent, '80 %');
  assert.equal(b.get('planner-afternoon-estimate').textContent, '67,4 %');
  assert.doesNotMatch(pages.planification, /id="planner-target(?:["-])|Objectif du prochain créneau|Cible active/);
  assert.equal(b.requests.length, 1);
});

test('planner labels tomorrow goals and estimates by Zurich calendar date, including DST and midnight', async () => {
  for (const [origin, deadline, day] of [
    ['2026-10-25T17:00:00Z', '2026-10-26T15:55:00Z', 'demain '],
    ['2026-10-25T00:30:00Z', '2026-10-25T15:55:00Z', ''],
    ['2026-10-25T23:30:00Z', '2026-10-26T15:55:00Z', ''],
    ['2026-10-24T22:30:00Z', '2026-10-26T15:55:00Z', 'demain '],
    ['2026-10-24T21:30:00Z', '2026-10-25T15:55:00Z', 'demain '],
    ['2026-03-28T00:30:00Z', '2026-03-29T14:55:00Z', 'demain '],
    ['2026-03-29T21:30:00Z', '2026-03-30T14:55:00Z', 'demain '],
    ['2026-12-31T18:00:00Z', '2027-01-01T15:55:00Z', 'demain '],
  ]) {
    const b = browser('planification', Date.parse(origin));
    await b.complete(snapshot({ planner: { ...plannerDetails(), afternoonEstimate: { at: deadline, socPercent: 80.08 } },
      automation: automation({ plan: { afternoonTargetSocPercent: 80, afternoonTargetAt: deadline } }) }));
    assert.equal(b.get('planner-afternoon-goal-label').textContent, `Objectif ${day}à 16:55`, origin);
    assert.equal(b.get('planner-afternoon-estimate-label').textContent, `Batterie estimée ${day}à 16:55`, origin);
    assert.equal(b.get('planner-afternoon-goal').textContent, '80 %');
    assert.equal(b.get('planner-afternoon-estimate').textContent, '80,08 %');
  }
});

test('planner removes tomorrow from both labels after Zurich midnight on the next poll', async () => {
  const b = browser('planification', Date.parse('2026-10-25T22:59:59Z'));
  const active = snapshot({ planner: { ...plannerDetails(), afternoonEstimate: { at: '2026-10-26T15:55:00Z', socPercent: 80.08 } },
    automation: automation({ plan: { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-26T15:55:00Z' } }) });
  await b.complete(active);
  assert.equal(b.get('planner-afternoon-goal-label').textContent, 'Objectif demain à 16:55');
  assert.equal(b.get('planner-afternoon-estimate-label').textContent, 'Batterie estimée demain à 16:55');
  b.advance(2000);
  b.fireTimer(10000);
  await b.complete(active);
  assert.equal(b.get('planner-afternoon-goal-label').textContent, 'Objectif à 16:55');
  assert.equal(b.get('planner-afternoon-estimate-label').textContent, 'Batterie estimée à 16:55');
});

const chargeBreakdown = (overrides: Record<string, unknown> = {}) => ({
  start: '2026-10-24T10:05:00Z', end: '2026-10-24T14:55:00Z', storedKwh: 36, gapKwh: 12,
  consumptionKwh: 0, solarKwh: 4, gridKwh: 8, unmetKwh: 0, ...overrides,
});

function chargeBreakdownSnapshot(breakdown: unknown = chargeBreakdown()) {
  return { ...snapshot({ automation: automation() }), planner: { ...plannerDetails(),
    battery: { ...plannerDetails().battery, socPercent: 60, storedKwh: 36 }, chargeBreakdown: breakdown,
    upcomingPlan: { start: '2026-10-24T10:05:00Z', end: '2026-10-24T14:55:00Z', estimatedSocPercent: 60,
      plan: { action: 'charge', reason: 'energy_shortfall', powerKw: 6, shortfallKwh: 12,
        afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' } } } };
}

test('planner battery card splits the consumption-adjusted afternoon requirement into solar, grid and uncovered energy', async () => {
  const b = browser('planification');
  await b.complete(chargeBreakdownSnapshot());
  assert.equal(b.get('planner-gap').textContent, '12 kWh');
  assert.equal(b.get('planner-gap-solar').textContent, '≈ 4 kWh');
  assert.equal(b.get('planner-gap-grid').textContent, '≈ 8 kWh');
  assert.equal(b.get('planner-gap-unmet-row').hidden, true);
  assert.doesNotMatch(pages.planification, /Répartition estimée sur le créneau de charge/);
  assert.equal(b.requests.length, 1);
  b.fireTimer(10000);
  await b.complete(chargeBreakdownSnapshot(chargeBreakdown({ solarKwh: 0, gridKwh: 10, unmetKwh: 2 })));
  assert.equal(b.get('planner-gap-solar').textContent, '0 kWh');
  assert.equal(b.get('planner-gap-grid').textContent, '≈ 10 kWh');
  assert.equal(b.get('planner-gap-unmet-row').hidden, false);
  assert.equal(b.get('planner-gap-unmet').textContent, '≈ 2 kWh');
});

test('a captured charge requirement remains visible while live battery SOC changes between evaluations', async () => {
  const b = browser('planification');
  const active = chargeBreakdownSnapshot(chargeBreakdown({ storedKwh: 36 }));
  await b.complete(active);
  assert.equal(b.get('planner-gap').textContent, '12 kWh');
  b.fireTimer(10000);
  const planner = active.planner;
  await b.complete({ ...active, planner: { ...planner,
    battery: { ...planner.battery, socPercent: 62, storedKwh: 37.2, availableKwh: 34.2 } } });
  assert.equal(b.get('planner-soc').textContent, '62 %');
  assert.equal(b.get('planner-available').textContent, '34,2 kWh');
  assert.equal(b.get('planner-gap').textContent, '12 kWh');
  assert.equal(b.get('planner-gap-solar').textContent, '≈ 4 kWh');
  assert.equal(b.get('planner-gap-grid').textContent, '≈ 8 kWh');
});

test('planner source breakdown uses the final afternoon goal during active night charging too', async () => {
  const b = browser('planification');
  await b.complete(snapshot({ charging: { allowed: true, nextWindow: { end: '2026-10-24T14:55:00Z' } },
    automation: automation({ status: 'charging', plan: { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' } }), planner: { ...plannerDetails(),
      chargeBreakdown: chargeBreakdown({ storedKwh: 14.46, gapKwh: 35.54, consumptionKwh: 2, solarKwh: 1, gridKwh: 34.54 }) } }));
  assert.equal(b.get('planner-gap').textContent, '35,5 kWh');
  assert.equal(b.get('planner-gap-solar').textContent, '≈ 1 kWh');
  assert.equal(b.get('planner-gap-grid').textContent, '≈ 34,5 kWh');
});

test('planner does not invent a source split for unknown, malformed or mismatched energy and deadlines', async () => {
  const b = browser('planification');
  for (const invalid of [null, {}, chargeBreakdown({ solarKwh: null, gridKwh: null, unmetKwh: null }),
    chargeBreakdown({ solarKwh: -1 }), chargeBreakdown({ consumptionKwh: null }), chargeBreakdown({ consumptionKwh: -1 }), chargeBreakdown({ gridKwh: '8' }), chargeBreakdown({ gapKwh: 13 }),
    chargeBreakdown({ gridKwh: 7 }), ...[undefined, null, -1, '36', 36.5, 61].map(storedKwh => chargeBreakdown({ storedKwh })), chargeBreakdown({ unmetKwh: -1 }), chargeBreakdown({ end: 'invalid' }),
    chargeBreakdown({ end: '2026-10-25T15:55:00Z' })]) {
    await b.complete(chargeBreakdownSnapshot(invalid));
    assert.equal(b.get('planner-gap-solar').textContent, '—');
    assert.equal(b.get('planner-gap-grid').textContent, '—');
    assert.equal(b.get('planner-gap-unmet-row').hidden, true);
    b.fireTimer(10000);
  }
});

test('planner source split clears after failed requests or hidden pages including late responses', async () => {
  const b = browser('planification');
  await b.complete(chargeBreakdownSnapshot());
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('network failure'));
  await tick();
  for (const id of ['planner-gap-solar', 'planner-gap-grid', 'planner-gap-unmet']) assert.equal(b.get(id).textContent, '—');
  b.fireTimer(10000);
  await b.complete(chargeBreakdownSnapshot());
  b.fireTimer(10000);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  await b.complete(chargeBreakdownSnapshot());
  for (const id of ['planner-gap-solar', 'planner-gap-grid', 'planner-gap-unmet']) assert.equal(b.get(id).textContent, '—');
  assert.equal(b.get('planner-gap-unmet-row').hidden, true);
});

test('planner clears missing or malformed afternoon goals instead of retaining an earlier goal', async () => {
  const b = browser('planification');
  const plan = { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' };
  for (const invalid of [null, {}, { ...plan, afternoonTargetSocPercent: null },
    { ...plan, afternoonTargetSocPercent: '80' }, { ...plan, afternoonTargetSocPercent: -1 },
    { ...plan, afternoonTargetSocPercent: 101 }, { ...plan, afternoonTargetAt: null },
    { ...plan, afternoonTargetAt: 'invalid' }]) {
    await b.complete(snapshot({ planner: plannerDetails(), automation: automation({ plan }) }));
    assert.equal(b.get('planner-afternoon-goal-row').hidden, false);
    b.fireTimer(10000);
    await b.complete(snapshot({ planner: plannerDetails(), automation: automation({ plan: invalid }) }));
    assert.equal(b.get('planner-afternoon-goal-row').hidden, true);
    assert.equal(b.get('planner-afternoon-estimate-row').hidden, true);
    assert.equal(b.get('planner-afternoon-estimate').textContent, '—');
    assert.equal(b.get('planner-afternoon-goal').textContent, '—');
    assert.equal(b.get('planner-afternoon-goal-label').textContent, '—');
    b.fireTimer(10000);
  }
});

test('planner afternoon goal clears on transport errors and while hidden, including late responses', async () => {
  const b = browser('planification');
  const active = snapshot({ planner: { ...plannerDetails(), afternoonEstimate: { at: '2026-10-24T14:55:00Z', socPercent: 72.1 } }, automation: automation({
    plan: { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' } }) });
  await b.complete(active);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('network failure'));
  await tick();
  assert.equal(b.get('planner-afternoon-goal-row').hidden, true);
  assert.equal(b.get('planner-afternoon-estimate-row').hidden, true);
  assert.equal(b.get('planner-afternoon-estimate').textContent, '—');
  assert.equal(b.get('planner-afternoon-goal').textContent, '—');
  b.fireTimer(10000);
  await b.complete(active);
  assert.equal(b.get('planner-afternoon-goal-row').hidden, false);
  b.fireTimer(10000);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('planner-afternoon-goal-row').hidden, true);
  assert.equal(b.get('planner-afternoon-estimate-row').hidden, true);
  assert.equal(b.get('planner-afternoon-estimate').textContent, '—');
  assert.equal(b.get('planner-afternoon-goal').textContent, '—');
  await b.complete(active);
  assert.equal(b.get('planner-afternoon-goal-row').hidden, true);
  assert.equal(b.get('planner-afternoon-estimate-row').hidden, true);
  assert.equal(b.get('planner-afternoon-estimate').textContent, '—');
  assert.equal(b.get('planner-afternoon-goal-label').textContent, '—');
});

test('planner availability stays unknown without verified reserve and displays zero at the reserve floor', async () => {
  const b = browser('planification');
  const planner = plannerDetails();
  for (const [availableKwh, label] of [[null, '—'], [0, '0 kWh']] as const) {
    await b.complete(snapshot({ planner: { ...planner, battery: { ...planner.battery, availableKwh } }, automation: automation() }));
    assert.equal(b.get('planner-available').textContent, label);
    b.fireTimer(10000);
  }
});

test('planner page shows remaining charge time and finish in Zurich using its existing snapshot request', async () => {
  const b = browser('planification');
  const active = snapshot({ planner: plannerDetails(), automation: automation(), batteryChargeEstimate: chargeEstimate({ targetSocPercent: 30 }) });
  await b.complete(active);
  assert.equal(b.get('planner-charge-remaining').textContent, '≈ 2 h 15');
  assert.equal(b.get('planner-charge-end').textContent, '≈ 22:10');
  assert.equal(b.requests.length, 1);
  b.fireTimer(10000);
  await b.complete({ ...active, batteryChargeEstimate: chargeEstimate({ targetSocPercent: 30,
    observedAt: '2026-10-24T21:55:00Z', estimatedCompletionAt: '2026-10-25T01:10:00Z', remainingMinutes: 195 }) });
  assert.equal(b.get('planner-charge-remaining').textContent, '≈ 3 h 15');
  assert.equal(b.get('planner-charge-end').textContent, '≈ dim. 25 oct. à 02:10');
});

test('planner charge estimates distinguish learning, waiting and completed targets without inventing an end time', async () => {
  const b = browser('planification');
  for (const [status, remaining, end] of [
    ['estimating', 'Calcul en cours…', 'Calcul en cours…'],
    ['not_charging', 'En attente de charge', '—'],
    ['target_reached', 'Cible atteinte', '—'],
    ['unavailable', '—', '—'],
  ]) {
    await b.complete(snapshot({ planner: plannerDetails(), batteryChargeEstimate: chargeEstimate({
      targetSocPercent: 30, status, remainingMinutes: null, estimatedCompletionAt: null,
    }) }));
    assert.equal(b.get('planner-charge-remaining').textContent, remaining);
    assert.equal(b.get('planner-charge-end').textContent, end);
    b.fireTimer(10000);
  }
});

test('planner and flow show the charging cutoff rather than promising the target after its window', async () => {
  const estimate = chargeEstimate({ status: 'window_limited', remainingMinutes: 13,
    observedAt: '2026-10-24T14:42:00Z', chargingEndsAt: '2026-10-24T14:55:00Z', estimatedCompletionAt: '2026-10-24T14:55:00Z' });
  const b = browser('planification');
  await b.complete(snapshot({ planner: plannerDetails(), batteryChargeEstimate: estimate }));
  assert.equal(b.get('planner-charge-remaining').textContent, '≈ 13 min');
  assert.equal(b.get('planner-charge-end').textContent, '16:55 · cible non atteinte');
  const home = browser();
  await home.complete(snapshot({ batteryChargeEstimate: estimate }));
  assert.match(home.get('flow-battery-charge-estimate').textContent, /arrêt à 16:55 · cible non atteinte/);
  b.fireTimer(10000);
  await b.complete(snapshot({ planner: plannerDetails(), batteryChargeEstimate: { ...estimate, status: 'estimating',
    remainingMinutes: null, estimatedCompletionAt: null } }));
  assert.equal(b.get('planner-charge-end').textContent, 'Au plus tard 16:55');
});

test('planner charge times clear on invalid estimates, stale telemetry, failed refreshes and hidden pages', async () => {
  const b = browser('planification');
  const active = snapshot({ planner: plannerDetails(), batteryChargeEstimate: chargeEstimate({ targetSocPercent: 30 }) });
  for (const change of [
    { batteryChargeEstimate: null },
    { batteryChargeEstimate: chargeEstimate({ remainingMinutes: -1 }) },
    { batteryChargeEstimate: chargeEstimate({ estimatedCompletionAt: 'invalid' }) },
    { batteryChargeEstimate: chargeEstimate({ estimatedCompletionAt: '2026-10-24T16:00:00Z' }) },
    { batteryChargeEstimate: chargeEstimate({ targetSocPercent: null }) },
    { telemetry: { ...active.telemetry, status: 'stale' } },
    { telemetry: { ...active.telemetry, status: 'offline' } },
  ]) {
    await b.complete(active);
    assert.equal(b.get('planner-charge-remaining').textContent, '≈ 2 h 15');
    b.fireTimer(10000);
    await b.complete({ ...active, ...change });
    assert.equal(b.get('planner-charge-remaining').textContent, '—');
    assert.equal(b.get('planner-charge-end').textContent, '—');
    b.fireTimer(10000);
  }
  await b.complete(active);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('planner-charge-remaining').textContent, '—');
  assert.equal(b.get('planner-charge-end').textContent, '—');
  b.fireTimer(10000);
  await b.complete(active);
  b.fireTimer(10000);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('planner-charge-remaining').textContent, '—');
  assert.equal(b.get('planner-charge-end').textContent, '—');
  await b.complete(active);
  assert.equal(b.get('planner-charge-end').textContent, '—');
});

test('planner page identifies actual controller authority independently of the planner being enabled', async () => {
  const b = browser('planification');
  const details = plannerDetails();
  await b.complete(snapshot({ planner: { ...details, battery: { ...details.battery, mode: 'auto', powerKw: null, automated: false } },
    automation: automation({ status: 'idle' }) }));
  assert.equal(b.get('planner-mode').textContent, 'GEN24 · auto');
  b.fireTimer(10000);
  await b.complete(snapshot({ planner: { ...details, battery: { ...details.battery, automated: false } },
    automation: automation({ status: 'charging' }) }));
  assert.equal(b.get('planner-mode').textContent, 'Manuel');
  b.fireTimer(10000);
  await b.complete(snapshot({ planner: { ...details, battery: { ...details.battery, mode: 'unknown', powerKw: null, automated: false } },
    automation: automation({ status: 'idle' }) }));
  assert.equal(b.get('planner-mode').textContent, 'Indisponible');
});

test('planner page shows holding release and a zero setpoint during the current high tariff', async () => {
  const b = browser('planification');
  const planner = plannerDetails();
  planner.battery.powerKw = 0;
  planner.battery.targetSource = 'planner';
  planner.highTariff.isCurrent = true;
  planner.highTariff.remainingConsumptionKwh = 4.2;
  planner.highTariff.remainingProductionKwh = 0;
  planner.highTariff.remainingNetDemandKwh = 4.2;
  await b.complete(snapshot({ planner, automation: automation({ status: 'holding', reason: 'holding_until_peak', holdUntil: '2026-10-24T14:55:00Z' }) }));
  assert.equal(b.get('planner-mode').textContent, 'Planificateur · réserve');
  assert.equal(b.get('planner-hold-row').hidden, false);
  assert.match(b.get('planner-hold-until').textContent, /16:55/);
  assert.equal(b.get('planner-power').textContent, '0 W');
});

test('planner preserves signed manual setpoints when solar weather is unavailable', async () => {
  const b = browser('planification');
  const planner = plannerDetails();
  planner.battery.powerKw = -2;
  planner.battery.automated = false;
  for (const [status, method] of [
    ['offline', 'uniform_fallback'],
    ['not_configured', 'baseline_only'],
  ]) {
    await b.complete(snapshot({ planner: { ...planner, highTariff: { ...planner.highTariff, forecastStatus: status, consumptionMethod: method,
      isCurrent: true, remainingConsumptionKwh: 4.2, estimatedProductionKwh: null, netDemandKwh: null,
      remainingProductionKwh: null, remainingNetDemandKwh: null } }, automation: automation({ status: 'manual_override' }) }));
    assert.equal(b.get('planner-power').textContent, '-2,00 kW');
    assert.equal(b.get('planner-mode').textContent, 'Manuel');
    b.fireTimer(10000);
  }
});

test('planner page clears every energy and decision on transport failure and while hidden, including late responses', async () => {
  const b = browser('planification');
  const active = snapshot({ planner: plannerDetails(), automation: automation({ status: 'charging', reason: 'energy_shortfall', plan: { window: 'afternoon', forecastDate: '2026-10-24', requiredStoredKwh: 18, energyBufferKwh: 1, storedKwh: 13.2, unmetKwh: 0 } }) });
  await b.complete(active);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('network failure'));
  await tick();
  assert.equal(b.get('planner-mode').textContent, 'Indisponible');
  assert.equal(b.get('planner-reason').textContent, 'Bilan indisponible');
  for (const id of ['planner-afternoon-estimate', 'planner-power', 'planner-next', 'planner-last', 'planner-soc', 'planner-available', 'planner-gap']) assert.equal(b.get(id).textContent, '—');
  b.fireTimer(10000);
  await b.complete(active);
  b.fireTimer(10000);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('planner-available').textContent, '—');
  await b.complete(active);
  assert.equal(b.get('planner-available').textContent, '—');
  assert.equal([...b.timers.values()].some(timer => timer.milliseconds === 10000), false);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  await b.complete(active);
  assert.equal(b.get('planner-available').textContent, '11,5 kWh');
});

test('controls show automatic charging, manual priority and shortfalls using the existing status poll', async () => {
  const b = browser('pilotage');
  await b.complete(snapshot({ automation: automation() }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur · prochain bilan 14:15');
  assert.equal(b.requests.length, 1);
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'charging', targetSocPercent: 32.5, plan: { powerKw: 3.2, unmetKwh: 12, nextHighTariffUnmetKwh: 2.4 } }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur · charge 3,20 kW · cible 32,5 % · prévision estimée · couverture limitée : manque ≈ 2,4 kWh de batterie');
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'idle', reason: 'target_reached_capacity_limited', plan: { unmetKwh: 12, nextHighTariffUnmetKwh: 2.4 } }) }));
  assert.match(b.get('automation-status').textContent, /couverture limitée : manque ≈ 2,4 kWh de batterie/);
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'idle', reason: 'outside_charging_window', plan: { unmetKwh: 12, nextHighTariffUnmetKwh: 2.4 } }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur · prochain bilan 14:15');
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'manual_override' }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur en pause · commande manuelle');
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ enabled: false, status: 'disabled' }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur désactivé');
  assert.equal(b.requests.length, 6);
  assert.match(pages.accueil, /id="automation-status"/);
  assert.doesNotMatch(pages.accueil, /Auto inactive/);
});

test('automation clears obsolete state on failures and hides technical errors', async () => {
  const b = browser('pilotage');
  await b.complete(snapshot({ automation: automation({ status: 'charging', targetSocPercent: 40 }) }));
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'blocked', reason: 'grid_limit', error: 'socket secret detail' }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur bloqué · Plafond de consommation de 16 kW atteint');
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'error', reason: 'new_internal_reason', error: 'socket secret detail' }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur en erreur · Bilan indisponible');
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('automation-status').textContent, 'Automatisation indisponible');
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ nextEvaluationAt: 'invalid' }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur · en attente du prochain bilan');
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('automation-status').textContent, 'Automatisation indisponible');
});

test('preserved battery energy shows its release time and clears the hold label after release', async () => {
  const b = browser('pilotage');
  await b.complete(snapshot({ automation: automation({ status: 'holding', holdUntil: '2026-10-24T14:55:00.000Z' }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur · batterie en réserve jusqu’à 16:55');
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'idle', holdUntil: null }) }));
  assert.equal(b.get('automation-status').textContent, 'Planificateur · prochain bilan 14:15');
  assert.equal(b.requests.length, 2);
});

test('device planning state follows automation status and clears when unavailable', async () => {
  const b = browser('appareils');
  const states = [
    ['idle', 'Auto', 'online'], ['charging', 'En charge', 'online'],
    ['manual_override', 'En pause', ''], ['blocked', 'Bloquée', 'warning'],
    ['error', 'Erreur', 'warning'], ['disabled', 'Désactivée', ''],
  ];
  for (const [status, label, className] of states) {
    await b.complete(snapshot({ automation: automation({ status }) }));
    assert.equal(b.get('planner-state').textContent, label);
    assert.equal(b.get('planner-state').className, `connection-state${className ? ` ${className}` : ''}`);
    b.fireTimer(10000);
  }
  await b.complete(snapshot());
  assert.equal(b.get('planner-state').textContent, 'Inconnu');
});

test('flow battery shows reserve mode while preserving measured solar charging and clears it after release', async () => {
  const b = browser('accueil');
  const base = snapshot();
  await b.complete(snapshot({
    automation: automation({ status: 'holding' }),
    telemetry: { ...base.telemetry, batteryChargeKw: 0.114, batteryDischargeKw: 0 },
  }));
  assert.equal(b.get('flow-battery-direction').textContent, 'En réserve');
  assert.equal(b.get('flow-battery').textContent, '114 W');
  assert.equal(b.get('battery-line').classList.contains('active'), true);
  assert.equal(b.get('battery-line').classList.contains('reverse'), true);
  b.fireTimer(10000);
  await b.complete(snapshot({
    automation: automation({ status: 'holding' }),
    telemetry: { ...base.telemetry, batteryChargeKw: 0, batteryDischargeKw: 0 },
  }));
  assert.equal(b.get('flow-battery-direction').textContent, 'En réserve');
  assert.equal(b.get('flow-battery').textContent, '0 W');
  assert.equal(b.get('battery-line').classList.contains('active'), false);
  b.fireTimer(10000);
  await b.complete(snapshot({ automation: automation({ status: 'idle' }) }));
  assert.equal(b.get('flow-battery-direction').textContent, 'En charge');
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('flow-battery-direction').textContent, 'Aucune mesure');
});

test('flow reserve label requires enabled holding automation and online telemetry', async () => {
  const base = snapshot();
  for (const overrides of [
    {},
    { automation: automation({ enabled: false, status: 'holding' }) },
    ...['idle', 'charging', 'manual_override', 'blocked', 'error'].map(status => ({ automation: automation({ status }) })),
    ...['stale', 'offline'].map(status => ({
      automation: automation({ status: 'holding' }), telemetry: { ...base.telemetry, status },
    })),
  ]) {
    const b = browser('accueil');
    await b.complete(snapshot(overrides));
    assert.equal(b.get('flow-battery-direction').textContent, 'En charge');
  }
});

test('flow footer shows the battery ETA without changing the component circle', async () => {
  const b = browser('accueil');
  await b.complete(snapshot({ batteryChargeEstimate: chargeEstimate() }));
  assert.equal(b.get('flow-battery-charge-estimate').textContent, 'Batterie : cible 80 % · encore ≈ 2 h 15 · fin vers 22:10');
  assert.equal(b.get('flow-battery-charge-estimate').hidden, false);
  assert.equal(b.get('flow-battery-direction').textContent, 'En charge');
  b.fireTimer(10000);
  await b.complete(snapshot({ batteryChargeEstimate: chargeEstimate({ observedAt: '2026-10-24T21:55:00Z', estimatedCompletionAt: '2026-10-25T01:10:00Z', remainingMinutes: 195 }) }));
  assert.equal(b.get('flow-battery-charge-estimate').textContent, 'Batterie : cible 80 % · encore ≈ 3 h 15 · fin vers dim. 25 oct. à 02:10');
});

test('flow view keeps the confirmed SOC target visible while duration and end time are being learned', async () => {
  const b = browser('accueil');
  await b.complete(snapshot({ batteryChargeEstimate: chargeEstimate({ status: 'estimating', targetSocPercent: 22.7, remainingMinutes: null, estimatedCompletionAt: null }) }));
  assert.equal(b.get('flow-battery-charge-estimate').textContent, 'Batterie : cible 22,7 % · durée et fin en calcul…');
  assert.equal(b.get('flow-battery-charge-estimate').hidden, false);
  b.fireTimer(10000);
  await b.complete(snapshot({ batteryChargeEstimate: chargeEstimate({ targetSocPercent: 22.7, remainingMinutes: 25, estimatedCompletionAt: '2026-10-24T18:20:00Z' }) }));
  assert.equal(b.get('flow-battery-charge-estimate').textContent, 'Batterie : cible 22,7 % · encore ≈ 25 min · fin vers 20:20');
});

test('waiting and reached targets remain explicit without inventing a finish time', async () => {
  const b = browser('accueil');
  for (const [status, expected] of [['not_charging', 'cible 80 % · en attente de charge'], ['target_reached', 'cible 80 % atteinte']] as const) {
    await b.complete(snapshot({ batteryChargeEstimate: chargeEstimate({ status, remainingMinutes: null, estimatedCompletionAt: null }) }));
    assert.equal(b.get('flow-battery-charge-estimate').textContent, `Batterie : ${expected}`);
    b.fireTimer(10000);
  }
  await b.complete(snapshot({ batteryChargeEstimate: chargeEstimate({ status: 'estimating', targetSocPercent: null }) }));
  assert.equal(b.get('flow-battery-charge-estimate').hidden, true);
});

test('flow ETA clears on missing, invalid, stale and offline data and failed refreshes', async () => {
  const b = browser('accueil');
  const active = snapshot({ batteryChargeEstimate: chargeEstimate() });
  const base = snapshot();
  for (const next of [snapshot(), snapshot({ batteryChargeEstimate: { status: 'available' } }), snapshot({ batteryChargeEstimate: chargeEstimate({ remainingMinutes: -1 }) }), snapshot({ batteryChargeEstimate: chargeEstimate({ estimatedCompletionAt: null }) }), snapshot({ batteryChargeEstimate: chargeEstimate(), telemetry: { ...base.telemetry, status: 'stale' } }), snapshot({ batteryChargeEstimate: chargeEstimate(), telemetry: { ...base.telemetry, status: 'offline' } })]) {
    await b.complete(active);
    assert.equal(b.get('flow-battery-charge-estimate').hidden, false);
    b.fireTimer(10000);
    await b.complete(next);
    assert.equal(b.get('flow-battery-charge-estimate').hidden, true);
    assert.equal(b.get('flow-battery-charge-estimate').textContent, '');
    b.fireTimer(10000);
  }
  await b.complete(active);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('flow-battery-charge-estimate').hidden, true);
});

test('hidden flow ETA stays cleared until a fresh visible observation arrives', async () => {
  const b = browser('accueil');
  const active = snapshot({ batteryChargeEstimate: chargeEstimate() });
  await b.complete(active);
  b.fireTimer(10000);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('flow-battery-charge-estimate').hidden, true);
  await b.complete(active);
  assert.equal(b.get('flow-battery-charge-estimate').hidden, true);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('flow-battery-charge-estimate').hidden, true);
  await b.complete(active);
  assert.equal(b.get('flow-battery-charge-estimate').hidden, false);
});

test('dashboard refreshes on load and every ten seconds without overlapping requests', async () => {
  const b = browser();
  assert.equal(b.requests.length, 1);
  b.events.get('visibilitychange')!();
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 1);
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 0);
  await b.complete(snapshot());
  assert.equal(b.get('flow-solar').textContent, '4,20 kW');
  assert.equal(b.get('flow-home').textContent, '1,20 kW');
  assert.equal(b.get('flow-grid-direction').textContent, 'Injection');
  assert.equal(b.get('flow-grid').textContent, '1,00 kW');
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 1);
  assert.equal(b.get('connection-notice').hidden, true);
  b.fireTimer(10000);
  assert.equal(b.requests.length, 2);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2);
  await b.complete(snapshot());
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 1);
});

test('missing readings remain unknown and genuine zero is displayed without a false flow', async () => {
  const b = browser();
  const base = snapshot();
  await b.complete({ ...base, telemetry: { ...base.telemetry, solarKw: null, householdKw: null, batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null, gridImportKw: 0, gridExportKw: 0 } });
  assert.equal(b.get('flow-solar').textContent, '—');
  assert.equal(b.get('flow-battery-soc').textContent, '—');
  assert.equal(b.get('flow-home').textContent, '—');
  assert.equal(b.get('flow-grid').textContent, '0 W');
  assert.equal(b.get('flow-grid-direction').textContent, 'Aucun échange');
  assert.equal(b.get('grid-line').classList.contains('active'), false);
});

test('house includes the live residual without a provisional balance display', async () => {
  assert.doesNotMatch(pages.accueil, /Solde provisoire|flow-balance/);
  for (const [solarKw, gridImportKw, batteryDischargeKw, householdKw, batteryChargeKw, gridExportKw, house] of [
    [5, 2, 0, 3, 4, 0, '3,00 kW'],
    [.2, .3, 1, 1.5, 0, 0, '1,50 kW'],
    [5, 0, 0, 2, 1, 2, '2,00 kW'],
    [0, 0, 0, 0, 0, 0, '0 W'],
    [.588, 0, 0, .5, 0, 0, '588 W'],
    [.512, 0, 0, .5, 0, 0, '512 W'],
    [.1006, .1006, .1006, .2, .1004, .1004, '103 W'],
    [.10049, .00049, .00049, .12349, .00051, .00051, '98 W'],
    [.045, 0, 0, 0, 0, 0, '45 W'],
    [0, 0, 0, .045, 0, 0, '0 W'],
    [1.25, 0, 0, 0, 0, 0, '1,25 kW'],
    [0, 0, 0, 1.25, 0, 0, '0 W'],
    [0, 0, 0, .5, 1, 0, '—'],
  ] as const) {
    const b = browser('accueil');
    await b.complete(snapshot({ telemetry: { ...snapshot().telemetry,
      solarKw, gridImportKw, batteryDischargeKw, householdKw, batteryChargeKw, gridExportKw } }));
    assert.equal(b.get('flow-home').textContent, house);
    assert.equal(b.get('home-line').classList.contains('active'), house !== '—' && house !== '0 W');
    assert.equal(b.requests.length, 1);
  }
});

test('house retains measured power on incomplete or stale readings and clears on request failures', async () => {
  const base = snapshot({ telemetry: { ...snapshot().telemetry, solarKw: 4.288 } });
  for (const change of [
    ...['solarKw', 'gridImportKw', 'gridExportKw', 'householdKw', 'batteryChargeKw', 'batteryDischargeKw'].map(key => ({ [key]: null })),
    { solarKw: -1 }, { status: 'stale' }, { status: 'offline' },
  ]) {
    const b = browser('accueil');
    await b.complete(base);
    assert.equal(b.get('flow-home').textContent, '1,29 kW');
    b.fireTimer(10000);
    await b.complete({ ...base, telemetry: { ...base.telemetry, ...change } });
    assert.equal(b.get('flow-home').textContent, 'householdKw' in change ? '—' : '1,20 kW');
  }
  const b = browser('accueil');
  await b.complete(base); b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline')); await tick();
  assert.equal(b.get('flow-home').textContent, '—');
});

test('flow calculations retain whole-watt precision before formatting kW to two decimals', async () => {
  for (const [solarKw, gridImportKw, gridExportKw, batteryChargeKw, batteryDischargeKw, labels] of [
    [0, 1.0006, 0, .001, 0, ['0 W', '1,00 kW', '1 W', '1,00 kW']],
    [1.0006, 0, .001, 0, 0, ['1,00 kW', '1 W', '0 W', '1,00 kW']],
    [0, 0, 0, 0, 1.0006, ['0 W', '0 W', '1,00 kW', '1,00 kW']],
    [0, 2.0006, 0, 1.0006, 0, ['0 W', '2,00 kW', '1,00 kW', '1,00 kW']],
    [.001, .6, 0, .1, 0, ['0 W', '600 W', '100 W', '500 W']],
    [.004999, .6, 0, .1, 0, ['0 W', '600 W', '100 W', '500 W']],
    [.005, .6, 0, .1, 0, ['5 W', '600 W', '100 W', '505 W']],
    [.1006, .1006, .1004, .1004, .1006, ['101 W', '1 W', '1 W', '103 W']],
    [.1006, .1004, .1006, .1006, .1004, ['101 W', '1 W', '1 W', '99 W']],
    [.1, .1004, .1004, .1004, .1004, ['100 W', '0 W', '0 W', '100 W']],
    [0, .5005, 0, 0, 0, ['0 W', '501 W', '0 W', '501 W']],
    [0, .500499, 0, 0, 0, ['0 W', '500 W', '0 W', '500 W']],
    [1.0055, 0, 0, .5005, 0, ['1,01 kW', '0 W', '501 W', '505 W']],
    [1.0006, 0, .999, .002, 0, ['1,00 kW', '999 W', '2 W', '0 W']],
    [.001, 0, 0, 0, 0, ['0 W', '0 W', '0 W', '0 W']],
    [0, .0005, 0, 0, 0, ['0 W', '1 W', '0 W', '1 W']],
    [0, .9995, 0, 0, 0, ['0 W', '1,00 kW', '0 W', '1,00 kW']],
    [0, 0, 0, 0, 0, ['0 W', '0 W', '0 W', '0 W']],
  ] as const) {
    const b = browser('accueil');
    const telemetry = { ...snapshot().telemetry, solarKw, gridImportKw, gridExportKw,
      batteryChargeKw, batteryDischargeKw, householdKw: .8 };
    await b.complete(snapshot({ telemetry }));
    const ids = ['flow-solar', 'flow-grid', 'flow-battery', 'flow-home'];
    const displayed = ids.map(id => b.get(id).textContent);
    assert.deepEqual(displayed, labels, JSON.stringify(telemetry));
    const [solar, grid, battery, home] = displayed.map(label => {
      const value = Number(label.replace(/[^\d,.-]/g, '').replace(',', '.'));
      return Math.round(value * (label.endsWith('kW') ? 1000 : 1));
    });
    const gridSign = b.get('flow-grid-direction').textContent === 'Injection' ? -1 : 1;
    const batterySign = b.get('flow-battery-direction').textContent === 'En charge' ? -1 : 1;
    const roundingToleranceWatts = displayed.filter(label => label.endsWith('kW')).length * 5;
    assert.ok(Math.abs(solar + gridSign * grid + batterySign * battery - home) <= roundingToleranceWatts, displayed.join(', '));
    assert.equal(b.get('flow-grid-direction').textContent,
      grid === 0 ? 'Aucun échange' : gridImportKw > gridExportKw ? 'Import' : 'Injection');
    assert.equal(b.get('flow-battery-direction').textContent,
      battery === 0 ? 'Au repos' : batteryChargeKw > batteryDischargeKw ? 'En charge' : 'En décharge');
    for (const [index, line] of ['solar-line', 'grid-line', 'battery-line', 'home-line'].entries()) {
      assert.equal(b.get(line).classList.contains('active'), [solar, grid, battery, home][index] > 0);
    }
  }
});

test('power readings switch from whole watts to kW at 1000 W in all flow nodes', async () => {
  for (const [value, number, unit] of [
    [0, '0', 'W'], [0.001, '1', 'W'], [0.5, '500', 'W'],
    [0.999, '999', 'W'], [0.9999, '1,00', 'kW'],
    [1, '1,00', 'kW'], [1.001, '1,00', 'kW'], [1.234, '1,23', 'kW'],
    [1.236, '1,24', 'kW'], [1.25, '1,25', 'kW'], [null, '—', ''],
  ] as const) {
    const b = browser('accueil');
    const base = snapshot();
    await b.complete({ ...base, telemetry: {
      ...base.telemetry, solarKw: value, householdKw: value, gridImportKw: value,
      gridExportKw: value === null ? null : 0,
      batteryChargeKw: value, batteryDischargeKw: value === null ? null : 0,
    } });
    for (const id of ['flow-solar', 'flow-grid', 'flow-home', 'flow-battery']) {
      const suppressedSolar = value !== null && value < 0.005;
      const expected = suppressedSolar && (id === 'flow-solar' || id === 'flow-home') ? '0 W' : unit ? `${number} ${unit}` : number;
      assert.equal(b.get(id).textContent, expected, `${value}: ${id}`);
    }
  }
});

test('flow connectors follow measured direction through the junction and reverse when needed', async () => {
  const b = browser('accueil');
  const base = snapshot();
  await b.complete(base);
  for (const id of ['solar-line', 'grid-line', 'battery-line', 'home-line']) {
    assert.equal(b.get(id).classList.contains('active'), true, id);
    assert.equal(b.get(id).classList.contains('unavailable'), false, id);
  }
  assert.equal(b.get('solar-line').classList.contains('reverse'), false);
  assert.equal(b.get('grid-line').classList.contains('reverse'), true);
  assert.equal(b.get('battery-line').classList.contains('reverse'), true);
  assert.equal(b.get('home-line').classList.contains('reverse'), true);
  assert.equal(b.get('flow-battery-soc').textContent, '62,5 %');
  assert.equal(b.get('car-line').classList.contains('active'), false);
  assert.equal(b.get('car-line').classList.contains('reverse'), false);
  assert.equal(b.get('car-line').classList.contains('unavailable'), true);

  b.fireTimer(10000);
  await b.complete({ ...base, telemetry: {
    ...base.telemetry, gridImportKw: 3, gridExportKw: 0,
    batteryChargeKw: 0, batteryDischargeKw: 2,
  } });
  assert.equal(b.get('grid-line').classList.contains('active'), true);
  assert.equal(b.get('grid-line').classList.contains('reverse'), false);
  assert.equal(b.get('battery-line').classList.contains('active'), true);
  assert.equal(b.get('battery-line').classList.contains('reverse'), false);
  assert.equal(b.get('flow-grid-direction').textContent, 'Import');
  assert.equal(b.get('flow-battery-direction').textContent, 'En décharge');
});

test('solar below 5 W displays zero and stops animation; exactly 5 W resumes without pausing other branches', async () => {
  const b = browser('accueil');
  const base = snapshot({ telemetry: { ...snapshot().telemetry, gridImportKw: 4, gridExportKw: 0 } });
  await b.complete(base);
  assert.equal(b.get('solar-line').classList.contains('active'), true);
  for (const [solarKw, label, active] of [
    [0, '0 W', false], [0.0004, '0 W', false], [0.0005, '0 W', false],
    [0.002, '0 W', false], [0.004999, '0 W', false], [0.005, '5 W', true], [1.5, '1,50 kW', true],
  ] as const) {
    b.fireTimer(10000);
    await b.complete({ ...base, telemetry: { ...base.telemetry, solarKw } });
    assert.equal(b.get('flow-solar').textContent, label);
    assert.equal(b.get('solar-line').classList.contains('active'), active, `${solarKw} kW`);
    assert.equal(b.get('solar-line').classList.contains('unavailable'), false);
    for (const id of ['grid-line', 'battery-line', 'home-line']) {
      assert.equal(b.get(id).classList.contains('active'), true, id);
    }
  }
});

test('every flow branch stops at displayed zero watts in either direction and resumes with visible power', async () => {
  const branches = [
    { line: 'grid-line', label: 'flow-grid', reverse: false, readings: (value: number) => ({ gridImportKw: value, gridExportKw: 0 }) },
    { line: 'grid-line', label: 'flow-grid', reverse: true, readings: (value: number) => ({ gridImportKw: 0, gridExportKw: value }) },
    { line: 'battery-line', label: 'flow-battery', reverse: true, readings: (value: number) => ({ batteryChargeKw: value, batteryDischargeKw: 0 }) },
    { line: 'battery-line', label: 'flow-battery', reverse: false, readings: (value: number) => ({ batteryChargeKw: 0, batteryDischargeKw: value }) },
    { line: 'home-line', label: 'flow-home', reverse: true, readings: (value: number) => ({
      solarKw: 0, householdKw: value, gridImportKw: 1, gridExportKw: 0,
      batteryChargeKw: 1 - value, batteryDischargeKw: 0,
    }) },
  ];
  for (const branch of branches) {
    const b = browser('accueil');
    const base = snapshot();
    await b.complete(base);
    for (const [value, label, active] of [[0, '0 W', false], [0.0004, '0 W', false], [0.001, '1 W', true]] as const) {
      b.fireTimer(10000);
      await b.complete({ ...base, telemetry: { ...base.telemetry, ...branch.readings(value) } });
      assert.equal(b.get(branch.label).textContent, label);
      assert.equal(b.get(branch.line).classList.contains('active'), active, `${branch.line}: ${value}`);
      assert.equal(b.get(branch.line).classList.contains('reverse'), active && branch.reverse);
      assert.equal(b.get('flow-stage').classList.contains('paused'), false);
      assert.equal(b.get('car-line').classList.contains('active'), false);
    }
  }
});

test('zero, missing, stale and offline telemetry never animate any connector', async () => {
  const base = snapshot();
  for (const mode of ['zero', 'missing', 'stale', 'offline', 'not_configured']) {
    const b = browser('accueil');
    await b.complete(base);
    b.fireTimer(10000);
    const value = mode === 'missing' ? null : 0;
    const telemetry = mode === 'zero' || mode === 'missing'
      ? { ...base.telemetry, solarKw: value, householdKw: value, gridImportKw: value, gridExportKw: value, batteryChargeKw: value, batteryDischargeKw: value }
      : { ...base.telemetry, status: mode };
    await b.complete({ ...base, telemetry });
    for (const id of ['solar-line', 'grid-line', 'battery-line', 'home-line', 'car-line']) {
      assert.equal(b.get(id).classList.contains('active'), false, `${mode}: ${id}`);
      assert.equal(b.get(id).classList.contains('unavailable'), mode === 'missing' || id === 'car-line', `${mode}: ${id}`);
      if (mode === 'zero' || mode === 'missing') assert.equal(b.get(id).classList.contains('reverse'), false, `${mode}: ${id}`);
    }
  }
});

test('total consumption warning remains visible even when solar keeps grid import below the ceiling', async () => {
  const b = browser('accueil');
  const base = snapshot();
  await b.complete({ ...base, telemetry: { ...base.telemetry, gridImportKw: 4.1, gridExportKw: 0, householdKw: 14.1, batteryChargeKw: 2 } });
  assert.equal(b.get('flow-grid').textContent, '4,10 kW');
  assert.match(b.get('flow-grid-direction').textContent, /consommation totale > 16 kW/);
});

test('stale observations are labeled and never rendered as active live flows', async () => {
  const b = browser();
  const base = snapshot();
  await b.complete({ ...base, telemetry: { ...base.telemetry, status: 'stale' } });
  assert.equal(b.get('flow-solar').textContent, '4,20 kW');
  assert.match(b.get('connection-notice').textContent, /Mesures anciennes/);
  assert.equal(b.get('solar-line').classList.contains('active'), false);
  assert.equal(b.get('connection-notice').hidden, false);
});

test('failed refresh clears former live readings and a later request can recover', async () => {
  const b = browser();
  await b.complete(snapshot());
  b.fireTimer(10000);
  b.requests[1].reject(new Error('offline'));
  await tick();
  assert.equal(b.get('flow-solar').textContent, '—');
  assert.equal(b.get('flow-battery-soc').textContent, '—');
  assert.equal(b.get('connection-notice').hidden, false);
  b.fireTimer(10000);
  await b.complete(snapshot());
  assert.equal(b.get('flow-solar').textContent, '4,20 kW');
  assert.equal(b.get('connection-notice').hidden, true);
});

test('hidden tabs pause flow animation and polling while stalled requests can recover', async () => {
  const b = browser();
  const timeout = [...b.timers.values()].find(timer => timer.milliseconds === 12000)!;
  timeout.callback();
  await tick();
  assert.equal(b.requests[0].signal.aborted, true);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('flow-stage').classList.contains('paused'), true);
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 0);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 1);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('flow-stage').classList.contains('paused'), true);
  assert.equal(b.requests.length, 2);
  await b.complete(snapshot());
  assert.equal(b.get('flow-stage').classList.contains('paused'), false);
});

test('open window shows availability without the removed automation label or a refresh button', async () => {
  const b = browser();
  await b.complete(snapshot({
    tariff: { kind: 'low', priceCts: 17.1, nextChangeAt: '2026-01-15T16:00:00Z' },
    charging: { allowed: true, phase: 'open', currentWindow: 'afternoon', nextWindow: { label: 'Secours de l’après-midi', start: '2026-01-15T11:05:00Z', end: '2026-01-15T15:55:00Z' } },
  }));
  assert.equal(b.get('window-status').textContent, 'Ouvert');
  assert.match(b.get('window-detail').textContent, /16:55/);
  assert.doesNotMatch(html, /id="refresh"|refresh-label|refresh-button/);
});

test('closing buffer permits normal battery operation after the 16:55 hold release', async () => {
  const b = browser();
  await b.complete(snapshot({
    tariff: { kind: 'low', priceCts: 17.1, nextChangeAt: '2026-10-24T15:00:00Z' },
    charging: { allowed: false, phase: 'buffer', nextWindow: { label: 'Nuit', start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z' } },
    automation: automation({ status: 'idle', holdUntil: null }),
  }));
  assert.equal(b.get('window-status').textContent, 'Marge de sécurité');
  assert.equal(b.get('automation-status').textContent, 'Planificateur · prochain bilan 14:15');
  assert.match(pages.tarifs, /23:05 <span>→<\/span> 06:55/);
  assert.match(pages.tarifs, /12:05 <span>→<\/span> 16:55/);
  assert.match(pages.tarifs, /7 h 50\*/);
  assert.match(pages.tarifs, /4 h 50/);
  assert.match(pages.pilotage, /Réserve préservée jusqu’à 06:55 ou 16:55/);
});

test('tariffs use the upcoming morning target and clear it when status becomes unavailable', async () => {
  const b = browser();
  await b.complete(snapshot());
  assert.equal(b.get('car-target-value').textContent, '60');
  assert.match(b.get('car-target-summary').textContent, /Minimum quotidien/);
  assert.match(b.get('car-target-summary').textContent, /06:55/);
  b.fireTimer(10000);
  await b.complete(snapshot({ carTarget: { date: '2026-01-16', weekday: 'Friday', minimumSocPercent: 50, deadline: '2026-01-16T06:00:00Z', gridChargingEndsAt: '2026-01-16T05:55:00Z', reason: 'Minimum quotidien' } }));
  assert.equal(b.get('car-target-value').textContent, '50');
  b.fireTimer(10000);
  b.requests[2].reject(new Error('offline'));
  await tick();
  assert.equal(b.get('car-target-value').textContent, '—');
});

test('French display uses decimal commas and Zurich weekdays without leaking machine weekday names', async () => {
  const b = browser();
  await b.complete(snapshot());
  assert.equal(b.get('flow-solar').textContent, '4,20 kW');
  assert.equal(b.get('flow-battery-soc').textContent, '62,5 %');
  assert.equal(b.get('tariff-price').textContent, '28,29');
  assert.match(b.get('car-target-summary').textContent, /^jeudi à 07:00/);
  assert.doesNotMatch(b.get('car-target-summary').textContent, /Thursday|Monday|Weekly/);
});

for (const page of pageNames) {
  test(`${page} refreshes and recovers independently with only its own DOM elements`, async () => {
    const b = browser(page);
    assert.equal(b.requests.length, 1);
    await b.complete(snapshot());
    assert.equal(b.get('connection-notice').hidden, true);
    if (page === 'accueil') assert.equal(b.get('flow-home').textContent, '1,20 kW');
    if (page === 'tarifs') assert.equal(b.get('tariff-price').textContent, '28,29');
    if (page === 'appareils') assert.equal(b.get('gen24-state').textContent, 'Connecté');
    b.fireTimer(10000);
    b.requests[1].reject(new Error('offline'));
    await tick();
    assert.equal(b.get('connection-notice').hidden, false);
    b.fireTimer(10000);
    await b.complete(snapshot());
    assert.equal(b.get('connection-notice').hidden, true);
  });
}


const dailyMetric = (energyKwh: number | null, sampleCount: number) => ({ energyKwh, sampleCount, coverageSeconds: 0, firstCoveredAt: null, lastCoveredAt: null, firstObservedAt: null, lastObservedAt: null });
const dailyEnergy = (overrides: Record<string, unknown> = {}) => ({
  date: '2026-10-24', timeZone: 'Europe/Zurich', dayHours: 24, expectedSeconds: 86400,
  status: 'partial', solar: dailyMetric(4.23, 2), household: dailyMetric(7.89, 1),
  firstObservationAt: null, lastObservationAt: null, method: 'recorded_energy',
  solarSource: 'GEN24 PV (DC)', householdSource: 'GEN24 household (AC)', householdIncludesCar: false,
  storageStatus: 'ready', error: null, ...overrides,
});
const dailySnapshot = (summary: unknown = dailyEnergy(), overrides: Record<string, unknown> = {}) => snapshot({
  updatedAt: '2026-10-24T10:00:00Z', dailyEnergy: summary, ...overrides,
});

test('home accepts retained energy values with real timestamps without claiming measured duration', async () => {
  const b = browser('accueil');
  const { dailyEnergy: recorded } = summarizeRecordedEnergy('2026-10-24', {
    solar: [{ at: '2026-10-24T09:59:29.000Z', value: 1250 }],
    household: [{ at: '2026-10-24T09:59:30.000Z', value: 0 }],
  }, new Date('2026-10-24T10:00:00Z'));
  await b.complete(dailySnapshot(recorded));
  assert.equal(b.get('today-daily-energy').hidden, false);
  assert.equal(b.get('today-daily-solar').textContent, '1,3');
  assert.equal(b.get('today-daily-household').textContent, '0');
  assert.equal(b.get('today-daily-energy-status').textContent, '');
  assert.doesNotMatch(b.get('today-daily-energy-status').textContent, /couvertes|Journée complète/);
  assert.match(b.get('today-daily-energy').getAttribute('title')!, /11:59:29/);
  assert.match(b.get('today-daily-energy').getAttribute('title')!, /11:59:30/);
});

test('daily readings appear above the home forecasts with matching value styles', async () => {
  const b = browser('accueil');
  b.get('today-forecast-energy').textContent = '18,3';
  b.get('today-forecast-consumption').textContent = '29';
  await b.complete(dailySnapshot());
  assert.equal(b.get('today-daily-energy').hidden, false);
  assert.equal(b.get('today-daily-solar').textContent, '4,2');
  assert.equal(b.get('today-daily-household').textContent, '7,9');
  assert.equal(b.get('today-daily-energy-status').textContent, '');
  assert.equal(b.get('today-daily-energy-status').hidden, true);
  assert.equal(b.get('today-forecast-energy').textContent, '18,3');
  assert.equal(b.get('today-forecast-consumption').textContent, '29');
  assert.equal(b.requests.length, 1);
  assert.match(pages.accueil, /<div class="daily-energy-actuals" id="today-daily-energy" hidden>/);
  assert.doesNotMatch(pages.accueil, /Relevé du jour/);
  assert.ok(pages.accueil.indexOf('id="today-daily-household"') < pages.accueil.indexOf('id="today-forecast-energy"'));
  for (const id of ['today-daily-solar', 'today-daily-household', 'today-daily-car', 'today-forecast-energy', 'today-forecast-consumption', 'today-forecast-car']) {
    assert.ok(pages.accueil.includes(`<div class="forecast-production"><strong id="${id}">`));
  }
  assert.match(pages.accueil, /id="today-observations-heading">Observations<\/h3>/);
  assert.match(pages.accueil, /id="today-forecast-group-heading">Prévisions<\/h3>/);
  assert.doesNotMatch(pages.accueil, /today-daily-energy-source|Maison hors recharge voiture/);
  assert.equal((pages.accueil.match(/id="today-daily-energy"/g) ?? []).length, 1);
});

test('daily readings distinguish missing data and measured zero without claiming complete coverage', async () => {
  const b = browser('accueil');
  await b.complete(dailySnapshot(dailyEnergy({ status: 'unavailable', solar: dailyMetric(null, 0), household: dailyMetric(null, 0) })));
  assert.equal(b.get('today-daily-energy-status').textContent, '');
  assert.equal(b.get('today-daily-solar').textContent, '—');
  assert.equal(b.get('today-daily-household').textContent, '—');
  b.fireTimer(10000);
  await b.complete(dailySnapshot(dailyEnergy({ solar: dailyMetric(0, 1), household: dailyMetric(0, 1) })));
  assert.equal(b.get('today-daily-solar').textContent, '0');
  assert.equal(b.get('today-daily-household').textContent, '0');
  assert.equal(b.get('today-daily-energy-status').textContent, '');
  assert.doesNotMatch(b.get('today-daily-energy-status').textContent, /couvertes|complète/);
});

test('house-only daily readings show separate charging and clear it when readings become unavailable', async () => {
  const b = browser('accueil');
  await b.complete(dailySnapshot(dailyEnergy({ householdIncludesCar: false, car: dailyMetric(2, 1) })));
  assert.equal(b.get('today-daily-household').textContent, '7,9');
  assert.equal(b.get('today-daily-car').textContent, '2');
  b.fireTimer(10000);
  await b.complete(dailySnapshot(dailyEnergy({ householdIncludesCar: false, car: dailyMetric(0, 1) })));
  assert.equal(b.get('today-daily-car').textContent, '0');
  b.fireTimer(10000);
  await b.complete(dailySnapshot(null));
  assert.equal(b.get('today-daily-car').textContent, '—');
});

test('historical daily readings survive controller outages and storage errors stay explicit', async () => {
  const b = browser('accueil');
  await b.complete(dailySnapshot(dailyEnergy(), { telemetry: { ...snapshot().telemetry, status: 'offline' } }));
  assert.equal(b.get('today-daily-solar').textContent, '4,2');
  assert.equal(b.get('today-daily-energy').hidden, false);
  b.fireTimer(10000);
  await b.complete(dailySnapshot(dailyEnergy({ storageStatus: 'error', error: 'write failed', status: 'complete' })));
  assert.equal(b.get('today-daily-energy-status').textContent, 'Enregistrement indisponible');
  assert.equal(b.get('today-daily-energy-status').hidden, false);
  assert.equal(b.get('today-daily-energy').getAttribute('data-state'), 'error');
  assert.equal(b.get('today-daily-household').textContent, '7,9');
  b.fireTimer(10000);
  await b.complete(dailySnapshot());
  assert.equal(b.get('today-daily-energy-status').textContent, '');
  assert.equal(b.get('today-daily-energy-status').hidden, true);
});

test('missing, malformed and wrong-date daily summaries hide and clear recorded values', async () => {
  const b = browser('accueil');
  for (const summary of [null, undefined, {}, [], dailyEnergy({ date: '2026-10-23' }),
    dailyEnergy({ timeZone: 'UTC' }), dailyEnergy({ expectedSeconds: 0 }), dailyEnergy({ status: 'invented' }),
    dailyEnergy({ solar: dailyMetric(-1, 100) }), dailyEnergy({ solar: dailyMetric(0, 0) }),
    dailyEnergy({ household: dailyMetric(7, 0) }), dailyEnergy({ household: dailyMetric(null, 100) }),
    dailyEnergy({ household: { energyKwh: '7.8', coverageSeconds: 100 } }),
    dailyEnergy({ household: { energyKwh: 1, coverageSeconds: null } }), dailyEnergy({ solar: { ...dailyMetric(1, 1), coverageSeconds: 90000 } }),
    dailyEnergy({ method: 'weather_estimate' }), dailyEnergy({ householdIncludesCar: null }), dailyEnergy({ householdIncludesCar: true })]) {
    await b.complete(dailySnapshot());
    assert.equal(b.get('today-daily-energy').hidden, false);
    b.fireTimer(10000);
    await b.complete(dailySnapshot(null, { dailyEnergy: summary }));
    assert.equal(b.get('today-daily-energy').hidden, true);
    assert.equal(b.get('today-daily-solar').textContent, '—');
    assert.equal(b.get('today-daily-household').textContent, '—');
    assert.equal(b.get('today-daily-energy-status').textContent, '');
    b.fireTimer(10000);
  }
});

test('daily date follows the snapshot in Zurich and clears yesterday after local midnight', async () => {
  const b = browser('accueil');
  await b.complete(dailySnapshot(dailyEnergy(), { updatedAt: '2026-10-23T22:01:00Z' }));
  assert.equal(b.get('today-daily-energy').hidden, false);
  b.fireTimer(10000);
  await b.complete(dailySnapshot(dailyEnergy(), { updatedAt: '2026-10-24T22:01:00Z' }));
  assert.equal(b.get('today-daily-energy').hidden, true);
  b.fireTimer(10000);
  await b.complete(dailySnapshot(dailyEnergy({ date: '2026-10-25', dayHours: 25, expectedSeconds: 90000 }), { updatedAt: '2026-10-24T22:01:00Z' }));
  assert.equal(b.get('today-daily-energy').hidden, false);
  b.fireTimer(10000);
  await b.complete(dailySnapshot(dailyEnergy(), { updatedAt: 'invalid' }));
  assert.equal(b.get('today-daily-energy').hidden, true);
});

test('daily readings clear on transport failure and while hidden, including late hidden responses', async () => {
  const b = browser('accueil');
  await b.complete(dailySnapshot());
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('network failure'));
  await tick();
  assert.equal(b.get('today-daily-energy').hidden, true);
  assert.equal(b.get('today-daily-solar').textContent, '—');
  b.fireTimer(10000);
  await b.complete(dailySnapshot());
  b.fireTimer(10000);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('today-daily-energy').hidden, true);
  await b.complete(dailySnapshot());
  assert.equal(b.get('today-daily-energy').hidden, true);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  await b.complete(dailySnapshot());
  assert.equal(b.get('today-daily-energy').hidden, false);
});

test('daily details stay scoped to Today without adding notices or requests on other pages', async () => {
  for (const page of ['pilotage', 'tarifs', 'appareils'] as const) {
    assert.doesNotMatch(pages[page], /today-daily-energy|Relevé du jour/);
    const b = browser(page);
    await b.complete(dailySnapshot(dailyEnergy({ storageStatus: 'error' })));
    assert.equal(b.get('connection-notice').hidden, true);
    assert.equal(b.requests.length, 1);
  }
  for (const page of pageNames) assert.doesNotMatch(pages[page], /Actualisation · 5 s|Auto inactive|GEN24 connecté/);
});


test('one unobserved daily metric remains unknown while the observed metric is shown', async () => {
  const b = browser('accueil');
  await b.complete(dailySnapshot(dailyEnergy({ solar: dailyMetric(null, 0), household: dailyMetric(0, 300) })));
  assert.equal(b.get('today-daily-energy').hidden, false);
  assert.equal(b.get('today-daily-solar').textContent, '—');
  assert.equal(b.get('today-daily-household').textContent, '0');
  assert.equal(b.get('today-daily-energy-status').textContent, '');
});


test('dashboard keeps a ten-second start cadence after two-second reads and bounds overruns', async () => {
  const b = browser('accueil');
  assert.equal([...b.timers.values()].some(timer => timer.milliseconds === 12000), true);
  b.advance(2000);
  await b.complete(snapshot());
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 8000).length, 1);
  b.advance(8000);
  b.fireTimer(8000);
  assert.equal(b.requests.length, 2);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2, 'An in-flight read cannot overlap');
  b.advance(11000);
  await b.complete(snapshot());
  b.fireTimer(1000);
  assert.equal(b.requests.length, 3, 'Overruns wait at least one second before retrying');
  b.advance(2000);
  b.advance(-60000);
  await b.complete(snapshot());
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 1,
    'A backward wall-clock correction cannot postpone polling beyond ten seconds');
});

test('dashboard aborts hidden requests and ignores their results after an immediate visible refresh', async () => {
  const b = browser('accueil');
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests[0].signal.aborted, true);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2);
  await b.complete(snapshot({ telemetry: { ...snapshot().telemetry, solarKw: 99 } }), 0);
  assert.equal(b.get('flow-solar').textContent, '');
  await b.complete(snapshot(), 1);
  assert.equal(b.get('flow-solar').textContent, '4,20 kW');
});


test('coverage labels ignore unmet SOC goals and unknown next-period coverage', async () => {
  for (const coverage of [0, null, undefined]) {
    for (const [reason, expected] of [
      ['charging_insufficient_capacity_or_time', 'Charge prévue'],
      ['target_reached_capacity_limited', 'Cible atteinte'],
    ]) {
      const b = browser();
      const plan = { unmetKwh: 30, nextHighTariffUnmetKwh: coverage };
      await b.complete(snapshot({ charging: { ...snapshot().charging, allowed: true }, planner: plannerDetails(),
        automation: automation({ status: reason === 'target_reached_capacity_limited' ? 'idle' : 'charging', reason, plan }) }));
      assert.equal(b.get('planner-reason').textContent, expected);
      assert.doesNotMatch(b.get('automation-status').textContent, /couverture limitée/i);
    }
  }
});

test('planner reserves Charge nécessaire for a demonstrated next-high-tariff need, before scheduled charging', async () => {
  for (const [need, expected] of [[0, 'Charge de réserve'], [2, 'Charge nécessaire'], [1e-7, 'Charge de réserve'],
    [null, 'Charge prévue'], [undefined, 'Charge prévue'], [-1, 'Charge prévue'], ['2', 'Charge prévue']] as const) {
    for (const preview of [false, true]) {
      const b = browser('planification');
      const plan = { action: 'charge', reason: 'energy_shortfall', unmetKwh: 30,
        nextHighTariffUnmetKwh: 0, nextHighTariffChargeNeededKwh: need };
      await b.complete(snapshot({ charging: { allowed: !preview }, automation: automation({ status: 'charging', reason: plan.reason, plan }),
        planner: { ...plannerDetails(), highTariff: { ...plannerDetails().highTariff, start: '2026-10-25T06:00:00Z' }, upcomingPlan: preview ? {
          start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: 60, plan,
        } : null } }));
      assert.equal(b.get('planner-reason').textContent, expected);
    }
  }
});

test('upcoming plan labels use next-period coverage rather than the overall SOC shortfall', async () => {
  for (const [coverage, expected] of [[0, 'Charge prévue'], [2, 'Couverture limitée']] as const) {
    const b = browser('planification');
    await b.complete(snapshot({ planner: { ...plannerDetails(),
      highTariff: { ...plannerDetails().highTariff, start: '2026-10-25T06:00:00Z', end: '2026-10-25T11:00:00Z' }, upcomingPlan: {
      start: '2026-10-24T21:05:00Z', end: '2026-10-25T05:55:00Z', estimatedSocPercent: 20,
      plan: { action: 'charge', reason: 'charging_insufficient_capacity_or_time', unmetKwh: 30,
        nextHighTariffUnmetKwh: coverage },
    } }, automation: automation() }));
    assert.equal(b.get('planner-reason').textContent, expected);
  }
});


test('closing-buffer previews do not warn about a later tariff instead of the imminent one', async () => {
  for (const [peakStart, start, end] of [
    ['2026-10-24T05:00:00Z', '2026-10-24T10:05:00Z', '2026-10-24T14:55:00Z'],
    ['2026-10-24T15:00:00Z', '2026-10-24T21:05:00Z', '2026-10-25T05:55:00Z'],
  ]) {
    const b = browser('planification');
    await b.complete(snapshot({ planner: { ...plannerDetails(),
      highTariff: { ...plannerDetails().highTariff, start: peakStart, isCurrent: false },
      upcomingPlan: { start, end, estimatedSocPercent: 20,
        plan: { action: 'charge', reason: 'charging_insufficient_capacity_or_time', nextHighTariffUnmetKwh: 2 } },
    }, automation: automation() }));
    assert.equal(b.get('planner-reason').textContent, 'Charge prévue');
  }
});


test('afternoon estimates do not substitute goals for unknown or mismatched projections', async () => {
  const b = browser('planification');
  const plan = { afternoonTargetSocPercent: 80, afternoonTargetAt: '2026-10-24T14:55:00Z' };
  for (const estimate of [null, { at: plan.afternoonTargetAt, socPercent: null },
    { at: plan.afternoonTargetAt, socPercent: 101 }, { at: '2026-10-25T15:55:00Z', socPercent: 80 }]) {
    await b.complete(snapshot({ planner: { ...plannerDetails(), afternoonEstimate: estimate }, automation: automation({ plan }) }));
    assert.equal(b.get('planner-afternoon-goal').textContent, '80 %');
    assert.equal(b.get('planner-afternoon-estimate').textContent, '—');
    b.fireTimer(10000);
  }
});
