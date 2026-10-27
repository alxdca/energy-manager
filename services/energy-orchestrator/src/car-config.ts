import type { CarAutomationConfig } from './car-types.js';

export function loadCarAutomationConfig(env: Record<string, string | undefined> = process.env): CarAutomationConfig {
  const read = (key: string, fallback: number, min: number, max: number, integer = false) => {
    const raw = env[key]?.trim();
    const value = raw === undefined || raw === '' ? fallback : /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) {
      throw new Error(`${key} doit être ${integer ? 'un entier' : 'un nombre'} entre ${min} et ${max}.`);
    }
    return value;
  };
  return {
    capacityKwh: read('CAR_AUTOMATION_CAPACITY_KWH', 75, 1, 250),
    chargingEfficiency: read('CAR_AUTOMATION_EFFICIENCY', 0.9, 0.1, 1),
    maxCurrentAmps: read('CAR_AUTOMATION_MAX_CURRENT_AMPS', 16, 6, 16, true),
    socFreshnessMs: read('CAR_AUTOMATION_SOC_FRESHNESS_SECONDS', 600, 30, 600, true) * 1000,
    leaseSeconds: read('CAR_AUTOMATION_LEASE_SECONDS', 90, 10, 120, true),
    wakeCooldownMs: read('CAR_AUTOMATION_WAKE_COOLDOWN_SECONDS', 900, 900, 86400, true) * 1000,
  };
}
