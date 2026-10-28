import type { CarTelemetry } from './tesla.js';
import type { Telemetry } from './status.js';
import type { WattpilotTelemetry } from './wattpilot.js';
import type { EnergyForecast } from './automation-plan.js';

export interface CarAutomationConfig {
  capacityKwh: number;
  chargingEfficiency: number;
  maxCurrentAmps: number;
  socFreshnessMs: number;
  leaseSeconds: number;
  wakeCooldownMs: number;
}
export interface CarTargetOverride { deadline: string; targetSocPercent: number }
export interface CarCheckpoint {
  date: string;
  targetSocPercent: number;
  observedSocPercent: number | null;
  result: 'met' | 'missed' | 'unknown';
  recordedAt: string;
  kind: 'morning' | 'afternoon';
}
export interface CarAutomationState {
  readonly owner: string;
  readonly manualOverride: boolean;
  readonly error: string | null;
  readonly epoch: string | null;
  readonly revision: number;
  readonly targetOverride: CarTargetOverride | null;
  readonly lastCheckpoint: CarCheckpoint | null;
  readonly completedTarget: CarTargetOverride | null;
  setManualOverride(value: boolean): Promise<void>;
  setSession(epoch: string | null, revision: number): Promise<void>;
  setTargetOverride(value: CarTargetOverride | null): Promise<void>;
  setCheckpoint(value: CarCheckpoint): Promise<void>;
  setCompletedTarget(value: CarTargetOverride | null): Promise<void>;
}
export interface CarBatteryContext {
  available: boolean;
  automatic: boolean;
  requestedPowerKw: 0 | 6;
  socPercent: number | null;
  goalSocPercent: number;
  capacityKwh?: number;
  pendingChargeKw?: number;
  solarSupport?: SolarBatterySupport;
}
export interface SolarBatterySupport {
  available: boolean;
  solarStoredKwh: number | null;
  protectedStoredKwh: number | null;
  usableStoredKwh: number;
  minimumSocPercent: number | null;
  maxDischargeKw: number;
  authorizationExpiresAt?: string;
}
export interface CarChargingSlot {
  start: string;
  end: string;
  powerKw: number;
  energyKwh: number;
  source: 'grid' | 'solar';
  required: boolean;
  batteryChargeAllowed: boolean;
  batterySupply?: { minimumSocPercent: number; maxDischargeKw: number };
}
export interface CarChargingForecast {
  status: 'inactive' | 'available' | 'unavailable';
  date: string;
  calculatedAt: string | null;
  socObservedAt: string | null;
  slots: CarChargingSlot[];
}
export interface CarPlan {
  status: 'available' | 'blocked';
  action: 'charge' | 'eco' | 'pause' | 'wait';
  reason: string;
  calculatedAt: string;
  target: { date: string; minimumSocPercent: number; deadline: string; gridChargingEndsAt: string; kind?: 'morning' | 'afternoon' };
  socPercent: number | null;
  observedAt: string | null;
  requiredStoredKwh: number | null;
  requiredAcKwh: number | null;
  solarKwh: number | null;
  gridKwh: number | null;
  unmetKwh: number | null;
  estimatedCompletionAt: string | null;
  feasible: boolean | null;
  currentAmps: number | null;
  phases: 1 | 3 | null;
  source: 'grid' | 'solar' | 'eco' | null;
  requiresBatteryHold: boolean;
  allowBatteryCharge: boolean;
  /** Upper bound for home-battery charging while this car allocation is active. */
  maxBatteryChargePowerKw?: number;
  windowEndsAt: string | null;
  slots: CarChargingSlot[];
  batterySupport?: SolarBatterySupport;
}
export interface CarPlanInput {
  now: Date;
  config: CarAutomationConfig;
  car: CarTelemetry;
  charger: WattpilotTelemetry;
  telemetry: Telemetry;
  battery: CarBatteryContext;
  forecasts: EnergyForecast[];
  override?: CarTargetOverride | null;
  /** Target already reached in this period; cleared once a full recharge is needed. */
  completedTarget?: CarTargetOverride | null;
}
export interface CarBatteryConstraint {
  active: boolean;
  allowCharge: boolean;
  maxChargePowerKw?: number;
  until: string | null;
  guardNight?: boolean;
  supply?: { minimumSocPercent: number; maxDischargeKw: number; authorizationExpiresAt?: string };
}
export interface CarAutomationStatus {
  enabled: boolean;
  status: 'manual' | 'idle' | 'charging' | 'eco' | 'paused' | 'blocked' | 'error' | 'stopping' | 'waking';
  reason: string;
  error: string | null;
  lastEvaluatedAt: string | null;
  nextEvaluationAt: string | null;
  plan: CarPlan | null;
  lastCheckpoint: CarCheckpoint | null;
}
export interface CarLeaseRequest {
  owner: string;
  epoch: string;
  revision: number;
  expiresAt: string;
}
export interface CarActivation extends CarLeaseRequest {
  mode: 'normal' | 'eco';
  currentAmps: number;
  phases?: 1 | 3;
}
export interface CarAutomationController {
  read(): Promise<WattpilotTelemetry>;
  /** Explicit Auto action only: pause manual control, then establish a fenced epoch. */
  authorize(owner: string): Promise<WattpilotTelemetry>;
  activate(request: CarActivation, isCurrent: () => boolean, signal?: AbortSignal): Promise<WattpilotTelemetry>;
  renew(request: CarLeaseRequest, isCurrent: () => boolean, signal?: AbortSignal): Promise<WattpilotTelemetry>;
  stop(request: Pick<CarLeaseRequest, 'owner' | 'epoch' | 'revision'>): Promise<WattpilotTelemetry>;
}
