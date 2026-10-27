interface EstimateTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EstimateScheduleOptions {
  run(at: Date): Promise<unknown>;
  now?: () => Date;
  onError?: (error: unknown) => void;
  timers?: EstimateTimers;
  initializeImmediately?: boolean;
}

const quarterMs = 15 * 60_000;

/** Explicitly started, quarter-hour work; page reads never trigger this schedule. */
export function createEstimateSchedule(options: EstimateScheduleOptions) {
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } satisfies EstimateTimers;
  let started = false;
  let stopping = false;
  let timer: unknown;
  let pending: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let lastAttemptSlot = -Infinity;

  function report(error: unknown) {
    try { options.onError?.(error); } catch { /* Reporting must not stop future cycles. */ }
  }

  function schedule() {
    if (stopping || pending) return;
    const timestamp = now().getTime();
    const due = Math.max((Math.floor(timestamp / quarterMs) + 1) * quarterMs,
      (lastAttemptSlot + 1) * quarterMs);
    timer = timers.setTimeout(() => {
      timer = undefined;
      const at = now();
      // A clock rollback or early callback must never pull a calculation forward.
      if (at.getTime() < due) schedule();
      else launch(at);
    }, due - timestamp);
  }

  function launch(at: Date) {
    if (stopping || pending) return;
    const slot = Math.floor(at.getTime() / quarterMs);
    if (slot <= lastAttemptSlot) { schedule(); return; }
    lastAttemptSlot = slot;
    pending = (async () => {
      try { await options.run(at); } catch (error) { report(error); }
    })().finally(() => {
      pending = undefined;
      // Advance to the next real boundary, skipping slots missed during slow work.
      schedule();
    });
  }

  return {
    start(): void {
      if (started || stopping) return;
      started = true;
      const at = now();
      if (options.initializeImmediately || at.getTime() % quarterMs === 0) launch(at);
      else schedule();
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (timer !== undefined) { timers.clearTimeout(timer); timer = undefined; }
      stopPromise = (async () => { await pending; })();
      return stopPromise;
    },
  };
}
