/** Explicit recovery command. Requires the same opt-in and limits as other writes. */
import { FroniusInverter } from '../src/devices/fronius-inverter.js';
import { BatteryMode } from '../src/types/common.js';
import { config } from '../src/config/index.js';

async function restoreNormal(): Promise<void> {
  if (!config.fronius.control.enabled) throw new Error('Restore is a write operation; explicit control configuration is required');
  const inverter = new FroniusInverter();
  try {
    await inverter.initialize();
    await inverter.setBatteryMode(BatteryMode.NORMAL);
    console.log('Battery power-window control disabled; reserve and grid-charging permission preserved.');
  } finally {
    await inverter.disconnect();
  }
}

restoreNormal().catch(error => {
  console.error('Could not confirm normal operation:', error);
  process.exitCode = 1;
});
