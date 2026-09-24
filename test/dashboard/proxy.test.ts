import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardApp, type DashboardEnv } from '../../src/dashboard/worker/app';

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = 'dashboard-test-token';

type Respond = (request: Request) => Response | Promise<Response>;

function setup(respond: Respond = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  });
  const env: DashboardEnv = { API: { fetch } as unknown as Fetcher, API_TOKEN: TOKEN };
  const app = createDashboardApp();
  const call = (path: string, init?: RequestInit, overrides: Partial<DashboardEnv> = {}) =>
    app.request(path, init, { ...env, ...overrides });
  return { requests, fetch, call };
}

function expectJsonHeaders(res: Response) {
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('cache-control')).toBe('no-store');
}

describe('GET /api/anomalies', () => {
  it('forwards to /anomalies with the bearer token and passes the body through', async () => {
    const body = { as_of: '2026-09-23T12:00:00.000Z', regions: [] };
    const { requests, call } = setup(() => Response.json(body));

    const res = await call('/api/anomalies');

    expect(res.status).toBe(200);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual(body);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://episent-api/anomalies');
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('forwards no query parameters', async () => {
    const { requests, call } = setup();
    await call('/api/anomalies?geohash=ezs42&lat=1&lon=2');
    expect(requests[0].url).toBe('https://episent-api/anomalies');
  });
});

describe('GET /api/similar', () => {
  it('forwards only geohash and limit', async () => {
    const { requests, call } = setup();

    await call('/api/similar?geohash=u4pru&limit=5&lat=1&token=x');

    const url = new URL(requests[0].url);
    expect(url.origin + url.pathname).toBe('https://episent-api/similar');
    expect([...url.searchParams]).toEqual([
      ['geohash', 'u4pru'],
      ['limit', '5'],
    ]);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('forwards without a query string when no allowed params are given', async () => {
    const { requests, call } = setup();
    await call('/api/similar?lat=1');
    expect(requests[0].url).toBe('https://episent-api/similar');
  });
});

describe('upstream pass-through', () => {
  it.each([
    [400, { error: 'limit must be an integer from 1 to 20' }],
    [404, { error: 'no aggregated pattern for this region yet' }],
    [500, { error: 'internal error' }],
  ])('passes status %i and its body through', async (status, body) => {
    const { call } = setup(() => Response.json(body, { status }));

    const res = await call('/api/similar?geohash=u4pru');

    expect(res.status).toBe(status);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual(body);
  });

  it('does not forward client headers or cookies', async () => {
    const { requests, call } = setup();

    await call('/api/anomalies', {
      headers: { authorization: 'Bearer client-supplied', cookie: 'session=abc', 'x-forwarded-for': '1.2.3.4' },
    });

    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].headers.get('cookie')).toBeNull();
    expect(requests[0].headers.get('x-forwarded-for')).toBeNull();
  });
});

describe('unreachable routes', () => {
  it.each([
    ['GET', '/api/ingest'],
    ['POST', '/api/ingest'],
    ['POST', '/api/anomalies'],
    ['GET', '/api/unknown'],
    ['GET', '/api'],
  ])('%s %s returns 404 without calling upstream', async (method, path) => {
    const { fetch, call } = setup();

    const res = await call(path, { method });

    expect(res.status).toBe(404);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('returns 500 when API_TOKEN is not configured', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetch, call } = setup();

    const res = await call('/api/anomalies', undefined, { API_TOKEN: '' });

    expect(res.status).toBe(500);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it('returns 502 when the binding throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { call } = setup(() => {
      throw new Error('service unavailable');
    });

    const res = await call('/api/anomalies');

    expect(res.status).toBe(502);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual({ error: 'upstream unavailable' });
  });
});

describe('token confidentiality', () => {
  it.each<[string, string, Respond]>([
    ['success', '/api/anomalies', () => Response.json({ regions: [] })],
    ['upstream error', '/api/similar?geohash=u4pru', () => Response.json({ error: 'x' }, { status: 400 })],
    ['binding failure', '/api/anomalies', () => {
      throw new Error('boom');
    }],
    ['unknown route', '/api/ingest', () => Response.json({})],
  ])('never includes the token in the response (%s)', async (_name, path, respond) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { call } = setup(respond);

    const res = await call(path);

    expect(await res.text()).not.toContain(TOKEN);
    for (const [, value] of res.headers) expect(value).not.toContain(TOKEN);
  });
});
