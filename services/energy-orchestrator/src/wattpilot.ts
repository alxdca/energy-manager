import { resolveControllerUrl, type StatusOptions } from './status.js';
import type { CarActivation, CarLeaseRequest } from './car-types.js';

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

export interface WattpilotTelemetry {
  status: 'not_configured' | 'online' | 'stale' | 'offline' | 'error';
  configured: boolean;
  connected: boolean;
  ready: boolean;
  stale: boolean;
  observedAt: string | null;
  powerObservedAt: string | null;
  error: string | null;
  controlEnabled: boolean;
  mode: 'pause' | 'eco' | 'normal' | 'unknown';
  carConnected: boolean | null;
  charging: boolean | null;
  allowedCharging: boolean | null;
  currentAmps: number | null;
  phaseMode: 'auto' | 1 | 3 | null;
  phaseSwitchingSupported: boolean;
  powerWatts: number | null;
  sessionEnergyWh: number | null;
  totalEnergyWh: number | null;
  energyCounterSource?: string | null;
  limits: { minCurrentAmps: 6; maxCurrentAmps: number | null };
  deviceLeaseSupported: false;
  automation: WattpilotAutomationStatus | null;
}

export interface CarControl {
  available: boolean;
  canPause: boolean;
  mode: WattpilotTelemetry['mode'];
  currentAmps: number | null;
  phaseMode: WattpilotTelemetry['phaseMode'];
  phaseSwitchingSupported: boolean;
  powerKw: number | null;
  carConnected: boolean | null;
  charging: boolean | null;
  limits: WattpilotTelemetry['limits'];
  error: string | null;
  canReturnToAuto?: boolean;
  automated?: boolean;
}

export type WattpilotCommand = { mode: 'pause'; currentAmps?: never; phases?: never }
  | { mode: 'eco' | 'normal'; currentAmps: number; phases?: 1 | 3 };

export interface WattpilotOptions extends StatusOptions {
  beforeStart?: (command: WattpilotCommand, observed: WattpilotTelemetry, signal?: AbortSignal) => Promise<void>;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
}

export class WattpilotControlError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 413 | 502 | 503 | 504 = 502, readonly unknownOutcome = false) {
    super(message);
    this.name = 'WattpilotControlError';
  }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const freshnessMs = 30_000;
const messages = {
  invalid: 'Le contrôleur a renvoyé un état Wattpilot invalide.',
  offline: 'La connexion au Wattpilot est indisponible.',
  stale: 'Les mesures du Wattpilot sont anciennes. Attendez une nouvelle mesure.',
  disabled: 'Activez le pilotage Wattpilot dans le contrôleur énergétique.',
  limits: 'Les limites de courant du Wattpilot sont indisponibles.',
  cancelled: 'La requête Wattpilot a été annulée avant l’envoi de la commande.',
};

function empty(status: WattpilotTelemetry['status'], error: string | null = null): WattpilotTelemetry {
  return { status, configured: false, connected: false, ready: false, stale: false,
    observedAt: null, powerObservedAt: null, error, controlEnabled: false, mode: 'unknown',
    carConnected: null, charging: null, allowedCharging: null, currentAmps: null,
    phaseMode: null, phaseSwitchingSupported: false,
    powerWatts: null, sessionEnergyWh: null, totalEnergyWh: null,
    limits: { minCurrentAmps: 6, maxCurrentAmps: null }, deviceLeaseSupported: false, automation: null };
}

export function unavailableWattpilot(status: 'not_configured' | 'offline' | 'error' = 'not_configured', error: string | null = null): WattpilotTelemetry {
  return empty(status, error);
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const date = new Date(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(date.getTime()) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return date.toISOString();
}

function fresh(value: string | null, now: Date): boolean {
  if (value === null) return false;
  const age = now.getTime() - Date.parse(value);
  return age >= -5000 && age <= freshnessMs;
}

function ageSnapshot(value: WattpilotTelemetry, now: Date): WattpilotTelemetry {
  const ready = value.status === 'online' && value.connected && value.ready && !value.stale && fresh(value.observedAt, now);
  const becameStale = value.status === 'online' && !ready;
  return { ...value, ready,
    status: becameStale ? 'stale' : value.status,
    stale: becameStale || value.stale,
    powerWatts: ready && fresh(value.powerObservedAt, now) ? value.powerWatts : null,
    error: becameStale ? messages.stale : value.error,
    limits: { ...value.limits },
    automation: value.automation ? { ...value.automation } : null,
  };
}

function parseAutomation(value: unknown): WattpilotAutomationStatus | null {
  if (!object(value) || value.supported !== true || value.deviceExpirySupported !== false
    || !['active', 'stopping', 'manualOverride'].every(key => typeof value[key] === 'boolean')
    || !Number.isSafeInteger(value.fence) || (value.fence as number) < 0
    || !Number.isSafeInteger(value.lastRevision) || (value.lastRevision as number) < 0
    || !(value.revision === null || Number.isSafeInteger(value.revision) && (value.revision as number) > 0)
    || !['owner', 'epoch'].every(key => value[key] === null || typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value[key] as string))
    || !(value.expiresAt === null || timestamp(value.expiresAt) === value.expiresAt)
    || !(value.error === null || typeof value.error === 'string')
    || (typeof value.revision === 'number' && value.revision > (value.lastRevision as number))
    || (value.active && (value.owner === null || value.epoch === null || value.revision === null || value.expiresAt === null))
    || (value.epoch !== null && value.owner === null)) return null;
  return { supported: true, owner: value.owner as string | null, epoch: value.epoch as string | null,
    revision: value.revision as number | null, lastRevision: value.lastRevision as number, expiresAt: value.expiresAt as string | null,
    active: value.active as boolean, stopping: value.stopping as boolean, manualOverride: value.manualOverride as boolean,
    fence: value.fence as number, error: value.error ? 'La supervision automatique Wattpilot est indisponible.' : null, deviceExpirySupported: false };
}

function parseStatus(body: unknown, now: Date): WattpilotTelemetry {
  if (!object(body) || body.success !== true || !object(body.wattpilot)) throw new WattpilotControlError(messages.invalid);
  const value = body.wattpilot;
  if (!['not_configured', 'online', 'stale', 'offline', 'error'].includes(value.status as string)
    || !['configured', 'connected', 'ready', 'stale', 'controlEnabled'].every(key => typeof value[key] === 'boolean')
    || !['pause', 'eco', 'normal', 'unknown'].includes(value.mode as string)
    || !object(value.limits) || value.limits.minCurrentAmps !== 6 || value.deviceLeaseSupported !== false) {
    throw new WattpilotControlError(messages.invalid);
  }
  const observedAt = timestamp(value.observedAt);
  if ((value.observedAt !== null && observedAt === null)
    || (observedAt !== null && Date.parse(observedAt) > now.getTime() + 5000)
    || (value.status === 'online' && (!value.configured || !value.connected || !value.ready || value.stale || observedAt === null))
    || (value.status !== 'online' && value.ready)
    || (value.status === 'not_configured' && value.configured)) throw new WattpilotControlError(messages.invalid);
  const max = nonnegative(value.limits.maxCurrentAmps);
  const maxCurrentAmps = max !== null && Number.isInteger(max) && max >= 6 && max <= 32 ? Math.min(16, max) : null;
  const current = nonnegative(value.currentAmps);
  const powerObservedAt = timestamp(value.powerObservedAt);
  const phaseSwitchingSupported = value.phaseSwitchingSupported === true && ['auto', 1, 3].includes(value.phaseMode as string | number);
  const result: WattpilotTelemetry = {
    status: value.status as WattpilotTelemetry['status'], configured: value.configured as boolean,
    connected: value.connected as boolean, ready: value.ready as boolean, stale: value.stale as boolean,
    observedAt, powerObservedAt,
    error: value.status === 'error' || value.status === 'offline' ? messages.offline : value.status === 'stale' ? messages.stale : null,
    controlEnabled: value.controlEnabled as boolean, mode: value.mode as WattpilotTelemetry['mode'],
    carConnected: bool(value.carConnected), charging: bool(value.charging), allowedCharging: bool(value.allowedCharging),
    currentAmps: current !== null && Number.isInteger(current) && current >= 6 && current <= 32 ? current : null,
    phaseMode: phaseSwitchingSupported ? value.phaseMode as WattpilotTelemetry['phaseMode'] : null,
    phaseSwitchingSupported,
    powerWatts: nonnegative(value.powerWatts), sessionEnergyWh: nonnegative(value.sessionEnergyWh), totalEnergyWh: nonnegative(value.totalEnergyWh),
    energyCounterSource: typeof value.energyCounterSource === 'string' && value.energyCounterSource.length <= 256 ? value.energyCounterSource : null,
    limits: { minCurrentAmps: 6, maxCurrentAmps }, deviceLeaseSupported: false, automation: parseAutomation(value.automation),
  };
  return ageSnapshot(result, now);
}

export function toCarControl(value: WattpilotTelemetry): CarControl {
  const canPause = value.status === 'online' && value.ready && !value.stale && value.controlEnabled;
  const validLimits = value.limits.maxCurrentAmps !== null && value.limits.maxCurrentAmps >= 6;
  const available = canPause && validLimits && value.carConnected === true;
  return { available, canPause, mode: value.ready ? value.mode : 'unknown', currentAmps: value.currentAmps,
    phaseMode: value.ready ? value.phaseMode : null, phaseSwitchingSupported: value.ready && value.phaseSwitchingSupported,
    powerKw: value.powerWatts === null ? null : value.powerWatts / 1000,
    carConnected: value.carConnected, charging: value.charging, limits: { ...value.limits },
    error: value.error ?? (!value.configured ? 'Wattpilot non configuré.' : !value.ready ? messages.offline
      : !value.controlEnabled ? messages.disabled : !validLimits ? messages.limits
        : value.carConnected !== true ? 'Branchez la voiture pour lancer la recharge.' : null),
  };
}

export function validateWattpilotCommand(value: unknown): WattpilotCommand {
  if (!object(value) || !['pause', 'eco', 'normal'].includes(value.mode as string)
    || Object.keys(value).some(key => !['mode', 'currentAmps', 'phases'].includes(key))
    || ('phases' in value && value.phases !== 1 && value.phases !== 3)
    || (value.mode === 'pause' ? 'currentAmps' in value || 'phases' in value
      : typeof value.currentAmps !== 'number' || !Number.isInteger(value.currentAmps) || value.currentAmps < 6 || value.currentAmps > 16)) {
    throw new WattpilotControlError('Choisissez Pause, ou Éco/Normal avec un courant entier entre 6 et 16 A et, si souhaité, 1 ou 3 phases.', 400);
  }
  return value.mode === 'pause' ? { mode: 'pause' } : { mode: value.mode as 'eco' | 'normal', currentAmps: value.currentAmps as number,
    ...('phases' in value ? { phases: value.phases as 1 | 3 } : {}) };
}

export function createWattpilotService(options: WattpilotOptions = {}) {
  const base = resolveControllerUrl(options);
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const readTimeoutMs = options.readTimeoutMs ?? 6500;
  const writeTimeoutMs = options.writeTimeoutMs ?? 35_000;
  if (![readTimeoutMs, writeTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('Wattpilot timeouts must be finite and positive');
  let generation = 0;
  let mutating = false;
  let cached: { at: number; value: WattpilotTelemetry } | null = null;
  let pending: { generation: number; promise: Promise<WattpilotTelemetry> } | null = null;

  function cancelled(signal?: AbortSignal) {
    if (signal?.aborted) throw new WattpilotControlError(messages.cancelled, 409);
  }

  async function upstream(path: string, command?: unknown, signal?: AbortSignal): Promise<WattpilotTelemetry> {
    cancelled(signal);
    if (!base) throw new WattpilotControlError('Le contrôleur énergétique n’est pas configuré.', 503);
    const url = new URL(base.toString());
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const writing = command !== undefined;
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        controller.abort();
        reject(new WattpilotControlError(writing && sent ? 'La commande Wattpilot a été interrompue. Son résultat est inconnu.' : messages.cancelled, 409, writing && sent));
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new WattpilotControlError(writing ? 'La commande Wattpilot a expiré. Son résultat est inconnu.' : 'La demande d’état Wattpilot a expiré.', 504, writing && sent));
      }, writing ? writeTimeoutMs : readTimeoutMs);
    });
    try {
      return await Promise.race([
        (async () => {
          cancelled(signal);
          sent = true;
          const response = await request(url, { method: writing ? 'POST' : 'GET', signal: controller.signal,
            redirect: 'error', cache: 'no-store', headers: { accept: 'application/json', ...(writing ? { 'content-type': 'application/json' } : {}) },
            ...(writing ? { body: JSON.stringify(command) } : {}),
          });
          const body: unknown = await response.json().catch(() => { throw new WattpilotControlError(messages.invalid, 502, writing); });
          if (!response.ok) {
            const unknownOutcome = writing && (object(body) && body.outcome === 'unknown' || response.status >= 500);
            const status = response.status === 400 || response.status === 409 || response.status === 413 || response.status === 503 || response.status === 504 ? response.status : 502;
            throw new WattpilotControlError(unknownOutcome ? 'La commande Wattpilot n’a pas été confirmée. Son résultat est inconnu.'
              : writing ? 'Le contrôleur a refusé la commande Wattpilot.' : messages.offline, status, unknownOutcome);
          }
          try { return parseStatus(body, now()); }
          catch (error) {
            if (writing) throw new WattpilotControlError('Le contrôleur n’a pas confirmé l’état Wattpilot après la commande.', 502, true);
            throw error;
          }
        })(), interrupted,
      ]);
    } catch (error) {
      if (error instanceof WattpilotControlError) throw error;
      throw new WattpilotControlError(writing ? 'La commande Wattpilot n’a pas pu être confirmée. Son résultat est inconnu.' : messages.offline, 502, writing && sent);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function readStatus(readOptions: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<WattpilotTelemetry> {
    cancelled(readOptions.signal);
    if (!base) return empty('not_configured');
    if (!readOptions.fresh && cached && now().getTime() >= cached.at && now().getTime() - cached.at < 2000) return ageSnapshot(cached.value, now());
    const readingGeneration = generation;
    if (!pending || pending.generation !== readingGeneration) {
      const previous = cached?.value;
      const promise = upstream('/wattpilot/status').catch(error => {
        const message = error instanceof WattpilotControlError ? error.message : messages.offline;
        return previous?.observedAt
          ? { ...previous, status: 'stale' as const, ready: false, stale: true, connected: false, powerWatts: null, error: message }
          : empty('offline', message);
      }).then(value => {
        if (generation === readingGeneration) cached = { at: now().getTime(), value };
        return value;
      });
      pending = { generation: readingGeneration, promise };
      void promise.finally(() => { if (pending?.promise === promise) pending = null; });
    }
    const reading = pending.promise;
    if (!readOptions.signal) return ageSnapshot(await reading, now());
    const signal = readOptions.signal;
    let abort!: () => void;
    try {
      return ageSnapshot(await Promise.race([reading, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new WattpilotControlError(messages.cancelled, 409));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]), now());
    } finally { signal.removeEventListener('abort', abort); }
  }

  async function setControl(value: WattpilotCommand, signal?: AbortSignal): Promise<WattpilotTelemetry> {
    const command = validateWattpilotCommand(value);
    cancelled(signal);
    if (mutating) throw new WattpilotControlError('Une commande Wattpilot est déjà en cours.', 409);
    mutating = true;
    generation++;
    cached = null;
    try {
      const observed = await readStatus({ fresh: true, signal });
      cancelled(signal);
      const control = toCarControl(observed);
      if (!control.canPause) throw new WattpilotControlError(control.error ?? messages.offline, 503);
      if (command.mode !== 'pause') {
        if (!control.available) throw new WattpilotControlError(control.error ?? messages.limits, 503);
        if (control.limits.maxCurrentAmps === null || command.currentAmps > control.limits.maxCurrentAmps) {
          throw new WattpilotControlError('Le courant demandé dépasse la limite du Wattpilot.', 400);
        }
        if (command.phases !== undefined && !observed.phaseSwitchingSupported) {
          throw new WattpilotControlError('La sélection des phases n’est pas disponible sur cette borne.', 503);
        }
        await options.beforeStart?.(command, observed, signal);
      }
      cancelled(signal);
      const result = await upstream('/wattpilot/set-control', command, signal);
      if (!result.ready || result.status !== 'online' || result.mode !== command.mode
        || command.mode !== 'pause' && (result.currentAmps !== command.currentAmps
          || command.phases !== undefined && (!result.phaseSwitchingSupported || result.phaseMode !== command.phases))) {
        throw new WattpilotControlError('Le mode, le courant ou les phases Wattpilot n’ont pas pu être confirmés.', 502, true);
      }
      return result;
    } finally {
      generation++;
      cached = null;
      mutating = false;
    }
  }

  function validateLease(request: CarLeaseRequest, expiry = true) {
    if (!request || !['owner', 'epoch'].every(key => typeof request[key as 'owner' | 'epoch'] === 'string'
      && /^[A-Za-z0-9_-]{1,80}$/.test(request[key as 'owner' | 'epoch']))
      || !Number.isSafeInteger(request.revision) || request.revision <= 0) throw new WattpilotControlError('Session automatique Wattpilot invalide.', 400);
    if (expiry && (timestamp(request.expiresAt) !== request.expiresAt || Date.parse(request.expiresAt) <= now().getTime()
      || Date.parse(request.expiresAt) > now().getTime() + 120_000)) throw new WattpilotControlError('Échéance automatique Wattpilot invalide.', 400);
  }
  async function automaticMutation(path: string, body: unknown, signal?: AbortSignal, preflight?: () => Promise<void>) {
    cancelled(signal);
    if (mutating) throw new WattpilotControlError('Une commande Wattpilot est déjà en cours.', 409);
    mutating = true;
    generation++; cached = null;
    try {
      await preflight?.();
      cancelled(signal);
      const result = await upstream(path, body, signal);
      if (!result.automation) throw new WattpilotControlError('La supervision automatique Wattpilot n’a pas pu être confirmée.', 502, true);
      return result;
    } finally { generation++; cached = null; mutating = false; }
  }
  function establishAutomation(owner: string, expectedFence: number, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(owner) || !Number.isSafeInteger(expectedFence) || expectedFence < 0) {
      throw new WattpilotControlError('Autorisation automatique Wattpilot invalide.', 400);
    }
    return automaticMutation('/wattpilot/automation-epoch', { owner, expectedFence }, signal);
  }
  function activateAutomation(request: CarActivation, signal?: AbortSignal, isCurrent = () => true) {
    validateLease(request);
    const command = validateWattpilotCommand({ mode: request.mode, currentAmps: request.currentAmps,
      ...(request.phases === undefined ? {} : { phases: request.phases }) });
    if (command.mode !== 'normal' && command.mode !== 'eco') throw new WattpilotControlError('Le mode automatique Wattpilot est invalide.', 400);
    return automaticMutation('/wattpilot/automation-control', request, signal, async () => {
      const observed = await readStatus({ fresh: true, signal });
      const info = observed.automation;
      const control = toCarControl(observed);
      if (!(command.mode === 'eco' ? control.canPause : control.available) || !info || info.epoch !== request.epoch || info.owner !== request.owner
        || info.manualOverride || info.stopping || info.error) throw new WattpilotControlError('La session automatique Wattpilot n’est plus disponible.', 409);
      if (control.limits.maxCurrentAmps !== null && request.currentAmps > control.limits.maxCurrentAmps) throw new WattpilotControlError('Le courant automatique dépasse la limite de la borne.', 400);
      if (command.mode === 'normal' && request.phases !== undefined && !observed.phaseSwitchingSupported) throw new WattpilotControlError('La sélection des phases n’est pas disponible.', 503);
      if (command.mode === 'normal') await options.beforeStart?.(command, observed, signal);
      if (!isCurrent() || Date.parse(request.expiresAt) <= now().getTime()) throw new WattpilotControlError('Le plan de charge voiture a été remplacé ou a expiré.', 409);
    }).then(result => {
      if (!result.ready || result.mode !== request.mode || result.currentAmps !== request.currentAmps
        || request.phases !== undefined && result.phaseMode !== request.phases) {
        throw new WattpilotControlError('Le mode et le courant automatiques de la borne n’ont pas pu être confirmés.', 502, true);
      }
      return result;
    });
  }
  function renewAutomation(request: CarLeaseRequest, signal?: AbortSignal) {
    validateLease(request);
    return automaticMutation('/wattpilot/automation-renew', request, signal);
  }
  async function stopAutomation(request: Pick<CarLeaseRequest, 'owner' | 'epoch' | 'revision'>): Promise<WattpilotTelemetry> {
    validateLease({ ...request, expiresAt: '' }, false);
    // A safety stop must reach the controller even while an activation is pending.
    generation++; cached = null;
    try {
      const result = await upstream('/wattpilot/automation-stop', request);
      if (!result.automation) throw new WattpilotControlError('L’arrêt automatique Wattpilot n’a pas pu être confirmé.', 502, true);
      return result;
    } finally { generation++; cached = null; }
  }

  return { readStatus, setControl, establishAutomation, activateAutomation, renewAutomation, stopAutomation };
}
