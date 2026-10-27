export interface BatteryHistoryPoint { at: string; socPercent: number }
export interface BatteryHistorySummary {
  date: string;
  timeZone: 'Europe/Zurich';
  dayHours: 23 | 24 | 25;
  periodStart: string;
  periodEnd: string;
  status: 'ready' | 'error';
  error: string | null;
  points: BatteryHistoryPoint[];
}
