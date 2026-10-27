import type { Telemetry } from './status.js';
import type { ObservationSample } from './observation-types.js';

interface CollectorTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}
interface CollectorOptions<Sample> {
  read(): Promise<Sample>;
  store: { record(sample: Sample, now?: Date): void; flush(): Promise<void> };
  now?: () => Date;
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  checkpointIntervalMs?: number;
  timers?: CollectorTimers;
}
export interface EnergyCollectorOptions extends Omit<CollectorOptions<Telemetry>, 'read'> {
  readTelemetry(): Promise<Telemetry>;
}
export interface ObservationCollectorOptions extends Omit<CollectorOptions<ObservationSample>, 'read'> {
  readSample(): Promise<ObservationSample>;
}
const unavailable: Telemetry = {
  status: 'offline', observedAt: null, error: 'La collecte de mesures est indisponible',
  solarKw: null, householdKw: null, gridImportKw: null, gridExportKw: null,
  batterySocPercent: null, batteryChargeKw: null, batteryDischargeKw: null,
};

/** One non-overlapping wall-clock loop, with explicit unavailable input on read failure. */
function createCollector<Sample>(options: CollectorOptions<Sample>, empty: () => Sample, defaultPollInterval: number) {
  const now = options.now ?? (() => new Date());
  const timers: CollectorTimers = options.timers ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const pollInterval = options.pollIntervalMs ?? defaultPollInterval;
  const checkpointInterval = options.checkpointIntervalMs ?? 30_000;
  for (const interval of [pollInterval, checkpointInterval]) {
    if (!Number.isFinite(interval) || interval <= 0) throw new Error('Collector intervals must be positive finite numbers');
  }
  let started = false, stopping = false;
  let timer: unknown;
  let pending: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let lastCheckpoint: number | undefined;
  function report(error: unknown) { try { options.onError?.(error); } catch { /* Preserve collection. */ } }
  async function checkpoint() {
    try { await options.store.flush(); lastCheckpoint = now().getTime(); }
    catch (error) { report(error); }
  }
  async function sample() {
    try {
      let value: Sample;
      try { value = await options.read(); }
      catch (error) { report(error); value = empty(); }
      try { options.store.record(value, now()); } catch (error) { report(error); }
      const elapsed = lastCheckpoint === undefined ? Infinity : now().getTime() - lastCheckpoint;
      if (!stopping && (elapsed >= checkpointInterval || elapsed < 0)) await checkpoint();
    } finally {
      pending = undefined;
      if (!stopping) schedule();
    }
  }
  function schedule() {
    const timestamp = now().getTime();
    const due = (Math.floor(timestamp / pollInterval) + 1) * pollInterval;
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (now().getTime() < due) schedule();
      else pending = sample();
    }, due - timestamp);
  }
  return {
    start(): void {
      if (started || stopping) return;
      started = true;
      pending = sample();
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (timer !== undefined) { timers.clearTimeout(timer); timer = undefined; }
      stopPromise = (async () => { await pending; await checkpoint(); })();
      return stopPromise;
    },
  };
}

/** Fast power telemetry remains available for provenance and safety, independently of observation storage. */
export function createEnergyCollector({ readTelemetry, ...options }: EnergyCollectorOptions) {
  return createCollector({ ...options, read: readTelemetry }, () => ({ ...unavailable }), 5000);
}

/** Only observation candidates are sampled here; the store finalizes completed quarter targets. */
export function createObservationCollector({ readSample, ...options }: ObservationCollectorOptions) {
  return createCollector({ ...options, read: readSample }, () => ({ battery: null, solar: null, household: null }), 30_000);
}
