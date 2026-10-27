/**
 * Main entry point for the home energy device controller service
 */

import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import api, { shutdownApi, startApi } from './api/api.js';
import { config } from './config/index.js';

// Export all the main classes and types for easy importing
export { FroniusInverter, InverterControlError } from './devices/fronius-inverter.js';
export { Battery } from './devices/battery.js';
export { Wattpilot, WattpilotError } from './devices/wattpilot.js';
export type { WattpilotConfig, WattpilotCommand, WattpilotStatus } from './devices/wattpilot.js';
export { createWattpilotAutomation } from './devices/wattpilot-automation.js';
export type { WattpilotAutomationStatus, SupervisedWattpilotStatus } from './devices/wattpilot-automation.js';

// Export types
export * from './types/common.js';

/**
 * Start the API server
 */
export async function startApiServer() {
  const port = config.api.port;
  const host = config.api.host;

  console.log('🚀 Starting Energy Controller API...');
  console.log(`📡 Server will listen on http://${host}:${port}`);
  console.log('\n📋 Available endpoints:');
  console.log('  POST /inverter/charge-battery    - Charge to target SOC');
  console.log('  POST /inverter/set-charge-power  - Set charge/discharge power');
  console.log('  POST /inverter/set-mode          - Set battery mode');
  console.log('  POST /inverter/standby           - Apply temporary zero charge/discharge window');
  console.log('  GET  /battery/status             - Get battery status');
  console.log('  GET  /system/status              - Get system status');
  console.log('  GET  /wattpilot/status            - Read local charger state');
  console.log('  POST /wattpilot/set-control       - Pause or set mode and current');
  console.log('');

  await startApi();

  const server = serve({
    fetch: api.fetch,
    port,
    hostname: host,
  }) as Server;

  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = (async () => {
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        try {
          await shutdownApi();
        } catch (error) {
          console.error('Device cleanup failed; verify control status before reuse:', error);
          process.exitCode = 1;
        } finally {
          server.closeAllConnections();
          await closed;
        }
      })();
    }
    return stopping;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  console.log(`API server running on http://${host}:${port} (GEN24 control ${config.fronius.control.enabled ? 'enabled' : 'disabled'}; Wattpilot control ${config.wattpilot.controlEnabled ? 'enabled' : 'disabled'})`);
  return { server, stop };
}

// Example usage function
export async function exampleUsage() {
  console.log('Energy Controller - Example Usage');
  console.log('=====================================');

  // Import the classes we need for this example
  const { FroniusInverter } = await import('./devices/fronius-inverter.js');
  const { Battery } = await import('./devices/battery.js');
  const { config } = await import('./config/index.js');

  // Create inverter instance (uses environment variables or defaults)
  const inverter = new FroniusInverter(); // Will use FRONIUS_INVERTER_IP from .env
  console.log(`Using inverter at: ${inverter.getIpAddress()}:${config.fronius.port}`);

  try {

    // Initialize inverter
    console.log('Initializing inverter...');
    await inverter.initialize();
    console.log('✓ Inverter initialized successfully');

    // Create battery instance
    const battery = new Battery(inverter);

    // Initialize battery
    console.log('Initializing battery...');
    await battery.initialize();
    console.log('✓ Battery initialized successfully');

    // Get current battery info
    const batteryInfo = battery.getBatteryInfo();
    console.log('Current battery info:', batteryInfo);
    console.log(`Battery charge: ${battery.getChargePercentage()?.toFixed(1) ?? 'unknown'}%`);

    // Read Modbus diagnostics before changing settings
    // Scan for Model 124 to find the correct starting address
    console.log('\nScanning for SunSpec Model 124...');
    const model124Addr = await inverter.scanForModel124();
    if (!model124Addr) {
      console.error('⚠️  Model 124 not found! Battery control may not work.');
    }

    // Read current Modbus register values
    console.log('\nReading current Modbus register values...');
    await inverter.readModbusDiagnostics();

    // Example: Get some data from the inverter
    console.log('\n📊 Getting current system data...');
    const solarData = await inverter.getSolarData();
    const gridData = await inverter.getGridData();

    if (solarData) {
      console.log(`☀️  Solar production: ${solarData.currentProductionKw.toFixed(2)} kW`);
    }

    if (gridData) {
      console.log(`⚡ Grid power: ${gridData.currentConsumptionKw.toFixed(2)} kW`);
    }

    console.log('\n✅ System initialized successfully!');
    console.log('\n📝 Example usage:');
    console.log('  // Charge battery at 3kW:');
    console.log('  await battery.setChargePower(3000);');
    console.log('');
    console.log('  // Discharge battery at 2kW:');
    console.log('  await battery.setChargePower(-2000);');
    console.log('');
    console.log('  // Restore normal mode:');
    console.log('  await battery.setMode(BatteryMode.NORMAL);');

    // Cleanup
    await battery.disconnect();

  } catch (error) {
    console.error('\n❌ Error in example usage:', error);
    console.error('\n💡 Troubleshooting tips:');
    console.error('  1. Verify your inverter IP address in .env file');
    console.error('  2. Ensure the inverter is powered on and connected to your network');
    console.error('  3. Check if you can ping the inverter: ping ' + inverter.getIpAddress());
    console.error('  4. Try accessing the API in your browser: http://' + inverter.getIpAddress() + '/solar_api/v1/GetInverterInfo.cgi');
    console.error('  5. Check firewall settings that might block the connection');
    console.error('  6. Verify that the Fronius Solar API is enabled on your inverter');
    process.exit(1);
  }
}

// Run API server or example based on environment variable
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.env.MODE || 'api';
  
  if (mode === 'example') {
    exampleUsage().catch(console.error);
  } else {
    startApiServer().catch(console.error);
  }
}
