import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fetchTeslaAuth, teslaTokenUrl } from './tesla-auth.js';

export interface CarTelemetry {
  status: 'not_configured' | 'connecting' | 'online' | 'asleep' | 'offline' | 'stale' | 'auth_required' | 'error';
  vehicleName: string | null;
  socPercent: number | null;
  chargeLimitPercent: number | null;
  chargingState: string | null;
  observedAt: string | null;
  error: string | null;
}
interface Tokens { refreshToken: string; accessToken: string; expiresAt: number }
interface LastCharge {
  vin: string;
  vehicleName: string;
  socPercent: number;
  chargeLimitPercent: number | null;
  observedAt: string;
}
export interface TeslaOptions {
  /** null disables disk persistence in tests. Runtime always uses a private file. */
  tokensPath?: string | null;
  vin?: string;
  fetch?: typeof globalThis.fetch;
  authFetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Test seam for the bounded, explicitly requested automatic-charge wake path. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  wakeTimeoutMs?: number;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && v.length >= 8 && v.length <= 8192 && !/\s/.test(v);
const percent = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const empty = { vehicleName: null, socPercent: null, chargeLimitPercent: null, chargingState: null, observedAt: null, error: null };
const apiBase = 'https://owner-api.teslamotors.com';
const authUrl = teslaTokenUrl;
const freshnessMs = 10 * 60_000;
class TeslaError extends Error {
  constructor(message: string, readonly state: CarTelemetry['status'] = 'error', readonly retryMs = 300_000, readonly refreshable = false) { super(message); }
}

/** Passive Owner API reads, plus an explicit bounded automatic-charge wake path. */
export function createTeslaService(options: TeslaOptions = {}) {
  const path = options.tokensPath === undefined
    ? process.env.TESLA_TOKENS_PATH?.trim() || fileURLToPath(new URL('../data/tesla-tokens.json', import.meta.url)) : options.tokensPath;
  const vin = (options.vin ?? process.env.TESLA_VIN ?? '').trim().toUpperCase();
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('TESLA_VIN doit contenir un VIN valide de 17 caractères.');
  const request = options.fetch ?? globalThis.fetch;
  const authRequest = options.authFetch ?? options.fetch ?? fetchTeslaAuth;
  const now = options.now ?? (() => new Date());
  let credentials: Tokens | null = null;
  let lastCharge: LastCharge | null = null;
  let state: CarTelemetry = { ...empty, status: 'not_configured' };
  let nextReadAt = 0;
  let pending: Promise<void> | null = null;
  let editing = false;
  let mutation: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let unsaved = false;
  let wakePending: Promise<CarTelemetry> | null = null;
  let wakeAbort: AbortController | null = null;
  let nextWakeAt = 0;
  const wakeTimeoutMs = options.wakeTimeoutMs ?? 60_000;
  if (!Number.isFinite(wakeTimeoutMs) || wakeTimeoutMs <= 0 || wakeTimeoutMs > 60_000) throw new Error('Tesla wake timeout must be within sixty seconds.');
  const sleep = options.sleep ?? ((milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(handle); reject(new TeslaError('La demande Tesla a été annulée.')); };
    const handle = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  }));

  const ready = (async () => {
    if (!path) return;
    try {
      const stored: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!object(stored) || !token(stored.refreshToken) || !token(stored.accessToken)
        || typeof stored.expiresAt !== 'number' || !Number.isFinite(stored.expiresAt)) throw new Error();
      await chmod(path, 0o600);
      credentials = { refreshToken: stored.refreshToken, accessToken: stored.accessToken, expiresAt: stored.expiresAt };
      state.status = 'connecting';
      const cached = stored.lastCharge;
      if (object(cached) && typeof cached.vin === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(cached.vin)
        && (!vin || cached.vin === vin) && typeof cached.vehicleName === 'string' && cached.vehicleName.length <= 100
        && percent(cached.socPercent) && (cached.chargeLimitPercent === null || percent(cached.chargeLimitPercent))
        && typeof cached.observedAt === 'string') {
        const observed = Date.parse(cached.observedAt);
        if (Number.isFinite(observed) && observed > 0 && observed <= now().getTime() + 5000
          && new Date(observed).toISOString() === cached.observedAt) {
          lastCharge = { vin: cached.vin, vehicleName: cached.vehicleName, socPercent: cached.socPercent,
            chargeLimitPercent: cached.chargeLimitPercent, observedAt: cached.observedAt };
          // A saved reading is historical until Tesla confirms a current observation.
          state = { ...empty, status: 'stale', vehicleName: lastCharge.vehicleName, socPercent: lastCharge.socPercent,
            chargeLimitPercent: lastCharge.chargeLimitPercent, observedAt: lastCharge.observedAt };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        state = { ...empty, status: 'error', error: 'Le fichier de connexion Tesla est illisible. Reconnectez le compte.' };
      }
    }
  })();

  async function save(value: Tokens) {
    if (!path) return;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify({ ...value, ...(lastCharge ? { lastCharge } : {}) }), { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } catch {
      throw new TeslaError('Impossible de conserver les données Tesla. Vérifiez les droits du répertoire de données.');
    } finally { await rm(temp, { force: true }).catch(() => {}); }
  }

  async function json(url: string, init: RequestInit = {}): Promise<unknown> {
    if (init.signal?.aborted) throw new TeslaError('La demande Tesla a été annulée.');
    const abort = new AbortController();
    const signal = init.signal;
    let cancelled!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      cancelled = () => { abort.abort(); reject(new TeslaError('La demande Tesla a été annulée.')); };
      signal?.addEventListener('abort', cancelled, { once: true });
      if (signal?.aborted) cancelled();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await (url === authUrl ? authRequest : request)(url, { ...init, signal: abort.signal, redirect: 'error', cache: 'no-store',
            headers: { accept: 'application/json', 'user-agent': 'EnergyManager/0.1', ...init.headers } });
          if (response.status === 401) throw new TeslaError('La connexion Tesla a expiré. Reconnectez le compte.', 'auth_required', 300_000, url !== authUrl);
          if (url === authUrl && response.status === 400) {
            const error: unknown = await response.json();
            if (object(error) && ['invalid_grant', 'login_required'].includes(String(error.error))) {
              throw new TeslaError('Le jeton Tesla a expiré. Reconnectez le compte.', 'auth_required');
            }
          }
          if (response.status === 403) {
            const body: unknown = await response.json().catch(() => null);
            if (object(body) && body.error === 'account disabled: EXCEEDED_LIMIT') {
              throw new TeslaError('La limite Tesla est atteinte. Nouvelle tentative dans quinze minutes.', 'error', 900_000);
            }
            throw new TeslaError('Tesla refuse cet accès. Vérifiez les autorisations du compte et la disponibilité de l’API Owner.', 'auth_required');
          }
          if (response.status === 408) throw new TeslaError('La voiture est indisponible ou en veille.', 'asleep');
          if (response.status === 429) {
            const raw = response.headers.get('retry-after');
            const seconds = raw === null ? NaN : Number(raw);
            const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw ?? '') - now().getTime();
            throw new TeslaError('Trop de demandes à Tesla. Nouvelle tentative différée.', 'error', Math.max(300_000, Number.isFinite(delay) ? delay : 300_000));
          }
          if (!response.ok) throw new TeslaError(`La demande Tesla a échoué (HTTP ${response.status}).`);
          return await response.json();
        })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => { abort.abort(); reject(new TeslaError('La demande Tesla a expiré.')); }, 10_000); }), cancellation,
      ]);
    } catch (error) {
      // Never include an upstream body, URL, token or raw transport error in logs/API.
      if (error instanceof TeslaError) throw error;
      throw new TeslaError('La réponse Tesla est indisponible ou invalide.');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancelled); }
  }

  async function exchange(refreshToken: string, signal?: AbortSignal): Promise<Tokens> {
    const body = await json(authUrl, { method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'ownerapi', scope: 'openid email offline_access', refresh_token: refreshToken }) });
    if (object(body) && ['invalid_grant', 'login_required'].includes(String(body.error))) {
      throw new TeslaError('Le jeton Tesla a expiré. Reconnectez le compte.', 'auth_required');
    }
    if (!object(body) || !token(body.access_token) || typeof body.expires_in !== 'number'
      || !Number.isFinite(body.expires_in) || body.expires_in < 60
      || !Number.isFinite(now().getTime() + body.expires_in * 1000)
      || (body.refresh_token !== undefined && body.refresh_token !== null && !token(body.refresh_token))) {
      throw new TeslaError('Tesla a renvoyé des jetons invalides.');
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token as string || refreshToken,
      expiresAt: now().getTime() + body.expires_in * 1000 };
  }

  async function renew(signal?: AbortSignal) {
    const renewed = await exchange(credentials!.refreshToken, signal);
    // Keep rotated tokens in memory even if disk fails, so a retry cannot reuse the consumed token.
    credentials = renewed;
    unsaved = true;
    await save(renewed);
    unsaved = false;
  }

  async function get(pathname: string, signal?: AbortSignal): Promise<unknown> {
    return json(`${apiBase}${pathname}`, { method: 'GET', signal, headers: { authorization: `Bearer ${credentials!.accessToken}` } });
  }

  async function vehicle(signal?: AbortSignal) {
    const body = await get('/api/1/products', signal);
    if (!object(body) || !Array.isArray(body.response)) throw new TeslaError('La liste des véhicules Tesla est invalide.');
    const cars = body.response.filter((v): v is Record<string, unknown> => object(v) && typeof v.vin === 'string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(v.vin));
    const car = vin ? cars.find(v => v.vin === vin) : cars.length === 1 ? cars[0] : undefined;
    if (!car) throw new TeslaError(vin ? 'Le véhicule TESLA_VIN est introuvable sur ce compte.' : cars.length > 1
      ? 'Plusieurs voitures sont présentes. Configurez TESLA_VIN pour choisir le véhicule.' : 'Aucune voiture n’est accessible sur ce compte.');
    if (lastCharge && lastCharge.vin !== car.vin) {
      lastCharge = null;
      state = { ...empty, status: 'connecting' };
      unsaved = true;
      await save(credentials!);
      unsaved = false;
    }
    return { vin: car.vin as string, name: typeof car.display_name === 'string' ? car.display_name.slice(0, 100) : 'Tesla' };
  }

  async function collectCharge(car: { vin: string; name: string }, signal?: AbortSignal) {
    const data = await get(`/api/1/vehicles/${car.vin}/vehicle_data?endpoints=charge_state`, signal);
    if (!object(data) || !object(data.response) || !object(data.response.charge_state)) throw new TeslaError('Le niveau de charge Tesla est indisponible.');
    const charge = data.response.charge_state;
    if (!percent(charge.battery_level) || typeof charge.timestamp !== 'number' || !Number.isFinite(charge.timestamp)
      || charge.timestamp <= 0 || charge.timestamp > now().getTime() + 5000 || charge.timestamp > 8.64e15) {
      throw new TeslaError('Le niveau de charge ou son horodatage Tesla est invalide.');
    }
    state = { status: now().getTime() - charge.timestamp > freshnessMs ? 'stale' : 'online', vehicleName: car.name,
      socPercent: charge.battery_level, chargeLimitPercent: percent(charge.charge_limit_soc) ? charge.charge_limit_soc : null,
      chargingState: ['Charging', 'Complete', 'Stopped', 'Disconnected', 'NoPower', 'Starting'].includes(String(charge.charging_state)) ? String(charge.charging_state) : null,
      observedAt: new Date(charge.timestamp).toISOString(), error: null };
    lastCharge = { vin: car.vin, vehicleName: car.name, socPercent: charge.battery_level,
      chargeLimitPercent: state.chargeLimitPercent, observedAt: state.observedAt! };
    unsaved = true;
    await save(credentials!);
    unsaved = false;
    nextReadAt = now().getTime() + 60_000;
  }

  async function collect() {
    if (unsaved) { await save(credentials!); unsaved = false; }
    if (credentials!.expiresAt <= now().getTime() + 60_000) await renew();
    const car = await vehicle();
    const vehicleName = car.name;
    if (state.vehicleName !== vehicleName) state.vehicleName = vehicleName;
    // Use VIN as the identifier to avoid loss of precision in large numeric Tesla IDs.
    const summary = await get(`/api/1/vehicles/${car.vin}`);
    if (!object(summary) || !object(summary.response)) throw new TeslaError('L’état du véhicule Tesla est invalide.');
    if (summary.response.state === 'asleep' || summary.response.state === 'offline') {
      state = { ...state, status: summary.response.state, vehicleName, chargingState: null, error: null };
      nextReadAt = now().getTime() + 300_000;
      return;
    }
    if (summary.response.state !== 'online') throw new TeslaError('L’état du véhicule Tesla est inconnu.');
    await collectCharge(car);
  }

  async function refresh() {
    await ready;
    if (wakePending) { await wakePending.catch(() => {}); return; }
    if (pending) return pending;
    if (stopped || editing || !credentials || state.status === 'auth_required' || now().getTime() < nextReadAt) return;
    pending = (async () => {
      try {
        // Retry one 401 using a refreshed token; never loop on failed authorization.
        try { await collect(); }
        catch (error) {
          if (!(error instanceof TeslaError) || !error.refreshable) throw error;
          await renew();
          await collect();
        }
      } catch (error) {
        const failure = error instanceof TeslaError ? error : new TeslaError('La connexion Tesla est indisponible.');
        state = { ...state, status: failure.state, chargingState: null, error: failure.message };
        nextReadAt = now().getTime() + failure.retryMs;
      }
    })();
    try { await pending; } finally { pending = null; }
  }

  async function readStatus(): Promise<CarTelemetry> {
    await ready;
    const aged = state.status === 'online' && state.observedAt !== null && now().getTime() - Date.parse(state.observedAt) > freshnessMs;
    return { ...state, status: aged ? 'stale' : state.status };
  }

  /** Called only by an opted-in charging runner; status GETs remain passive. */
  function refreshForCharging(signal?: AbortSignal): Promise<CarTelemetry> {
    if (wakePending) return wakePending;
    const controller = new AbortController();
    const cancelled = () => controller.abort();
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) controller.abort();
    wakeAbort = controller;
    let expired = false;
    const timeout = setTimeout(() => { expired = true; controller.abort(); }, wakeTimeoutMs);
    const task = (async () => {
      const check = () => {
        if (controller.signal.aborted || stopped || editing) throw new TeslaError('La demande Tesla a été annulée.');
      };
      await ready;
      if (pending) await pending;
      check();
      const current = await readStatus();
      if (current.status === 'online' || !credentials || current.status === 'auth_required'
        || now().getTime() < nextWakeAt) return current;
      nextWakeAt = now().getTime() + 15 * 60_000;
      const deadline = now().getTime() + wakeTimeoutMs;
      try {
        if (unsaved) { await save(credentials); unsaved = false; }
        if (credentials.expiresAt <= now().getTime() + 60_000) await renew(controller.signal);
        check();
        const car = await vehicle(controller.signal);
        const summary = await get(`/api/1/vehicles/${car.vin}`, controller.signal);
        if (!object(summary) || !object(summary.response)) throw new TeslaError('L’état du véhicule Tesla est invalide.');
        if (summary.response.state !== 'online') {
          if (!['asleep', 'offline'].includes(String(summary.response.state))) throw new TeslaError('L’état du véhicule Tesla est inconnu.');
          check();
          // One wake request only; polling and charge-state reads never replay it.
          await json(`${apiBase}/api/1/vehicles/${car.vin}/wake_up`, {
            method: 'POST', signal: controller.signal, headers: { authorization: `Bearer ${credentials!.accessToken}` },
          });
          let delay = 2000;
          while (true) {
            check();
            const remaining = deadline - now().getTime();
            if (remaining <= 0) throw new TeslaError('Le réveil Tesla a expiré.', 'asleep', 900_000);
            await sleep(Math.min(delay, remaining), controller.signal);
            check();
            const observed = await get(`/api/1/vehicles/${car.vin}`, controller.signal);
            if (!object(observed) || !object(observed.response)) throw new TeslaError('L’état du véhicule Tesla est invalide.');
            if (observed.response.state === 'online') break;
            if (!['asleep', 'offline'].includes(String(observed.response.state))) throw new TeslaError('L’état du véhicule Tesla est inconnu.');
            delay = Math.min(10_000, Math.ceil(delay * 1.15));
          }
        }
        check();
        await collectCharge(car, controller.signal);
        check();
        return readStatus();
      } catch (error) {
        if (controller.signal.aborted && !expired) throw new Error('La demande Tesla a été annulée.');
        const failure = expired ? new TeslaError('Le réveil Tesla a expiré.', 'asleep', 900_000)
          : error instanceof TeslaError ? error : new TeslaError('Le réveil Tesla est indisponible.');
        state = { ...state, status: failure.state, chargingState: null, error: failure.message };
        nextReadAt = now().getTime() + failure.retryMs;
        nextWakeAt = Math.max(nextWakeAt, nextReadAt);
        return readStatus();
      }
    })();
    wakePending = task;
    void task.finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancelled);
      if (wakePending === task) wakePending = null;
      if (wakeAbort === controller) wakeAbort = null;
    }).catch(() => {});
    return task;
  }

  async function mutate(operation: () => Promise<void>) {
    await ready;
    if (stopped) throw new Error('Le service Tesla est en cours d’arrêt.');
    if (editing) throw new Error('Une connexion Tesla est déjà en cours.');
    editing = true;
    wakeAbort?.abort();
    const task = (async () => {
      try { await pending; await wakePending?.catch(() => {}); await operation(); }
      finally { editing = false; }
    })();
    mutation = task;
    try { await task; }
    finally { if (mutation === task) mutation = null; }
  }

  async function connect(refreshToken: string) {
    if (!token(refreshToken)) throw new Error('Le jeton de renouvellement Tesla est invalide.');
    await mutate(async () => {
      try {
        const renewed = await exchange(refreshToken);
        credentials = renewed;
        lastCharge = null;
        state = { ...empty, status: 'connecting' };
        unsaved = true;
        await save(renewed);
        unsaved = false;
        nextReadAt = 0;
        nextWakeAt = 0;
      } catch (error) {
        if (unsaved) state = { ...empty, status: 'error', error: 'Impossible de conserver la connexion Tesla. Vérifiez le répertoire de données.' };
        throw error;
      }
    });
    void refresh();
  }

  async function disconnect() {
    await mutate(async () => {
      if (path) {
        try { await rm(path, { force: true }); }
        catch { throw new Error('Impossible de supprimer les jetons Tesla. Vérifiez les droits du fichier.'); }
      }
      credentials = null;
      lastCharge = null;
      unsaved = false;
      state = { ...empty, status: 'not_configured' };
      nextReadAt = 0;
      nextWakeAt = 0;
    });
  }

  return {
    readStatus, refresh, refreshForCharging, connect, disconnect,
    start() {
      if (timer) return;
      stopped = false;
      void refresh();
      timer = setInterval(() => { void refresh(); }, 15_000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      wakeAbort?.abort();
      if (timer) clearInterval(timer);
      timer = null;
      await ready;
      await pending;
      await wakePending?.catch(() => {});
      await mutation?.catch(() => {});
    },
  };
}

export type TeslaService = ReturnType<typeof createTeslaService>;
