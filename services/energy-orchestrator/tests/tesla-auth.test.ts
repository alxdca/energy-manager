import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import { fetchTeslaAuth, teslaTokenUrl } from '../src/tesla-auth.js';

function transport(t: TestContext, respond?: (stream: EventEmitter) => void) {
  const stream = Object.assign(new EventEmitter(), {
    destroyed: false,
    body: '',
    destroy() { this.destroyed = true; },
    end(body: string): void { this.body = body; queueMicrotask(() => respond?.(stream)); },
  });
  const session = Object.assign(new EventEmitter(), {
    destroyed: false,
    headers: {} as http2.OutgoingHttpHeaders,
    destroy() { this.destroyed = true; },
    request(headers: http2.OutgoingHttpHeaders) { this.headers = headers; return stream; },
  });
  const connect = t.mock.method(http2, 'connect', (authority: string | URL, options: http2.SecureClientSessionOptions) => {
    assert.equal(authority, 'https://auth.tesla.com');
    assert.deepEqual(options, { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true });
    queueMicrotask(() => session.emit('connect'));
    return session;
  });
  return { session, stream, connect };
}
const request = (signal?: AbortSignal) => fetchTeslaAuth(teslaTokenUrl, {
  method: 'POST', signal, headers: { 'user-agent': 'EnergyManager/0.1' }, body: '{"refresh_token":"private-secret"}',
});

test('token transport negotiates HTTP/2 with verified TLS 1.3 and closes after a complete response', async t => {
  const { session, stream } = transport(t, stream => {
    stream.emit('response', { ':status': 200, 'content-type': 'application/json' });
    stream.emit('data', Buffer.from('{"access_token":"test-token"}'));
    stream.emit('end');
  });
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: 'test-token' });
  assert.equal(session.headers[':method'], 'POST');
  assert.equal(session.headers[':path'], '/oauth2/v3/token');
  assert.equal(stream.body, '{"refresh_token":"private-secret"}');
  assert.equal(session.destroyed, true);
  assert.equal(stream.destroyed, true);
});

test('auth redirects are returned without sending the refresh token to another host', async t => {
  const { connect } = transport(t, stream => {
    stream.emit('response', { ':status': 302, location: 'https://untrusted.example/token' });
    stream.emit('end');
  });
  const response = await request();
  assert.equal(response.status, 302);
  assert.equal(response.ok, false);
  assert.equal(connect.mock.callCount(), 1);
});

test('auth transport restricts the credential destination and method before connecting', async t => {
  const { connect } = transport(t);
  for (const url of ['https://untrusted.example/token', `${teslaTokenUrl}?token=secret`, teslaTokenUrl.replace('https:', 'http:')]) {
    await assert.rejects(fetchTeslaAuth(url, { method: 'POST', body: 'private-secret' }), /invalide/);
  }
  await assert.rejects(fetchTeslaAuth(teslaTokenUrl, { method: 'GET' }), /invalide/);
  assert.equal(connect.mock.callCount(), 0);
});

test('abort destroys the auth stream/session and never leaks transport error details', async t => {
  const { session, stream } = transport(t);
  const abort = new AbortController();
  const pending = request(abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort(new Error('private-secret'));
  await assert.rejects(pending, error => error instanceof Error && !error.message.includes('private-secret'));
  assert.equal(session.destroyed, true);
  assert.equal(stream.destroyed, true);
});

test('an already aborted auth request creates no network connection', async t => {
  const { connect } = transport(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(request(abort.signal), /indisponible/);
  assert.equal(connect.mock.callCount(), 0);
});

test('truncated responses, session errors and oversized auth bodies fail closed', async t => {
  for (const kind of ['close', 'error', 'large']) {
    const { session, stream } = transport(t, stream => {
      if (kind === 'close') stream.emit('close');
      else if (kind === 'error') stream.emit('error', new Error('private-secret'));
      else stream.emit('data', Buffer.alloc(65_537));
    });
    await assert.rejects(request(), error => error instanceof Error && !error.message.includes('private-secret'));
    assert.equal(session.destroyed, true);
    assert.equal(stream.destroyed, true);
    t.mock.restoreAll();
  }
});
