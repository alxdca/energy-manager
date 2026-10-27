/**
 * Common types and interfaces for the energy management system
 */

/**
 * Device status information
 */
export interface DeviceStatus {
  isOnline: boolean;
  lastSeen: Date;
  error?: string;
}

/**
 * Battery operating modes
 */
export enum BatteryMode {
  NORMAL = 'normal',
  FORCE_CHARGE = 'force_charge',
  FORCE_DISCHARGE = 'force_discharge'
}

/**
 * Battery information
 */
export interface BatteryInfo {
  capacityKwh: number;
  currentChargeKwh: number;
  chargeRateKw: number;
  dischargeRateKw: number;
  efficiency: number;
  socPercent: number | null;
  validValues: Array<'soc' | 'chargeRate' | 'dischargeRate'>;
}

/**
 * Solar panel information
 */
export interface SolarInfo {
  capacityKw: number;
  currentProductionKw: number;
  dailyProductionKwh: number;
}

/**
 * Grid/meter information
 */
export interface GridInfo {
  currentConsumptionKw: number;
  currentFeedInKw: number;
  dailyConsumptionKwh: number;
  dailyFeedInKwh: number;
  pricePerKwh: number;
}
