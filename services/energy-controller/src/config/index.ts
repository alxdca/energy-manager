import type { WattpilotConfig } from '../devices/wattpilot.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Configuration is validated before any device connection is opened. */
export interface InverterControlConfig {
  enabled: boolean;
  maxPowerWatts: number | null;
  maxSocPercent: number;
  maxDurationMs: number;
  revertTimeoutSeconds: number;
  checkIntervalMs: number;
}

export interface SystemConfig {
  wattpilot: WattpilotConfig;
  wattpilotJournalPath: string;
  fronius: {
    ip: string;
    port: number;
    modbus: { port: number; unitId: number; mode: 'int' | 'float' };
    control: InverterControlConfig;
  };
  api: { port: number; host: string };
  system: { timezone: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SystemConfig {
  function number(key: string, fallback: number, min: number, max: number): number {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (raw?.trim() === '' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
    return value;
  }
  const enabled = env.FRONIUS_CONTROL_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('FRONIUS_CONTROL_ENABLED must be true or false');
  const rawMax = env.FRONIUS_MAX_POWER_WATTS;
  const maxPowerWatts = rawMax === undefined || rawMax === '' ? null : number('FRONIUS_MAX_POWER_WATTS', 0, 1, 100000);
  if (enabled === 'true' && maxPowerWatts === null) {
    throw new Error('Control requires FRONIUS_MAX_POWER_WATTS');
  }
  const mode = env.FRONIUS_MODBUS_MODE ?? 'int';
  if (mode !== 'int' && mode !== 'float') throw new Error('FRONIUS_MODBUS_MODE must be int or float');
  const maxSocPercent = number('FRONIUS_MAX_SOC_PERCENT', 90, 51, 95);
  const revertTimeoutSeconds = number('FRONIUS_REVERT_TIMEOUT_SECONDS', 30, 10, 120);
  const checkIntervalMs = number('FRONIUS_CONTROL_CHECK_SECONDS', 5, 1, 10) * 1000;
  if (checkIntervalMs * 3 > revertTimeoutSeconds * 1000) {
    throw new Error('Control check interval must be at most one third of the revert timeout');
  }
  const timezone = env.SYSTEM_TIMEZONE ?? 'Europe/Zurich';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new Error('SYSTEM_TIMEZONE must be a valid IANA timezone'); }

  const wattpilotEnabled = env.WATTPILOT_CONTROL_ENABLED ?? 'false';
  if (!['true', 'false'].includes(wattpilotEnabled)) throw new Error('WATTPILOT_CONTROL_ENABLED must be true or false');
  const wattpilotUrl = env.WATTPILOT_URL?.trim() || null;
  const wattpilotPassword = env.WATTPILOT_PASSWORD || null;
  if (wattpilotUrl) {
    try {
      const url = new URL(wattpilotUrl);
      if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password
        || url.search || url.hash || url.pathname !== '/ws') throw new Error();
    } catch { throw new Error('WATTPILOT_URL must be a WebSocket URL ending in /ws without credentials, query or fragment'); }
  }
  if (Boolean(wattpilotUrl) !== Boolean(wattpilotPassword)) throw new Error('WATTPILOT_URL and WATTPILOT_PASSWORD must be configured together');
  const maxCurrentAmps = env.WATTPILOT_MAX_CURRENT_AMPS === undefined || env.WATTPILOT_MAX_CURRENT_AMPS === ''
    ? null : number('WATTPILOT_MAX_CURRENT_AMPS', 0, 6, 16);
  if (wattpilotEnabled === 'true' && (!wattpilotUrl || !wattpilotPassword || maxCurrentAmps === null)) {
    throw new Error('Wattpilot control requires URL, password and an explicit WATTPILOT_MAX_CURRENT_AMPS');
  }

  return {
    wattpilotJournalPath: env.WATTPILOT_AUTOMATION_STATE_PATH?.trim()
      ? resolve(env.WATTPILOT_AUTOMATION_STATE_PATH.trim()) : fileURLToPath(new URL('../../data/wattpilot-automation.json', import.meta.url)),
    wattpilot: {
      url: wattpilotUrl, password: wattpilotPassword, controlEnabled: wattpilotEnabled === 'true', maxCurrentAmps,
      requestTimeoutMs: number('WATTPILOT_REQUEST_TIMEOUT_SECONDS', 5, 1, 15) * 1000,
      staleAfterMs: 30_000,
    },
    fronius: {
      ip: env.FRONIUS_INVERTER_IP || '192.168.1.1',
      port: number('FRONIUS_INVERTER_PORT', 80, 1, 65535),
      modbus: { port: number('FRONIUS_MODBUS_PORT', 502, 1, 65535), unitId: number('FRONIUS_MODBUS_UNIT_ID', 1, 1, 247), mode },
      control: { enabled: enabled === 'true', maxPowerWatts, maxSocPercent, maxDurationMs: number('FRONIUS_MAX_CONTROL_SECONDS', 300, 5, 900) * 1000, revertTimeoutSeconds, checkIntervalMs },
    },
    api: { port: number('API_PORT', 3001, 1, 65535), host: env.API_HOST || '127.0.0.1' },
    system: { timezone },
  };
}

export const config = loadConfig();
