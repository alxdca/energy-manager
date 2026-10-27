import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/controls.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function browser({ page = 'pilotage', desktop = true } = {}) {
  const elements = new Map<string, {
    textContent: string; hidden: boolean; disabled: boolean; checked: boolean; value: string; min: string; max: string;
    attributes: Map<string, string>;
    listeners: Map<string, (event?: { preventDefault(): void }) => unknown>;
    setAttribute(name: string, value: string): void;
    addEventListener(name: string, listener: (event?: { preventDefault(): void }) => unknown): void;
  }>();
  for (const device of ['battery', 'car']) {
    for (const suffix of device === 'battery'
      ? ['control-form', 'control-fields', 'power', 'use-soc', 'soc', 'soc-hint', 'charge', 'auto', 'mode', 'control-note', 'feedback', 'charge-estimate']
      : ['control-form', 'control-fields', 'current', 'phases', 'current-hint', 'charge', 'eco', 'pause', 'auto', 'auto-target', 'mode', 'control-note', 'feedback']) {
      elements.set(`${device}-${suffix}`, {
        textContent: '', hidden: true, disabled: false, checked: false, value: suffix === 'power' || suffix === 'phases' ? '3' : suffix === 'current' ? '6' : '80', min: '', max: '',
        listeners: new Map(), attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); },
        addEventListener(name, listener) { this.listeners.set(name, listener); },
      });
    }
  }
  const timers = new Map<number, { callback(): void; milliseconds: number }>();
  const events = new Map<string, () => void>();
  const mediaEvents = new Map<string, () => void>();
  const media = {
    matches: desktop,
    addEventListener: (name: string, listener: () => void) => mediaEvents.set(name, listener),
  };
  let timerId = 0;
  const requests: Array<{
    url: string; options: { method?: string; body?: string; signal: AbortSignal; cache?: string };
    resolve(response: Response): void; reject(error: Error): void;
  }> = [];
  const document = {
    hidden: false,
    body: { dataset: { page } },
    getElementById: (id: string) => { const result = elements.get(id); assert.ok(result, id); return result; },
    addEventListener: (name: string, listener: () => void) => events.set(name, listener),
  };
  let now = Date.now();
  const RuntimeDate = class extends Date {
    constructor(value?: string | number) { super(value ?? now); }
    static now() { return now; }
  };
  vm.runInNewContext(script, {
    document, AbortController, Date: RuntimeDate,
    window: { matchMedia(query: string) { assert.equal(query, '(min-width: 701px)'); return media; } },
    setTimeout(callback: () => void, milliseconds: number) { timers.set(++timerId, { callback, milliseconds }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch(url: string, options: (typeof requests)[number]['options']) {
      return new Promise<Response>((resolve, reject) => {
        requests.push({ url, options, resolve, reject });
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  });
  const get = document.getElementById;
  const complete = async (body: unknown, index = requests.length - 1, status = 200) => {
    requests[index].resolve(Response.json(body, { status }));
    await tick();
  };
  const fireTimer = (milliseconds: number) => {
    const entry = [...timers].find(([, timer]) => timer.milliseconds === milliseconds);
    assert.ok(entry, `Expected ${milliseconds}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  const submit = (device = 'battery') => get(`${device}-control-form`).listeners.get('submit')!({ preventDefault() {} });
  const auto = (device = 'battery') => get(`${device}-auto`).listeners.get('click')!();
  const resize = (desktop: boolean) => {
    media.matches = desktop;
    mediaEvents.get('change')?.();
  };
  return { get, requests, complete, fireTimer, timers, document, events, submit, auto, resize, advance: (milliseconds: number) => { now += milliseconds; } };
}

function snapshot(battery: Record<string, unknown> = {}) {
  return {
    battery: { available: true, mode: 'auto', powerKw: null, targetSocPercent: null, limits: { minPowerKw: 0.1, maxPowerKw: 7, minSocPercent: 10, maxSocPercent: 95 }, error: null, ...battery },
    car: carState({ available: false, canPause: false, mode: 'unknown', error: 'Wattpilot non connecté.' }),
    automationEnabled: false,
  };
}

function carState(overrides: Record<string, unknown> = {}) {
  return { available: true, canPause: true, mode: 'eco', currentAmps: 6, powerKw: 0,
    carConnected: true, charging: false, limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, error: null as string | null, ...overrides };
}
const carAutomation = (overrides: Record<string, unknown> = {}) => ({
  enabled: false, status: 'manual', reason: 'manual_override', error: null,
  lastEvaluatedAt: null, nextEvaluationAt: null, plan: null, lastCheckpoint: null, ...overrides,
});
const morningTarget = { date: '2026-10-26', minimumSocPercent: 60,
  deadline: '2026-10-26T06:00:00.000Z', gridChargingEndsAt: '2026-10-26T05:55:00.000Z' };

const writes = (b: ReturnType<typeof browser>) => b.requests.filter(request => request.options.method === 'POST');

test('only automation-owned charging is labelled automatic and ownership changes refresh in place', async () => {
  const b = browser();
  const active = snapshot({ mode: 'manual', powerKw: 6, targetSocPercent: 40, automated: true });
  await b.complete({ ...active, automationEnabled: true });
  assert.equal(b.get('battery-mode').textContent, 'Planificateur · charge 6 kW · seuil 40 %');
  b.fireTimer(10000);
  await b.complete({ ...snapshot({ mode: 'manual', powerKw: 6, targetSocPercent: 40, automated: false }), automationEnabled: true });
  assert.equal(b.get('battery-mode').textContent, 'Manuel · charge 6 kW · seuil 40 %');
  b.fireTimer(10000);
  await b.complete({ ...active, automationEnabled: false });
  assert.equal(b.get('battery-mode').textContent, 'Planificateur · charge 6 kW · seuil 40 %');
  b.fireTimer(10000);
  await b.complete({ ...snapshot(), automationEnabled: true });
  assert.equal(b.get('battery-mode').textContent, 'GEN24 · auto');
  assert.equal(b.requests.length, 4);
});

test('returning to Auto resumes through the existing command endpoint and confirms ownership', async () => {
  const b = browser();
  await b.complete({ ...snapshot({ mode: 'manual', powerKw: 3, targetSocPercent: null }), automationEnabled: true });
  b.auto();
  assert.deepEqual(JSON.parse(writes(b)[0].options.body!), { mode: 'auto' });
  await b.complete({ success: true });
  await b.complete({ ...snapshot({ mode: 'manual', powerKw: 6, targetSocPercent: 45, automated: true }), automationEnabled: true });
  assert.equal(b.get('battery-mode').textContent, 'Planificateur · charge 6 kW · seuil 45 %');
  assert.equal(writes(b).length, 1);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
});

test('an automation hold is labelled reserve without being confused with manual standby', async () => {
  const b = browser();
  await b.complete({ ...snapshot({ mode: 'manual', powerKw: 0, targetSocPercent: null, automated: true, automationMode: 'hold' }), automationEnabled: true });
  assert.equal(b.get('battery-mode').textContent, 'Planificateur · réserve');
  b.fireTimer(10000);
  await b.complete({ ...snapshot({ mode: 'manual', powerKw: 0, targetSocPercent: null, automated: false }), automationEnabled: true });
  assert.match(b.get('battery-mode').textContent, /^Manuel · veille/);
});

test('an owned solar supply window is labelled as car support rather than forced discharge power', async () => {
  const b = browser();
  await b.complete(snapshot({ mode: 'manual', automated: true, automationMode: 'supply', powerKw: -4,
    targetSocPercent: null, minimumSocPercent: 35, chargeEstimate: { status: 'available', method: 'soc_trend' } }));
  assert.equal(b.get('battery-mode').textContent, 'Soutien voiture · solaire');
  assert.doesNotMatch(b.get('battery-mode').textContent, /décharge|4 kW|Manuel/);
  assert.equal(b.get('battery-charge-estimate').hidden, true);
});

const chargeEstimate = (overrides: Record<string, unknown> = {}) => ({
  status: 'available', targetSocPercent: 80, remainingMinutes: 135,
  observedAt: '2026-10-24T17:55:00Z', estimatedCompletionAt: '2026-10-24T20:10:00Z',
  method: 'soc_trend', ...overrides,
});

test('battery ETA uses the confirmed target and observed rate despite unsubmitted form edits', async () => {
  const b = browser();
  await b.complete(snapshot({ mode: 'manual', powerKw: 3, targetSocPercent: 80, chargeEstimate: chargeEstimate() }));
  assert.equal(b.get('battery-charge-estimate').textContent, '80 % vers 22:10 · ≈ 2 h 15');
  assert.equal(b.get('battery-charge-estimate').hidden, false);
  b.get('battery-power').value = '6';
  b.get('battery-soc').value = '95';
  b.get('battery-use-soc').checked = true;
  b.get('battery-use-soc').listeners.get('change')!();
  assert.equal(b.get('battery-charge-estimate').textContent, '80 % vers 22:10 · ≈ 2 h 15');
  b.submit();
  assert.equal(b.get('battery-charge-estimate').textContent, '');
  assert.equal(b.get('battery-charge-estimate').hidden, true);
});

test('battery ETA includes the Zurich date across midnight and daylight-saving time', async () => {
  const b = browser();
  await b.complete(snapshot({ chargeEstimate: chargeEstimate({ observedAt: '2026-10-24T21:55:00Z', estimatedCompletionAt: '2026-10-25T01:10:00Z', remainingMinutes: 195 }) }));
  assert.equal(b.get('battery-charge-estimate').textContent, '80 % vers dim. 25 oct. à 02:10 · ≈ 3 h 15');
});

test('automatic battery ETA identifies the cutoff when the target cannot be reached', async () => {
  const b = browser();
  await b.complete(snapshot({ chargeEstimate: chargeEstimate({ status: 'window_limited', remainingMinutes: 13,
    observedAt: '2026-10-24T14:42:00Z', estimatedCompletionAt: '2026-10-24T14:55:00Z', chargingEndsAt: '2026-10-24T14:55:00Z' }) }));
  assert.equal(b.get('battery-charge-estimate').textContent, 'Arrêt à 16:55 · ≈ 13 min · cible 80 % non atteinte');
});

test('battery ETA distinguishes warmup, waiting and target reached and clears invalid values', async () => {
  const b = browser();
  for (const [status, label] of [['estimating', 'Fin de charge : calcul en cours…'], ['not_charging', 'En attente de charge'], ['target_reached', 'Cible atteinte']] as const) {
    await b.complete(snapshot({ chargeEstimate: chargeEstimate({ status }) }));
    assert.equal(b.get('battery-charge-estimate').textContent, label);
    b.fireTimer(10000);
  }
  for (const invalid of [undefined, null, {}, chargeEstimate({ status: 'unavailable' }), chargeEstimate({ remainingMinutes: 0 }), chargeEstimate({ remainingMinutes: '135' }), chargeEstimate({ targetSocPercent: 101 }), chargeEstimate({ estimatedCompletionAt: 'bad date' }), chargeEstimate({ observedAt: null }), chargeEstimate({ method: 'power' })]) {
    await b.complete(snapshot({ chargeEstimate: invalid }));
    assert.equal(b.get('battery-charge-estimate').textContent, '');
    assert.equal(b.get('battery-charge-estimate').hidden, true);
    b.fireTimer(10000);
  }
});

test('battery ETA clears on failure, hidden tab and responsive home controls', async () => {
  const b = browser({ page: 'accueil' });
  const active = snapshot({ chargeEstimate: chargeEstimate() });
  await b.complete(active);
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('battery-charge-estimate').hidden, true);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.get('battery-charge-estimate').hidden, true);
  await b.complete(active);
  assert.equal(b.get('battery-charge-estimate').hidden, false);
  b.resize(false);
  assert.equal(b.get('battery-charge-estimate').hidden, true);
  b.resize(true);
  await b.complete(active);
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('battery-charge-estimate').hidden, true);
});

test('mobile home keeps embedded controls disabled and makes no control requests or writes', async () => {
  const b = browser({ page: 'accueil', desktop: false });
  b.events.get('visibilitychange')!();
  b.submit();
  b.auto();
  b.get('battery-use-soc').checked = true;
  b.get('battery-use-soc').listeners.get('change')!();
  assert.equal(b.get('battery-control-fields').disabled, true);
  assert.equal(b.get('battery-charge').disabled, true);
  assert.equal(b.get('battery-soc').disabled, true);
  assert.equal(b.get('battery-auto').disabled, true);
  assert.equal(b.requests.length, 0);
  assert.equal(b.timers.size, 0);
  b.resize(true);
  assert.equal(b.requests.length, 1);
  assert.equal(b.get('battery-charge').disabled, true);
  await b.complete(snapshot());
  assert.equal(b.get('battery-charge').disabled, false);
});

test('hiding desktop home cancels polling, invalidates a late read, and requires fresh state on return', async () => {
  const b = browser({ page: 'accueil' });
  await b.complete(snapshot());
  b.get('battery-power').value = '6.2';
  b.get('battery-use-soc').checked = true;
  b.get('battery-soc').value = '91';
  b.fireTimer(10000);
  const oldPoll = b.requests.length - 1;
  let finishOldBody!: (body: unknown) => void;
  b.requests[oldPoll].resolve({ ok: true, json: () => new Promise(resolve => { finishOldBody = resolve; }) } as Response);
  await tick();
  b.resize(false);
  assert.equal(b.requests[oldPoll].options.signal.aborted, true);
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  assert.equal(b.get('battery-auto').disabled, true);
  assert.equal(b.get('battery-charge').disabled, true);
  b.submit();
  b.auto();
  assert.equal(writes(b).length, 0);
  b.resize(true);
  assert.equal(b.requests.length, 3);
  assert.equal(b.get('battery-charge').disabled, true);
  await b.complete(snapshot({ mode: 'manual', powerKw: 4 }));
  finishOldBody(snapshot());
  await tick();
  assert.match(b.get('battery-mode').textContent, /Manuel · charge 4 kW/);
  assert.equal(b.get('battery-charge').disabled, false);
  assert.equal(b.get('battery-power').value, '6.2');
  assert.equal(b.get('battery-soc').value, '91');
  assert.equal(b.get('battery-use-soc').checked, true);
  b.resize(false);
  assert.equal(b.timers.size, 0);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 3);
  b.resize(true);
  assert.equal(b.get('battery-charge').disabled, true);
  assert.equal(b.requests.length, 4);
  await b.complete(snapshot());
  assert.equal(b.get('battery-charge').disabled, false);
});

test('resizing home during a write never cancels or retries it and defers hidden reconciliation', async () => {
  for (const returnBeforeAcknowledgement of [false, true]) {
    const b = browser({ page: 'accueil' });
    await b.complete(snapshot());
    b.submit();
    const write = writes(b)[0];
    b.resize(false);
    if (returnBeforeAcknowledgement) b.resize(true);
    assert.equal(write.options.signal.aborted, false);
    b.submit();
    b.auto();
    assert.equal(writes(b).length, 1);
    await b.complete({ success: true });
    assert.equal(write.options.signal.aborted, false);
    if (!returnBeforeAcknowledgement) {
      assert.equal(b.requests.length, 2);
      assert.equal(b.timers.size, 0);
      assert.equal(b.get('battery-charge').disabled, true);
      b.resize(true);
    }
    assert.equal(b.requests.length, 3);
    assert.equal(b.requests.at(-1)!.url, '/api/controls');
    assert.equal(b.get('battery-charge').disabled, true);
    await b.complete(snapshot({ mode: 'manual', powerKw: 3 }));
    assert.match(b.get('battery-mode').textContent, /Manuel · charge 3 kW/);
    assert.equal(b.get('battery-charge').disabled, false);
    assert.equal(writes(b).length, 1);
  }
});

test('mobile Pilotage retains control polling and writes independently of the home breakpoint', async () => {
  const b = browser({ desktop: false });
  assert.equal(b.requests.length, 1);
  await b.complete(snapshot());
  assert.equal(b.get('battery-charge').disabled, false);
  b.resize(false);
  b.fireTimer(10000);
  await b.complete(snapshot());
  b.submit();
  assert.equal(writes(b).length, 1);
  await b.complete({ success: true });
  await b.complete(snapshot({ mode: 'manual', powerKw: 3 }));
  assert.equal(b.get('battery-charge').disabled, false);
});

test('manual power status uses watts below 1000 W and preserves charge/discharge direction', async () => {
  for (const [powerKw, expected] of [[0.5, 'charge 500 W'], [0.999, 'charge 999 W'], [1, 'charge 1 kW'], [-0.5, 'décharge 500 W'], [-1, 'décharge 1 kW']] as const) {
    const b = browser();
    await b.complete(snapshot({ mode: 'manual', powerKw }));
    assert.equal(b.get('battery-mode').textContent, `Manuel · ${expected} · sans seuil`);
  }
});

test('controls serialize polling, preserve form edits, and keep disconnected car actions disabled', async () => {
  const b = browser();
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].url, '/api/controls');
  assert.equal(b.requests[0].options.cache, 'no-store');
  assert.equal(b.get('battery-control-fields').disabled, true);
  assert.equal(b.get('battery-charge').disabled, true);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 1);
  await b.complete(snapshot());
  assert.equal(b.get('battery-mode').textContent, 'GEN24 · auto');
  assert.equal(b.get('battery-control-fields').disabled, false);
  assert.equal(b.get('battery-charge').disabled, false);
  assert.equal(b.get('battery-control-note').textContent, '');
  assert.equal(b.get('car-control-fields').disabled, true);
  assert.equal(b.get('car-charge').disabled, true);
  assert.equal(b.get('car-pause').disabled, true);
  b.submit('car');
  assert.equal(writes(b).length, 0);
  assert.equal(b.get('car-feedback').attributes.get('data-state'), 'error');
  b.get('battery-power').value = '6.2';
  b.get('battery-soc').value = '91';
  b.get('battery-use-soc').checked = true;
  b.get('battery-use-soc').listeners.get('change')!();
  assert.equal(b.get('battery-soc').disabled, false);
  b.fireTimer(10000);
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2);
  await b.complete(snapshot({ mode: 'manual', powerKw: 4, targetSocPercent: 85 }));
  assert.match(b.get('battery-mode').textContent, /Manuel · charge 4 kW · seuil 85 %/);
  assert.equal(b.get('battery-power').value, '6.2');
  assert.equal(b.get('battery-soc').value, '91');
});

test('local power and SOC validation prevents writes and uses current controller bounds', async () => {
  const b = browser();
  await b.complete(snapshot());
  assert.equal(b.get('battery-power').max, '7');
  for (const invalid of ['', '0', '8', 'NaN', 'Infinity']) {
    b.get('battery-power').value = invalid;
    b.submit();
    assert.match(b.get('battery-feedback').textContent, /Puissance : de 100 W à 7 kW/);
  }
  b.get('battery-power').value = '3';
  b.get('battery-use-soc').checked = true;
  for (const invalid of ['', '10', '0', '96', 'Infinity']) {
    b.get('battery-soc').value = invalid;
    b.submit();
    assert.match(b.get('battery-feedback').textContent, /Limite : > 10 % et ≤ 95 %/);
  }
  assert.equal(writes(b).length, 0);
  assert.equal(b.get('battery-feedback').attributes.get('data-state'), 'error');
});

test('manual writes have explicit optional SOC, block duplicates, and reconcile actual mode after acknowledgement', async () => {
  const b = browser();
  await b.complete(snapshot());
  b.submit();
  b.submit();
  b.auto();
  assert.equal(writes(b).length, 1);
  assert.deepEqual(JSON.parse(writes(b)[0].options.body!), { mode: 'manual', powerKw: 3, targetSocPercent: null });
  assert.equal(b.get('battery-control-fields').disabled, true);
  assert.equal(b.get('battery-charge').disabled, true);
  assert.equal(b.get('battery-auto').disabled, true);
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  assert.equal(b.get('battery-feedback').attributes.get('data-state'), 'pending');
  await b.complete({ success: true, message: 'Accepted' });
  assert.equal(b.get('battery-feedback').attributes.get('data-state'), 'success');
  assert.equal(b.get('battery-feedback').textContent, 'Commande acceptée. Vérification du mode…');
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  assert.equal(b.get('battery-auto').disabled, true);
  await b.complete(snapshot({ mode: 'manual', powerKw: 3, targetSocPercent: null }));
  assert.match(b.get('battery-mode').textContent, /Manuel · charge 3 kW · sans seuil/);
  assert.equal(b.get('battery-auto').disabled, false);
  b.get('battery-use-soc').checked = true;
  b.get('battery-soc').value = '95';
  b.submit();
  assert.deepEqual(JSON.parse(writes(b)[1].options.body!), { mode: 'manual', powerKw: 3, targetSocPercent: 95 });
  await b.complete({ success: true, message: 'Accepted' });
  await b.complete(snapshot());
  b.auto();
  assert.deepEqual(JSON.parse(writes(b)[2].options.body!), { mode: 'auto' });
});

test('rejected commands never imply success, including busy responses', async () => {
  const b = browser();
  await b.complete(snapshot());
  b.submit();
  await b.complete({ success: false, error: 'Controller busy' }, undefined, 409);
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  assert.match(b.get('battery-feedback').textContent, /Controller busy.*réessayer/);
  await b.complete(snapshot());
  assert.equal(b.get('battery-mode').textContent, 'GEN24 · auto');
  assert.equal(writes(b).length, 1);
});

test('write timeout remains an unknown outcome, reads fresh state, and never retries the write', async () => {
  const b = browser();
  await b.complete(snapshot());
  b.submit();
  b.fireTimer(20000);
  await tick();
  assert.equal(writes(b)[0].options.signal.aborted, true);
  assert.match(b.get('battery-feedback').textContent, /Résultat inconnu.*Vérifiez le mode avant de réessayer.*Aucun renvoi automatique/);
  assert.equal(b.get('battery-feedback').attributes.get('data-state'), 'error');
  assert.equal(b.requests.at(-1)!.url, '/api/controls');
  await b.complete(snapshot({ mode: 'manual', powerKw: 3 }));
  assert.equal(b.get('battery-auto').disabled, false);
  assert.match(b.get('battery-feedback').textContent, /Résultat inconnu/);
  b.fireTimer(10000);
  await b.complete(snapshot());
  assert.equal(writes(b).length, 1);
});

test('a poll invalidated by a command cannot overwrite its reconciliation', async () => {
  const b = browser();
  await b.complete(snapshot());
  b.fireTimer(10000);
  const oldPoll = b.requests.length - 1;
  let finishOldBody!: (body: unknown) => void;
  b.requests[oldPoll].resolve({ ok: true, json: () => new Promise(resolve => { finishOldBody = resolve; }) } as Response);
  await tick();
  b.submit();
  assert.equal(b.requests[oldPoll].options.signal.aborted, true);
  finishOldBody(snapshot());
  await tick();
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  await b.complete({ success: true, message: 'Accepted' });
  await b.complete(snapshot({ mode: 'manual', powerKw: 5, targetSocPercent: 90 }));
  assert.match(b.get('battery-mode').textContent, /Manuel · charge 5 kW/);
});

test('read failures clear confirmed modes and recover; hidden pages pause polling without stranding command controls', async () => {
  const b = browser();
  await b.complete(snapshot());
  b.fireTimer(10000);
  b.requests.at(-1)!.reject(new Error('offline'));
  await tick();
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  assert.equal(b.get('battery-auto').disabled, true);
  b.fireTimer(10000);
  await b.complete(snapshot());
  b.submit();
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  await b.complete({ success: true, message: 'Accepted' });
  assert.equal(b.requests.at(-1)!.url, '/api/controls');
  await b.complete(snapshot({ mode: 'manual', powerKw: 3 }));
  assert.equal(b.get('battery-auto').disabled, true, 'Hidden reconciliation must not render a late response');
  assert.equal([...b.timers.values()].filter(timer => timer.milliseconds === 10000).length, 0);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.at(-1)!.url, '/api/controls');
  await b.complete(snapshot());
  assert.equal(b.get('battery-mode').textContent, 'GEN24 · auto');
});

test('read timeouts recover and unsafe device message markup is only displayed as text', async () => {
  const b = browser();
  b.fireTimer(8000);
  await tick();
  assert.equal(b.requests[0].options.signal.aborted, true);
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  b.fireTimer(10000);
  await b.complete(snapshot({ error: '<img src=x onerror=alert(1)>' }));
  assert.equal(b.get('battery-control-note').textContent, '<img src=x onerror=alert(1)>');
});

test('full battery targets and the optional SOC checkbox explain when manual charging ends', async () => {
  const b = browser();
  await b.complete(snapshot({ mode: 'manual', powerKw: 3, targetSocPercent: 100 }));
  assert.match(b.get('battery-mode').textContent, /jusqu’à 100 %/);
  assert.doesNotMatch(b.get('battery-mode').textContent, /seuil 100 %/);
  assert.equal(b.get('battery-soc-hint').textContent, 'Sans limite : jusqu’à 100 %.');
  assert.equal(b.get('battery-soc').min, '11');
  assert.equal(b.get('battery-soc').disabled, true);
  assert.equal(b.get('car-control-note').textContent, 'Wattpilot non connecté.');
  assert.equal(b.get('car-current-hint').textContent, 'Puissance de charge estimée : —');
  b.get('battery-use-soc').checked = true;
  b.get('battery-use-soc').listeners.get('change')!();
  assert.equal(b.get('battery-soc').disabled, false);
  assert.equal(b.get('battery-soc-hint').textContent, 'Limite : > 10 % et ≤ 95 %.');
  b.get('battery-use-soc').checked = false;
  b.get('battery-use-soc').listeners.get('change')!();
  assert.equal(b.get('battery-soc').disabled, true);
  assert.equal(b.get('battery-soc-hint').textContent, 'Sans limite : jusqu’à 100 %.');
});

test('Auto remains available for recovery when charging capabilities cannot be read', async () => {
  const b = browser();
  await b.complete(snapshot({ available: false, canReturnToAuto: true, mode: 'unknown', error: 'Charging limits unavailable.' }));
  assert.equal(b.get('battery-control-fields').disabled, true);
  assert.equal(b.get('battery-auto').disabled, false);
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  b.submit();
  assert.equal(writes(b).length, 0);
  assert.match(b.get('battery-feedback').textContent, /Charge manuelle indisponible/);
  b.auto();
  assert.equal(writes(b).length, 1);
  assert.deepEqual(JSON.parse(writes(b)[0].options.body!), { mode: 'auto' });
  assert.equal(b.get('battery-auto').disabled, true);
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  await b.complete({ success: true, message: 'Auto accepted' });
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  await b.complete(snapshot({ available: false, canReturnToAuto: true, mode: 'auto' }));
  assert.equal(b.get('battery-mode').textContent, 'GEN24 · auto');
  assert.equal(b.get('battery-auto').disabled, false);
  assert.equal(b.get('car-pause').disabled, true);
});

test('manual mode localizes decimal power while commands keep numeric JSON values', async () => {
  const b = browser();
  await b.complete(snapshot({ mode: 'manual', powerKw: 3.2, targetSocPercent: 85 }));
  assert.equal(b.get('battery-mode').textContent, 'Manuel · charge 3,2 kW · seuil 85 %');
  b.get('battery-power').value = '3.2';
  b.submit();
  assert.deepEqual(JSON.parse(writes(b)[0].options.body!), { mode: 'manual', powerKw: 3.2, targetSocPercent: null });
});

test('current API errors preserve disabled controls and recovery permissions', async () => {
  const error = 'Le contrôleur énergétique est indisponible.';
  for (const canReturnToAuto of [false, true]) {
    const b = browser();
    await b.complete(snapshot({ available: false, canReturnToAuto, mode: 'unknown', error }));
    assert.equal(b.get('battery-control-note').textContent, error);
    assert.equal(b.get('battery-mode').textContent, 'Inconnu');
    assert.equal(b.get('battery-control-fields').disabled, true);
    assert.equal(b.get('battery-auto').disabled, !canReturnToAuto);
    assert.equal(writes(b).length, 0);
  }
});

test('controls keep a ten-second start cadence after two-second reads and bound overruns', async () => {
  const b = browser();
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

test('controls ignore an aborted hidden read and resume with a fresh request immediately', async () => {
  const b = browser();
  b.document.hidden = true;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests[0].options.signal.aborted, true);
  b.document.hidden = false;
  b.events.get('visibilitychange')!();
  assert.equal(b.requests.length, 2);
  await b.complete(snapshot({ mode: 'manual', powerKw: 6 }), 0);
  assert.equal(b.get('battery-mode').textContent, 'Inconnu');
  await b.complete(snapshot(), 1);
  assert.equal(b.get('battery-mode').textContent, 'GEN24 · auto');
});


test('Wattpilot retains manual normal, eco and pause commands in amperes without a car SOC stop', async () => {
  const markup = readFileSync(new URL('../public/pages/controls.html', import.meta.url), 'utf8');
  assert.match(markup, /id="car-current"[^>]*name="currentAmps"/);
  assert.doesNotMatch(markup, /id="car-(?:power|soc|use-soc)"/);
  assert.match(markup, /id="car-auto"/);
  for (const mode of ['normal', 'eco', 'pause']) {
    const b = browser();
    const active = { ...snapshot(), car: carState({ mode: 'normal', currentAmps: 8, powerKw: 2.83, charging: true }) };
    await b.complete(active);
    assert.equal(b.get('car-mode').textContent, 'Normal · 8 A');
    assert.match(b.get('car-control-note').textContent, /Voiture branchée · En charge · 2,83 kW/);
    assert.equal(b.get('car-current').value, '6', 'Polling must not replace the chosen current with measured settings');
    b.get('car-current').value = '10';
    if (mode === 'normal') b.submit('car');
    else b.get(`car-${mode}`).listeners.get('click')!();
    assert.equal(writes(b).length, 1);
    assert.equal(writes(b)[0].url, '/api/controls/car');
    assert.deepEqual(JSON.parse(writes(b)[0].options.body!), mode === 'pause' ? { mode } : { mode, currentAmps: 10 });
    assert.equal(b.get('battery-charge').disabled, true);
    assert.equal(b.get('car-charge').disabled, true);
    assert.equal(b.get('car-eco').disabled, true);
    assert.equal(b.get('car-pause').disabled, true);
    b.submit(); b.submit('car'); b.get('car-pause').listeners.get('click')!();
    assert.equal(writes(b).length, 1);
    await b.complete({ success: true });
    assert.equal(b.get('car-pause').disabled, true, 'A command acknowledgement is not a fresh status');
    await b.complete(active);
    assert.equal(b.get('car-charge').disabled, false);
    assert.equal(b.get('car-current').value, '10');
  }
});

test('car Auto explicitly opts in without current or phase fields and waits for confirmed status', async () => {
  const b = browser();
  await b.complete({ ...snapshot(), car: carState({ available: false, carConnected: false, canReturnToAuto: true }),
    carAutomation: carAutomation(), carTarget: morningTarget });
  assert.equal(b.get('car-charge').disabled, true);
  assert.equal(b.get('car-auto').disabled, false, 'Auto can be armed before the next plug-in');
  assert.match(b.get('car-auto-target').textContent, /Minimum du matin : 60 %/);
  assert.match(b.get('car-mode').textContent, /^Manuel/);
  b.get('car-current').value = '16';
  b.get('car-phases').value = '1';
  b.auto('car');
  assert.deepEqual(JSON.parse(writes(b)[0]!.options.body!), { mode: 'auto' });
  assert.equal(b.get('car-mode').textContent, 'Inconnu');
  assert.equal(b.get('car-auto').disabled, true);
  await b.complete({ success: true });
  assert.equal(b.get('car-mode').textContent, 'Inconnu', 'A POST acknowledgement cannot fabricate the observed mode');
  await b.complete({ ...snapshot(), car: carState({ mode: 'normal', currentAmps: 10, canReturnToAuto: true, automated: true }),
    carAutomation: carAutomation({ enabled: true, status: 'charging', reason: 'grid_charge' }), carTarget: morningTarget });
  assert.equal(b.get('car-mode').textContent, 'Planificateur · Normal · 10 A');
  b.get('car-pause').listeners.get('click')!();
  assert.deepEqual(JSON.parse(writes(b)[1]!.options.body!), { mode: 'pause' });
  await b.complete({ success: true });
  await b.complete({ ...snapshot(), car: carState({ mode: 'pause', canReturnToAuto: true }),
    carAutomation: carAutomation(), carTarget: morningTarget });
  assert.match(b.get('car-mode').textContent, /^Manuel · Pause/);
  assert.equal(writes(b).length, 2);
});

test('missing or invalid automatic-car capability never enables Auto and keeps manual recovery usable', async () => {
  for (const automation of [undefined, null, {}, carAutomation({ enabled: 'true' }), carAutomation({ enabled: true, status: 'manual' })]) {
    const b = browser();
    await b.complete({ ...snapshot(), car: carState({ canReturnToAuto: true }), carAutomation: automation });
    assert.equal(b.get('car-auto').disabled, true);
    assert.equal(b.get('car-pause').disabled, false);
    b.auto('car');
    assert.equal(writes(b).length, 0);
    assert.match(b.get('car-feedback').textContent, /Mode Auto indisponible/);
  }
});

test('car automatic status distinguishes stopping and blocked plans and is cleared on hidden pages', async () => {
  const b = browser();
  await b.complete({ ...snapshot(), car: carState({ canReturnToAuto: true, automated: true }),
    carAutomation: carAutomation({ enabled: true, status: 'blocked', reason: 'soc_unavailable' }), carTarget: morningTarget });
  assert.equal(b.get('car-mode').textContent, 'Planificateur · bloqué');
  b.fireTimer(10000);
  await b.complete({ ...snapshot(), car: carState({ canReturnToAuto: true, automated: true }),
    carAutomation: carAutomation({ status: 'stopping', reason: 'manual_override' }), carTarget: morningTarget });
  assert.equal(b.get('car-mode').textContent, 'Planificateur · arrêt en cours');
  b.document.hidden = true; b.events.get('visibilitychange')!();
  assert.equal(b.get('car-auto').disabled, true);
  assert.equal(b.get('car-auto-target').textContent, 'Objectif de recharge indisponible.');
  b.document.hidden = false; b.events.get('visibilitychange')!();
  assert.equal(b.get('car-auto').disabled, true);
  await b.complete({ ...snapshot(), car: carState({ canReturnToAuto: true }), carAutomation: carAutomation() });
  assert.equal(b.get('car-auto').disabled, false);
});

test('automatic native Eco stays distinct from charging and shows the afternoon 30% target', async () => {
  const b = browser();
  const target = { ...morningTarget, minimumSocPercent: 30, kind: 'afternoon', deadline: '2026-10-26T15:55:00.000Z' };
  await b.complete({ ...snapshot(), car: carState({ mode: 'eco', charging: false, canReturnToAuto: true,
    automated: true, phaseMode: 3, phaseSwitchingSupported: true }), carTarget: morningTarget,
    carAutomation: carAutomation({ enabled: true, status: 'eco', reason: 'eco_default', plan: { target } }) });
  assert.equal(b.get('car-mode').textContent, 'Planificateur · éco');
  assert.doesNotMatch(b.get('car-mode').textContent, /en charge/);
  assert.match(b.get('car-auto-target').textContent, /Minimum de l’après-midi : 30 %/);
  assert.match(b.get('car-current-hint').textContent, /≈ 4[,.]14 kW/);
  assert.equal(writes(b).length, 0);
  b.fireTimer(10000);
  await b.complete({ ...snapshot(), car: carState({ canReturnToAuto: true, automated: true }),
    carAutomation: carAutomation({ enabled: true, status: 'eco', reason: 'eco_default', plan: { target: morningTarget } }) });
  assert.match(b.get('car-auto-target').textContent, /Minimum du matin : 60 %/);
});

test('Wattpilot current validation uses integer amperes and the latest cable limit without writing', async () => {
  const b = browser();
  await b.complete({ ...snapshot(), car: carState({ limits: { minCurrentAmps: 6, maxCurrentAmps: 10 } }) });
  assert.equal(b.get('car-current').min, '6');
  assert.equal(b.get('car-current').max, '10');
  for (const value of ['', '0', '5', '6.5', '11', 'Infinity', 'NaN']) {
    b.get('car-current').value = value;
    b.submit('car');
    b.get('car-eco').listeners.get('click')!();
    assert.match(b.get('car-feedback').textContent, /Courant : de 6 à 10 A par phase, sans décimale/);
  }
  assert.equal(writes(b).length, 0);
});

test('Wattpilot pause remains available with missing cable limits or an absent car while starting stays disabled', async () => {
  for (const change of [{ limits: { minCurrentAmps: 6, maxCurrentAmps: null } }, { carConnected: false }]) {
    const b = browser();
    const active = { ...snapshot(), car: carState({ available: false, canPause: true, ...change }) };
    await b.complete(active);
    assert.equal(b.get('car-control-fields').disabled, true);
    assert.equal(b.get('car-charge').disabled, true);
    assert.equal(b.get('car-eco').disabled, true);
    assert.equal(b.get('car-pause').disabled, false);
    b.get('car-current').value = 'invalid';
    b.get('car-pause').listeners.get('click')!();
    assert.deepEqual(JSON.parse(writes(b)[0].options.body!), { mode: 'pause' });
    await b.complete({ success: true });
    await b.complete(active);
  }
});

test('unavailable or malformed Wattpilot data never disables a healthy battery or permits a car command', async () => {
  const cases = [null, {}, carState({ mode: 'auto' }), carState({ limits: { minCurrentAmps: 1, maxCurrentAmps: 16 } }),
    carState({ limits: { minCurrentAmps: 6, maxCurrentAmps: 32 } }), carState({ powerKw: -1 }),
    carState({ available: true, carConnected: false }), carState({ available: true, mode: 'unknown' })];
  for (const car of cases) {
    const b = browser();
    await b.complete({ ...snapshot(), car });
    assert.equal(b.get('battery-charge').disabled, false);
    assert.equal(b.get('battery-mode').textContent, 'GEN24 · auto');
    assert.equal(b.get('car-charge').disabled, true);
    assert.equal(b.get('car-pause').disabled, true);
    b.submit('car');
    b.get('car-pause').listeners.get('click')!();
    assert.equal(writes(b).length, 0);
  }
  for (const error of ['Mesures Wattpilot anciennes.', 'Wattpilot indisponible.', 'Pilotage Wattpilot désactivé.']) {
    const b = browser();
    await b.complete({ ...snapshot(), car: carState({ available: false, canPause: false, mode: 'unknown', error }) });
    assert.equal(b.get('car-control-note').textContent, error);
    assert.equal(b.get('car-charge').disabled, true);
    assert.equal(b.get('car-pause').disabled, true);
    assert.equal(b.get('battery-charge').disabled, false);
  }
});

test('a Wattpilot timeout has an unknown outcome, refreshes status and never resends the command', async () => {
  const b = browser();
  const active = { ...snapshot(), car: carState() };
  await b.complete(active);
  b.submit('car');
  b.fireTimer(50000);
  await tick();
  assert.equal(writes(b)[0].options.signal.aborted, true);
  assert.match(b.get('car-feedback').textContent, /Résultat inconnu.*Aucun renvoi automatique/);
  assert.equal(b.get('car-mode').textContent, 'Inconnu');
  await b.complete(active);
  assert.equal(b.get('car-charge').disabled, false);
  b.fireTimer(10000);
  await b.complete(active);
  assert.equal(writes(b).length, 1);
});

test('hidden Wattpilot controls require a fresh visible snapshot and a stale poll cannot overwrite reconciliation', async () => {
  const b = browser();
  const active = { ...snapshot(), car: carState() };
  await b.complete(active);
  b.document.hidden = true; b.events.get('visibilitychange')!();
  assert.equal(b.get('car-pause').disabled, true);
  b.submit('car');
  assert.equal(writes(b).length, 0);
  b.document.hidden = false; b.events.get('visibilitychange')!();
  assert.equal(b.get('car-charge').disabled, true);
  await b.complete(active);
  assert.equal(b.get('car-charge').disabled, false);
  b.fireTimer(10000);
  const old = b.requests.length - 1;
  let finish!: (value: unknown) => void;
  b.requests[old].resolve({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) } as Response);
  await tick();
  b.get('car-pause').listeners.get('click')!();
  assert.equal(b.requests[old].options.signal.aborted, true);
  await b.complete({ success: true });
  await b.complete({ ...active, car: carState({ mode: 'pause' }) });
  finish(active); await tick();
  assert.equal(b.get('car-mode').textContent, 'Pause · 6 A');
  assert.equal(writes(b).length, 1);
});

test('estimated charging power updates from chosen current and phases without sending commands', async () => {
  const b = browser();
  await b.complete({ ...snapshot(), car: carState({ phaseMode: 3, phaseSwitchingSupported: true }) });
  assert.match(b.get('car-current-hint').textContent, /^Puissance de charge estimée : ≈ 4[,.]14 kW$/);
  b.get('car-current').value = '16';
  b.get('car-current').listeners.get('input')!();
  assert.match(b.get('car-current-hint').textContent, /11[,.]04 kW$/);
  b.get('car-phases').value = '1';
  b.get('car-phases').listeners.get('change')!();
  assert.match(b.get('car-current-hint').textContent, /3[,.]68 kW$/);
  b.get('car-current').value = '6';
  b.get('car-current').listeners.get('input')!();
  assert.match(b.get('car-current-hint').textContent, /1[,.]38 kW$/);
  for (const value of ['', '0', '17', '6.5', 'invalid']) {
    b.get('car-current').value = value;
    b.get('car-current').listeners.get('input')!();
    assert.equal(b.get('car-current-hint').textContent, 'Puissance de charge estimée : —');
  }
  assert.match(b.get('car-mode').textContent, /3 phases/);
  assert.equal(writes(b).length, 0);
});

test('manual Wattpilot commands send selected phases while showing the confirmed configuration', async () => {
  const markup = readFileSync(new URL('../public/pages/controls.html', import.meta.url), 'utf8');
  assert.match(markup, /<select[^>]*id="car-phases"[^>]*name="phases"/);
  assert.match(markup, /<option value="1">1 phase<\/option><option value="3" selected>3 phases<\/option>/);
  for (const [mode, selected, reported] of [['normal', 1, 3], ['eco', 3, 1]] as const) {
    const b = browser();
    await b.complete({ ...snapshot(), car: carState({ mode: 'normal', phaseMode: reported, phaseSwitchingSupported: true }) });
    assert.equal(b.get('car-phases').value, String(reported));
    assert.equal(b.get('car-phases').disabled, false);
    b.get('car-phases').value = String(selected);
    b.get('car-phases').listeners.get('change')!();
    assert.match(b.get('car-mode').textContent, new RegExp(`${reported} phase`));
    if (mode === 'normal') b.submit('car');
    else b.get('car-eco').listeners.get('click')!();
    assert.deepEqual(JSON.parse(writes(b)[0]!.options.body!), { mode, currentAmps: 6, phases: selected });
    assert.equal(b.get('car-phases').disabled, true);
    assert.ok([...b.timers.values()].some(timer => timer.milliseconds === 50000));
    await b.complete({ success: true });
    await b.complete({ ...snapshot(), car: carState({ mode, phaseMode: selected, phaseSwitchingSupported: true }) });
    assert.equal(b.get('car-phases').value, String(selected));
    assert.match(b.get('car-mode').textContent, new RegExp(`${selected} phase`));
    assert.equal(writes(b).length, 1);
  }
});

test('phase selection initializes on first available forced configuration and preserves edits across polls', async () => {
  const b = browser();
  await b.complete({ ...snapshot(), car: carState({ available: false, canPause: false, mode: 'unknown', phaseMode: 1, phaseSwitchingSupported: true }) });
  assert.equal(b.get('car-phases').disabled, true);
  assert.equal(b.get('car-phases').value, '3');
  b.fireTimer(10000);
  await b.complete({ ...snapshot(), car: carState({ phaseMode: 1, phaseSwitchingSupported: true }) });
  assert.equal(b.get('car-phases').value, '1');
  b.get('car-phases').value = '3';
  b.get('car-phases').listeners.get('change')!();
  b.fireTimer(10000);
  await b.complete({ ...snapshot(), car: carState({ phaseMode: 1, phaseSwitchingSupported: true }) });
  assert.equal(b.get('car-phases').value, '3');
  assert.match(b.get('car-mode').textContent, /1 phase/);
  b.document.hidden = true; b.events.get('visibilitychange')!();
  assert.equal(b.get('car-phases').disabled, true);
  b.document.hidden = false; b.events.get('visibilitychange')!();
  await b.complete({ ...snapshot(), car: carState({ phaseMode: 1, phaseSwitchingSupported: true }) });
  assert.equal(b.get('car-phases').value, '3');
  assert.equal(writes(b).length, 0);
});

test('automatic phase configuration does not pretend the default manual selection is applied', async () => {
  const b = browser();
  await b.complete({ ...snapshot(), car: carState({ phaseMode: 'auto', phaseSwitchingSupported: true }) });
  assert.equal(b.get('car-phases').value, '3');
  assert.match(b.get('car-mode').textContent, /Phases auto/);
  assert.doesNotMatch(b.get('car-mode').textContent, /3 phases/);
  b.get('car-phases').value = '1';
  b.get('car-phases').listeners.get('change')!();
  b.fireTimer(10000);
  await b.complete({ ...snapshot(), car: carState({ phaseMode: 3, phaseSwitchingSupported: true }) });
  assert.equal(b.get('car-phases').value, '1');
  assert.match(b.get('car-mode').textContent, /3 phases/);
});

test('unsupported or malformed phase capabilities keep current-only commands', async () => {
  for (const phases of [{}, { phaseMode: null, phaseSwitchingSupported: false },
    { phaseMode: 2, phaseSwitchingSupported: true }, { phaseMode: '1', phaseSwitchingSupported: true },
    { phaseMode: 1, phaseSwitchingSupported: 'true' }]) {
    const b = browser();
    await b.complete({ ...snapshot(), car: carState(phases) });
    assert.equal(b.get('car-phases').disabled, true);
    assert.equal(b.get('car-charge').disabled, false);
    b.submit('car');
    assert.deepEqual(JSON.parse(writes(b)[0]!.options.body!), { mode: 'normal', currentAmps: 6 });
  }
});

test('invalid phase selections never start charging and pause never sends phases', async () => {
  for (const value of ['2', '0', '', 'NaN', 'trois']) {
    const b = browser();
    await b.complete({ ...snapshot(), car: carState({ phaseMode: 3, phaseSwitchingSupported: true }) });
    b.get('car-phases').value = value;
    b.submit('car');
    b.get('car-eco').listeners.get('click')!();
    assert.equal(writes(b).length, 0, value);
    assert.match(b.get('car-feedback').textContent, /1 phase ou 3 phases/);
    b.get('car-pause').listeners.get('click')!();
    assert.deepEqual(JSON.parse(writes(b)[0]!.options.body!), { mode: 'pause' });
  }
});
