import { describe, expect, it, vi } from 'vitest';
import { createApi, SIMILAR_LIMIT, type FetchFn } from '../../src/dashboard/web/api';

function fakeFetch(respond: () => Response | Promise<Response>) {
  return vi.fn<FetchFn>(async () => respond());
}

describe('createApi', () => {
  it('requests /api/anomalies and returns the body', async () => {
    const body = { as_of: '2026-09-23T12:00:00.000Z', regions: [] };
    const fetch = fakeFetch(() => Response.json(body));

    const result = await createApi(fetch).anomalies();

    expect(fetch).toHaveBeenCalledWith('/api/anomalies', { headers: { accept: 'application/json' } });
    expect(result).toEqual({ ok: true, data: body });
  });

  it('requests /api/similar with the geohash and the fixed limit', async () => {
    const fetch = fakeFetch(() => Response.json({ query: {}, matches: [] }));

    await createApi(fetch).similar('u4xsu');

    expect(SIMILAR_LIMIT).toBe(5);
    expect(fetch).toHaveBeenCalledWith('/api/similar?geohash=u4xsu&limit=5', { headers: { accept: 'application/json' } });
  });

  it('returns the API error message and status', async () => {
    const fetch = fakeFetch(() => Response.json({ error: 'no aggregated pattern for this region yet' }, { status: 404 }));

    expect(await createApi(fetch).similar('u4xsu')).toEqual({
      ok: false,
      status: 404,
      error: 'no aggregated pattern for this region yet',
    });
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    const fetch = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));

    expect(await createApi(fetch).anomalies()).toEqual({ ok: false, status: 502, error: 'HTTP 502' });
  });

  it('reports an invalid successful body', async () => {
    const fetch = fakeFetch(() => new Response('not json', { status: 200 }));

    expect(await createApi(fetch).anomalies()).toEqual({ ok: false, status: 200, error: 'invalid response' });
  });

  it('reports network failures with status 0', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    expect(await createApi(fetch).anomalies()).toEqual({ ok: false, status: 0, error: 'network error' });
  });
});
