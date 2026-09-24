import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSupabaseRepository, type NewCaseReport } from '../../src/shared/repository';

const url = process.env.SUPABASE_TEST_URL;
const key = process.env.SUPABASE_TEST_SECRET_KEY;

// Safety guard: beforeEach below deletes every row in both tables, so only ever run this
// suite against a local database.
function isLocalUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

describe.skipIf(!url || !key || !isLocalUrl(url))('Supabase repository (contract)', () => {
  // describe.skipIf only skips the `it()` bodies below; this setup code still runs at
  // collection time even when skipped, so fall back to dummy values to avoid throwing
  // when the env vars are unset (the real url/key are used whenever they are set).
  const admin = createClient(url ?? 'http://127.0.0.1:54321', key ?? 'test-key', {
    auth: { persistSession: false },
  });
  const repo = createSupabaseRepository(url ?? 'http://127.0.0.1:54321', key ?? 'test-key');

  const report = (overrides: Partial<NewCaseReport> = {}): NewCaseReport => ({
    event_timestamp: '2026-09-20T08:00:00Z',
    lat: 42.605,
    lon: -5.603,
    geohash: 'ezs42',
    disease_category: 'respiratory',
    case_count: 3,
    age_band: '25-34',
    symptom_codes: ['R05'],
    raw_payload: { source: 'contract-test' },
    ...overrides,
  });

  beforeEach(async () => {
    const reports = await admin.from('case_reports').delete().not('id', 'is', null);
    expect(reports.error).toBeNull();
    const regions = await admin.from('regions_index').delete().not('geohash', 'is', null);
    expect(regions.error).toBeNull();
  });

  it('inserting a report registers its region as never aggregated', async () => {
    const { id } = await repo.insertCaseReport(report());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await repo.getRegion('ezs42')).toEqual({
      geohash: 'ezs42',
      last_aggregated_at: null,
      latest_window_end: null,
    });
  });

  it('returns null for an unknown region', async () => {
    expect(await repo.getRegion('u4pru')).toBeNull();
  });

  it('lists a never-aggregated region as dirty with a database timestamp', async () => {
    await repo.insertCaseReport(report());
    const dirty = await repo.listDirtyRegions(20);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.geohash).toBe('ezs42');
    expect(Number.isNaN(Date.parse(dirty[0]!.checkedAt))).toBe(false);
  });

  it('is clean after markAggregated and dirty again after a new report', async () => {
    await repo.insertCaseReport(report());
    const [region] = await repo.listDirtyRegions(20);
    await repo.markAggregated('ezs42', region!.checkedAt, '2026-09-23');

    expect(await repo.listDirtyRegions(20)).toEqual([]);
    expect(await repo.getRegion('ezs42')).toMatchObject({ latest_window_end: '2026-09-23' });

    await repo.insertCaseReport(report());
    expect((await repo.listDirtyRegions(20)).map((r) => r.geohash)).toEqual(['ezs42']);
  });

  it('keeps the previous latest_window_end when marked with null', async () => {
    await repo.insertCaseReport(report());
    const [first] = await repo.listDirtyRegions(20);
    await repo.markAggregated('ezs42', first!.checkedAt, '2026-09-22');
    await repo.insertCaseReport(report());
    const [second] = await repo.listDirtyRegions(20);

    await repo.markAggregated('ezs42', second!.checkedAt, null);

    expect(await repo.getRegion('ezs42')).toMatchObject({ latest_window_end: '2026-09-22' });
    expect(await repo.listDirtyRegions(20)).toEqual([]);
  });

  it('returns only the region reports inside (start, end]', async () => {
    await repo.insertCaseReport(report({ event_timestamp: '2026-09-09T12:00:00Z', case_count: 1 }));
    await repo.insertCaseReport(report({ event_timestamp: '2026-09-10T00:00:00Z', case_count: 2 }));
    await repo.insertCaseReport(
      report({ event_timestamp: '2026-09-23T12:00:00Z', case_count: 5, age_band: undefined }),
    );
    await repo.insertCaseReport(report({ event_timestamp: '2026-09-23T12:00:01Z', case_count: 7 }));
    await repo.insertCaseReport(report({ geohash: 'u4pru', case_count: 11 }));

    const rows = await repo.getWindowReports(
      'ezs42',
      new Date('2026-09-09T12:00:00Z'),
      new Date('2026-09-23T12:00:00Z'),
    );

    expect(rows.map((r) => r.case_count).sort((a, b) => a - b)).toEqual([2, 5]);
    expect(rows.find((r) => r.case_count === 5)?.age_band).toBeNull();
  });

  it('pages past the 1000-row PostgREST limit', async () => {
    const rows = Array.from({ length: 1005 }, (_, i) => ({
      event_timestamp: '2026-09-20T08:00:00Z',
      lat: 42.605,
      lon: -5.603,
      geohash: 'ezs42',
      disease_category: 'respiratory',
      case_count: 1,
      raw_payload: { i },
    }));
    const { error } = await admin.from('case_reports').insert(rows);
    expect(error).toBeNull();

    const result = await repo.getWindowReports(
      'ezs42',
      new Date('2026-09-09T12:00:00Z'),
      new Date('2026-09-23T12:00:00Z'),
    );
    expect(result).toHaveLength(1005);
  });

  it('respects the limit and lists never-aggregated regions first', async () => {
    for (const geohash of ['ezs42', 'u4pru', 's0000']) {
      await repo.insertCaseReport(report({ geohash }));
    }
    const ezs42 = (await repo.listDirtyRegions(20)).find((r) => r.geohash === 'ezs42')!;
    await repo.markAggregated('ezs42', ezs42.checkedAt, '2026-09-22');
    await repo.insertCaseReport(report({ geohash: 'ezs42' }));

    expect((await repo.listDirtyRegions(2)).map((r) => r.geohash)).toEqual(['s0000', 'u4pru']);
    expect((await repo.listDirtyRegions(20)).map((r) => r.geohash)).toEqual(['s0000', 'u4pru', 'ezs42']);
  });

  describe('anomaly_stats', () => {
    const T = new Date('2026-09-23T12:00:00Z');
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const WEEK = 7 * DAY;
    const before = (ms: number) => new Date(T.getTime() - ms).toISOString();

    async function seed(rows: Array<{ at: string; cases: number; geohash?: string; category?: string }>) {
      const { error } = await admin.from('case_reports').insert(
        rows.map((r) => ({
          event_timestamp: r.at,
          lat: 42.605,
          lon: -5.603,
          geohash: r.geohash ?? 'ezs42',
          disease_category: r.category ?? 'respiratory',
          case_count: r.cases,
          raw_payload: {},
        })),
      );
      expect(error).toBeNull();
    }

    const stats = (rows: Array<{ as_of: string }>) => rows.map(({ as_of: _asOf, ...rest }) => rest);

    it('buckets by 7-day week, ignores the guard week, and computes median and MAD', async () => {
      await seed([
        // Anchors the region's first report long ago so all 12 baseline weeks qualify.
        { at: before(200 * DAY), cases: 1, category: 'other' },
        { at: before(0), cases: 2 }, // exactly t: week 0
        { at: before(WEEK - 1000), cases: 3 }, // just inside week 0
        { at: before(WEEK), cases: 100 }, // exactly t − 7d: week 1 (guard), ignored
        // Baseline weeks 2..13 hold 1..12 cases → median 6.5, MAD 3.
        ...Array.from({ length: 12 }, (_, i) => ({ at: before((i + 2) * WEEK + HOUR), cases: i + 1 })),
      ]);

      const rows = await repo.getAnomalyStats('ezs42', T);

      expect(stats(rows)).toEqual([
        {
          geohash: 'ezs42',
          disease_category: 'respiratory',
          current_cases: 5,
          baseline_median: 6.5,
          baseline_mad: 3,
          baseline_weeks: 12,
        },
      ]);
      expect(Date.parse(rows[0]!.as_of)).toBe(T.getTime());
    });

    it('zero-fills baseline weeks and omits categories with no reports in 98 days', async () => {
      await seed([
        { at: before(200 * DAY), cases: 4, category: 'other' },
        { at: before(5 * WEEK + HOUR), cases: 12 },
      ]);

      expect(stats(await repo.getAnomalyStats('ezs42', T))).toEqual([
        {
          geohash: 'ezs42',
          disease_category: 'respiratory',
          current_cases: 0,
          baseline_median: 0,
          baseline_mad: 0,
          baseline_weeks: 12,
        },
      ]);
    });

    it("counts only whole baseline weeks after the region's first report", async () => {
      await seed([
        // First report lands inside week 5, so only weeks 2, 3 and 4 qualify.
        { at: before(5 * WEEK + HOUR), cases: 1 },
        { at: before(HOUR), cases: 2 },
      ]);

      expect(stats(await repo.getAnomalyStats('ezs42', T))).toEqual([
        {
          geohash: 'ezs42',
          disease_category: 'respiratory',
          current_cases: 2,
          baseline_median: 0,
          baseline_mad: 0,
          baseline_weeks: 3,
        },
      ]);
    });

    it('returns null baseline statistics when no week qualifies', async () => {
      await seed([{ at: before(HOUR), cases: 1 }]);

      expect(stats(await repo.getAnomalyStats('ezs42', T))).toEqual([
        {
          geohash: 'ezs42',
          disease_category: 'respiratory',
          current_cases: 1,
          baseline_median: null,
          baseline_mad: null,
          baseline_weeks: 0,
        },
      ]);
    });

    it('filters by geohash, or returns every region ordered by geohash and category', async () => {
      await seed([
        { at: before(HOUR), cases: 1, geohash: 'u4pru', category: 'respiratory' },
        { at: before(HOUR), cases: 1, geohash: 'ezs42', category: 'respiratory' },
        { at: before(HOUR), cases: 1, geohash: 'ezs42', category: 'gastrointestinal' },
      ]);

      expect((await repo.getAnomalyStats('u4pru', T)).map((r) => r.geohash)).toEqual(['u4pru']);
      expect((await repo.getAnomalyStats(null, T)).map((r) => `${r.geohash}/${r.disease_category}`)).toEqual([
        'ezs42/gastrointestinal',
        'ezs42/respiratory',
        'u4pru/respiratory',
      ]);
    });

    it('defaults as_of to the database clock', async () => {
      await seed([{ at: new Date(Date.now() - HOUR).toISOString(), cases: 1 }]);

      const [row] = await repo.getAnomalyStats('ezs42');

      expect(Math.abs(Date.parse(row!.as_of) - Date.now())).toBeLessThan(60_000);
    });

    it('pages past the 1000-row PostgREST limit', async () => {
      await seed(Array.from({ length: 1005 }, (_, i) => ({ at: before(HOUR), cases: 1, category: `c${i}` })));

      expect(await repo.getAnomalyStats('ezs42', T)).toHaveLength(1005);
    });
  });
});
