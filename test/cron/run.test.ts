import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_REGIONS_PER_RUN, runAggregation, type AggregationDeps } from '../../src/cron/run';
import type { Embedder } from '../../src/shared/embedding';
import type { WindowReport } from '../../src/shared/repository';
import { FakeRepository, FakeVectorStore } from '../fakes';

const NOW = new Date('2026-09-23T12:00:00Z');
const CHECKED_AT = '2026-09-23T12:00:00.5+00:00';

function report(event_timestamp: string, disease_category: string, case_count: number, age_band: string | null = null): WindowReport {
  return { event_timestamp, disease_category, case_count, age_band };
}

const EZS42_REPORTS = [
  report('2026-09-22T08:00:00Z', 'respiratory', 36, '25-34'),
  report('2026-09-12T08:00:00Z', 'gastrointestinal', 12),
];

function setup(embed?: Embedder) {
  const repo = new FakeRepository();
  const vectors = new FakeVectorStore();
  const embeddedTexts: string[] = [];
  const deps: AggregationDeps = {
    repo,
    vectors,
    embed:
      embed ??
      (async (text) => {
        embeddedTexts.push(text);
        return [1, 0, 0];
      }),
  };
  return { repo, vectors, embeddedTexts, deps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAggregation', () => {
  it('aggregates a dirty region into a dated pattern vector and marks it', async () => {
    const { repo, vectors, embeddedTexts, deps } = setup();
    repo.dirty = [{ geohash: 'ezs42', checkedAt: CHECKED_AT }];
    repo.windowReports.set('ezs42', EZS42_REPORTS);

    const result = await runAggregation(deps, NOW);

    expect(result).toEqual({ aggregated: ['ezs42'], empty: [], failed: [] });
    expect(repo.windowRequests).toEqual([
      {
        geohash: 'ezs42',
        start: new Date('2026-09-09T12:00:00Z'),
        end: new Date('2026-09-23T12:05:00.500Z'),
      },
    ]);
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain('48 total cases');
    expect(embeddedTexts[0]).not.toContain('ezs42');
    expect(embeddedTexts[0]).not.toContain('2026');
    expect(await vectors.getByIds(['ezs42:2026-09-23'])).toEqual([
      {
        id: 'ezs42:2026-09-23',
        values: [1, 0, 0],
        metadata: { geohash: 'ezs42', window_end: '2026-09-23', total_cases: 48, top_category: 'respiratory' },
      },
    ]);
    expect(repo.marked).toEqual([{ geohash: 'ezs42', checkedAt: CHECKED_AT, latestWindowEnd: '2026-09-23' }]);
  });

  it('derives the window end per region from that region\'s checkedAt', async () => {
    const { repo, deps } = setup();
    repo.dirty = [
      { geohash: 'ezs42', checkedAt: '2026-09-23T12:00:00.5+00:00' },
      { geohash: 'u4pru', checkedAt: '2026-09-23T12:03:00+00:00' },
    ];
    repo.windowReports.set('ezs42', EZS42_REPORTS);
    repo.windowReports.set('u4pru', EZS42_REPORTS);

    await runAggregation(deps, NOW);

    expect(repo.windowRequests).toEqual([
      {
        geohash: 'ezs42',
        start: new Date('2026-09-09T12:00:00Z'),
        end: new Date('2026-09-23T12:05:00.500Z'),
      },
      {
        geohash: 'u4pru',
        start: new Date('2026-09-09T12:00:00Z'),
        end: new Date('2026-09-23T12:08:00.000Z'),
      },
    ]);
  });

  it('asks for at most MAX_REGIONS_PER_RUN regions', async () => {
    const { repo, deps } = setup();
    await runAggregation(deps, NOW);
    expect(MAX_REGIONS_PER_RUN).toBe(20);
    expect(repo.lastMaxRegions).toBe(20);
  });

  it('marks a region with no reports in the window without writing a vector', async () => {
    const { repo, vectors, deps } = setup();
    repo.dirty = [{ geohash: 's0000', checkedAt: CHECKED_AT }];

    const result = await runAggregation(deps, NOW);

    expect(result).toEqual({ aggregated: [], empty: ['s0000'], failed: [] });
    expect(vectors.stored.size).toBe(0);
    expect(repo.marked).toEqual([{ geohash: 's0000', checkedAt: CHECKED_AT, latestWindowEnd: null }]);
  });

  it('keeps going when one region fails to embed and leaves that region unmarked', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const { repo, deps } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Workers AI unavailable');
      return [1, 0, 0];
    });
    repo.dirty = [
      { geohash: 'ezs42', checkedAt: CHECKED_AT },
      { geohash: 'u4pru', checkedAt: CHECKED_AT },
    ];
    repo.windowReports.set('ezs42', EZS42_REPORTS);
    repo.windowReports.set('u4pru', EZS42_REPORTS);

    const result = await runAggregation(deps, NOW);

    expect(result).toEqual({ aggregated: ['u4pru'], empty: [], failed: ['ezs42'] });
    expect(repo.marked.map((m) => m.geohash)).toEqual(['u4pru']);
    expect(errorLog).toHaveBeenCalled();
  });

  it('leaves a region unmarked when the vector upsert fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, vectors, deps } = setup();
    repo.dirty = [{ geohash: 'ezs42', checkedAt: CHECKED_AT }];
    repo.windowReports.set('ezs42', EZS42_REPORTS);
    vectors.failUpsertFor.add('ezs42:2026-09-23');

    const result = await runAggregation(deps, NOW);

    expect(result.failed).toEqual(['ezs42']);
    expect(repo.marked).toEqual([]);
  });

  it('leaves a region unmarked when fetching its reports fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, deps } = setup();
    repo.dirty = [{ geohash: 'ezs42', checkedAt: CHECKED_AT }];
    repo.failures.add('getWindowReports:ezs42');

    const result = await runAggregation(deps, NOW);

    expect(result.failed).toEqual(['ezs42']);
    expect(repo.marked).toEqual([]);
  });

  it('lists the region as failed when markAggregated fails, though the vector was already upserted', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, vectors, deps } = setup();
    repo.dirty = [{ geohash: 'ezs42', checkedAt: CHECKED_AT }];
    repo.windowReports.set('ezs42', EZS42_REPORTS);
    repo.failures.add('markAggregated:ezs42');

    const result = await runAggregation(deps, NOW);

    expect(result.failed).toEqual(['ezs42']);
    expect(await vectors.getByIds(['ezs42:2026-09-23'])).toHaveLength(1);
    expect(errorLog).toHaveBeenCalled();
  });

  it('overwrites the same day vector when rerun', async () => {
    const { repo, vectors, deps } = setup();
    repo.dirty = [{ geohash: 'ezs42', checkedAt: CHECKED_AT }];
    repo.windowReports.set('ezs42', EZS42_REPORTS);

    await runAggregation(deps, NOW);
    await runAggregation(deps, new Date('2026-09-23T13:00:00Z'));

    expect([...vectors.stored.keys()]).toEqual(['ezs42:2026-09-23']);
  });

  it('propagates a failure to list dirty regions', async () => {
    const { repo, deps } = setup();
    repo.failures.add('listDirtyRegions');
    await expect(runAggregation(deps, NOW)).rejects.toThrow(/listDirtyRegions/);
  });
});
