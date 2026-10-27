import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import type { Socket } from 'node:net';
import { Wattpilot } from '../src/devices/wattpilot.js';

// Wire fixtures follow the local protocol: this exercises Node's real WebSocket,
// not an injected socket, including masking and secured writes.
test('native WebSocket authenticates and confirms manual control over a local protocol fixture', {
  skip: typeof globalThis.WebSocket !== 'function' ? 'Wattpilot requires native WebSocket (Node 22.4+)' : false,
}, async t => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const serial = '12345678';
  const secret = pbkdf2Sync('test-only', serial, 100_000, 256, 'sha512').toString('base64').slice(0, 32);
  const properties: Record<string, unknown> = {
    frc: 0, lmo: 3, amp: 6, psm: 0, ama: 16, cbl: 16, adi: false, var: 11,
    car: 3, alw: true, nrg: [230, 230, 230, 0, 0, 0, 0, 0, 0, 0, 0, 0], wh: 0, eto: 1234,
  };
  const writes: Array<[string, number]> = [];
  const wireErrors: Error[] = [];
  const sockets = new Set<Socket>();
  function send(socket: Socket, value: unknown) {
    const payload = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
    header[0] = 0x81;
    header[1] = payload.length < 126 ? payload.length : 126;
    if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
    socket.write(Buffer.concat([header, payload]));
  }
  const server = createServer();
  server.on('upgrade', (request, duplex) => {
    const socket = duplex as Socket;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => wireErrors.push(error));
    const key = request.headers['sec-websocket-key'];
    if (request.url !== '/ws' || typeof key !== 'string') { socket.destroy(); return; }
    const upgrade = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${upgrade}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      try {
        while (buffer.length >= 2) {
          const opcode = buffer[0]! & 0xf;
          const masked = Boolean(buffer[1]! & 0x80);
          let length = buffer[1]! & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2); offset = 4;
          }
          assert.notEqual(length, 127, 'fixture messages remain small');
          assert.equal(masked, true);
          if (buffer.length < offset + 4 + length) return;
          const mask = buffer.subarray(offset, offset + 4); offset += 4;
          const payload = Buffer.from(buffer.subarray(offset, offset + length));
          for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) { socket.end(); return; }
          if (opcode !== 1) continue;
          const message = JSON.parse(payload.toString()) as Record<string, unknown>;
          if (message.type === 'auth') {
            assert.equal(message.hash, sha(String(message.token3) + 'token-two' + sha('token-one' + secret)));
            send(socket, { type: 'authSuccess' });
            send(socket, { type: 'fullStatus', status: properties, partial: false });
          } else {
            assert.equal(message.type, 'securedMsg');
            assert.equal(typeof message.data, 'string');
            const data = message.data as string;
            assert.equal(message.hmac, createHmac('sha256', secret).update(data).digest('hex'));
            const command = JSON.parse(data) as { type: string; requestId: number; key: string; value: number };
            assert.equal(command.type, 'setValue');
            writes.push([command.key, command.value]);
            properties[command.key] = command.value;
            send(socket, { type: 'response', requestId: String(command.requestId), success: true, status: { [command.key]: command.value } });
            if (command.key === 'frc' && command.value === 1) {
              properties.car = 3; properties.alw = false;
              send(socket, { type: 'deltaStatus', status: { car: 3, alw: false, nrg: properties.nrg } });
            }
          }
        }
      } catch (error) { wireErrors.push(error as Error); socket.destroy(); }
    });
    send(socket, { type: 'hello', manufacturer: 'fronius', devicetype: 'wattpilot', protocol: 2, serial, secured: true });
    send(socket, { type: 'authRequired', token1: 'token-one', token2: 'token-two' });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('This sandbox does not allow a loopback test server');
      return;
    }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const device = new Wattpilot({ url: `ws://127.0.0.1:${address.port}/ws`, password: 'test-only',
    controlEnabled: true, maxCurrentAmps: 16, requestTimeoutMs: 3000, staleAfterMs: 30_000 });
  t.after(async () => {
    await device.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const status = await device.readStatus();
  assert.equal(status.status, 'online', status.error ?? 'Wattpilot should be online');
  assert.equal(status.totalEnergyWh, 1234);
  assert.equal(status.phaseMode, 'auto');
  const charging = await device.setControl({ mode: 'normal', currentAmps: 10, phases: 1 });
  assert.equal(charging.currentAmps, 10);
  assert.equal(charging.phaseMode, 1);
  assert.equal((await device.setControl({ mode: 'pause' })).mode, 'pause');
  assert.deepEqual(writes, [['frc', 1], ['psm', 1], ['amp', 10], ['lmo', 3], ['frc', 0], ['frc', 1]]);
  assert.deepEqual(wireErrors, []);
});
