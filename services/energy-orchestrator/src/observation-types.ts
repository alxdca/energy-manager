/** Real sampled times and fixed per-channel units; no nominal buckets are observation data. */
export interface ObservationPoint { at: string; value: number }
/** Observed delta boundaries and provenance, written at finalization rather than inferred later. */
export interface HouseholdInterval {
  at: string; start: string; end: string; nominalStart: string; nominalEnd: string; source: string; availableAt: string;
}
export interface EnergyCounterPoint extends ObservationPoint {
  source: string;
  /** Native monotonic totals detect resets hidden by a derived household balance. */
  components?: Record<string, number>;
}
export interface EnergyCounterSnapshot {
  status: 'online' | 'offline';
  error: string | null;
  battery?: ObservationPoint | null;
  solar: EnergyCounterPoint | null;
  household: EnergyCounterPoint | null;
}
export interface ObservationSample {
  battery: ObservationPoint | null;
  solar: EnergyCounterPoint | null;
  household: EnergyCounterPoint | null;
}
export interface FinalizedObservationState {
  version: 1;
  finalizedThrough: string | null;
  solar: { target: string; sample: EnergyCounterPoint } | null;
  household: { target: string; sample: EnergyCounterPoint } | null;
}
export interface FinalizedObservations {
  battery: ObservationPoint[];
  solar: ObservationPoint[];
  household: ObservationPoint[];
  householdIntervals: HouseholdInterval[];
  state: FinalizedObservationState;
}
