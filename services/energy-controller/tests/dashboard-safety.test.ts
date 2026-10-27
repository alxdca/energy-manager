import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('dashboard monitoring never overlaps requests and ignores stale stop/start responses', async () => {
  const html = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const section = html.slice(html.indexOf('// Monitoring function'), html.indexOf('// Initialize when page loads'));
  let requests = 0;
  let displays = 0;
  let resolveFetch: (data: unknown) => void = () => {};
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const context = vm.createContext({
    console: { log() {} }, isMonitoring: false, monitoringInterval: null,
    fetchData: () => { requests++; return new Promise(resolve => { resolveFetch = resolve; }); },
    updateDataDisplays: () => displays++, updateCharts() {},
    document: { getElementById: () => ({ textContent: '', className: '' }) },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => { throw new Error('Fixed intervals permit overlapping monitoring requests'); },
    clearInterval() {},
  });
  vm.runInContext(section, context);
  vm.runInContext('startMonitoring(); startMonitoring();', context);
  assert.equal(requests, 1);
  vm.runInContext('stopMonitoring(); startMonitoring();', context);
  assert.equal(requests, 1);
  resolveFetch({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(displays, 0);
  assert.equal(timers.size, 1);
  const [id, tick] = [...timers][0]; timers.delete(id); tick();
  assert.equal(requests, 2);
  vm.runInContext('stopMonitoring()', context);
  resolveFetch({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(displays, 0); assert.equal(timers.size, 0);
});
