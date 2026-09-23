import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import type { ApiEnv } from '../../src/api/env';
import { FakeRepository, FakeVectorStore } from '../fakes';

const TOKEN = 'test-token';
const env = { API_TOKEN: TOKEN } as ApiEnv;

const valid = {
  event_timestamp: '2026-09-20T08:00:00Z',
  lat: 42.605,
  lon: -5.603,
  disease_category: 'respiratory',
  case_count: 3,
  age_band: '25-34',
  symptom_codes: ['R05'],
};

function setup(testEnv: ApiEnv = env) {
  const repo = new FakeRepository();
  const vectors = new FakeVectorStore();
  const app = createApp(() => ({ repo, vectors }));
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    app.request(
      '/ingest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      testEnv,
    );
  return { repo, post };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /ingest', () => {
  it('stores a valid report with its geohash and the raw payload', async () => {
    const { repo, post } = setup();
    const body = { ...valid, disease_category: 'Respiratory', extra_field: 'kept in raw payload' };

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'report-1', geohash: 'ezs42' });
    expect(repo.inserted).toEqual([{ ...valid, geohash: 'ezs42', raw_payload: body }]);
  });

  it('rejects a request without a bearer token', async () => {
    const { repo, post } = setup();
    const res = await post(valid, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(repo.inserted).toHaveLength(0);
  });

  it('rejects a wrong bearer token', async () => {
    const { repo, post } = setup();
    const res = await post(valid, { authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(repo.inserted).toHaveLength(0);
  });

  it('rejects a malformed authorization header', async () => {
    const { repo, post } = setup();
    const res = await post(valid, { authorization: 'Basic abc' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(repo.inserted).toHaveLength(0);
  });

  it('fails closed when API_TOKEN is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, post } = setup({ ...env, API_TOKEN: '' });
    const res = await post(valid);
    expect(res.status).toBe(500);
    expect(repo.inserted).toHaveLength(0);
  });

  it('returns 400 for malformed JSON', async () => {
    const { post } = setup();
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid JSON body' });
  });

  it('returns 400 with field details for an invalid report', async () => {
    const { repo, post } = setup();
    const res = await post({ ...valid, lat: 200 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: Array<{ field: string }> };
    expect(body.error).toBe('validation failed');
    expect(body.details.map((d) => d.field)).toContain('lat');
    expect(repo.inserted).toHaveLength(0);
  });

  it('returns 413 for a body over 64 KB', async () => {
    const { repo, post } = setup();
    const res = await post({ ...valid, padding: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(repo.inserted).toHaveLength(0);
  });

  it('returns a generic 500 when storage fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, post } = setup();
    repo.failures.add('insertCaseReport');

    const res = await post(valid);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(errorLog).toHaveBeenCalled();
  });
});

describe('unknown routes', () => {
  it('returns a JSON 404 for an authenticated request to an unknown route', async () => {
    const repo = new FakeRepository();
    const vectors = new FakeVectorStore();
    const app = createApp(() => ({ repo, vectors }));

    const res = await app.request('/nope', { headers: { authorization: `Bearer ${TOKEN}` } }, env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
