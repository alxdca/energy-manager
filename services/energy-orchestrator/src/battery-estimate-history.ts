import type { BatteryProjection } from './battery-projection.js';

export interface BatteryEstimatePoint { at: string; socPercent: number }
export interface BatteryEstimateSummary {
  status: 'ready' | 'error';
  error: string | null;
  points: BatteryEstimatePoint[];
  projection?: Pick<BatteryProjection, 'status' | 'reason' | 'assumption'>;
}
