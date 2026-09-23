# Anomaly Scoring (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /anomalies` to the API Worker. It scores each region's current 7-day case count per disease category against a robust 12-week baseline and reports a status for each category and region.

**Architecture:** A Postgres function `anomaly_stats()` does the counting: weekly buckets, zero-fill, median and MAD. It returns one row per (region, category). A pure TypeScript module, `src/shared/anomaly.ts`, turns those rows into scores, statuses, region rollups and sort order. The API handler glues them together through the existing `Repository` interface. There are no aggregator, Vectorize or Workers AI changes.

**Tech Stack:** TypeScript, Hono, @supabase/supabase-js, Postgres (Supabase), Cloudflare Workers, Vitest, Supabase CLI.

**Spec:** `docs/superpowers/specs/2026-09-23-anomaly-scoring-design.md`

## Global Constraints

- Week `k` covers `(t − 7(k+1) days, t − 7k days]`, where `t = p_as_of`. Week 0 is the current window, week 1 is the guard band (ignored), and weeks 2–13 are the baseline (12 weeks). Only reports in `(t − 98 days, t]` are counted.
- A baseline week counts only if `t − 7(k+1) days ≥` the region's earliest `event_timestamp` over all categories and all time. Once a region qualifies, a week with no reports in a category counts as 0.
- Score: `(current − median) / max(1.4826 · MAD, √median, 1)`. It is rounded to 2 decimals in responses, and the status is decided on the unrounded value.
- Statuses, first match wins:
  1. `baseline_weeks < 4` → `insufficient_data` with a `null` score;
  2. `score ≥ 3` and `current_cases ≥ 5` → `anomalous`;
  3. `score ≥ 2` → `elevated`;
  4. otherwise `normal`.
- Severity order: `anomalous > elevated > normal > insufficient_data`.
- Constants live only in `src/shared/anomaly.ts`: `BASELINE_MIN_WEEKS = 4`, `ELEVATED_SCORE = 2`, `ANOMALOUS_SCORE = 3`, `ANOMALOUS_MIN_CASES = 5`.
- Sort order:
  - regions by severity (descending), then `max_score` (descending, nulls last), then `geohash` (ascending);
  - categories by severity, then `score`, then `category` name, using the same directions.
- Error bodies are `{ "error": string }`. The 404 message for an unknown region is exactly `unknown region`.
- The migration file is `supabase/migrations/20260924000000_anomaly_stats.sql`. The function is `stable` with `set search_path = ''`, and execute is revoked from `public`, `anon` and `authenticated`.
- The repository pages RPC results in chunks of `PAGE_SIZE` (1000), the existing constant.
- `/similar` behaviour must not change. Its existing tests must pass unmodified.
- Node 22.12+. Run the commands from the repo root.

## File Structure

```
supabase/migrations/20260924000000_anomaly_stats.sql   NEW  anomaly_stats() RPC
src/shared/repository.ts        MODIFY  AnomalyStatsRow type; Repository.getAnomalyStats + Supabase impl
src/shared/anomaly.ts           NEW     scoring constants, robustScore, scoreCategory, regionAnomaly, buildRegionAnomalies
src/api/region-query.ts         NEW     parseRegionQuery (geohash | lat+lon → geohash), extracted from similar.ts
src/api/similar.ts              MODIFY  parseSimilarQuery delegates region parsing to parseRegionQuery
src/api/anomalies.ts            NEW     GET /anomalies handler
src/api/app.ts                  MODIFY  register GET /anomalies
test/fakes.ts                   MODIFY  FakeRepository.getAnomalyStats
test/shared/anomaly.test.ts     NEW
test/shared/repository.contract.test.ts  MODIFY  anomaly_stats contract tests
test/api/region-query.test.ts   NEW
test/api/anomalies.test.ts      NEW
README.md                       MODIFY  document GET /anomalies
```

Task order: 1 (data layer) → 2 (scoring) → 3 (region-query refactor) → 4 (endpoint). Tasks 2 and 3 depend only on Task 1's `AnomalyStatsRow` type, and Task 4 depends on all three.

---

### Task 1: `anomaly_stats` RPC and repository method

**Files:**
- Create: `supabase/migrations/20260924000000_anomaly_stats.sql`
- Modify: `src/shared/repository.ts`
- Modify: `test/fakes.ts`
- Test: `test/shared/repository.contract.test.ts`

**Interfaces:**
- Consumes: existing `PAGE_SIZE`, `Repository`, `createSupabaseRepository` in `src/shared/repository.ts`.
- Produces:
  ```ts
  // src/shared/repository.ts
  export interface AnomalyStatsRow {
    geohash: string;
    disease_category: string;
    current_cases: number;
    baseline_median: number | null;
    baseline_mad: number | null;
    baseline_weeks: number;
    as_of: string; // Postgres timestamptz text, e.g. "2026-09-23T12:00:00+00:00"
  }
  // added to interface Repository:
  getAnomalyStats(geohash: string | null, asOf?: Date): Promise<AnomalyStatsRow[]>;
  ```
  ```ts
  // test/fakes.ts — FakeRepository gains:
  anomalyStats: AnomalyStatsRow[];                                  // rows returned (filtered by geohash when non-null)
  anomalyRequests: Array<{ geohash: string | null; asOf: Date | undefined }>;
  // failure key: 'getAnomalyStats'
  ```

**Prerequisite for the contract tests:** Docker is running. Then:

```bash
npx supabase start
```

The secret key is shown by `npx supabase status` (as "Secret key", or "service_role key" on older CLIs).

- [ ] **Step 1: Write the failing contract tests**

In `test/shared/repository.contract.test.ts`, add this block **inside** the existing `describe.skipIf(...)` callback, after the last `it(...)`. It reuses the outer `admin`, `repo` and `beforeEach` cleanup.

```ts
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
```

- [ ] **Step 2: Add the repository method (type-level only) so the tests compile, and confirm they fail**

In `src/shared/repository.ts`, add the `AnomalyStatsRow` interface (from **Interfaces** above) after `WindowReport`. Add this to `interface Repository`:

```ts
  getAnomalyStats(geohash: string | null, asOf?: Date): Promise<AnomalyStatsRow[]>;
```

Then add a stub to the object returned by `createSupabaseRepository`, after `markAggregated`:

```ts
    async getAnomalyStats() {
      throw new Error('not implemented');
    },
```

In `test/fakes.ts`:
- add `AnomalyStatsRow` to the type import from `'../src/shared/repository'`;
- add these members to `FakeRepository` after `markAggregated`:

```ts
  anomalyStats: AnomalyStatsRow[] = [];
  anomalyRequests: Array<{ geohash: string | null; asOf: Date | undefined }> = [];

  async getAnomalyStats(geohash: string | null, asOf?: Date): Promise<AnomalyStatsRow[]> {
    this.failIfRequested('getAnomalyStats');
    this.anomalyRequests.push({ geohash, asOf });
    return geohash === null ? this.anomalyStats : this.anomalyStats.filter((row) => row.geohash === geohash);
  }
```

Run:

```bash
npm run typecheck
npx supabase db reset
SUPABASE_TEST_URL=http://127.0.0.1:54321 SUPABASE_TEST_SECRET_KEY=<secret key> npx vitest run test/shared/repository.contract.test.ts
```

Expected: typecheck passes. The 7 new `anomaly_stats` tests FAIL with `not implemented`, and the existing contract tests PASS.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260924000000_anomaly_stats.sql`:

```sql
-- Per (region, disease category) statistics for anomaly scoring; src/shared/anomaly.ts turns
-- these rows into scores and statuses.
-- Week k covers (p_as_of - 7(k+1) days, p_as_of - 7k days]: week 0 is the current window,
-- week 1 is a guard band (ignored), weeks 2..13 are the 12-week baseline. A baseline week
-- counts only if it lies entirely after the region's first report; within those weeks a
-- category with no reports counts as 0. Intervals are in seconds so they match the
-- epoch-based week bucketing regardless of session time zone.
create function public.anomaly_stats(
  p_geohash text default null,
  p_as_of   timestamptz default now()
)
returns table (
  geohash          text,
  disease_category text,
  current_cases    integer,
  baseline_median  double precision,
  baseline_mad     double precision,
  baseline_weeks   integer,
  as_of            timestamptz
)
language sql
stable
set search_path = ''
as $$
  with first_seen as (
    select c.geohash, min(c.event_timestamp) as first_ts
    from public.case_reports c
    where p_geohash is null or c.geohash = p_geohash
    group by c.geohash
  ),
  weekly as (
    select
      c.geohash,
      c.disease_category,
      floor(extract(epoch from (p_as_of - c.event_timestamp)) / 604800)::integer as week_ago,
      sum(c.case_count)::integer as cases
    from public.case_reports c
    where (p_geohash is null or c.geohash = p_geohash)
      and c.event_timestamp > p_as_of - make_interval(secs => 604800 * 14)
      and c.event_timestamp <= p_as_of
    group by 1, 2, 3
  ),
  scored as (
    select distinct w.geohash, w.disease_category
    from weekly w
  ),
  baseline as (
    select s.geohash, s.disease_category, coalesce(w.cases, 0) as cases
    from scored s
    join first_seen f on f.geohash = s.geohash
    cross join generate_series(2, 13) as k(week_ago)
    left join weekly w
      on w.geohash = s.geohash
     and w.disease_category = s.disease_category
     and w.week_ago = k.week_ago
    where p_as_of - make_interval(secs => 604800 * (k.week_ago + 1)) >= f.first_ts
  ),
  medians as (
    select
      b.geohash,
      b.disease_category,
      percentile_cont(0.5) within group (order by b.cases) as median,
      count(*)::integer as weeks
    from baseline b
    group by b.geohash, b.disease_category
  ),
  mads as (
    select
      b.geohash,
      b.disease_category,
      percentile_cont(0.5) within group (order by abs(b.cases - m.median)) as mad
    from baseline b
    join medians m on m.geohash = b.geohash and m.disease_category = b.disease_category
    group by b.geohash, b.disease_category
  )
  select
    s.geohash,
    s.disease_category,
    coalesce(cur.cases, 0),
    m.median,
    d.mad,
    coalesce(m.weeks, 0),
    p_as_of
  from scored s
  left join weekly cur
    on cur.geohash = s.geohash
   and cur.disease_category = s.disease_category
   and cur.week_ago = 0
  left join medians m on m.geohash = s.geohash and m.disease_category = s.disease_category
  left join mads d on d.geohash = s.geohash and d.disease_category = s.disease_category
  order by s.geohash, s.disease_category;
$$;

revoke execute on function public.anomaly_stats(text, timestamptz) from public, anon, authenticated;
```

- [ ] **Step 4: Implement `getAnomalyStats`**

Replace the stub in `createSupabaseRepository` with:

```ts
    async getAnomalyStats(geohash, asOf) {
      const params: { p_geohash: string | null; p_as_of?: string } = { p_geohash: geohash };
      if (asOf) params.p_as_of = asOf.toISOString();
      const rows: AnomalyStatsRow[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await db
          .rpc('anomaly_stats', params)
          .order('geohash')
          .order('disease_category')
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`getAnomalyStats failed: ${error.message}`);
        const page = (data ?? []) as AnomalyStatsRow[];
        rows.push(...page);
        if (page.length < PAGE_SIZE) return rows;
      }
    },
```

- [ ] **Step 5: Apply the migration and run the contract tests**

```bash
npx supabase db reset
SUPABASE_TEST_URL=http://127.0.0.1:54321 SUPABASE_TEST_SECRET_KEY=<secret key> npx vitest run test/shared/repository.contract.test.ts
```

Expected: all contract tests PASS, both old and new.

If you debug a mismatch, run the SQL by hand with `docker exec -it supabase_db_core-edge-api psql -U postgres`. The container name comes from `project_id` in `supabase/config.toml`.

- [ ] **Step 6: Verify execute is revoked from the public roles**

```bash
docker exec supabase_db_core-edge-api psql -U postgres -tAc "select has_function_privilege('anon', 'public.anomaly_stats(text, timestamptz)', 'execute'), has_function_privilege('authenticated', 'public.anomaly_stats(text, timestamptz)', 'execute'), has_function_privilege('service_role', 'public.anomaly_stats(text, timestamptz)', 'execute');"
```

Expected: `f|f|t`.

- [ ] **Step 7: Run the full suite and typecheck**

```bash
npm run typecheck && npm test
```

Expected: PASS. The contract tests skip without the env vars.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260924000000_anomaly_stats.sql src/shared/repository.ts test/fakes.ts test/shared/repository.contract.test.ts
git commit -m "Add anomaly_stats RPC and repository method"
```

---

### Task 2: Scoring module

**Files:**
- Create: `src/shared/anomaly.ts`
- Test: `test/shared/anomaly.test.ts`

**Interfaces:**
- Consumes: `AnomalyStatsRow` from `src/shared/repository.ts` (Task 1).
- Produces:
  ```ts
  // src/shared/anomaly.ts
  export const BASELINE_MIN_WEEKS = 4;
  export const ELEVATED_SCORE = 2;
  export const ANOMALOUS_SCORE = 3;
  export const ANOMALOUS_MIN_CASES = 5;
  export type AnomalyStatus = 'anomalous' | 'elevated' | 'normal' | 'insufficient_data';
  export interface CategoryAnomaly {
    category: string;
    status: AnomalyStatus;
    score: number | null;
    current_cases: number;
    baseline_median: number | null;
    baseline_mad: number | null;
    baseline_weeks: number;
  }
  export interface RegionAnomaly {
    geohash: string;
    status: AnomalyStatus;
    max_score: number | null;
    categories: CategoryAnomaly[];
  }
  export function robustScore(current: number, median: number, mad: number): number;
  export function scoreCategory(row: AnomalyStatsRow): CategoryAnomaly;
  export function regionAnomaly(geohash: string, categories: CategoryAnomaly[]): RegionAnomaly; // sorts categories, rolls up
  export function buildRegionAnomalies(rows: AnomalyStatsRow[]): RegionAnomaly[];              // groups, rolls up, sorts regions
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/shared/anomaly.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildRegionAnomalies,
  regionAnomaly,
  robustScore,
  scoreCategory,
  type CategoryAnomaly,
} from '../../src/shared/anomaly';
import type { AnomalyStatsRow } from '../../src/shared/repository';

function row(overrides: Partial<AnomalyStatsRow> = {}): AnomalyStatsRow {
  return {
    geohash: 'ezs42',
    disease_category: 'respiratory',
    current_cases: 4,
    baseline_median: 4,
    baseline_mad: 0,
    baseline_weeks: 12,
    as_of: '2026-09-23T12:00:00+00:00',
    ...overrides,
  };
}

describe('robustScore', () => {
  it('scales MAD to a standard deviation when it dominates', () => {
    expect(robustScore(10, 4, 2)).toBeCloseTo(6 / 2.9652, 6);
  });

  it('uses sqrt(median) as a floor when MAD is small', () => {
    expect(robustScore(20, 16, 0)).toBe(1);
  });

  it('uses 1 as a floor for sparse categories', () => {
    expect(robustScore(3, 0, 0)).toBe(3);
  });

  it('is negative when the current week is below the baseline', () => {
    expect(robustScore(0, 4, 0)).toBe(-2);
  });
});

describe('scoreCategory', () => {
  it('reports insufficient data with fewer than 4 baseline weeks', () => {
    expect(scoreCategory(row({ baseline_weeks: 3, current_cases: 50 }))).toEqual({
      category: 'respiratory',
      status: 'insufficient_data',
      score: null,
      current_cases: 50,
      baseline_median: 4,
      baseline_mad: 0,
      baseline_weeks: 3,
    });
  });

  it('scores once there are exactly 4 baseline weeks', () => {
    expect(scoreCategory(row({ baseline_weeks: 4 })).status).toBe('normal');
  });

  it.each([
    // median 4, MAD 0 → denominator 2, so score = (current − 4) / 2
    { current: 7, score: 1.5, status: 'normal' },
    { current: 8, score: 2, status: 'elevated' },
    { current: 9, score: 2.5, status: 'elevated' },
    { current: 10, score: 3, status: 'anomalous' },
    { current: 0, score: -2, status: 'normal' },
  ])('current $current → score $score, $status', ({ current, score, status }) => {
    const result = scoreCategory(row({ current_cases: current }));
    expect(result.score).toBe(score);
    expect(result.status).toBe(status);
  });

  it('caps a high score at elevated when the current week has fewer than 5 cases', () => {
    const result = scoreCategory(row({ current_cases: 4, baseline_median: 0 }));
    expect(result).toMatchObject({ score: 4, status: 'elevated' });
  });

  it('marks a high score with exactly 5 cases as anomalous', () => {
    expect(scoreCategory(row({ current_cases: 5, baseline_median: 0 })).status).toBe('anomalous');
  });

  it('rounds the score to 2 decimals', () => {
    expect(scoreCategory(row({ current_cases: 10, baseline_median: 4, baseline_mad: 2 })).score).toBe(2.02);
  });
});

describe('regionAnomaly', () => {
  const category = (name: string, status: CategoryAnomaly['status'], score: number | null): CategoryAnomaly => ({
    category: name,
    status,
    score,
    current_cases: 0,
    baseline_median: 0,
    baseline_mad: 0,
    baseline_weeks: 12,
  });

  it('takes the worst category status and the highest score, sorting categories', () => {
    const region = regionAnomaly('ezs42', [
      category('b-normal', 'normal', 1.5),
      category('insufficient', 'insufficient_data', null),
      category('elevated', 'elevated', 2.4),
      category('a-normal', 'normal', 1.5),
      category('low-normal', 'normal', -1),
    ]);

    expect(region.status).toBe('elevated');
    expect(region.max_score).toBe(2.4);
    expect(region.categories.map((c) => c.category)).toEqual([
      'elevated',
      'a-normal',
      'b-normal',
      'low-normal',
      'insufficient',
    ]);
  });

  it('is insufficient_data with a null max_score when no category can be scored', () => {
    const region = regionAnomaly('ezs42', [category('respiratory', 'insufficient_data', null)]);
    expect(region).toMatchObject({ status: 'insufficient_data', max_score: null });
  });

  it('is insufficient_data with no categories', () => {
    expect(regionAnomaly('ezs42', [])).toEqual({
      geohash: 'ezs42',
      status: 'insufficient_data',
      max_score: null,
      categories: [],
    });
  });
});

describe('buildRegionAnomalies', () => {
  it('groups rows by region and sorts regions by severity, score, then geohash', () => {
    const regions = buildRegionAnomalies([
      row({ geohash: 'aaaaa', current_cases: 4 }), // normal, score 0
      row({ geohash: 'bbbbb', current_cases: 4 }), // normal, score 0
      row({ geohash: 'ccccc', current_cases: 20 }), // anomalous, score 8
      row({ geohash: 'ddddd', current_cases: 8 }), // elevated, score 2
      row({ geohash: 'ddddd', disease_category: 'gastrointestinal', current_cases: 5 }), // normal, score 0.5
      row({ geohash: 'eeeee', baseline_weeks: 0, baseline_median: null, baseline_mad: null }), // insufficient
      row({ geohash: 'fffff', current_cases: 7 }), // normal, score 1.5
    ]);

    expect(regions.map((r) => [r.geohash, r.status, r.max_score])).toEqual([
      ['ccccc', 'anomalous', 8],
      ['ddddd', 'elevated', 2],
      ['fffff', 'normal', 1.5],
      ['aaaaa', 'normal', 0],
      ['bbbbb', 'normal', 0],
      ['eeeee', 'insufficient_data', null],
    ]);
    expect(regions[1]!.categories.map((c) => c.category)).toEqual(['respiratory', 'gastrointestinal']);
  });

  it('returns an empty list for no rows', () => {
    expect(buildRegionAnomalies([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/shared/anomaly.test.ts`
Expected: FAIL. The module `../../src/shared/anomaly` cannot be resolved.

- [ ] **Step 3: Implement the module**

Create `src/shared/anomaly.ts`:

```ts
import type { AnomalyStatsRow } from './repository';

export const BASELINE_MIN_WEEKS = 4;
export const ELEVATED_SCORE = 2;
export const ANOMALOUS_SCORE = 3;
export const ANOMALOUS_MIN_CASES = 5;
// Scales MAD to a standard-deviation estimate for normally distributed counts.
const MAD_TO_SD = 1.4826;

export type AnomalyStatus = 'anomalous' | 'elevated' | 'normal' | 'insufficient_data';

const SEVERITY: Record<AnomalyStatus, number> = {
  anomalous: 3,
  elevated: 2,
  normal: 1,
  insufficient_data: 0,
};

export interface CategoryAnomaly {
  category: string;
  status: AnomalyStatus;
  score: number | null;
  current_cases: number;
  baseline_median: number | null;
  baseline_mad: number | null;
  baseline_weeks: number;
}

export interface RegionAnomaly {
  geohash: string;
  status: AnomalyStatus;
  max_score: number | null;
  categories: CategoryAnomaly[];
}

// Robust z-score. sqrt(median) is a Poisson-like noise floor; 1 keeps sparse categories
// (median 0, MAD 0) from producing huge scores.
export function robustScore(current: number, median: number, mad: number): number {
  return (current - median) / Math.max(MAD_TO_SD * mad, Math.sqrt(median), 1);
}

export function scoreCategory(row: AnomalyStatsRow): CategoryAnomaly {
  const stats = {
    category: row.disease_category,
    current_cases: row.current_cases,
    baseline_median: row.baseline_median,
    baseline_mad: row.baseline_mad,
    baseline_weeks: row.baseline_weeks,
  };
  if (row.baseline_weeks < BASELINE_MIN_WEEKS) {
    return { ...stats, status: 'insufficient_data', score: null };
  }
  const score = robustScore(row.current_cases, row.baseline_median ?? 0, row.baseline_mad ?? 0);
  return { ...stats, status: statusFor(score, row.current_cases), score: Math.round(score * 100) / 100 };
}

function statusFor(score: number, currentCases: number): AnomalyStatus {
  if (score >= ANOMALOUS_SCORE && currentCases >= ANOMALOUS_MIN_CASES) return 'anomalous';
  if (score >= ELEVATED_SCORE) return 'elevated';
  return 'normal';
}

export function regionAnomaly(geohash: string, categories: CategoryAnomaly[]): RegionAnomaly {
  const sorted = [...categories].sort((a, b) =>
    compareRanked(a.status, a.score, a.category, b.status, b.score, b.category),
  );
  const scores = sorted.flatMap((c) => (c.score === null ? [] : [c.score]));
  return {
    geohash,
    status: sorted[0]?.status ?? 'insufficient_data',
    max_score: scores.length > 0 ? Math.max(...scores) : null,
    categories: sorted,
  };
}

export function buildRegionAnomalies(rows: AnomalyStatsRow[]): RegionAnomaly[] {
  const byRegion = new Map<string, CategoryAnomaly[]>();
  for (const row of rows) {
    const categories = byRegion.get(row.geohash) ?? [];
    categories.push(scoreCategory(row));
    byRegion.set(row.geohash, categories);
  }
  return [...byRegion]
    .map(([geohash, categories]) => regionAnomaly(geohash, categories))
    .sort((a, b) => compareRanked(a.status, a.max_score, a.geohash, b.status, b.max_score, b.geohash));
}

// Severity descending, then score descending with nulls last, then name ascending.
function compareRanked(
  statusA: AnomalyStatus,
  scoreA: number | null,
  nameA: string,
  statusB: AnomalyStatus,
  scoreB: number | null,
  nameB: string,
): number {
  return (
    SEVERITY[statusB] - SEVERITY[statusA] ||
    compareScores(scoreA, scoreB) ||
    (nameA < nameB ? -1 : nameA > nameB ? 1 : 0)
  );
}

function compareScores(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/shared/anomaly.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/shared/anomaly.ts test/shared/anomaly.test.ts
git commit -m "Add robust z-score anomaly scoring module"
```

---

### Task 3: Extract `parseRegionQuery` from `/similar`

**Files:**
- Create: `src/api/region-query.ts`
- Modify: `src/api/similar.ts:1-35` (`parseSimilarQuery` and imports)
- Test: `test/api/region-query.test.ts`

**Interfaces:**
- Consumes: `encodeGeohash`, `isValidRegionGeohash` from `src/shared/geohash.ts`.
- Produces:
  ```ts
  // src/api/region-query.ts
  export type RegionQuery = { ok: true; geohash: string } | { ok: false; error: string };
  export function parseRegionQuery(query: Record<string, string>): RegionQuery;
  ```
  The error messages are unchanged from `/similar`:
  - `'geohash must be a 5-character geohash'`
  - `'lat must be within -90..90 and lon within -180..180'`
  - `'provide geohash, or lat and lon'`

- [ ] **Step 1: Write the failing test**

Create `test/api/region-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRegionQuery } from '../../src/api/region-query';

describe('parseRegionQuery', () => {
  it('accepts and lowercases a geohash', () => {
    expect(parseRegionQuery({ geohash: 'EZS42' })).toEqual({ ok: true, geohash: 'ezs42' });
  });

  it('encodes lat/lon to the region geohash', () => {
    expect(parseRegionQuery({ lat: '42.605', lon: '-5.603' })).toEqual({ ok: true, geohash: 'ezs42' });
  });

  it('prefers geohash when both forms are given', () => {
    expect(parseRegionQuery({ geohash: 'u4pru', lat: '42.605', lon: '-5.603' })).toEqual({
      ok: true,
      geohash: 'u4pru',
    });
  });

  it.each([{ geohash: 'abc' }, { geohash: 'ezsa2' }])('rejects geohash %j', (query) => {
    expect(parseRegionQuery(query)).toEqual({ ok: false, error: 'geohash must be a 5-character geohash' });
  });

  it.each([
    { lat: '91', lon: '0' },
    { lat: '0', lon: '-181' },
    { lat: '', lon: '0' },
    { lat: 'x', lon: '0' },
  ])('rejects lat/lon %j', (query) => {
    expect(parseRegionQuery(query)).toEqual({
      ok: false,
      error: 'lat must be within -90..90 and lon within -180..180',
    });
  });

  it.each([{}, { lat: '10' }, { lon: '10' }])('requires a region for %j', (query) => {
    expect(parseRegionQuery(query)).toEqual({ ok: false, error: 'provide geohash, or lat and lon' });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/api/region-query.test.ts`
Expected: FAIL. The module `../../src/api/region-query` cannot be resolved.

- [ ] **Step 3: Create `region-query.ts` and make `similar.ts` use it**

Create `src/api/region-query.ts`:

```ts
import { encodeGeohash, isValidRegionGeohash } from '../shared/geohash';

export type RegionQuery = { ok: true; geohash: string } | { ok: false; error: string };

export function parseRegionQuery(query: Record<string, string>): RegionQuery {
  if (query.geohash !== undefined) {
    const geohash = query.geohash.toLowerCase();
    if (!isValidRegionGeohash(geohash)) {
      return { ok: false, error: 'geohash must be a 5-character geohash' };
    }
    return { ok: true, geohash };
  }
  if (query.lat !== undefined && query.lon !== undefined) {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    const blank = query.lat.trim() === '' || query.lon.trim() === '';
    if (blank || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, error: 'lat must be within -90..90 and lon within -180..180' };
    }
    return { ok: true, geohash: encodeGeohash(lat, lon) };
  }
  return { ok: false, error: 'provide geohash, or lat and lon' };
}
```

In `src/api/similar.ts`, change the imports at the top from:

```ts
import type { Context } from 'hono';
import { encodeGeohash, isValidRegionGeohash } from '../shared/geohash';
import { vectorId, type PatternMetadata } from '../shared/vectors';
import type { AppEnv } from './env';
```

to:

```ts
import type { Context } from 'hono';
import { vectorId, type PatternMetadata } from '../shared/vectors';
import type { AppEnv } from './env';
import { parseRegionQuery } from './region-query';
```

Replace the whole body of `parseSimilarQuery` with:

```ts
export function parseSimilarQuery(query: Record<string, string>): SimilarQuery {
  const region = parseRegionQuery(query);
  if (!region.ok) return region;

  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return { ok: true, geohash: region.geohash, limit };
}
```

Leave `SimilarQuery`, `DEFAULT_LIMIT`, `MAX_LIMIT` and `similarHandler` unchanged.

- [ ] **Step 4: Run the new and existing tests**

Run: `npx vitest run test/api/region-query.test.ts test/api/similar.test.ts && npm run typecheck`
Expected: PASS. `test/api/similar.test.ts` is **not** modified.

- [ ] **Step 5: Commit**

```bash
git add src/api/region-query.ts src/api/similar.ts test/api/region-query.test.ts
git commit -m "Extract region query parsing from /similar"
```

---

### Task 4: `GET /anomalies` endpoint and docs

**Files:**
- Create: `src/api/anomalies.ts`
- Modify: `src/api/app.ts` (import and route registration)
- Modify: `README.md`
- Test: `test/api/anomalies.test.ts`

**Interfaces:**
- Consumes:
  - `Repository.getRegion` (existing) and `Repository.getAnomalyStats(geohash, asOf?)` (Task 1);
  - `FakeRepository.anomalyStats`, `.anomalyRequests` and failure key `'getAnomalyStats'` (Task 1);
  - `buildRegionAnomalies` and `regionAnomaly` (Task 2);
  - `parseRegionQuery` (Task 3).
- Produces: `anomaliesHandler(c: Context<AppEnv>)`, registered as `GET /anomalies`. The response shape is `{ as_of: string; regions: RegionAnomaly[] }`.

- [ ] **Step 1: Write the failing tests**

Create `test/api/anomalies.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/api/anomalies.test.ts`
Expected: FAIL. Requests get 404 `{ error: 'not found' }` because the route does not exist yet, except for the 401 test, which already passes.

- [ ] **Step 3: Implement the handler**

Create `src/api/anomalies.ts`:

```ts
import type { Context } from 'hono';
import { buildRegionAnomalies, regionAnomaly } from '../shared/anomaly';
import type { AnomalyStatsRow } from '../shared/repository';
import type { AppEnv } from './env';
import { parseRegionQuery } from './region-query';

export async function anomaliesHandler(c: Context<AppEnv>) {
  const query = c.req.query();
  const { repo } = c.get('deps');

  if (query.geohash === undefined && query.lat === undefined && query.lon === undefined) {
    const rows = await repo.getAnomalyStats(null);
    return c.json({ as_of: asOf(rows), regions: buildRegionAnomalies(rows) });
  }

  const parsed = parseRegionQuery(query);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  if (!(await repo.getRegion(parsed.geohash))) return c.json({ error: 'unknown region' }, 404);

  const rows = await repo.getAnomalyStats(parsed.geohash);
  const [region] = buildRegionAnomalies(rows);
  return c.json({ as_of: asOf(rows), regions: [region ?? regionAnomaly(parsed.geohash, [])] });
}

// The database clock when there are rows; otherwise the Worker clock.
function asOf(rows: AnomalyStatsRow[]): string {
  return new Date(rows[0]?.as_of ?? Date.now()).toISOString();
}
```

In `src/api/app.ts`, add this import directly **before** the `import type { ApiDeps, ApiEnv, AppEnv } from './env';` line. Local imports are alphabetical by path.

```ts
import { anomaliesHandler } from './anomalies';
```

Then register the route after `app.get('/similar', similarHandler);`:

```ts
  app.get('/anomalies', anomaliesHandler);
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/api/anomalies.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Document the endpoint in the README**

In `README.md`, replace the line:

```
- `episent-api` (`wrangler.api.jsonc`): `POST /ingest`, `GET /similar`, bearer-token auth.
```

with:

```
- `episent-api` (`wrangler.api.jsonc`): `POST /ingest`, `GET /similar`, `GET /anomalies`, bearer-token auth.
```

Then append this section at the end of the file:

````markdown
## Anomaly scoring

`GET /anomalies` scores each region's last 7 days of cases, per disease category, against
that region's own recent history:

- **Baseline:** weeks 2–13 before now, skipping the most recent prior week as a guard band.
  Only whole weeks after the region's first report count.
- **Score:** a robust z-score, `(current − median) / max(1.4826·MAD, √median, 1)`.
- **Status:**
  - `insufficient_data`: fewer than 4 baseline weeks;
  - `anomalous`: score ≥ 3 with at least 5 current cases;
  - `elevated`: score ≥ 2;
  - otherwise `normal`.
- **Region status:** its worst category.

```bash
curl -H "Authorization: Bearer $API_TOKEN" "$API_URL/anomalies"                 # all regions
curl -H "Authorization: Bearer $API_TOKEN" "$API_URL/anomalies?geohash=ezs42"   # one region (or lat=&lon=)
```

No seasonal adjustment: the baseline covers the last ~3 months only.
````

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm test
npx wrangler deploy --dry-run -c wrangler.api.jsonc --outdir dist/api
```

Expected: typecheck passes, every test passes (contract tests skip without env vars), and the API bundle builds.

If local Supabase is running, also run the contract suite:

```bash
SUPABASE_TEST_URL=http://127.0.0.1:54321 SUPABASE_TEST_SECRET_KEY=<secret key> npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/anomalies.ts src/api/app.ts test/api/anomalies.test.ts README.md
git commit -m "Add GET /anomalies endpoint"
```
