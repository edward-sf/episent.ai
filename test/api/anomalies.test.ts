import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import type { ApiEnv } from '../../src/api/env';
import type { RegionAnomaly } from '../../src/shared/anomaly';
import type { AnomalyStatsRow } from '../../src/shared/repository';
import { FakeRepository, FakeVectorStore } from '../fakes';

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = 'test-token';
const env = { API_TOKEN: TOKEN } as ApiEnv;
const AS_OF = '2026-09-23T14:05:00+00:00';

function stats(geohash: string, category: string, current: number, median: number, mad: number): AnomalyStatsRow {
  return {
    geohash,
    disease_category: category,
    current_cases: current,
    baseline_median: median,
    baseline_mad: mad,
    baseline_weeks: 12,
    as_of: AS_OF,
  };
}

function setup() {
  const repo = new FakeRepository();
  for (const geohash of ['ezs42', 'u4pru', 'dr5ru']) {
    repo.regions.set(geohash, { geohash, last_aggregated_at: null, latest_window_end: null });
  }
  repo.anomalyStats = [
    stats('u4pru', 'respiratory', 3, 3, 1), // score 0 → normal
    stats('ezs42', 'gastrointestinal', 4, 3.5, 1.5), // 0.5 / 2.2239 → 0.22, normal
    stats('ezs42', 'respiratory', 41, 5, 2), // 36 / 2.9652 → 12.14, anomalous
  ];
  const app = createApp(() => ({ repo, vectors: new FakeVectorStore() }));
  const get = (query: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    app.request(`/anomalies${query ? `?${query}` : ''}`, { headers }, env);
  return { repo, get };
}

type AnomaliesBody = { as_of: string; regions: RegionAnomaly[] };

const EZS42: RegionAnomaly = {
  geohash: 'ezs42',
  status: 'anomalous',
  max_score: 12.14,
  categories: [
    {
      category: 'respiratory',
      status: 'anomalous',
      score: 12.14,
      current_cases: 41,
      baseline_median: 5,
      baseline_mad: 2,
      baseline_weeks: 12,
    },
    {
      category: 'gastrointestinal',
      status: 'normal',
      score: 0.22,
      current_cases: 4,
      baseline_median: 3.5,
      baseline_mad: 1.5,
      baseline_weeks: 12,
    },
  ],
};

describe('GET /anomalies', () => {
  it('lists every scored region, most anomalous first, with the database as_of', async () => {
    const { repo, get } = setup();

    const res = await get('');

    expect(res.status).toBe(200);
    const body = (await res.json()) as AnomaliesBody;
    expect(body.as_of).toBe('2026-09-23T14:05:00.000Z');
    expect(body.regions.map((r) => [r.geohash, r.status])).toEqual([
      ['ezs42', 'anomalous'],
      ['u4pru', 'normal'],
    ]);
    expect(body.regions[0]).toEqual(EZS42);
    expect(repo.anomalyRequests).toEqual([{ geohash: null, asOf: undefined }]);
  });

  it('falls back to the current time when there are no rows', async () => {
    const { repo, get } = setup();
    repo.anomalyStats = [];

    const body = (await (await get('')).json()) as AnomaliesBody;

    expect(body.regions).toEqual([]);
    expect(Math.abs(Date.parse(body.as_of) - Date.now())).toBeLessThan(60_000);
  });

  it('returns one region by geohash', async () => {
    const { repo, get } = setup();

    const res = await get('geohash=EZS42');

    expect(res.status).toBe(200);
    expect(((await res.json()) as AnomaliesBody).regions).toEqual([EZS42]);
    expect(repo.anomalyRequests).toEqual([{ geohash: 'ezs42', asOf: undefined }]);
  });

  it('resolves lat/lon to the region', async () => {
    const { get } = setup();
    const body = (await (await get('lat=42.605&lon=-5.603')).json()) as AnomaliesBody;
    expect(body.regions.map((r) => r.geohash)).toEqual(['ezs42']);
  });

  it('returns an empty insufficient_data region for a known region with no recent reports', async () => {
    const { get } = setup();

    const res = await get('geohash=dr5ru');

    expect(res.status).toBe(200);
    expect(((await res.json()) as AnomaliesBody).regions).toEqual([
      { geohash: 'dr5ru', status: 'insufficient_data', max_score: null, categories: [] },
    ]);
  });

  it('returns 404 for an unknown region without querying stats', async () => {
    const { repo, get } = setup();

    const res = await get('geohash=s0000');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown region' });
    expect(repo.anomalyRequests).toEqual([]);
  });

  it.each(['geohash=abc', 'lat=91&lon=0', 'lat=10', 'lon=10'])('returns 400 for query %j', async (query) => {
    const { get } = setup();
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
  });

  it('requires a bearer token', async () => {
    const { get } = setup();
    expect((await get('', {})).status).toBe(401);
  });

  it('returns a generic 500 when the stats query fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, get } = setup();
    repo.failures.add('getAnomalyStats');

    const res = await get('');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(errorLog).toHaveBeenCalled();
  });
});
