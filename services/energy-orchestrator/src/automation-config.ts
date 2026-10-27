import type { AutomationConfig } from './automation-plan.js';
import { policy } from './policy.js';

export function loadAutomationConfig(env: Record<string, string | undefined> = process.env): AutomationConfig {
  const enabled = env.AUTOMATION_ENABLED?.trim() || 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('AUTOMATION_ENABLED doit être true ou false.');
  const read = (key: string, fallback: number) => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error(`${key} doit être un nombre positif.`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} doit être un nombre fini.`);
    return value;
  };
  const socCapacityKwh = read('AUTOMATION_SOC_CAPACITY_KWH', 60);
  const reserveSocPercent = Math.max(policy.homeBatteryReserveSocPercent,
    read('AUTOMATION_RESERVE_SOC_PERCENT', policy.homeBatteryReserveSocPercent));
  const energyBufferPercent = read('AUTOMATION_ENERGY_BUFFER_PERCENT', 5);
  const minimumEnergyBufferKwh = read('AUTOMATION_ENERGY_BUFFER_MIN_KWH', 1);
  const afternoonTargetSocPercent = read('AUTOMATION_AFTERNOON_TARGET_SOC_PERCENT', 80);
  if (socCapacityKwh <= 0 || socCapacityKwh > 1000 || reserveSocPercent >= 100) throw new Error('Les paramètres de capacité et de réserve automatique sont invalides.');
  if (energyBufferPercent > 100 || minimumEnergyBufferKwh > socCapacityKwh) throw new Error('Les paramètres de marge automatique sont invalides.');
  if (afternoonTargetSocPercent > 100) throw new Error('La cible de charge de l’après-midi doit être comprise entre 0 et 100 %.');
  return { enabled: enabled === 'true', socCapacityKwh, reserveSocPercent, energyBufferPercent, minimumEnergyBufferKwh, afternoonTargetSocPercent };
}
