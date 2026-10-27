import { policy } from './policy.js';

/** Household demand includes Tesla; solar generation never increases this allowance. */
export function batteryChargeAllowanceKw(householdKw: number, maximumKw = 6): number {
  if (!Number.isFinite(householdKw) || householdKw < 0 || !Number.isFinite(maximumKw) || maximumKw < 0) return 0;
  return Math.max(0, Math.floor(Math.min(maximumKw, policy.totalConsumptionLimitKw - householdKw) * 1000 + 1e-8) / 1000);
}
