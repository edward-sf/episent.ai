import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ApiDeps, ApiEnv, AppEnv } from './env';
import { ingestHandler } from './ingest';
import { similarHandler } from './similar';

export const MAX_INGEST_BYTES = 64 * 1024;

export function createApp(makeDeps: (env: ApiEnv) => ApiDeps) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error('unhandled error', err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.use('*', async (c, next) => {
    if (!c.env.API_TOKEN) {
      console.error('API_TOKEN is not configured');
      return c.json({ error: 'internal error' }, 500);
    }
    return bearerAuth<AppEnv>({
      token: c.env.API_TOKEN,
      noAuthenticationHeader: { message: { error: 'unauthorized' } },
      invalidAuthenticationHeader: { message: { error: 'unauthorized' } },
      invalidToken: { message: { error: 'unauthorized' } },
    })(c, next);
  });

  app.use('*', async (c, next) => {
    c.set('deps', makeDeps(c.env));
    await next();
  });

  app.post(
    '/ingest',
    bodyLimit({
      maxSize: MAX_INGEST_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    ingestHandler,
  );

  app.get('/similar', similarHandler);

  return app;
}
