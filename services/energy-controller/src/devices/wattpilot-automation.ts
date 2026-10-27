import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WattpilotError, type Wattpilot, type WattpilotCommand, type WattpilotStatus } from './wattpilot.js';

export interface WattpilotAutomationStatus {
  supported: true;
  owner: string | null;
  epoch: string | null;
  revision: number | null;
  lastRevision: number;
  expiresAt: string | null;
  active: boolean;
  stopping: boolean;
  manualOverride: boolean;
  fence: number;
  error: string | null;
  deviceExpirySupported: false;
}
export type SupervisedWattpilotStatus = WattpilotStatus & { automation: WattpilotAutomationStatus };
interface Identity { owner: string; epoch: string; revision: number }
export interface WattpilotAutomaticCommand extends Identity {
  expiresAt: string;
  mode: 'normal' | 'eco';
  currentAmps: number;
  phases?: 1 | 3;
}
interface Fingerprint { mode: WattpilotStatus['mode']; currentAmps: number | null; phaseMode: WattpilotStatus['phaseMode'] }
interface Lease extends Identity {
  expiresAt: string;
  expected: Fingerprint;
  active: boolean;
  stopping: boolean;
  /** An activation/stop was uncertain; cached pause must not release cleanup. */
  compensating?: boolean;
}
interface Journal {
  version: 1;
  fence: number;
  owner: string | null;
  epoch: string | null;
  lastRevision: number;
  manualOverride: boolean;
  idle: Fingerprint | null;
  lease: Lease | null;
}
export interface WattpilotAutomationOptions {
  device(): Pick<Wattpilot, 'readStatus' | 'setControl' | 'disconnect'> & Partial<Pick<Wattpilot, 'pauseAndConfirm'>>;
  /** null is an explicit in-memory test seam; runtime supplies its private path. */
  journalPath: string | null;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
const storageError = 'The Wattpilot automation journal is unavailable; automatic control is blocked.';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const canonical = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fresh = (value: WattpilotStatus) => value.status === 'online' && value.ready && value.connected && !value.stale;
const fingerprint = (value: WattpilotStatus): Fingerprint => ({ mode: value.mode, currentAmps: value.currentAmps, phaseMode: value.phaseMode });
const same = (value: WattpilotStatus, expected: Fingerprint) => value.mode === expected.mode
  && value.currentAmps === expected.currentAmps && value.phaseMode === expected.phaseMode;
function validFingerprint(value: unknown): value is Fingerprint {
  return object(value) && ['pause', 'normal', 'eco', 'unknown'].includes(String(value.mode))
    && (value.currentAmps === null || integer(value.currentAmps)) && [null, 'auto', 1, 3].includes(value.phaseMode as never);
}
function validLease(value: unknown): value is Lease {
  return object(value) && token(value.owner) && token(value.epoch) && integer(value.revision, 1)
    && canonical(value.expiresAt) && validFingerprint(value.expected)
    && typeof value.active === 'boolean' && typeof value.stopping === 'boolean'
    && (value.compensating === undefined || typeof value.compensating === 'boolean');
}
function validJournal(value: unknown): value is Journal {
  if (!object(value) || value.version !== 1 || !integer(value.fence) || !integer(value.lastRevision)
    || typeof value.manualOverride !== 'boolean' || !(value.idle === null || validFingerprint(value.idle))
    || !(value.lease === null || validLease(value.lease))) return false;
  if (value.lease !== null && ((value.lease as Lease).revision > (value.lastRevision as number)
    || !['normal', 'eco'].includes((value.lease as Lease).expected.mode))) return false;
  return value.manualOverride ? value.owner === null && value.epoch === null
    : token(value.owner) && token(value.epoch) && value.idle !== null
      && (value.lease === null || (value.lease as Lease).owner === value.owner && (value.lease as Lease).epoch === value.epoch);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new WattpilotError('Invalid automatic Wattpilot request.', 400);
}
function identity(value: Record<string, unknown>): asserts value is Record<string, unknown> & Identity {
  if (!token(value.owner) || !token(value.epoch) || !integer(value.revision, 1)) throw new WattpilotError('A valid owner, epoch and positive revision are required.', 400);
}

/** Controller-owned software supervision; it is not a device-side watchdog. */
export function createWattpilotAutomation(options: WattpilotAutomationOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let journal: Journal = { version: 1, fence: 0, owner: null, epoch: null, lastRevision: 0, manualOverride: true, idle: null, lease: null };
  let loaded = false, corrupt = false, started = false, shuttingDown = false;
  let loading: Promise<void> | null = null;
  let queue = Promise.resolve();
  let timer: unknown;
  let error: string | null = null;
  let device: ReturnType<WattpilotAutomationOptions['device']> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let generation = 0;
  const work = new Set<{ owner: string; epoch: string; revision: number; abort: AbortController }>();
  const stopped = (value: WattpilotStatus) => {
    const measuredAt = value.powerObservedAt === null ? NaN : Date.parse(value.powerObservedAt);
    const age = now() - measuredAt;
    return fresh(value) && Number.isFinite(measuredAt) && age >= -5000 && age <= 30_000
      && value.mode === 'pause' && value.charging === false && value.allowedCharging === false && value.powerWatts === 0;
  };
  const adapter = () => device ??= options.device();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  };
  function abortAll() { generation++; for (const current of work) current.abort.abort(); }
  function assertRunning() {
    if (shuttingDown) throw new WattpilotError('Wattpilot supervision is shutting down.');
  }
  async function load() {
    if (loaded) return;
    if (!loading) loading = (async () => {
      if (options.journalPath !== null) {
        try {
          const value: unknown = JSON.parse(await readFile(options.journalPath, 'utf8'));
          if (!validJournal(value)) throw new Error();
          journal = value;
          // A restart reconciles an old activation, even if its old expiry is future.
          if (journal.lease) journal = { ...journal, lease: { ...journal.lease, stopping: true } };
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') { corrupt = true; error = storageError; }
        }
      }
      loaded = true;
    })();
    await loading;
  }
  async function save(value: Journal) {
    if (corrupt) throw new WattpilotError(storageError);
    if (options.journalPath !== null) {
      const temporary = `${options.journalPath}.${randomUUID()}.tmp`;
      let renamed = false;
      try {
        await mkdir(dirname(options.journalPath), { recursive: true });
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, options.journalPath);
        renamed = true;
        const directory = await open(dirname(options.journalPath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {
        // Rename may have committed even when directory fsync is uncertain.
        // Keep its fence/high-water in memory so recovery cannot write an older
        // authorization back over that possibly committed transaction.
        if (renamed) journal = value;
        error = storageError;
        throw new WattpilotError(storageError);
      }
      finally { await unlink(temporary).catch(() => {}); }
    }
    journal = value;
    error = null;
  }
  function nextFence() {
    if (!integer(journal.fence + 1)) { error = storageError; throw new WattpilotError(storageError); }
    return journal.fence + 1;
  }
  function info(): WattpilotAutomationStatus {
    const lease = journal.lease;
    return { supported: true, owner: journal.owner, epoch: journal.epoch, revision: lease?.revision ?? null,
      lastRevision: journal.lastRevision, expiresAt: lease?.expiresAt ?? null,
      active: Boolean(lease?.active && !lease.stopping), stopping: lease?.stopping ?? false,
      manualOverride: journal.manualOverride, fence: journal.fence, error, deviceExpirySupported: false };
  }
  function annotate(status: WattpilotStatus): SupervisedWattpilotStatus { return { ...status, automation: info() }; }
  async function readStatus() { await load(); return annotate(await adapter().readStatus()); }
  function requireEpoch(value: { owner: string; epoch: string }) {
    if (corrupt || error === storageError) throw new WattpilotError(storageError);
    if (journal.manualOverride || value.owner !== journal.owner || value.epoch !== journal.epoch) {
      throw new WattpilotError('The Wattpilot automation epoch was revoked.', 409);
    }
  }
  async function revoke() {
    abortAll();
    await save({ ...journal, fence: nextFence(), owner: null, epoch: null, manualOverride: true, idle: null, lease: null });
  }
  async function clearLease(status: WattpilotStatus) {
    await save({ ...journal, idle: journal.epoch ? fingerprint(status) : null, lease: null });
  }
  async function markStopping() {
    if (journal.lease && !journal.lease.stopping) {
      // A storage failure must not postpone the physical stop until lease expiry.
      // Restart already treats every recorded activation as pending cleanup.
      journal = { ...journal, lease: { ...journal.lease, stopping: true } };
      await save(journal);
    }
  }
  async function compensate(signal?: AbortSignal): Promise<WattpilotStatus> {
    if (journal.lease && !journal.lease.compensating) {
      journal = { ...journal, lease: { ...journal.lease, compensating: true } };
      // Still attempt the safe physical pause if persistence has failed. The
      // existing durable activation remains pending on restart in that case.
      await save(journal).catch(() => {});
    }
    const current = adapter();
    if (!current.pauseAndConfirm) {
      await current.setControl({ mode: 'pause' }, signal);
      throw new WattpilotError('Fresh Wattpilot stop confirmation is unavailable; cleanup remains pending.', 503, 'unknown');
    }
    const observed = await current.pauseAndConfirm(signal);
    if (!stopped(observed)) throw new WattpilotError('The owned Wattpilot stop is not confirmed; cleanup remains pending.', 503, 'unknown');
    await clearLease(observed);
    return observed;
  }
  async function cleanup(): Promise<WattpilotStatus> {
    const lease = journal.lease;
    const status = await adapter().readStatus();
    if (!lease) return status;
    if (!fresh(status)) throw new WattpilotError('The owned Wattpilot stop is not confirmed; cleanup remains pending.', 503, 'unknown');
    if (lease.active && !lease.compensating && !same(status, lease.expected)) {
      // A changed manual/foreign window must never be overwritten by an old expiry.
      await revoke();
      return status;
    }
    // An unacknowledged final frc=0 can still apply after a cached pause/zero.
    // Send a later ordered pause and require a post-pause status frame before
    // clearing either the intent journal or its retry responsibility.
    return compensate();
  }
  function arm() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (!started || shuttingDown || (!journal.epoch && !journal.lease)) return;
    const remaining = journal.lease && !journal.lease.stopping ? Date.parse(journal.lease.expiresAt) - now() : 5000;
    timer = setTimer(() => {
      timer = undefined;
      const lease = journal.lease;
      if (lease && now() >= Date.parse(lease.expiresAt)) {
        for (const current of work) if (current.epoch === lease.epoch && current.revision <= lease.revision) current.abort.abort();
      }
      void enqueue(supervise).catch(() => {}).finally(arm);
    }, Math.max(0, Math.min(5000, remaining)));
  }
  async function supervise() {
    await load();
    if (journal.lease && (journal.lease.stopping || now() >= Date.parse(journal.lease.expiresAt) || error === storageError)) {
      await markStopping().catch(() => {});
      try { await cleanup(); }
      catch { error = error === storageError ? error : 'The owned Wattpilot stop remains unconfirmed.'; }
      return;
    }
    if (!journal.epoch || journal.manualOverride) return;
    const status = await adapter().readStatus();
    if (!fresh(status)) {
      if (journal.lease) { await markStopping(); try { await cleanup(); } catch { error = 'The owned Wattpilot stop remains unconfirmed.'; } }
      return;
    }
    const expected = journal.lease?.expected ?? journal.idle;
    if (expected && !same(status, expected)) await revoke();
  }
  async function start() {
    assertRunning();
    await load();
    if (started) return;
    started = true;
    if (journal.lease) await enqueue(supervise);
    arm();
  }
  async function manual(command: WattpilotCommand, signal?: AbortSignal) {
    assertRunning();
    abortAll();
    return enqueue(async () => {
      await load();
      assertRunning();
      const old = journal.lease;
      try {
        // Retain old cleanup until it is confirmed paused, before a new manual
        // setting can become indistinguishable from the old automatic setting.
        await save({ ...journal, fence: nextFence(), owner: null, epoch: null, manualOverride: true,
          idle: null, lease: old ? { ...old, stopping: true } : null });
      } catch (failure) {
        if (old) { journal = { ...journal, lease: { ...old, stopping: true } }; arm(); }
        if (command.mode !== 'pause') throw failure;
        return annotate(await adapter().setControl(command, signal));
      }
      if (old) {
        if (command.mode === 'pause') {
          try { return annotate(await compensate(signal)); }
          finally { arm(); }
        }
        await cleanup();
      }
      const status = await adapter().setControl(command, signal);
      arm();
      return annotate(status);
    });
  }
  async function establish(value: unknown) {
    exact(value, ['owner', 'expectedFence']);
    if (!token(value.owner) || !integer(value.expectedFence)) throw new WattpilotError('A valid owner and expected fence are required.', 400);
    const request = value as { owner: string; expectedFence: number };
    await start();
    return enqueue(async () => {
      assertRunning();
      if (corrupt || error === storageError) throw new WattpilotError(storageError);
      if (request.expectedFence !== journal.fence) throw new WattpilotError('The Wattpilot automation fence changed.', 409);
      if (journal.lease) throw new WattpilotError('Previous Wattpilot cleanup is still pending.', 409);
      const status = await adapter().readStatus();
      if (!fresh(status) || status.mode !== 'pause') throw new WattpilotError('Pause the charger before establishing automatic control.', 409);
      await save({ ...journal, fence: nextFence(), owner: request.owner, epoch: randomUUID(), lastRevision: 0,
        manualOverride: false, idle: fingerprint(status), lease: null });
      arm();
      return annotate(status);
    });
  }
  function expiry(value: unknown) {
    if (!canonical(value) || Date.parse(value) <= now() || Date.parse(value) > now() + 120_000) {
      throw new WattpilotError('Automatic expiry must be canonical UTC, future and within 120 seconds.', 400);
    }
    return value;
  }
  async function control(value: unknown, signal?: AbortSignal) {
    exact(value, ['owner', 'epoch', 'revision', 'expiresAt', 'mode', 'currentAmps', 'phases']); identity(value);
    if (!['normal', 'eco'].includes(value.mode as string) || !integer(value.currentAmps, 6) || value.currentAmps > 16
      || ('phases' in value && value.phases !== 1 && value.phases !== 3)) throw new WattpilotError('Automatic charging requires normal/eco mode, 6–16 A and optional 1/3 phases.', 400);
    expiry(value.expiresAt);
    const request = value as unknown as WattpilotAutomaticCommand;
    await start();
    const captured = generation;
    const current = { owner: request.owner, epoch: request.epoch, revision: request.revision, abort: new AbortController() };
    const deadlineTimer = setTimer(() => current.abort.abort(), Math.max(0, Date.parse(request.expiresAt) - now()));
    const abort = () => current.abort.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    work.add(current);
    const check = () => {
      assertRunning(); requireEpoch(request); expiry(request.expiresAt);
      if (captured !== generation || current.abort.signal.aborted) throw new WattpilotError('The automatic request was superseded.', 409);
    };
    try {
      return await enqueue(async () => {
        await load(); check();
        if (journal.lease?.stopping || request.revision <= journal.lastRevision) throw new WattpilotError('The automatic revision was stopped or superseded.', 409);
        let status = await adapter().readStatus(); check();
        if (!fresh(status)) throw new WattpilotError('Fresh Wattpilot state is required.');
        const expected = journal.lease?.expected ?? journal.idle;
        if (!expected || !same(status, expected)) { await revoke(); throw new WattpilotError('Wattpilot settings changed outside automatic control.', 409); }
        if (journal.lease) {
          await save({ ...journal, lastRevision: request.revision, lease: { ...journal.lease, stopping: true } });
          arm();
          status = await cleanup(); check();
        }
        const target: Fingerprint = { mode: request.mode, currentAmps: request.currentAmps,
          phaseMode: request.phases ?? status.phaseMode };
        await save({ ...journal, lastRevision: request.revision, lease: { owner: request.owner, epoch: request.epoch,
          revision: request.revision, expiresAt: request.expiresAt, expected: target, active: false, stopping: false } });
        arm();
        try {
          check();
          const observed = await adapter().setControl({ mode: request.mode, currentAmps: request.currentAmps,
            ...(request.phases === undefined ? {} : { phases: request.phases }) }, current.abort.signal);
          check();
          if (!same(observed, target) || !fresh(observed)) throw new WattpilotError('The automatic Wattpilot setting was not confirmed.', 503, 'unknown');
          await save({ ...journal, lease: { ...journal.lease!, active: true } });
          arm();
          return annotate(observed);
        } catch (failure) {
          await markStopping().catch(() => {});
          arm();
          const cause = failure instanceof WattpilotError ? failure : new WattpilotError('Automatic Wattpilot control failed.');
          throw new WattpilotError(cause.message, cause.statusCode, 'unknown');
        }
      });
    } finally { clearTimer(deadlineTimer); work.delete(current); signal?.removeEventListener('abort', abort); }
  }
  async function renew(value: unknown) {
    exact(value, ['owner', 'epoch', 'revision', 'expiresAt']); identity(value); expiry(value.expiresAt);
    const request = value as unknown as Identity & { expiresAt: string };
    await start();
    return enqueue(async () => {
      await load(); assertRunning(); requireEpoch(request); expiry(request.expiresAt);
      const lease = journal.lease;
      if (!lease || !lease.active || lease.stopping || lease.revision !== request.revision
        || now() >= Date.parse(lease.expiresAt)) throw new WattpilotError('An expired or superseded automatic lease cannot be renewed.', 409);
      const status = await adapter().readStatus();
      requireEpoch(request); expiry(request.expiresAt);
      if (now() >= Date.parse(lease.expiresAt)) { await markStopping(); arm(); throw new WattpilotError('The automatic lease expired during renewal.', 409); }
      if (!fresh(status)) { await markStopping(); arm(); throw new WattpilotError('Fresh state is required to renew automatic control.'); }
      if (!same(status, lease.expected)) { await revoke(); throw new WattpilotError('Wattpilot settings changed outside automatic control.', 409); }
      await save({ ...journal, lease: { ...lease, expiresAt: request.expiresAt } }); arm();
      return annotate(status);
    });
  }
  async function stop(value: unknown) {
    exact(value, ['owner', 'epoch', 'revision']); identity(value);
    const request = value as unknown as Identity;
    await start();
    for (const current of work) if (current.owner === request.owner && current.epoch === request.epoch && current.revision <= request.revision) current.abort.abort();
    return enqueue(async () => {
      await load(); assertRunning(); requireEpoch(request);
      const lease = journal.lease;
      try {
        await save({ ...journal, lastRevision: Math.max(journal.lastRevision, request.revision),
          lease: lease && lease.revision <= request.revision ? { ...lease, stopping: true } : lease });
      } catch (failure) {
        if (lease && lease.revision <= request.revision) {
          journal = { ...journal, lease: { ...lease, stopping: true } }; arm();
          await cleanup().catch(() => {});
        }
        throw failure;
      }
      arm();
      return annotate(lease && lease.revision <= request.revision ? await cleanup() : await adapter().readStatus());
    });
  }
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true; abortAll();
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (loaded && !journal.lease) {
      const disconnected = device?.disconnect();
      shutdownPromise = Promise.all([queue, disconnected]).then(() => {});
    } else {
      shutdownPromise = enqueue(async () => {
        await load();
        try { if (journal.lease) { await markStopping().catch(() => {}); await cleanup(); } }
        finally { await device?.disconnect(); }
      });
    }
    return shutdownPromise;
  }
  return { start, readStatus, manual, establish, control, renew, stop, shutdown, status: info };
}
export type WattpilotAutomation = ReturnType<typeof createWattpilotAutomation>;
