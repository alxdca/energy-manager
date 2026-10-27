import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWattpilotAutomation, type WattpilotAutomaticCommand } from '../src/devices/wattpilot-automation.js';
import { WattpilotError, type WattpilotCommand, type WattpilotStatus } from '../src/devices/wattpilot.js';

const origin = Date.parse('2026-10-25T20:00:00.000Z');
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(path: string | null = null) {
  let clock = origin;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  const writes: WattpilotCommand[] = [];
  let offline = false, pauseFailure = false, stalePower = false;
  let activationGate: Promise<void> | null = null;
  let stopProof = true;
  let activationUnknown = false;
  let closed = 0;
  let status: WattpilotStatus = {
    status: 'online', configured: true, connected: true, ready: true, stale: false,
    observedAt: new Date(clock).toISOString(), powerObservedAt: new Date(clock).toISOString(),
    error: null, controlEnabled: true, mode: 'pause', carConnected: true, charging: false,
    allowedCharging: false, currentAmps: 6, phaseMode: 3, phaseSwitchingSupported: true,
    powerWatts: 0, sessionEnergyWh: 0, totalEnergyWh: 10,
    limits: { minCurrentAmps: 6, maxCurrentAmps: 16 }, deviceLeaseSupported: false,
  };
  const device = {
    async readStatus() {
      return { ...status, observedAt: new Date(clock).toISOString(),
        powerObservedAt: new Date(stalePower ? clock - 60_000 : clock).toISOString(),
        ...(offline ? { status: 'offline' as const, connected: false, ready: false } : {}) };
    },
    async setControl(command: WattpilotCommand, signal?: AbortSignal) {
      writes.push(command);
      if (offline || command.mode === 'pause' && pauseFailure) throw new WattpilotError('fake device unavailable', 503, 'unknown');
      if (command.mode === 'normal' && activationGate) {
        status = { ...status, mode: 'pause', charging: false, allowedCharging: false, powerWatts: 0 };
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new WattpilotError('fake activation cancelled', 409, 'unknown'));
          signal?.addEventListener('abort', aborted, { once: true });
          activationGate!.then(resolve, reject).finally(() => signal?.removeEventListener('abort', aborted));
          if (signal?.aborted) aborted();
        });
      }
      if (signal?.aborted) throw new WattpilotError('fake request cancelled', 409, 'unknown');
      if (command.mode === 'normal' && activationUnknown) throw new WattpilotError('fake final resume acknowledgement lost', 504, 'unknown');
      status = { ...status, mode: command.mode, currentAmps: command.currentAmps ?? status.currentAmps,
        phaseMode: command.phases ?? status.phaseMode,
        charging: command.mode !== 'pause', allowedCharging: command.mode !== 'pause', powerWatts: command.mode === 'pause' ? 0 : 4140 };
      return this.readStatus();
    },
    async pauseAndConfirm(signal?: AbortSignal) {
      const observed = await this.setControl({ mode: 'pause' }, signal);
      if (!stopProof) throw new WattpilotError('fake no post-pause stopped observation', 504, 'unknown');
      return observed;
    },
    async disconnect() { closed++; },
  };
  const supervisor = createWattpilotAutomation({ device: () => device, journalPath: path, now: () => clock,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimer(handle) { timers.delete(handle as number); },
  });
  async function authorize(owner = 'orchestrator') {
    const result = await supervisor.establish({ owner, expectedFence: supervisor.status().fence });
    assert.ok(result.automation.epoch);
    return { owner, epoch: result.automation.epoch };
  }
  const command = (session: { owner: string; epoch: string }, revision = 1, seconds = 90): WattpilotAutomaticCommand => ({
    ...session, revision, expiresAt: new Date(clock + seconds * 1000).toISOString(), mode: 'normal', currentAmps: 6, phases: 3,
  });
  async function advance(milliseconds: number) {
    const end = clock + milliseconds;
    while (timers.size) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]!;
      if (first[1].at > end) break;
      timers.delete(first[0]); clock = first[1].at; first[1].callback(); await settle();
    }
    clock = end; await settle();
  }
  return { supervisor, device, writes, timers, authorize, command, advance,
    setStatus(change: Partial<WattpilotStatus>) { status = { ...status, ...change }; },
    setOffline(value: boolean) { offline = value; }, setPauseFailure(value: boolean) { pauseFailure = value; },
    setStalePower(value: boolean) { stalePower = value; }, setGate(value: Promise<void> | null) { activationGate = value; },
    setStopProof(value: boolean) { stopProof = value; }, setActivationUnknown(value: boolean) { activationUnknown = value; },
    get closed() { return closed; }, get clock() { return clock; },
    async close() { offline = false; pauseFailure = false; stalePower = false; activationGate = null; stopProof = true; activationUnknown = false; await supervisor.shutdown(); },
  };
}

test('passive construction and status reads never issue commands or establish automatic ownership', async () => {
  const f = fixture();
  const status = await f.supervisor.readStatus();
  assert.equal(status.automation.manualOverride, true);
  assert.equal(status.automation.epoch, null);
  assert.equal(status.automation.deviceExpirySupported, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.timers.size, 0);
  await f.close();
});

test('automatic command inputs are rejected before a device is created', async () => {
  let devices = 0;
  const supervisor = createWattpilotAutomation({ journalPath: null, device() { devices++; throw new Error('No access'); }, now: () => origin });
  const request = { owner: 'owner', epoch: 'epoch', revision: 1, expiresAt: new Date(origin + 90_000).toISOString(), mode: 'normal', currentAmps: 6 };
  for (const patch of [{ owner: '' }, { epoch: null }, { revision: 0 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: 'invalid' }, { expiresAt: new Date(origin).toISOString() }, { expiresAt: new Date(origin + 120_001).toISOString() },
    { expiresAt: '2026-10-25T21:01:00+01:00' }, { mode: 'invalid' }, { currentAmps: 5 }, { currentAmps: 17 }, { currentAmps: '6' },
    { phases: 2 }, { phases: null }, { unexpected: true }]) {
    await assert.rejects(supervisor.control({ ...request, ...patch }), error => error instanceof WattpilotError && error.statusCode === 400);
  }
  for (const value of [{ owner: 'owner' }, { owner: 'owner', expectedFence: -1 }, { owner: 'owner', expectedFence: 0, extra: true }]) {
    await assert.rejects(supervisor.establish(value), error => error instanceof WattpilotError && error.statusCode === 400);
  }
  assert.equal(devices, 0);
  await supervisor.shutdown();
});

test('activation checkpoint is durable before charging; renewal performs no setting writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wattpilot-lease-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const f = fixture(path); t.after(() => f.close());
  const session = await f.authorize();
  let release!: () => void;
  f.setGate(new Promise(resolve => { release = resolve; }));
  const command = f.command(session);
  const activating = f.supervisor.control(command);
  await settle();
  await settle();
  // Wait for the private journal fsync/rename rather than assuming one event loop turn.
  let saved: any;
  for (let i = 0; i < 100; i++) {
    saved = JSON.parse(await readFile(path, 'utf8'));
    if (saved.lease) break;
    await settle();
  }
  assert.equal(saved.lastRevision, 1);
  assert.equal(saved.lease.active, false);
  assert.equal(saved.lease.expected.mode, 'normal');
  release();
  assert.equal((await activating).automation.active, true);
  f.setGate(null);
  const count = f.writes.length;
  const renewed = await f.supervisor.renew({ ...session, revision: 1, expiresAt: new Date(f.clock + 120_000).toISOString() });
  assert.equal(renewed.automation.active, true);
  assert.equal(f.writes.length, count);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).lease.expiresAt, renewed.automation.expiresAt);
});

test('owned Eco can operate unplugged with an unknown cable ceiling and renew without changing settings', async t => {
  const f = fixture(); t.after(() => f.close());
  f.setStatus({carConnected: false, limits: {minCurrentAmps: 6, maxCurrentAmps: null}});
  const session = await f.authorize();
  const status = await f.supervisor.control({...f.command(session), mode: 'eco'});
  assert.equal(status.mode, 'eco');
  assert.equal(status.automation.active, true);
  const count = f.writes.length;
  await f.supervisor.renew({...session, revision: 1, expiresAt: new Date(f.clock + 120_000).toISOString()});
  assert.equal(f.writes.length, count);
});

test('an owned Eco fingerprint survives journal parsing and is reconciled on restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wattpilot-eco-restart-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'journal.json');
  const first = fixture(path);
  const session = await first.authorize();
  await first.supervisor.control({...first.command(session), mode: 'eco'});
  const crashed = join(directory, 'crashed.json');
  await writeFile(crashed, await readFile(path));
  await first.close();
  const second = fixture(crashed); t.after(() => second.close());
  second.setStatus({mode: 'eco', charging: false, allowedCharging: false, powerWatts: 0});
  await second.supervisor.start();
  assert.equal(second.supervisor.status().error, null);
  assert.equal(second.supervisor.status().epoch, session.epoch);
  assert.equal(second.supervisor.status().revision, null);
  assert.deepEqual(second.writes, [{mode: 'pause'}]);
});

test('controller expiry pauses at its deadline independently of the orchestrator', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  await f.supervisor.control(f.command(session, 1, 20));
  await f.advance(19_999);
  assert.equal(f.writes.filter(value => value.mode === 'pause').length, 0);
  await f.advance(1);
  assert.equal(f.writes.filter(value => value.mode === 'pause').length, 1);
  assert.equal((await f.supervisor.readStatus()).automation.active, false);
  assert.equal(f.supervisor.status().revision, null);
  await assert.rejects(f.supervisor.renew({ ...session, revision: 1, expiresAt: new Date(f.clock + 60_000).toISOString() }), /cannot be renewed/);
});

test('a lost stop remains pending and reconnect retries pause, never charging', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  await f.supervisor.control(f.command(session, 1, 10));
  f.setPauseFailure(true);
  await f.advance(10_000);
  assert.equal(f.supervisor.status().stopping, true);
  assert.equal(f.writes.filter(value => value.mode === 'normal').length, 1);
  f.setPauseFailure(false);
  await f.advance(5000);
  assert.equal(f.supervisor.status().stopping, false);
  assert.equal(f.supervisor.status().revision, null);
  assert.equal(f.writes.filter(value => value.mode === 'normal').length, 1);
});

test('a pause setting with stale power does not fabricate a confirmed stop', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  await f.supervisor.control(f.command(session));
  f.setStalePower(true);
  await assert.rejects(f.supervisor.stop({ ...session, revision: 1 }), error => error instanceof WattpilotError && error.outcome === 'unknown');
  assert.equal(f.supervisor.status().stopping, true);
  f.setStalePower(false);
  await f.advance(5000);
  assert.equal(f.supervisor.status().revision, null);
});

test('manual takeover revokes an epoch before its device action and old requests stay fenced', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  await f.supervisor.control(f.command(session));
  const fence = f.supervisor.status().fence;
  await f.supervisor.manual({ mode: 'eco', currentAmps: 10, phases: 1 });
  assert.equal(f.supervisor.status().manualOverride, true);
  assert.ok(f.supervisor.status().fence > fence);
  assert.equal((await f.supervisor.readStatus()).mode, 'eco');
  const writes = f.writes.length;
  await assert.rejects(f.supervisor.control(f.command(session, 2)), /epoch was revoked/);
  await assert.rejects(f.supervisor.stop({ ...session, revision: 1 }), /epoch was revoked/);
  await assert.rejects(f.supervisor.renew({ ...session, revision: 1, expiresAt: new Date(f.clock + 90_000).toISOString() }), /epoch was revoked/);
  await f.advance(120_000);
  assert.equal(f.writes.length, writes);
  assert.equal((await f.supervisor.readStatus()).mode, 'eco');
});

test('late epoch establishment cannot arm after manual takeover or replace a newer epoch', async t => {
  const f = fixture(); t.after(() => f.close());
  const oldFence = f.supervisor.status().fence;
  await f.supervisor.manual({ mode: 'pause' });
  await assert.rejects(f.supervisor.establish({ owner: 'old', expectedFence: oldFence }), /fence changed/);
  const fence = f.supervisor.status().fence;
  const first = await f.supervisor.establish({ owner: 'new', expectedFence: fence });
  await assert.rejects(f.supervisor.establish({ owner: 'old', expectedFence: fence }), /fence changed/);
  assert.equal(f.supervisor.status().epoch, first.automation.epoch);
});

test('stop tombstones a not-yet-arrived activation and old stop never affects a newer revision', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  await f.supervisor.stop({ ...session, revision: 1 });
  await assert.rejects(f.supervisor.control(f.command(session, 1)), /stopped or superseded/);
  assert.equal(f.writes.length, 0);
  await f.supervisor.control(f.command(session, 2));
  const count = f.writes.length;
  await f.supervisor.stop({ ...session, revision: 1 });
  assert.equal(f.writes.length, count);
  assert.equal(f.supervisor.status().revision, 2);
  assert.equal(f.supervisor.status().active, true);
});

test('manual takeover aborts an in-flight activation and its late acknowledgement cannot resume it', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  let release!: () => void;
  f.setGate(new Promise(resolve => { release = resolve; }));
  const activating = f.supervisor.control(f.command(session));
  await settle();
  const rejected = assert.rejects(activating, error => error instanceof WattpilotError && error.outcome === 'unknown');
  const manual = f.supervisor.manual({ mode: 'pause' });
  release();
  await rejected;
  await manual;
  assert.equal(f.supervisor.status().manualOverride, true);
  assert.equal(f.supervisor.status().epoch, null);
  assert.equal((await f.supervisor.readStatus()).mode, 'pause');
});

test('activation crossing its deadline is aborted before it can finish or renew', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  let release!: () => void;
  f.setGate(new Promise(resolve => { release = resolve; }));
  const activating = f.supervisor.control(f.command(session, 1, 5));
  await settle();
  const rejected = assert.rejects(activating, error => error instanceof WattpilotError && error.outcome === 'unknown');
  await f.advance(5000); release();
  await rejected;
  await settle();
  assert.equal((await f.supervisor.readStatus()).mode, 'pause');
  assert.equal(f.writes.filter(value => value.mode === 'normal').length, 1);
});

test('external active or idle setting changes revoke authority without overwriting the device', async t => {
  for (const active of [false, true]) {
    const f = fixture(); t.after(() => f.close());
    const session = await f.authorize();
    if (active) await f.supervisor.control(f.command(session));
    f.setStatus({ mode: 'eco', currentAmps: 12, phaseMode: 1 });
    const count = f.writes.length;
    await f.advance(5000);
    assert.equal(f.supervisor.status().manualOverride, true);
    assert.equal(f.supervisor.status().epoch, null);
    assert.equal(f.writes.length, count);
    assert.equal((await f.supervisor.readStatus()).mode, 'eco');
  }
});

test('restart reconciles an old lease instead of replaying it, with revisions and fence preserved', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wattpilot-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const original = fixture(path);
  const session = await original.authorize();
  await original.supervisor.control(original.command(session));
  const copy = join(directory, 'crashed.json');
  await writeFile(copy, await readFile(path));
  await original.close();
  const restarted = fixture(copy); t.after(() => restarted.close());
  restarted.setStatus({ mode: 'normal', charging: true, allowedCharging: true, powerWatts: 4140 });
  await restarted.supervisor.start();
  assert.deepEqual(restarted.writes, [{ mode: 'pause' }]);
  assert.equal(restarted.supervisor.status().lastRevision, 1);
  assert.equal(restarted.supervisor.status().epoch, session.epoch);
  await assert.rejects(restarted.supervisor.control(restarted.command(session, 1)), /superseded/);
});

test('corrupt or unwritable journals block automation while manual pause remains available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wattpilot-bad-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'corrupt.json');
  await writeFile(path, '{broken');
  const corrupt = fixture(path); t.after(() => corrupt.close());
  await assert.rejects(corrupt.authorize(), /journal is unavailable/);
  assert.equal(corrupt.writes.length, 0);
  await corrupt.supervisor.manual({ mode: 'pause' });
  assert.equal(corrupt.writes.length, 1);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  const parent = join(directory, 'file'); await writeFile(parent, 'not a directory');
  const unwritable = fixture(join(parent, 'journal.json')); t.after(() => unwritable.close());
  await assert.rejects(unwritable.authorize(), /journal is unavailable/);
  assert.equal(unwritable.writes.length, 0);
});

test('revision tombstones and establishment fences survive restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wattpilot-fence-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const first = fixture(path);
  const session = await first.authorize();
  const oldFence = first.supervisor.status().fence - 1;
  await first.supervisor.stop({ ...session, revision: 1 });
  await first.close();
  const second = fixture(path); t.after(() => second.close());
  await second.supervisor.start();
  await assert.rejects(second.supervisor.control(second.command(session, 1)), /superseded/);
  await assert.rejects(second.supervisor.establish({ owner: 'delayed', expectedFence: oldFence }), /fence changed/);
  assert.equal(second.writes.length, 0);
  await second.supervisor.control(second.command(session, 2));
  const count = second.writes.length;
  await second.supervisor.stop({ ...session, revision: 1 });
  assert.equal(second.writes.length, count);
  assert.equal(second.supervisor.status().revision, 2);
});

test('new setpoint revision pauses the old owned charge before starting another', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  await f.supervisor.control(f.command(session, 1));
  await f.supervisor.control({ ...f.command(session, 2), currentAmps: 10 });
  assert.deepEqual(f.writes.map(value => value.mode), ['normal', 'pause', 'normal']);
  assert.equal(f.supervisor.status().revision, 2);
  assert.equal(f.supervisor.status().lastRevision, 2);
});

test('storage failure on an active lease still triggers physical pause and blocks new activations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wattpilot-storage-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, 'journal');
  const backup = join(directory, 'backup');
  const f = fixture(join(parent, 'state.json'));
  const session = await f.authorize();
  await f.supervisor.control(f.command(session));
  await rename(parent, backup);
  await writeFile(parent, 'blocks journal directory');
  await assert.rejects(f.supervisor.renew({ ...session, revision: 1,
    expiresAt: new Date(f.clock + 120_000).toISOString() }), /journal is unavailable/);
  await f.advance(5000);
  await assert.rejects(f.supervisor.control(f.command(session, 2)), /journal is unavailable/);
  assert.equal((await f.supervisor.readStatus()).mode, 'pause');
  assert.equal(f.supervisor.status().stopping, true);
  await rm(parent); await rename(backup, parent);
  await f.close();
});

test('unknown activation cannot clear cleanup from a cached pre-resume pause and zero power', async t => {
  const f = fixture(); t.after(() => f.close());
  const session = await f.authorize();
  f.setActivationUnknown(true);
  await assert.rejects(f.supervisor.control(f.command(session)), error => error instanceof WattpilotError && error.outcome === 'unknown');
  assert.equal((await f.supervisor.readStatus()).mode, 'pause', 'cached pause predates the unknown resume');
  f.setStopProof(false);
  await assert.rejects(f.supervisor.stop({ ...session, revision: 1 }), /post-pause stopped observation/);
  assert.deepEqual(f.writes.map(command => command.mode), ['normal', 'pause']);
  assert.equal(f.supervisor.status().stopping, true);
  assert.equal(f.supervisor.status().revision, 1);
  f.setStatus({ mode: 'normal', charging: true, allowedCharging: true, powerWatts: 4140 });
  await f.advance(5000);
  assert.equal(f.supervisor.status().stopping, true);
  assert.equal(f.supervisor.status().epoch, session.epoch, 'late own continuation is not classified as foreign');
  assert.equal(f.writes.filter(command => command.mode === 'normal').length, 1);
  f.setStopProof(true);
  await f.advance(5000);
  assert.equal(f.supervisor.status().revision, null);
  assert.equal((await f.supervisor.readStatus()).mode, 'pause');
});

test('pending compensation survives restart and manual takeover requires the same fresh stop proof', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wattpilot-compensate-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.json');
  const first = fixture(path);
  const session = await first.authorize();
  first.setActivationUnknown(true);
  await assert.rejects(first.supervisor.control(first.command(session)), /acknowledgement lost/);
  first.setStopProof(false);
  await assert.rejects(first.supervisor.stop({ ...session, revision: 1 }), /post-pause/);
  const snapshot = join(directory, 'crashed.json');
  await writeFile(snapshot, await readFile(path));
  await first.close();
  const second = fixture(snapshot); t.after(() => second.close());
  second.setStopProof(false);
  await second.supervisor.start();
  assert.equal(second.writes.at(-1)?.mode, 'pause');
  assert.equal(second.supervisor.status().stopping, true);
  await assert.rejects(second.supervisor.manual({ mode: 'normal', currentAmps: 10 }), /post-pause/);
  assert.equal(second.supervisor.status().stopping, true);
  assert.equal(second.writes.some(command => command.mode === 'normal'), false);
  second.setStopProof(true);
  await second.advance(5000);
  await assert.rejects(second.supervisor.stop({ ...session, revision: 1 }), /epoch was revoked/);
  assert.equal(second.supervisor.status().revision, null);
});
