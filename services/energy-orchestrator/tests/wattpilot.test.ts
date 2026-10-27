import test from 'node:test';
import assert from 'node:assert/strict';
import { createWattpilotService, toCarControl, unavailableWattpilot, validateWattpilotCommand,
  WattpilotControlError, type WattpilotOptions, type WattpilotTelemetry } from '../src/wattpilot.js';

const at = '2026-10-25T20:00:00.000Z';
function state(overrides: Partial<WattpilotTelemetry> = {}): WattpilotTelemetry {
  return { status: 'online', configured: true, connected: true, ready: true, stale: false,
    observedAt: at, powerObservedAt: at, error: null, controlEnabled: true, mode: 'eco',
    carConnected: true, charging: false, allowedCharging: false, currentAmps: 14, powerWatts: 0,
    phaseMode: 'auto', phaseSwitchingSupported: true,
    sessionEnergyWh: 30, totalEnergyWh: 10_000, energyCounterSource: 'Wattpilot:test', limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false, automation: null,
    ...overrides };
}
interface Call { path: string; method: string; body: unknown; signal: AbortSignal | null | undefined }
function fixture(options: WattpilotOptions = {}, respond?: (call: Call) => Response | Promise<Response>) {
  let clock = Date.parse(at);
  let current = state();
  const calls: Call[] = [];
  const service = createWattpilotService({ controllerUrl: 'http://controller.test/base/', now: () => new Date(clock),
    fetch: async (url, init) => {
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.cache, 'no-store');
      const call = { path: new URL(String(url)).pathname, method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null, signal: init?.signal };
      calls.push(call);
      if (respond) return respond(call);
      if (call.method === 'POST') {
        const command = call.body as { phases?: 1 | 3 };
        current = { ...current, ...call.body as object, ...(command.phases === undefined ? {} : { phaseMode: command.phases }) };
      }
      return Response.json({ success: true, wattpilot: current });
    }, ...options });
  return { service, calls, advance(milliseconds: number) { clock += milliseconds; }, set(value: Partial<WattpilotTelemetry>) { current = { ...current, ...value }; } };
}
const posts = (calls: Call[]) => calls.filter(call => call.method === 'POST');

test('monitoring uses only the shared controller HTTP endpoint and deduplicates short-lived reads', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.service.readStatus(), f.service.readStatus()]);
  assert.deepEqual(first, state());
  assert.deepEqual(second, state());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/base/wattpilot/status');
  await f.service.readStatus();
  assert.equal(f.calls.length, 1);
  f.advance(2000);
  await f.service.readStatus();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('an absent controller stays unconfigured without making requests', async () => {
  const f = fixture({ controllerUrl: null });
  assert.deepEqual(await f.service.readStatus(), unavailableWattpilot());
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.setControl({ mode: 'pause' }), /non configuré/);
  assert.equal(f.calls.length, 0);
});

test('malformed core responses fail closed without exposing upstream properties or errors', async () => {
  for (const payload of [null, { success: true }, { success: false, wattpilot: state() },
    { success: true, wattpilot: { ...state(), ready: 'true' } },
    { success: true, wattpilot: { ...state(), observedAt: null } },
    { success: true, wattpilot: { ...state(), configured: false } },
    { success: true, wattpilot: { ...state(), stale: true } },
    { success: true, wattpilot: { ...state(), limits: {} } },
    { success: true, wattpilot: { ...state(), deviceLeaseSupported: true } },
  ]) {
    const f = fixture({}, () => Response.json(payload));
    const result = await f.service.readStatus();
    assert.equal(result.status, 'offline');
    assert.equal(result.ready, false);
    assert.equal(result.powerWatts, null);
    assert.match(result.error!, /invalide/);
  }
  const f = fixture({}, () => Response.json({ success: true, wattpilot: { ...state({ status: 'error', ready: false, error: 'secret-password' }), password: 'secret-password' } }));
  assert.doesNotMatch(JSON.stringify(await f.service.readStatus()), /secret-password/);
});

test('invalid and future observation dates never appear online', async () => {
  for (const observedAt of ['nonsense', '2026-02-30T12:00:00Z', '2026-10-24T24:00:00Z', '2026-10-25T20:00:06Z', '2026-10-25']) {
    const f = fixture(); f.set({ observedAt });
    assert.equal((await f.service.readStatus()).status, 'offline', observedAt);
  }
});

test('stale telemetry stays unknown for control and does not invent zero power', async () => {
  const f = fixture();
  f.advance(30_001);
  const result = await f.service.readStatus();
  assert.equal(result.status, 'stale');
  assert.equal(result.powerWatts, null);
  assert.equal(result.ready, false);
  assert.equal(toCarControl(result).canPause, false);
  await assert.rejects(f.service.setControl({ mode: 'pause' }), /anciennes/);
  assert.equal(posts(f.calls).length, 0);
});

test('power has its own freshness and cannot be renewed by an unrelated status update', async () => {
  const f = fixture();
  f.advance(31_000);
  f.set({ observedAt: '2026-10-25T20:00:31.000Z', powerWatts: 3000 });
  const result = await f.service.readStatus();
  assert.equal(result.status, 'online');
  assert.equal(result.powerWatts, null);
  assert.equal(result.powerObservedAt, at);
  assert.equal(toCarControl(result).powerKw, null);
  for (const powerObservedAt of [null, 'bad', '2026-10-25T20:01:00Z']) {
    f.set({ powerObservedAt });
    assert.equal((await f.service.readStatus({ fresh: true })).powerWatts, null);
  }
});

test('missing or invalid measurements remain null while zero remains a valid measurement', async () => {
  const f = fixture({}, () => Response.json({ success: true, wattpilot: { ...state(), powerWatts: -1,
    carConnected: 'yes', charging: 1, allowedCharging: null, currentAmps: 5,
    sessionEnergyWh: '3', totalEnergyWh: null } }));
  const result = await f.service.readStatus();
  for (const key of ['powerWatts', 'carConnected', 'charging', 'allowedCharging', 'currentAmps', 'sessionEnergyWh', 'totalEnergyWh'] as const) assert.equal(result[key], null);
  assert.equal((await fixture().service.readStatus()).powerWatts, 0);
});

test('read errors retain previous measurements explicitly stale without a live car-power flow', async () => {
  let failing = false;
  const f = fixture({}, () => {
    if (failing) throw new Error('secret upstream detail');
    return Response.json({ success: true, wattpilot: state({ powerWatts: 3000 }) });
  });
  await f.service.readStatus();
  failing = true; f.advance(2000);
  const result = await f.service.readStatus();
  assert.equal(result.status, 'stale');
  assert.equal(result.ready, false);
  assert.equal(result.currentAmps, 14);
  assert.equal(result.observedAt, at);
  assert.equal(result.powerWatts, null);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('commands reject old power/SOC/auto contracts and invalid currents before any controller request', async () => {
  const f = fixture();
  for (const command of [null, [], {}, { mode: 'auto' }, { mode: 'manual', powerKw: 3 },
    { mode: 'pause', currentAmps: 6 }, { mode: 'normal' }, { mode: 'normal', currentAmps: null },
    { mode: 'normal', currentAmps: '6' }, { mode: 'normal', currentAmps: 5 }, { mode: 'normal', currentAmps: 17 },
    { mode: 'normal', currentAmps: 6.5 }, { mode: 'normal', currentAmps: Infinity },
    { mode: 'pause', phases: 1 }, { mode: 'normal', currentAmps: 6, phases: 2 },
    { mode: 'normal', currentAmps: 6, phases: 0 }, { mode: 'normal', currentAmps: 6, phases: '1' },
    { mode: 'normal', currentAmps: 6, phases: null },
    { mode: 'normal', currentAmps: 6, targetSocPercent: 80 }, { mode: 'normal', currentAmps: 6, powerKw: 1.4 }]) {
    assert.throws(() => validateWattpilotCommand(command), error => error instanceof WattpilotControlError && error.status === 400);
  }
  await assert.rejects(f.service.setControl({ mode: 'normal', currentAmps: 17 }), error => error instanceof WattpilotControlError && error.status === 400);
  assert.equal(f.calls.length, 0);
});

test('phase selection passes through and requires the matching confirmed controller selection', async () => {
  const f = fixture();
  for (const phases of [1, 3] as const) {
    const status = await f.service.setControl({ mode: 'normal', currentAmps: 6, phases });
    assert.equal(status.phaseMode, phases);
    assert.equal(toCarControl(status).phaseMode, phases);
    assert.equal(toCarControl(status).phaseSwitchingSupported, true);
  }
  assert.deepEqual(posts(f.calls).map(call => call.body), [
    { mode: 'normal', currentAmps: 6, phases: 1 }, { mode: 'normal', currentAmps: 6, phases: 3 },
  ]);
  const wrong = fixture({}, call => Response.json({ success: true,
    wattpilot: state(call.method === 'POST' ? { mode: 'normal', currentAmps: 6, phaseMode: 3 } : {}) }));
  await assert.rejects(wrong.service.setControl({ mode: 'normal', currentAmps: 6, phases: 1 }),
    error => error instanceof WattpilotControlError && error.unknownOutcome);
  assert.equal(posts(wrong.calls).length, 1);
});

test('unknown phase capability preserves current-only operation and refuses an explicit phase choice', async () => {
  for (const changes of [{ phaseMode: undefined, phaseSwitchingSupported: undefined },
    { phaseMode: 2, phaseSwitchingSupported: true }, { phaseMode: 1, phaseSwitchingSupported: false },
    { phaseMode: '1', phaseSwitchingSupported: true }]) {
    const f = fixture({}, call => Response.json({ success: true,
      wattpilot: { ...state(), ...changes, ...(call.method === 'POST' ? call.body as object : {}) } }));
    const status = await f.service.readStatus();
    assert.equal(status.phaseMode, null);
    assert.equal(status.phaseSwitchingSupported, false);
    await assert.rejects(f.service.setControl({ mode: 'normal', currentAmps: 6, phases: 1 }), /phases/);
    assert.equal(posts(f.calls).length, 0);
    assert.equal((await f.service.setControl({ mode: 'normal', currentAmps: 6 })).mode, 'normal');
  }
});

test('normal and eco commands verify readiness and current limits, then check headroom before one write', async () => {
  const order: string[] = [];
  const f = fixture({ beforeStart: async (command, observed) => {
    order.push('headroom'); assert.equal(command.currentAmps, 6); assert.equal(observed.ready, true);
  } });
  for (const mode of ['normal', 'eco'] as const) {
    const result = await f.service.setControl({ mode, currentAmps: 6 });
    assert.equal(result.mode, mode);
    assert.equal(result.currentAmps, 6);
  }
  assert.deepEqual(posts(f.calls).map(call => call.body), [{ mode: 'normal', currentAmps: 6 }, { mode: 'eco', currentAmps: 6 }]);
  assert.ok(posts(f.calls).every(call => call.path === '/base/wattpilot/set-control'));
  assert.equal(order.length, 2);
});

test('disabled control, missing limits and absent vehicle reject starting without a write', async () => {
  for (const change of [{ controlEnabled: false }, { carConnected: false }, { carConnected: null },
    { limits: { minCurrentAmps: 6 as const, maxCurrentAmps: null } },
    { limits: { minCurrentAmps: 6 as const, maxCurrentAmps: 6 } },
  ]) {
    const f = fixture(); f.set(change);
    await assert.rejects(f.service.setControl({ mode: 'normal', currentAmps: 10 }));
    assert.equal(posts(f.calls).length, 0);
  }
});

test('pause remains available without a vehicle or cable limit and skips headroom', async () => {
  const f = fixture({ beforeStart: async () => { throw new Error('pause must not read GEN24'); } });
  f.set({ carConnected: false, limits: { minCurrentAmps: 6, maxCurrentAmps: null } });
  const control = toCarControl(await f.service.readStatus());
  assert.equal(control.available, false);
  assert.equal(control.canPause, true);
  assert.equal((await f.service.setControl({ mode: 'pause' })).mode, 'pause');
  assert.deepEqual(posts(f.calls)[0].body, { mode: 'pause' });
});

test('a headroom refusal stops before the device mutation', async () => {
  const f = fixture({ beforeStart: async () => { throw new WattpilotControlError('Limite réseau atteinte', 409); } });
  await assert.rejects(f.service.setControl({ mode: 'normal', currentAmps: 6 }), /Limite réseau/);
  assert.equal(posts(f.calls).length, 0);
});

test('controller refusals preserve definite versus unknown outcomes without exposing upstream text', async () => {
  for (const [status, outcome, unknown] of [[400, undefined, false], [409, undefined, false], [409, 'unknown', true], [503, 'unknown', true]] as const) {
    const f = fixture({}, call => call.method === 'GET' ? Response.json({ success: true, wattpilot: state() })
      : Response.json({ error: 'secret controller error', ...(outcome ? { outcome } : {}) }, { status }));
    await assert.rejects(f.service.setControl({ mode: 'pause' }), error => {
      assert.ok(error instanceof WattpilotControlError);
      assert.equal(error.status, status);
      assert.equal(error.unknownOutcome, unknown);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.equal(posts(f.calls).length, 1);
  }
});

test('unconfirmed or mismatched successful responses remain unknown and never retry', async () => {
  for (const payload of [{ success: true }, { success: false }, { success: true, wattpilot: state() },
    { success: true, wattpilot: state({ mode: 'normal', currentAmps: 7 }) }]) {
    const f = fixture({}, call => Response.json(call.method === 'GET' ? { success: true, wattpilot: state() } : payload));
    await assert.rejects(f.service.setControl({ mode: 'normal', currentAmps: 6 }), error => error instanceof WattpilotControlError && error.unknownOutcome);
    assert.equal(posts(f.calls).length, 1);
  }
});

test('a timed-out read is bounded even if a fetch mock ignores AbortSignal', async () => {
  const f = fixture({ readTimeoutMs: 5 }, () => new Promise(() => {}));
  const result = await f.service.readStatus();
  assert.equal(result.status, 'offline');
  assert.match(result.error!, /expiré/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal!.aborted, true);
});

test('a timed-out write reports unknown outcome once and invalidates the status cache', async () => {
  const f = fixture({ writeTimeoutMs: 5 }, call => call.method === 'GET'
    ? Response.json({ success: true, wattpilot: state() }) : new Promise(() => {}));
  await assert.rejects(f.service.setControl({ mode: 'pause' }), error => error instanceof WattpilotControlError && error.status === 504 && error.unknownOutcome);
  assert.equal(posts(f.calls).length, 1);
  assert.equal(posts(f.calls)[0].signal!.aborted, true);
  await f.service.readStatus();
  assert.equal(f.calls.filter(call => call.method === 'GET').length, 2);
});

test('already-cancelled commands and cancellation while waiting for state never write', async () => {
  const stopped = new AbortController(); stopped.abort();
  const f = fixture();
  await assert.rejects(f.service.setControl({ mode: 'pause' }, stopped.signal), error => error instanceof WattpilotControlError && error.status === 409 && !error.unknownOutcome);
  assert.equal(f.calls.length, 0);
  let release!: (value: Response) => void;
  const waiting = fixture({}, () => new Promise<Response>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const command = waiting.service.setControl({ mode: 'pause' }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(command, error => error instanceof WattpilotControlError && error.status === 409 && !error.unknownOutcome);
  release(Response.json({ success: true, wattpilot: state() }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posts(waiting.calls).length, 0);
});

test('cancellation during headroom prevents a delayed device write', async () => {
  const controller = new AbortController();
  const f = fixture({ beforeStart: async () => { controller.abort(); } });
  await assert.rejects(f.service.setControl({ mode: 'normal', currentAmps: 6 }, controller.signal), error => error instanceof WattpilotControlError && error.status === 409 && !error.unknownOutcome);
  assert.equal(posts(f.calls).length, 0);
});

test('cancellation after sending reports unknown outcome and aborts the controller request', async () => {
  let sent!: () => void;
  const writing = new Promise<void>(resolve => { sent = resolve; });
  const f = fixture({}, call => {
    if (call.method === 'GET') return Response.json({ success: true, wattpilot: state() });
    sent(); return new Promise(() => {});
  });
  const controller = new AbortController();
  const command = f.service.setControl({ mode: 'pause' }, controller.signal);
  await writing;
  controller.abort();
  await assert.rejects(command, error => error instanceof WattpilotControlError && error.status === 409 && error.unknownOutcome);
  assert.equal(posts(f.calls).length, 1);
  assert.equal(posts(f.calls)[0].signal!.aborted, true);
});

test('overlapping commands are rejected instead of queuing stale intentions', async () => {
  let release!: (value: Response) => void;
  const f = fixture({}, call => call.method === 'GET' ? Response.json({ success: true, wattpilot: state() })
    : new Promise(resolve => { release = resolve; }));
  const first = f.service.setControl({ mode: 'pause' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.setControl({ mode: 'normal', currentAmps: 6 }), error => error instanceof WattpilotControlError && error.status === 409);
  release(Response.json({ success: true, wattpilot: state({ mode: 'pause' }) }));
  await first;
  assert.equal(posts(f.calls).length, 1);
});

test('an old in-flight status response cannot repopulate the cache after a command', async () => {
  let release!: (value: Response) => void;
  let reads = 0;
  const f = fixture({}, call => {
    if (call.method === 'POST') return Response.json({ success: true, wattpilot: state({ mode: 'pause' }) });
    reads++;
    return reads === 1 ? new Promise(resolve => { release = resolve; })
      : Response.json({ success: true, wattpilot: state({ mode: 'pause' }) });
  });
  const old = f.service.readStatus();
  await f.service.setControl({ mode: 'pause' });
  release(Response.json({ success: true, wattpilot: state({ mode: 'normal' }) }));
  await old;
  assert.equal((await f.service.readStatus()).mode, 'pause');
  assert.equal(reads, 3);
});

test('owned Eco activates without a car, Tesla SOC or phase capability and skips Normal preflight', async () => {
  const request = { owner: 'owner', epoch: 'epoch', revision: 1, mode: 'eco' as const,
    currentAmps: 6, expiresAt: '2026-10-25T20:01:00.000Z' };
  const automation = { supported: true as const, owner: 'owner', epoch: 'epoch', revision: null,
    lastRevision: 0, expiresAt: null, active: false, stopping: false, manualOverride: false,
    fence: 1, error: null, deviceExpirySupported: false as const };
  const f = fixture({ beforeStart: async () => { throw new Error('Eco must not use the forced-charge preflight'); } }, call =>
    Response.json({ success: true, wattpilot: state({ carConnected: false, phaseMode: null, phaseSwitchingSupported: false,
      currentAmps: 6, limits: { minCurrentAmps: 6, maxCurrentAmps: null }, mode: call.method === 'POST' ? 'eco' : 'pause',
      automation: call.method === 'POST' ? { ...automation, active: true, revision: 1, lastRevision: 1, expiresAt: request.expiresAt } : automation }) }));
  const result = await f.service.activateAutomation(request);
  assert.equal(result.mode, 'eco');
  assert.equal(result.carConnected, false);
  assert.deepEqual(posts(f.calls).map(call => call.body), [request]);
});

test('an Eco activation still requires the configured mode echo and never replays an ambiguous response', async () => {
  const request = { owner: 'owner', epoch: 'epoch', revision: 1, mode: 'eco' as const,
    currentAmps: 6, expiresAt: '2026-10-25T20:01:00.000Z' };
  const automation = { supported: true as const, owner: 'owner', epoch: 'epoch', revision: null,
    lastRevision: 0, expiresAt: null, active: false, stopping: false, manualOverride: false,
    fence: 1, error: null, deviceExpirySupported: false as const };
  const f = fixture({}, call => Response.json({ success: true, wattpilot: state({ mode: 'normal', currentAmps: 6,
    automation: call.method === 'POST' ? { ...automation, active: true, revision: 1, lastRevision: 1, expiresAt: request.expiresAt } : automation }) }));
  await assert.rejects(f.service.activateAutomation(request), error => error instanceof WattpilotControlError && error.unknownOutcome);
  assert.equal(posts(f.calls).length, 1);
});
