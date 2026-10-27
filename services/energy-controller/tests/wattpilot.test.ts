import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { Wattpilot, WattpilotError, deriveWattpilotKey, type WattpilotConfig, type WattpilotSocket } from '../src/devices/wattpilot';

const password = 'test-password';
const serial = '12345678';
const token = '0123456789abcdef0123456789abcdef';
const vectorKey = '3bJwkjX/nzwdbk2XoScpK8WHG8gX9iIx';
const completeStatus = {
  ama: 16, cbl: 20, adi: false, var: 11, amp: 6,
  frc: 0, lmo: 3, car: 2, alw: true, wh: 1240, eto: 100_000,
  nrg: [230, 230, 230, 0, 6, 6, 6, 1380, 1380, 1380, 0, 4140],
};

type Write = { type: string; requestId: number; key: string; value: number };
class FakeSocket extends EventTarget implements WattpilotSocket {
  readyState = 1;
  sent: Record<string, any>[] = [];
  closeCount = 0;
  onSend?: (message: Record<string, any>) => void;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const message = JSON.parse(String(data));
    this.sent.push(message);
    this.onSend?.(message);
  }
  close() {
    this.closeCount++;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  receive(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  raw(data: string) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

function fixture(options: {
  config?: Partial<WattpilotConfig>;
  status?: Record<string, unknown>;
  initialize?: boolean;
  hello?: Record<string, unknown>;
  challenge?: Record<string, unknown>;
  write?: (message: Write, socket: FakeSocket) => void;
} = {}) {
  let clock = Date.parse('2026-10-25T06:00:00Z');
  const config: WattpilotConfig = {
    url: 'ws://192.168.1.50/ws', password, controlEnabled: true,
    maxCurrentAmps: 16, requestTimeoutMs: 2000, staleAfterMs: 30_000, ...options.config,
  };
  const sockets: FakeSocket[] = [];
  const writes: Write[] = [];
  const charger = new Wattpilot(config, {
    now: () => clock,
    randomToken: () => token,
    createSocket(url) {
      assert.equal(url, config.url);
      const socket = new FakeSocket();
      sockets.push(socket);
      socket.onSend = message => {
        if (message.type === 'auth') {
          queueMicrotask(() => {
            socket.receive({ type: 'authSuccess' });
            if (options.initialize !== false) socket.receive({ type: 'fullStatus', partial: false, status: options.status ?? completeStatus });
          });
        } else {
          const inner: Write = message.type === 'securedMsg' ? JSON.parse(message.data) : message as Write;
          writes.push(inner);
          if (options.write) options.write(inner, socket);
          else queueMicrotask(() => socket.receive({ type: 'response', requestId: String(inner.requestId), success: true, status: { [inner.key]: inner.value } }));
        }
      };
      queueMicrotask(() => {
        socket.receive({ type: 'hello', serial, manufacturer: 'fronius', devicetype: 'wattpilot', protocol: 2, secured: true, ...options.hello });
        socket.receive({ type: 'authRequired', token1: 'token-one', token2: 'token-two', ...options.challenge });
      });
      return socket;
    },
  });
  return { charger, config, sockets, writes, advance(ms: number) { clock += ms; }, get now() { return clock; } };
}

async function waitForAuth(socket: FakeSocket) {
  for (let attempt = 0; attempt < 100 && !socket.sent.some(message => message.type === 'auth'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(socket.sent.some(message => message.type === 'auth'));
  await tick();
}

test('classic authentication matches an independently generated PBKDF2/SHA256 vector', async t => {
  assert.equal(await deriveWattpilotKey(password, serial), vectorKey);
  const f = fixture(); t.after(() => f.charger.disconnect());
  const status = await f.charger.readStatus();
  assert.equal(status.status, 'online');
  assert.deepEqual(f.sockets[0].sent[0], {
    type: 'auth', token3: token,
    hash: 'b3651d2d91c5234984e05a4d0661215ded0767bff167cd7d167c6e7cf851bef7',
  });
  assert.equal(f.writes.length, 0);
  assert.equal(JSON.stringify(status).includes(password), false);
  assert.equal(JSON.stringify(status).includes(vectorKey), false);
});

test('multipart initialization waits for full completion and ignores premature delta state', async t => {
  const f = fixture({ initialize: false }); t.after(() => f.charger.disconnect());
  let resolved = false;
  const reading = f.charger.readStatus().then(value => { resolved = true; return value; });
  await waitForAuth(f.sockets[0]);
  f.sockets[0].receive({ type: 'deltaStatus', status: { amp: 100 } });
  f.sockets[0].receive({ type: 'fullStatus', partial: true, status: { ama: 16, cbl: 20, var: 11, adi: false } });
  await tick();
  assert.equal(resolved, false);
  f.sockets[0].receive({ type: 'fullStatus', partial: false, status: { amp: 6, frc: 0, lmo: 4, nrg: completeStatus.nrg } });
  const status = await reading;
  assert.equal(status.currentAmps, 6);
  assert.equal(status.limits.maxCurrentAmps, 16);
  assert.equal(status.mode, 'eco');
  assert.equal(status.carConnected, null);
});

test('delta updates merge, keep power observation age and never invent missing telemetry', async t => {
  const f = fixture(); t.after(() => f.charger.disconnect());
  const initial = await f.charger.readStatus();
  assert.equal(initial.powerWatts, 4140);
  assert.equal(initial.carConnected, true);
  assert.equal(initial.charging, true);
  assert.equal(initial.sessionEnergyWh, 1240);
  assert.equal(initial.totalEnergyWh, 100000);
  assert.match(initial.energyCounterSource!, /^Wattpilot:/);
  f.advance(1000);
  f.sockets[0].receive({ type: 'deltaStatus', status: { car: 1, amp: 10 } });
  await tick();
  const updated = await f.charger.readStatus();
  assert.equal(updated.currentAmps, 10);
  assert.equal(updated.powerWatts, 4140);
  assert.equal(updated.carConnected, false);
  assert.equal(updated.charging, false);
  assert.equal(updated.powerObservedAt, initial.powerObservedAt);
  assert.notEqual(updated.observedAt, initial.observedAt);
  f.sockets[0].receive({ type: 'deltaStatus', status: { nrg: null, car: 0, wh: -1, eto: '10' } });
  await tick();
  const missing = await f.charger.readStatus();
  assert.equal(missing.powerWatts, null);
  assert.equal(missing.carConnected, null);
  assert.equal(missing.charging, null);
  assert.equal(missing.sessionEnergyWh, null);
  assert.equal(missing.totalEnergyWh, null);
});

test('unconfigured and disabled controls never open a transport or perform writes', async t => {
  const f = fixture({ config: { url: null, password: null, controlEnabled: false, maxCurrentAmps: null } });
  t.after(() => f.charger.disconnect());
  assert.equal((await f.charger.readStatus()).status, 'not_configured');
  await assert.rejects(f.charger.setControl({ mode: 'pause' }), (error: unknown) => error instanceof WattpilotError && error.statusCode === 403);
  assert.equal(f.sockets.length, 0);
});

test('invalid commands reject before any device access', async t => {
  const f = fixture(); t.after(() => f.charger.disconnect());
  for (const command of [null, {}, { mode: 'auto' }, { mode: 'pause', currentAmps: 0 }, { mode: 'normal' }, { mode: 'eco', currentAmps: 5 },
    { mode: 'normal', currentAmps: 6.5 }, { mode: 'normal', currentAmps: Infinity }, { mode: 'normal', currentAmps: '6' }, { mode: 'pause', password },
    ...[null, 0, 2, '1', true].map(phases => ({ mode: 'normal', currentAmps: 6, phases })),
    { mode: 'pause', phases: 1 }]) {
    await assert.rejects(f.charger.setControl(command as any), (error: unknown) => error instanceof WattpilotError && error.statusCode === 400);
  }
  assert.equal(f.sockets.length, 0);
});

test('phase mode reports only the device setting and unknown capability remains unknown', async t => {
  for (const [psm, phaseMode] of [[0, 'auto'], [1, 1], [2, 3], [3, null], ['1', null], [null, null]] as const) {
    const f = fixture({ status: { ...completeStatus, psm } }); t.after(() => f.charger.disconnect());
    const status = await f.charger.readStatus();
    assert.equal(status.phaseMode, phaseMode);
    assert.equal(status.phaseSwitchingSupported, phaseMode !== null);
  }
});

test('one- and three-phase requests pause, confirm actual stopped power, then verify the phase mode before resuming', async t => {
  for (const phases of [1, 3] as const) {
    const f = fixture({ status: { ...completeStatus, psm: 0 }, write(message, socket) {
      socket.receive({ type: 'response', requestId: String(message.requestId), success: true, status: { [message.key]: message.value } });
      if (message.key === 'frc' && message.value === 1) socket.receive({ type: 'deltaStatus', status: {
        car: 3, alw: false, nrg: [...completeStatus.nrg.slice(0, 11), 0],
      } });
    } }); t.after(() => f.charger.disconnect());
    const result = await f.charger.setControl({ mode: 'normal', currentAmps: 10, phases });
    assert.equal(result.phaseMode, phases);
    assert.deepEqual(f.writes.map(({ key, value }) => [key, value]), [
      ['frc', 1], ['psm', phases === 1 ? 1 : 2], ['amp', 10], ['lmo', 3], ['frc', 0],
    ]);
  }
});

test('an unchanged forced phase mode and legacy current-only commands never write phase settings', async t => {
  const f = fixture({ status: { ...completeStatus, psm: 1 } }); t.after(() => f.charger.disconnect());
  await f.charger.setControl({ mode: 'normal', currentAmps: 10, phases: 1 });
  await f.charger.setControl({ mode: 'eco', currentAmps: 6 });
  assert.equal(f.writes.some(({ key }) => key === 'psm'), false);
  assert.equal((await f.charger.readStatus()).phaseMode, 1);
});

test('unsupported phase switching refuses explicit phase requests before any write', async t => {
  for (const psm of [undefined, null, 4, '1']) {
    const f = fixture({ status: { ...completeStatus, psm } }); t.after(() => f.charger.disconnect());
    await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 6, phases: 1 }), /phase switching support/);
    assert.equal(f.writes.length, 0);
  }
});

test('compensating pause requires a new stopped status frame even when the cache already says paused', async t => {
  const pausedStatus = { ...completeStatus, frc: 1, car: 3, alw: false,
    nrg: [...completeStatus.nrg.slice(0, 11), 0] };
  const f = fixture({ status: pausedStatus }); t.after(() => f.charger.disconnect());
  await f.charger.readStatus();
  let complete = false;
  const pause = f.charger.pauseAndConfirm().then(status => { complete = true; return status; });
  await tick();
  assert.equal(complete, false, 'the pause ACK and old zero-power cache are not proof');
  assert.deepEqual(f.writes.map(({ key, value }) => [key, value]), [['frc', 1]]);
  assert.equal((await pause).powerWatts, 0);
  assert.equal(f.sockets.length, 2, 'a new status snapshot follows the ordered pause acknowledgement');
  assert.equal(f.sockets[0].closeCount, 1);
});

test('an unconfirmed compensating pause remains unknown and never sends a resume', async t => {
  const deviceStatus = { ...completeStatus, frc: 1, car: 3, alw: false,
    nrg: [...completeStatus.nrg.slice(0, 11), 0] };
  const f = fixture({ status: deviceStatus }); t.after(() => f.charger.disconnect());
  await f.charger.readStatus();
  Object.assign(deviceStatus, { frc: 0, car: 2, alw: true, nrg: completeStatus.nrg });
  await assert.rejects(f.charger.pauseAndConfirm(), error => error instanceof WattpilotError
    && error.outcome === 'unknown');
  assert.deepEqual(f.writes.map(({ key, value }) => [key, value]), [['frc', 1]]);
});

test('delayed stop telemetry blocks phase/current writes until charging has actually stopped', async t => {
  let pauseSent!: () => void;
  const paused = new Promise<void>(resolve => { pauseSent = resolve; });
  const f = fixture({ status: { ...completeStatus, psm: 2 }, write(message, socket) {
    socket.receive({ type: 'response', requestId: String(message.requestId), success: true, status: { [message.key]: message.value } });
    if (message.key === 'frc' && message.value === 1) pauseSent();
  } }); t.after(() => f.charger.disconnect());
  const command = f.charger.setControl({ mode: 'normal', currentAmps: 6, phases: 1 });
  await paused; await tick();
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc']);
  f.sockets[0].receive({ type: 'deltaStatus', status: { car: 3, alw: false } });
  await tick();
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc'], 'a pause setting alone is not a stopped-power measurement');
  f.advance(1);
  f.sockets[0].receive({ type: 'deltaStatus', status: { nrg: [...completeStatus.nrg.slice(0, 11), 0] } });
  assert.equal((await command).phaseMode, 1);
});

test('missing stopped telemetry times out while paused without changing phases or resuming', async t => {
  const f = fixture({ status: { ...completeStatus, psm: 2 } }); t.after(() => f.charger.disconnect());
  await f.charger.readStatus();
  f.config.requestTimeoutMs = 10;
  await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 6, phases: 1 }), (error: unknown) =>
    error instanceof WattpilotError && error.statusCode === 504 && error.outcome === 'unknown');
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc']);
  assert.equal((await f.charger.readStatus()).mode, 'pause');
  assert.equal((await f.charger.readStatus()).phaseMode, 3);
});

test('busy or stale stopped telemetry during phase acknowledgement prevents current changes and resumption', async t => {
  const cases: Array<{ status: Record<string, unknown>; advanceMs?: number }> = [
    { status: { car: 2 } }, { status: { alw: true } }, { status: { nrg: completeStatus.nrg } },
    { status: { alw: false }, advanceMs: 30_001 },
  ];
  for (const changed of cases) {
    let phaseSent!: () => void;
    const changing = new Promise<void>(resolve => { phaseSent = resolve; });
    const f = fixture({ status: { ...completeStatus, psm: 2 }, write(message, socket) {
      if (message.key === 'psm') { phaseSent(); return; }
      socket.receive({ type: 'response', requestId: String(message.requestId), success: true, status: { [message.key]: message.value } });
      if (message.key === 'frc' && message.value === 1) socket.receive({ type: 'deltaStatus', status: {
        car: 3, alw: false, nrg: [...completeStatus.nrg.slice(0, 11), 0],
      } });
    } }); t.after(() => f.charger.disconnect());
    const command = f.charger.setControl({ mode: 'normal', currentAmps: 6, phases: 1 });
    const rejection = assert.rejects(command, (error: unknown) => error instanceof WattpilotError && error.outcome === 'unknown');
    await changing;
    if (changed.advanceMs) f.advance(changed.advanceMs);
    f.sockets[0].receive({ type: 'deltaStatus', status: changed.status });
    await tick();
    const phaseWrite = f.writes.at(-1)!;
    f.sockets[0].receive({ type: 'response', requestId: String(phaseWrite.requestId), success: true, status: { psm: phaseWrite.value } });
    await rejection;
    assert.deepEqual(f.writes.map(({ key }) => key), ['frc', 'psm']);
  }
});

test('unverified phase acknowledgements never apply current or release pause', async t => {
  const f = fixture({ status: { ...completeStatus, psm: 2 }, write(message, socket) {
    socket.receive({ type: 'response', requestId: String(message.requestId), success: true,
      status: { [message.key]: message.key === 'psm' ? 2 : message.value } });
    if (message.key === 'frc' && message.value === 1) socket.receive({ type: 'deltaStatus', status: {
      car: 3, alw: false, nrg: [...completeStatus.nrg.slice(0, 11), 0],
    } });
  } }); t.after(() => f.charger.disconnect());
  await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 6, phases: 1 }), (error: unknown) =>
    error instanceof WattpilotError && error.outcome === 'unknown');
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc', 'psm']);
  await f.charger.readStatus();
  assert.equal(f.writes.length, 2);
});

test('external phase changes during a legacy command cancel its remaining writes', async t => {
  const f = fixture({ status: { ...completeStatus, psm: 1 }, write(message, socket) {
    socket.receive({ type: 'response', requestId: String(message.requestId), success: true,
      status: { [message.key]: message.value, ...(message.key === 'amp' ? { psm: 2 } : {}) } });
  } }); t.after(() => f.charger.disconnect());
  await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 10 }), /changed externally/);
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc', 'amp']);
});

test('cancellation and shutdown while waiting for stopped power cannot resume or switch phases', async t => {
  for (const action of ['cancel', 'shutdown']) {
    let pauseSent!: () => void;
    const paused = new Promise<void>(resolve => { pauseSent = resolve; });
    const controller = new AbortController();
    const f = fixture({ status: { ...completeStatus, psm: 2 }, write(message, socket) {
      socket.receive({ type: 'response', requestId: String(message.requestId), success: true, status: { [message.key]: message.value } });
      if (message.key === 'frc' && message.value === 1) pauseSent();
    } }); t.after(() => f.charger.disconnect());
    const command = f.charger.setControl({ mode: 'normal', currentAmps: 6, phases: 1 }, controller.signal);
    const rejected = assert.rejects(command, (error: unknown) => error instanceof WattpilotError && error.outcome === 'unknown');
    await paused; await tick();
    if (action === 'cancel') controller.abort();
    else await f.charger.disconnect();
    await rejected;
    assert.deepEqual(f.writes.map(({ key }) => key), ['frc']);
  }
});

test('normal control pauses before setting current and mode, signs writes and verifies acknowledgements', async t => {
  const f = fixture(); t.after(() => f.charger.disconnect());
  const status = await f.charger.setControl({ mode: 'normal', currentAmps: 10 });
  assert.deepEqual(f.writes.map(({ key, value }) => [key, value]), [['frc', 1], ['amp', 10], ['lmo', 3], ['frc', 0]]);
  assert.equal(status.currentAmps, 10);
  assert.equal(status.mode, 'normal');
  assert.equal(status.deviceLeaseSupported, false);
  for (const message of f.sockets[0].sent.slice(1)) {
    assert.equal(message.type, 'securedMsg');
    assert.equal(message.requestId, `${JSON.parse(message.data).requestId}sm`);
    assert.equal(message.hmac, createHmac('sha256', vectorKey).update(message.data).digest('hex'));
  }
});

test('eco selects device logic without forcing On, and pause needs no capability-derived current ceiling', async t => {
  const f = fixture(); t.after(() => f.charger.disconnect());
  assert.equal((await f.charger.setControl({ mode: 'eco', currentAmps: 6 })).mode, 'eco');
  assert.equal(f.writes.some(write => write.key === 'frc' && write.value === 2), false);
  assert.equal(f.writes.some(write => write.key === 'alw'), false);
  const missing = fixture({ status: { frc: 0 } }); t.after(() => missing.charger.disconnect());
  assert.equal((await missing.charger.setControl({ mode: 'pause' })).mode, 'pause');
  assert.deepEqual(missing.writes.map(({ key, value }) => [key, value]), [['frc', 1]]);
});

test('device, cable, adapter and configured ceilings reject excess current before any write', async t => {
  for (const limits of [{ ama: 8 }, { cbl: 8 }, { adi: true }, {}]) {
    const f = fixture({ status: { ...completeStatus, var: 22, ama: 32, cbl: 32, ...limits }, config: { maxCurrentAmps: 16 } });
    t.after(() => f.charger.disconnect());
    const expected = 'ama' in limits || 'cbl' in limits ? 8 : 16;
    assert.equal((await f.charger.readStatus()).limits.maxCurrentAmps, expected);
    await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: expected + 1 }), /exceeds/);
    assert.equal(f.writes.length, 0);
  }
});

test('missing device limits and control state fail closed, while read-only telemetry remains available', async t => {
  for (const key of ['ama', 'cbl', 'var', 'adi', 'frc', 'lmo', 'amp']) {
    const status: Record<string, unknown> = { ...completeStatus }; delete status[key];
    const f = fixture({ status }); t.after(() => f.charger.disconnect());
    assert.equal((await f.charger.readStatus()).status, 'online');
    await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 6 }), /required/);
    assert.equal(f.writes.length, 0);
  }
});

test('negative acknowledgements, missing verification and wrong request IDs never report success or replay', async t => {
  for (const reply of [
    { success: false, message: password },
    { success: true, status: {} },
    { success: true, status: { frc: 0 } },
  ]) {
    const f = fixture({ write(message, socket) {
      socket.receive({ type: 'response', requestId: 'unrelated', success: true, status: { frc: 1 } });
      socket.receive({ type: 'response', requestId: String(message.requestId), ...reply });
    } }); t.after(() => f.charger.disconnect());
    await assert.rejects(f.charger.setControl({ mode: 'pause' }), (error: unknown) => {
      assert.ok(error instanceof WattpilotError);
      assert.equal(error.message.includes(password), false);
      return true;
    });
    assert.equal(f.writes.length, 1);
    await f.charger.readStatus();
    assert.equal(f.writes.length, 1);
  }
});

test('acknowledgement timeout reports unknown outcome and a late acknowledgement does not replay the command', async t => {
  const f = fixture({ write() {} }); t.after(() => f.charger.disconnect());
  await f.charger.readStatus();
  f.config.requestTimeoutMs = 10;
  await assert.rejects(f.charger.setControl({ mode: 'pause' }), (error: unknown) => error instanceof WattpilotError && error.statusCode === 504 && error.outcome === 'unknown');
  f.sockets[0].receive({ type: 'response', requestId: '1', success: true, status: { frc: 1 } });
  await tick();
  assert.equal(f.writes.length, 1);
  assert.equal((await f.charger.readStatus()).mode, 'normal');
});

test('Eco can preserve an observed bounded current while unplugged without an unknown cable ceiling', async t => {
  const f = fixture({status: {...completeStatus, car: 1, cbl: 0, amp: 6}}); t.after(() => f.charger.disconnect());
  const status = await f.charger.setControl({mode: 'eco', currentAmps: 6});
  assert.equal(status.mode, 'eco');
  assert.equal(status.carConnected, false);
  assert.equal(status.limits.maxCurrentAmps, null);
  assert.deepEqual(f.writes.map(({key, value}) => [key, value]), [['frc', 1], ['lmo', 4], ['frc', 0]]);
  assert.equal(f.writes.some(({key}) => key === 'amp'), false);
});

test('Eco still requires verified limits for changed current or an explicit phase request', async t => {
  for (const command of [{mode: 'eco', currentAmps: 10}, {mode: 'eco', currentAmps: 6, phases: 1},
    {mode: 'normal', currentAmps: 6}] as const) {
    const f = fixture({status: {...completeStatus, car: 1, cbl: 0, amp: 6, psm: 2}}); t.after(() => f.charger.disconnect());
    await assert.rejects(f.charger.setControl(command), /current limits/);
    assert.equal(f.writes.length, 0);
  }
});

test('an external current change still cancels unplugged Eco preservation before release', async t => {
  const f = fixture({status: {...completeStatus, car: 1, cbl: 0, amp: 6}, write(message, socket) {
    socket.receive({type: 'response', requestId: String(message.requestId), success: true,
      status: {[message.key]: message.value, ...(message.key === 'lmo' ? {amp: 16} : {})}});
  }}); t.after(() => f.charger.disconnect());
  await assert.rejects(f.charger.setControl({mode: 'eco', currentAmps: 6}), /changed externally/);
  assert.deepEqual(f.writes.map(({key}) => key), ['frc', 'lmo']);
});

test('external settings changes cancel the remaining multiwrite without resuming charging', async t => {
  const f = fixture({ write(message, socket) {
    socket.receive({ type: 'response', requestId: String(message.requestId), success: true,
      status: { [message.key]: message.value, ...(message.key === 'lmo' ? { amp: 16 } : {}) } });
  } }); t.after(() => f.charger.disconnect());
  await assert.rejects(f.charger.setControl({ mode: 'eco', currentAmps: 6 }), /changed externally/);
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc', 'lmo']);
  assert.equal((await f.charger.readStatus()).mode, 'pause');
});

test('an external mode change during the opening pause cancels the untouched current and mode writes', async t => {
  const f = fixture({ write(message, socket) {
    socket.receive({ type: 'response', requestId: String(message.requestId), success: true,
      status: { [message.key]: message.value, lmo: 5 } });
  } }); t.after(() => f.charger.disconnect());
  await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 10 }), /changed externally/);
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc']);
});

test('concurrent commands are rejected and shutdown cancels pending writes as unknown', async t => {
  const f = fixture({ write() {} }); t.after(() => f.charger.disconnect());
  await f.charger.readStatus();
  const first = f.charger.setControl({ mode: 'pause' });
  const rejected = assert.rejects(first, (error: unknown) => error instanceof WattpilotError && error.outcome === 'unknown');
  await tick();
  await assert.rejects(f.charger.setControl({ mode: 'pause' }), (error: unknown) => error instanceof WattpilotError && error.statusCode === 409);
  await f.charger.disconnect();
  await rejected;
  assert.equal(f.writes.length, 1);
  const status = await f.charger.readStatus();
  assert.equal(status.stale, true);
  assert.equal(status.connected, false);
  assert.equal(status.ready, false);
  assert.equal(f.sockets.length, 1);
});

test('stale status reconnects with a complete fresh snapshot and does not replay prior writes', async t => {
  const f = fixture(); t.after(() => f.charger.disconnect());
  await f.charger.setControl({ mode: 'pause' });
  f.advance(30_001);
  const status = await f.charger.readStatus();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[0].closeCount, 1);
  assert.equal(status.ready, true);
  assert.equal(status.mode, 'normal');
  assert.equal(f.writes.length, 1);
});

test('disconnect during authentication never sends a later auth response or opens a second socket', async t => {
  const f = fixture(); t.after(() => f.charger.disconnect());
  const reading = f.charger.readStatus();
  await tick();
  await f.charger.disconnect();
  const status = await reading;
  assert.equal(status.ready, false);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(f.sockets.length, 1);
});

test('unsupported identity, protocol or auth algorithms fail without leaking device messages', async t => {
  for (const options of [
    { hello: { devicetype: 'wattpilot_flex' } }, { hello: { manufacturer: 'other' } },
    { hello: { protocol: 3 } }, { challenge: { hash: 'bcrypt' } },
  ]) {
    const f = fixture(options); t.after(() => f.charger.disconnect());
    const status = await f.charger.readStatus();
    assert.equal(status.ready, false);
    assert.equal(status.status, 'error');
    assert.match(status.error!, /Unsupported/);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture({ initialize: false }); t.after(() => f.charger.disconnect());
  const reading = f.charger.readStatus();
  await tick();
  f.sockets[0].receive({ type: 'authError', message: password });
  assert.equal((await reading).error, 'Wattpilot authentication failed.');
});

test('missing native WebSocket is an optional integration error and never affects construction', async () => {
  const original = globalThis.WebSocket;
  try {
    Object.defineProperty(globalThis, 'WebSocket', { value: undefined, configurable: true, writable: true });
    const charger = new Wattpilot({ url: 'ws://192.168.1.50/ws', password, controlEnabled: false, maxCurrentAmps: null, requestTimeoutMs: 100, staleAfterMs: 30000 });
    const status = await charger.readStatus();
    assert.match(status.error!, /Node.js 22.4/);
    assert.equal(status.ready, false);
    await charger.disconnect();
  } finally {
    Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true, writable: true });
  }
});

test('adapter configuration rejects unsafe current limits, URLs and missing control authority', () => {
  const config: WattpilotConfig = { url: null, password: null, controlEnabled: false, maxCurrentAmps: null, requestTimeoutMs: 1000, staleAfterMs: 30000 };
  for (const patch of [
    { url: 'http://charger/ws' }, { url: 'ws://user:password@charger/ws' }, { url: 'ws://charger/ws#secret' },
    { url: 'ws://charger/ws?password=secret' }, { url: 'ws://charger/arbitrary' },
    { maxCurrentAmps: 32 }, { maxCurrentAmps: 5 }, { maxCurrentAmps: NaN }, { requestTimeoutMs: Infinity }, { staleAfterMs: 0 }, { controlEnabled: true },
  ]) assert.throws(() => new Wattpilot({ ...config, ...patch }), WattpilotError);
});

test('omitted partial marks a complete full snapshot and malformed partial is rejected', async t => {
  const f = fixture({ initialize: false }); t.after(() => f.charger.disconnect());
  const reading = f.charger.readStatus();
  await waitForAuth(f.sockets[0]);
  f.sockets[0].receive({ type: 'fullStatus', status: completeStatus });
  assert.equal((await reading).ready, true);
  const malformed = fixture({ initialize: false }); t.after(() => malformed.charger.disconnect());
  const invalid = malformed.charger.readStatus();
  await waitForAuth(malformed.sockets[0]);
  malformed.sockets[0].receive({ type: 'fullStatus', partial: 'false', status: completeStatus });
  assert.equal((await invalid).ready, false);
});

test('configured ceiling is checked before connecting', async t => {
  const f = fixture({ config: { maxCurrentAmps: 8 } }); t.after(() => f.charger.disconnect());
  await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 9 }), /exceeds/);
  assert.equal(f.sockets.length, 0);
});

test('changing current limits midway prevents current increase or final release', async t => {
  for (const changeAt of ['frc', 'lmo']) {
    const f = fixture({ write(message, socket) {
      socket.receive({ type: 'response', requestId: String(message.requestId), success: true,
        status: { [message.key]: message.value, ...(message.key === changeAt ? { cbl: 6 } : {}) } });
    } }); t.after(() => f.charger.disconnect());
    await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 10 }), (error: unknown) =>
      error instanceof WattpilotError && error.outcome === 'unknown' && /limits changed/.test(error.message));
    assert.equal(f.writes.some(({ key, value }) => key === 'frc' && value === 0), false);
    if (changeAt === 'frc') assert.equal(f.writes.some(({ key }) => key === 'amp'), false);
    assert.equal((await f.charger.readStatus()).mode, 'pause');
  }
});

test('request cancellation before initialization cannot later start charging', async t => {
  const f = fixture({ initialize: false }); t.after(() => f.charger.disconnect());
  const cancellation = new AbortController();
  const control = f.charger.setControl({ mode: 'normal', currentAmps: 10 }, cancellation.signal);
  const rejection = assert.rejects(control, (error: unknown) => error instanceof WattpilotError && error.statusCode === 409 && error.outcome === undefined);
  cancellation.abort();
  await rejection;
  await waitForAuth(f.sockets[0]);
  f.sockets[0].receive({ type: 'fullStatus', status: completeStatus });
  await tick();
  assert.equal(f.writes.length, 0);
  assert.equal((await f.charger.readStatus()).ready, true);
});

test('already cancelled requests do not connect, and cancellation between steps does not release pause', async t => {
  const cancelled = new AbortController(); cancelled.abort();
  const initial = fixture(); t.after(() => initial.charger.disconnect());
  await assert.rejects(initial.charger.setControl({ mode: 'pause' }, cancelled.signal), /cancelled/);
  assert.equal(initial.sockets.length, 0);
  const cancellation = new AbortController();
  const f = fixture({ write(message, socket) {
    socket.receive({ type: 'response', requestId: String(message.requestId), success: true, status: { [message.key]: message.value } });
    if (message.key === 'amp') cancellation.abort();
  } }); t.after(() => f.charger.disconnect());
  await assert.rejects(f.charger.setControl({ mode: 'normal', currentAmps: 10 }, cancellation.signal), (error: unknown) =>
    error instanceof WattpilotError && error.statusCode === 409 && error.outcome === 'unknown');
  assert.deepEqual(f.writes.map(({ key }) => key), ['frc', 'amp']);
  assert.equal((await f.charger.readStatus()).mode, 'pause');
});

test('oversized protocol frames and auth tokens fail before any property write', async t => {
  const longToken = fixture({ challenge: { token1: 'x'.repeat(257) } }); t.after(() => longToken.charger.disconnect());
  assert.match((await longToken.charger.readStatus()).error!, /Unsupported.*challenge/);
  assert.equal(longToken.writes.length, 0);
  const f = fixture({ initialize: false }); t.after(() => f.charger.disconnect());
  const reading = f.charger.readStatus();
  await waitForAuth(f.sockets[0]);
  f.sockets[0].raw(' '.repeat(1_048_577));
  assert.match((await reading).error!, /invalid protocol data/);
  assert.equal(f.writes.length, 0);
});
