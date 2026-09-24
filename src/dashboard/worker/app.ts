import { Hono, type Context } from 'hono';

export interface DashboardEnv {
  API: Fetcher;
  API_TOKEN: string;
}

type DashboardAppEnv = { Bindings: DashboardEnv };

// Service Bindings ignore the host, but fetch() needs an absolute URL.
export const UPSTREAM_ORIGIN = 'https://episent-api';

const SIMILAR_PARAMS = ['geohash', 'limit'] as const;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function jsonResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: JSON_HEADERS });
}

function jsonError(error: string, status: number): Response {
  return jsonResponse(JSON.stringify({ error }), status);
}

// Read-only proxy: forwards exactly two GET routes to episent-api with the
// server-side token. /ingest and everything else is unreachable.
export function createDashboardApp() {
  const app = new Hono<DashboardAppEnv>();

  app.onError((err) => {
    console.error('unhandled error', err);
    return jsonError('internal error', 500);
  });

  app.notFound(() => jsonError('not found', 404));

  app.get('/api/anomalies', (c) => forward(c, '/anomalies', new URLSearchParams()));

  app.get('/api/similar', (c) => {
    const params = new URLSearchParams();
    for (const name of SIMILAR_PARAMS) {
      const value = c.req.query(name);
      if (value !== undefined) params.set(name, value);
    }
    return forward(c, '/similar', params);
  });

  return app;
}

async function forward(c: Context<DashboardAppEnv>, path: string, params: URLSearchParams): Promise<Response> {
  if (!c.env.API_TOKEN) {
    console.error('API_TOKEN is not configured');
    return jsonError('internal error', 500);
  }

  const query = params.size > 0 ? `?${params}` : '';
  let upstream: Response;
  try {
    upstream = await c.env.API.fetch(`${UPSTREAM_ORIGIN}${path}${query}`, {
      headers: { authorization: `Bearer ${c.env.API_TOKEN}` },
    });
  } catch (err) {
    console.error('upstream fetch failed', err);
    return jsonError('upstream unavailable', 502);
  }

  return jsonResponse(await upstream.text(), upstream.status);
}
