import { FroniusModbus } from '../../src/devices/fronius-modbus.js';
export const control = { enabled: true, maxPowerWatts: 3000, maxSocPercent: 90,
  maxDurationMs: 300000, revertTimeoutSeconds: 30, checkIntervalMs: 5000 };
export const STORAGE = 40200;
const signed = (n: number) => n < 0 ? 65536 + n : n;

export class FakeTransport {
  memory = new Map<number, number>();
  writes: Array<[number, number]> = [];
  reads: Array<[number, number]> = [];
  connected = false;
  closed = false;
  activeRequests = 0;
  maxActiveRequests = 0;
  failRead?: number;
  ignoreWrite?: number;
  failWrite?: number;
  constructor() {
    this.memory.set(40000, 0x5375); this.memory.set(40001, 0x6e53);
    this.model(40002, 1, 65); this.string(40004, 'Fronius', 16); this.string(40020, 'Symo GEN24 10.0', 16);
    this.model(40069, 103, 50); this.memory.set(40069 + 38, 4);
    this.model(40121, 160, 77); this.model(STORAGE, 124, 24);
    this.memory.set(STORAGE + 2, 10000); this.memory.set(STORAGE + 5, 0);
    this.memory.set(STORAGE + 7, 2000); this.memory.set(STORAGE + 8, 5000);
    this.memory.set(STORAGE + 11, 6); this.memory.set(STORAGE + 12, 10000);
    this.memory.set(STORAGE + 13, 10000); this.memory.set(STORAGE + 17, 1);
    this.memory.set(STORAGE + 18, 0); this.memory.set(STORAGE + 21, signed(-2));
    this.memory.set(STORAGE + 22, signed(-2)); this.memory.set(STORAGE + 25, signed(-2));
    this.model(STORAGE + 26, 65535, 0);
    // Legacy hard-coded registers, so the regression captures unsafe writes rather than a read failure.
    this.memory.set(40345, 10000); this.memory.set(40351, 5000);
  }
  model(address: number, id: number, length: number) { this.memory.set(address, id); this.memory.set(address + 1, length); }
  string(address: number, text: string, words: number) {
    const buffer = Buffer.alloc(words * 2); buffer.write(text);
    for (let i = 0; i < words; i++) this.memory.set(address + i, buffer.readUInt16BE(i * 2));
  }
  async connectTCP() { this.connected = true; }
  setID() {}
  setTimeout() {}
  close(callback: () => void) { this.closed = true; this.connected = false; callback(); }
  async readHoldingRegisters(address: number, length: number) {
    this.reads.push([address,length]);
    this.activeRequests++; this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
    await Promise.resolve(); this.activeRequests--;
    if (this.failRead !== undefined && address <= this.failRead && address + length > this.failRead) throw new Error('Read failed');
    return {data: Array.from({length}, (_, index) => this.memory.get(address + index) ?? 0)};
  }
  async writeRegister(address: number, value: number) {
    this.activeRequests++; this.maxActiveRequests = Math.max(this.maxActiveRequests, this.activeRequests);
    await Promise.resolve(); this.activeRequests--;
    this.writes.push([address, value]);
    if (this.failWrite === address) throw new Error('Write failed');
    if (this.ignoreWrite !== address) this.memory.set(address, value);
  }
}
export function client(fake = new FakeTransport(), settings: any = control, mode: 'int' | 'float' = 'int') {
  const result = new (FroniusModbus as any)('offline.invalid', 502, 1, mode, {client: fake, control: settings});
  (result as any).client = fake;
  return {modbus: result as FroniusModbus, fake};
}

