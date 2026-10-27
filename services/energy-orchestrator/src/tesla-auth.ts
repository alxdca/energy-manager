import http2, { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';

export const teslaTokenUrl = 'https://auth.tesla.com/oauth2/v3/token';

/** Tesla's Owner tokens require the HTTP/2 + TLS 1.3 auth transport used by TeslaMate. */
export const fetchTeslaAuth: typeof globalThis.fetch = async (input, init = {}) => {
  if (String(input) !== teslaTokenUrl || init.method !== 'POST' || typeof init.body !== 'string') {
    throw new Error('Demande d’authentification Tesla invalide.');
  }
  const body = init.body;
  const headers = new Headers(init.headers);
  return new Promise<Response>((resolve, reject) => {
    let session: ClientHttp2Session | undefined;
    let stream: ClientHttp2Stream | undefined;
    let finished = false;
    const signal = init.signal;
    const fail = () => finish(new Error('Le service d’authentification Tesla est indisponible.'));
    const timer = setTimeout(fail, 10_000);
    function finish(error?: Error, response?: Response) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
      stream?.destroy();
      session?.destroy();
      if (error) reject(error);
      else resolve(response!);
    }
    if (signal?.aborted) { fail(); return; }
    signal?.addEventListener('abort', fail, { once: true });
    try {
      session = http2.connect(new URL(teslaTokenUrl).origin, {
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: true,
      });
      session.on('error', fail);
      session.once('connect', () => {
        if (finished) return;
        try {
          const requestHeaders: http2.OutgoingHttpHeaders = {
            ':method': 'POST', ':path': '/oauth2/v3/token',
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            accept: headers.get('accept') ?? 'application/json',
            'user-agent': headers.get('user-agent') ?? 'EnergyManager/0.1',
          };
          stream = session!.request(requestHeaders);
          let status = 0;
          const responseHeaders = new Headers();
          const chunks: Buffer[] = [];
          let bytes = 0;
          stream.on('response', received => {
            status = Number(received[':status']);
            for (const [name, value] of Object.entries(received)) {
              if (!name.startsWith(':') && value !== undefined) {
                for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(item));
              }
            }
          });
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65_536) fail();
            else chunks.push(chunk);
          });
          stream.on('error', fail);
          stream.on('aborted', fail);
          stream.on('close', () => { if (!finished) fail(); });
          stream.on('end', () => {
            try {
              // Return redirects as errors to the caller; never forward a refresh token.
              const content = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks).toString('utf8');
              finish(undefined, new Response(content, { status, headers: responseHeaders }));
            } catch { fail(); }
          });
          stream.end(body);
        } catch { fail(); }
      });
      session.on('close', () => { if (!finished) fail(); });
    } catch { fail(); }
  });
};
