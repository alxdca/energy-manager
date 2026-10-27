export interface BatteryEstimatePoint { at: string; socPercent: number }
export interface BatteryEstimateSummary {
  status: 'ready' | 'error';
  error: string | null;
  points: BatteryEstimatePoint[];
}
