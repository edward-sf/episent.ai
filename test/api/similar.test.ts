import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import type { ApiEnv } from '../../src/api/env';
import { FakeRepository, FakeVectorStore } from '../fakes';

const TOKEN = 'test-token';
const env = { API_TOKEN: TOKEN } as ApiEnv;

function pattern(geohash: string, windowEnd: string, values: number[], totalCases: number, topCategory: string) {
  return {
    id: `${geohash}:${windowEnd}`,
    values,
    metadata: { geohash, window_end: windowEnd, total_cases: totalCases, top_category: topCategory },
  };
}

async function setup() {
  const repo = new FakeRepository();
  const vectors = new FakeVectorStore();
  repo.regions.set('ezs42', {
    geohash: 'ezs42',
    last_aggregated_at: '2026-09-23T10:00:00+00:00',
    latest_window_end: '2026-09-23',
  });
  await vectors.upsert([
    pattern('ezs42', '2026-09-23', [1, 0, 0], 48, 'respiratory'),
    pattern('ezs42', '2026-09-20', [1, 0, 0], 40, 'respiratory'),
    pattern('u4pru', '2026-08-02', [0.9, 0.1, 0], 61, 'respiratory'),
    pattern('s0000', '2026-07-15', [0, 1, 0], 8, 'gastrointestinal'),
  ]);
  const app = createApp(() => ({ repo, vectors }));
  const get = (query: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    app.request(`/similar?${query}`, { headers }, env);
  return { repo, vectors, get };
}

type SimilarBody = {
  query: { geohash: string; window_end: string };
  matches: Array<{
    id: string;
    score: number;
    geohash: string;
    window_end: string;
    total_cases: number;
    top_category: string;
  }>;
};

describe('GET /similar', () => {
  it('returns the nearest patterns from other regions, excluding the query region history', async () => {
    const { get } = await setup();

    const res = await get('geohash=ezs42');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SimilarBody;
    expect(body.query).toEqual({ geohash: 'ezs42', window_end: '2026-09-23' });
    expect(body.matches.map((m) => m.id)).toEqual(['u4pru:2026-08-02', 's0000:2026-07-15']);
    expect(body.matches[0]).toMatchObject({
      geohash: 'u4pru',
      window_end: '2026-08-02',
      total_cases: 61,
      top_category: 'respiratory',
    });
    expect(body.matches[0]!.score).toBeCloseTo(0.9939, 3);
  });

  it('queries Vectorize with the limit, full metadata, and the region exclusion filter', async () => {
    const { vectors, get } = await setup();
    await get('geohash=ezs42');
    expect(vectors.lastQueryOptions).toEqual({
      topK: 10,
      returnMetadata: 'all',
      filter: { geohash: { $ne: 'ezs42' } },
    });
  });

  it('respects limit', async () => {
    const { vectors, get } = await setup();
    const body = (await (await get('geohash=ezs42&limit=1')).json()) as SimilarBody;
    expect(body.matches.map((m) => m.id)).toEqual(['u4pru:2026-08-02']);
    expect(vectors.lastQueryOptions?.topK).toBe(1);
  });

  it('resolves lat/lon to the region geohash', async () => {
    const { get } = await setup();
    const res = await get('lat=42.605&lon=-5.603');
    expect(res.status).toBe(200);
    expect(((await res.json()) as SimilarBody).query.geohash).toBe('ezs42');
  });

  it('accepts an uppercase geohash', async () => {
    const { get } = await setup();
    expect((await get('geohash=EZS42')).status).toBe(200);
  });

  it.each([
    'geohash=abc',
    'geohash=ezsa2',
    'lat=91&lon=0',
    'lat=&lon=0',
    'lat=10',
    '',
    'geohash=ezs42&limit=0',
    'geohash=ezs42&limit=21',
    'geohash=ezs42&limit=2.5',
  ])('returns 400 for query %j', async (query) => {
    const { get } = await setup();
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
  });

  it('returns 404 for an unknown region', async () => {
    const { get } = await setup();
    expect((await get('geohash=u4pru')).status).toBe(404);
  });

  it('returns 404 for a region that has never been aggregated', async () => {
    const { repo, get } = await setup();
    repo.regions.set('dr5ru', { geohash: 'dr5ru', last_aggregated_at: null, latest_window_end: null });
    expect((await get('geohash=dr5ru')).status).toBe(404);
  });

  it('returns 404 when the region vector is not visible in Vectorize yet', async () => {
    const { repo, get } = await setup();
    repo.regions.set('dr5ru', {
      geohash: 'dr5ru',
      last_aggregated_at: '2026-09-23T10:00:00+00:00',
      latest_window_end: '2026-09-23',
    });
    expect((await get('geohash=dr5ru')).status).toBe(404);
  });

  it('requires a bearer token', async () => {
    const { get } = await setup();
    expect((await get('geohash=ezs42', {})).status).toBe(401);
  });
});
