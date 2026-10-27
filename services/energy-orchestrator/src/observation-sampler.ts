import type {
  EnergyCounterPoint, FinalizedObservations, FinalizedObservationState, ObservationPoint, ObservationSample,
} from './observation-types.js';
import type { HouseholdInterval } from './household-model.js';

const quarterMs = 900_000;
const channels = ['battery', 'solar', 'household'] as const;
type Channel = typeof channels[number];
type Candidate = Partial<ObservationSample>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key));
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) return null;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return calendar.toISOString().slice(0, 10) === value.slice(0, 10) ? new Date(value).toISOString() : null;
}
const targetAt = (at: number) => (Math.floor(at / quarterMs) + 1) * quarterMs;
function counter(value: unknown, channel: 'solar' | 'household'): EnergyCounterPoint | null {
  if (!object(value) || !finite(value.value) || (channel === 'solar' && value.value < 0)
    || typeof value.source !== 'string' || !value.source.trim()) return null;
  const at = timestamp(value.at);
  if (at === null) return null;
  if (value.components !== undefined && (!object(value.components) || Object.keys(value.components).length === 0
    || Object.entries(value.components).some(([key, part]) => !key || !finite(part) || part < 0))) return null;
  return { at, value: value.value, source: value.source,
    ...(value.components === undefined ? {} : { components: { ...value.components as Record<string, number> } }) };
}

function continuousCounters(previous: EnergyCounterPoint, next: EnergyCounterPoint): boolean {
  if (previous.components === undefined || next.components === undefined) return previous.components === next.components;
  return keys(next.components, Object.keys(previous.components))
    && Object.entries(previous.components).every(([key, value]) => next.components![key] >= value);
}

function loadState(value: unknown): FinalizedObservationState {
  if (value === undefined) return { version: 1, finalizedThrough: null, solar: null, household: null };
  const invalid = () => { throw new Error('Invalid observation sampler state.'); };
  if (!object(value) || !keys(value, ['version', 'finalizedThrough', 'solar', 'household']) || value.version !== 1) return invalid();
  const through = value.finalizedThrough === null ? null : timestamp(value.finalizedThrough);
  if (value.finalizedThrough !== null && (through !== value.finalizedThrough || Date.parse(through!) % quarterMs !== 0)) return invalid();
  const result: FinalizedObservationState = { version: 1, finalizedThrough: through, solar: null, household: null };
  for (const channel of ['solar', 'household'] as const) {
    const baseline = value[channel];
    if (baseline === null) continue;
    if (through === null || !object(baseline) || !keys(baseline, ['target', 'sample'])
      || !object(baseline.sample) || !keys(baseline.sample,
        baseline.sample.components === undefined ? ['at', 'value', 'source'] : ['at', 'value', 'source', 'components'])) return invalid();
    const target = timestamp(baseline.target), sample = counter(baseline.sample, channel);
    if (!target || target !== baseline.target || !sample || sample.at !== baseline.sample.at
      || Date.parse(target) !== targetAt(Date.parse(sample.at)) || Date.parse(target) > Date.parse(through)) return invalid();
    result[channel] = { target, sample };
  }
  return result;
}

/** Volatile samples become immutable real-time observations only after their quarter target passes. */
export function createObservationSampler(options: { now?: () => Date; state?: unknown } = {}) {
  const clock = options.now ?? (() => new Date());
  const state = loadState(options.state);
  const candidates = new Map<number, Candidate>();
  const queued: Record<Channel, Map<string, ObservationPoint>> = { battery: new Map(), solar: new Map(), household: new Map() };
  const householdIntervals = new Map<string, HouseholdInterval>();

  function finalize(at = clock()): void {
    if (!Number.isFinite(at.getTime())) return;
    const through = Math.floor(at.getTime() / quarterMs) * quarterMs;
    const previousThrough = state.finalizedThrough === null ? -Infinity : Date.parse(state.finalizedThrough);
    if (through <= previousThrough) return;
    // Only actual candidate targets need processing, even across years of downtime.
    for (const target of [...candidates.keys()].filter(target => target <= through).sort((a, b) => a - b)) {
      const selected = candidates.get(target)!;
      if (selected.battery) queued.battery.set(selected.battery.at, { ...selected.battery });
      for (const channel of ['solar', 'household'] as const) {
        const point = selected[channel];
        if (!point) continue;
        const previous = state[channel];
        if (previous && Date.parse(previous.target) === target - quarterMs && previous.sample.source === point.source
          && point.value >= previous.sample.value && continuousCounters(previous.sample, point)) {
          const value = point.value - previous.sample.value;
          if (Number.isFinite(value)) {
            queued[channel].set(point.at, { at: point.at, value });
            if (channel === 'household') householdIntervals.set(point.at, {
              at: point.at, start: previous.sample.at, end: point.at,
              nominalStart: previous.target, nominalEnd: new Date(target).toISOString(),
              source: point.source, availableAt: at.toISOString(),
            });
          }
        }
        state[channel] = { target: new Date(target).toISOString(), sample: { ...point,
          ...(point.components ? { components: { ...point.components } } : {}) } };
      }
      candidates.delete(target);
    }
    state.finalizedThrough = new Date(through).toISOString();
  }

  function record(sample: ObservationSample, at = clock()): void {
    finalize(at);
    const now = at.getTime();
    if (!Number.isFinite(now) || !object(sample)) return;
    for (const channel of channels) {
      let point: ObservationPoint | EnergyCounterPoint | null;
      if (channel === 'battery') {
        const value = sample.battery;
        const observed = object(value) ? timestamp(value.at) : null;
        point = observed !== null && object(value) && finite(value.value) && value.value >= 0 && value.value <= 100
          ? { at: observed, value: value.value } : null;
      } else point = counter(sample[channel], channel);
      if (!point) continue;
      const observed = Date.parse(point.at), target = targetAt(observed);
      if (observed < now - 40_000 || observed > now + 5000
        || (state.finalizedThrough !== null && target <= Date.parse(state.finalizedThrough))) continue;
      const selected = candidates.get(target) ?? {};
      const previous = selected[channel];
      if (previous && point.at <= previous.at) continue;
      if (channel === 'battery') selected.battery = point;
      else selected[channel] = point as EnergyCounterPoint;
      candidates.set(target, selected);
    }
  }

  function pending(): FinalizedObservations {
    return structuredClone({ battery: [...queued.battery.values()], solar: [...queued.solar.values()],
      household: [...queued.household.values()], householdIntervals: [...householdIntervals.values()], state });
  }

  function acknowledge(snapshot: FinalizedObservations): void {
    for (const channel of channels) for (const point of snapshot[channel]) {
      if (queued[channel].get(point.at)?.value === point.value) queued[channel].delete(point.at);
    }
    for (const interval of snapshot.householdIntervals) householdIntervals.delete(interval.at);
  }
  return { record, finalize, pending, acknowledge };
}
