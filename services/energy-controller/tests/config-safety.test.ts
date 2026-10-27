import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';

test('configuration defaults to read-only and loopback; writes need a power ceiling', () => {
  const c = loadConfig({});
  assert.equal(c.api.host, '127.0.0.1');
  assert.equal(c.fronius.control.enabled, false);
  assert.equal(c.fronius.control.maxPowerWatts, null);
});

test('telemetry TTL configuration is removed, including when a legacy environment value exists', () => {
  for (const env of [{}, { API_STATUS_CACHE_SECONDS: '60' }, { API_STATUS_CACHE_SECONDS: 'invalid' }]) {
    assert.deepEqual(loadConfig(env).api, { host: '127.0.0.1', port: 3001 });
  }
});

test('control settings reject invalid values and require an explicit finite ceiling', () => {
  const base = { FRONIUS_CONTROL_ENABLED: 'true', FRONIUS_MAX_POWER_WATTS: '3000' };
  assert.equal(loadConfig(base).fronius.control.enabled, true);
  assert.throws(() => loadConfig({ FRONIUS_CONTROL_ENABLED: 'true' }), /FRONIUS_MAX_POWER_WATTS/);
  for (const patch of [ { FRONIUS_MAX_POWER_WATTS: '' }, { FRONIUS_MAX_POWER_WATTS: 'Infinity' }, { FRONIUS_MAX_POWER_WATTS: '-1' }, { FRONIUS_MAX_POWER_WATTS: '3000oops' }, { FRONIUS_CONTROL_ENABLED: 'yes' }, { FRONIUS_MODBUS_PORT: '502oops' }, { FRONIUS_REVERT_TIMEOUT_SECONDS: '0' }, { SYSTEM_TIMEZONE: 'invalid timezone' } ]) {
    assert.throws(() => loadConfig({ ...base, ...patch }));
  }
});

// Legacy environment settings must not reintroduce an application discharge reserve.
test('minimum SOC is delegated to the inverter, including with a legacy environment setting', () => {
  for (const env of [{}, { FRONIUS_MIN_SOC_PERCENT: '10' }]) {
    assert.equal('minSocPercent' in loadConfig(env).fronius.control, false);
  }
});

test('Wattpilot defaults to unconfigured read-only and requires separate explicit write limits', () => {
  const empty = loadConfig({}).wattpilot;
  assert.equal(empty.url, null);
  assert.equal(empty.password, null);
  assert.equal(empty.controlEnabled, false);
  assert.equal(empty.maxCurrentAmps, null);
  const base = { WATTPILOT_URL: 'ws://192.0.2.1/ws', WATTPILOT_PASSWORD: 'test-only' };
  assert.equal(loadConfig(base).wattpilot.controlEnabled, false);
  assert.equal(loadConfig({ ...base, WATTPILOT_CONTROL_ENABLED: 'true', WATTPILOT_MAX_CURRENT_AMPS: '16' }).wattpilot.controlEnabled, true);
  for (const patch of [
    { WATTPILOT_PASSWORD: '' }, { WATTPILOT_URL: '' }, { WATTPILOT_URL: 'http://192.0.2.1/ws' },
    { WATTPILOT_URL: 'ws://user:secret@192.0.2.1/ws' }, { WATTPILOT_URL: 'ws://192.0.2.1/ws?password=secret' },
    { WATTPILOT_URL: 'ws://192.0.2.1/' }, { WATTPILOT_CONTROL_ENABLED: 'yes' },
    { WATTPILOT_CONTROL_ENABLED: 'true' }, { WATTPILOT_MAX_CURRENT_AMPS: '5' },
    { WATTPILOT_MAX_CURRENT_AMPS: '17' }, { WATTPILOT_MAX_CURRENT_AMPS: '6.5' },
    { WATTPILOT_MAX_CURRENT_AMPS: 'Infinity' }, { WATTPILOT_REQUEST_TIMEOUT_SECONDS: '0' },
  ]) assert.throws(() => loadConfig({ ...base, ...patch }), /WATT|Watt/);
});
