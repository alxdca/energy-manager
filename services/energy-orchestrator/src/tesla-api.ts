import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { TeslaService } from './tesla.js';

export function createTeslaApi(tesla: TeslaService) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.method === 'POST') {
      const origin = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin !== undefined && origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'La connexion Tesla doit provenir de ce tableau de bord.' }, 403);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
        return c.json({ error: 'La demande doit utiliser le format application/json.' }, 415);
      }
    }
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 12_288, onError: c => c.json({ error: 'La demande est trop volumineuse.' }, 413) }));
  app.get('/', async c => c.json(await tesla.readStatus()));
  for (const action of ['connect', 'disconnect'] as const) {
    app.post(`/${action}`, async c => {
      let body: unknown;
      try {
        const raw = await c.req.text();
        if (new TextEncoder().encode(raw).byteLength > 12_288) return c.json({ error: 'La demande est trop volumineuse.' }, 413);
        body = JSON.parse(raw);
      } catch (error) {
        if (error instanceof Error && error.name === 'BodyLimitError') return c.json({ error: 'La demande est trop volumineuse.' }, 413);
        return c.json({ error: 'La demande doit contenir du JSON valide.' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'La demande est invalide.' }, 400);
      const input = body as Record<string, unknown>;
      if (action === 'connect') {
        if (Object.keys(input).length !== 1 || typeof input.refreshToken !== 'string'
          || input.refreshToken.length < 8 || input.refreshToken.length > 8192 || /\s/.test(input.refreshToken)) {
          return c.json({ error: 'Renseignez uniquement un jeton de renouvellement Tesla valide.' }, 400);
        }
      } else if (Object.keys(input).length !== 0) return c.json({ error: 'La demande de déconnexion est invalide.' }, 400);
      try {
        if (action === 'connect') await tesla.connect(input.refreshToken as string);
        else await tesla.disconnect();
        return c.json({ success: true, car: await tesla.readStatus() });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'La connexion Tesla est indisponible.' }, 502);
      }
    });
  }
  return app;
}
