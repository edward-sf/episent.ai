# episent.ai — Phase 2: Statistical Anomaly Scoring Design

**Date:** 2026-09-23
**Status:** Approved for implementation planning

## Purpose

Phase 1 lets a researcher find historically *similar* outbreak patterns.
Phase 2 answers a different question: **is anything unusual happening right
now?** It scores each region's current week of cases, per disease category,
against that region's own recent history, and exposes the result through the
API.

Phase order: 1 core edge API (done) → **2 anomaly scoring** → 3 web dashboard
→ 4 demo & teardown.

## Contract from Phase 4

Phase 4 (`2026-09-23-phase-4-demo-video-design.md`) requires that Phase 2:

- exposes a per-region anomaly score for the current window through the API;
- computes its baseline from about 6 months of history on a small dataset
  (about 10 regions, 5–10k reports);
- runs within free tiers (Workers Free: 50 subrequests and ~10 ms CPU per
  invocation; Supabase free project).

`demo:verify` will check that the "now" city's score is elevated.

## Decisions

- **Unit of scoring:** one score per (region, disease category). A region's
  status is its worst category. Rationale: a respiratory surge must not be
  hidden by a stable mix of other categories, and the demo can say *which*
  category is anomalous.
- **Method:** robust z-score (median / MAD) of the current 7-day count against
  a 12-week baseline, with a one-week guard band. Robust statistics keep a
  past outbreak inside the baseline from masking a new one.
- **Where:** statistics are computed on demand in Postgres by one RPC; scoring
  and status rules are a pure TypeScript module. No cron, Vectorize or
  Workers AI changes.
- **No seasonality.** Six months of history cannot support a seasonal
  baseline (needs ≥ 1 year). This resolves the Phase 1 open question: the
  baseline is per region and category, over recent weeks only.

## Architecture

```
GET /anomalies ──► API Worker ──► Supabase: regions_index (single-region only, for 404)
                              └─► Supabase: anomaly_stats() RPC   (counts, median, MAD)
                              └─► anomaly.ts (pure)               (score, status, rollup, sort)
```

The request makes at most 2 Supabase subrequests plus one per extra 1000-row
page (none expected at demo scale). Worker CPU work is a small loop over at
most a few dozen rows.

## Time buckets

Let `t = p_as_of` (defaults to the database's `now()`).

- Only reports with `event_timestamp` in `(t − 98 days, t]` are counted.
- Each report gets `week_ago = floor((t − event_timestamp) / 7 days)`, so
  week `k` covers `(t − 7(k+1) days, t − 7k days]`.
  - **Week 0** — the current window `(t − 7d, t]`.
  - **Week 1** — the guard band. Ignored, so the early rise of an outbreak does
    not inflate its own baseline.
  - **Weeks 2–13** — the baseline (12 weeks).
- **Qualifying baseline weeks.** Baseline week `k` qualifies only if it lies
  entirely after the region's first report, i.e.
  `t − 7(k+1) days ≥ first_event_timestamp`, where `first_event_timestamp`
  is the region's earliest `event_timestamp` across **all** categories and
  all time. Weeks before the region had data are not treated as zeros.
- **Zeros.** In a qualifying week with no reports for a category, that
  category's count is 0.
- **Scored categories.** Every category with at least one report in the
  region in `(t − 98 days, t]`.

## SQL function

Migration: `supabase/migrations/20260924000000_anomaly_stats.sql`.

```
anomaly_stats(p_geohash text default null, p_as_of timestamptz default now())
returns table (
  geohash          text,
  disease_category text,
  current_cases    integer,           -- week 0 total
  baseline_median  double precision,  -- median of qualifying baseline weeks; null if none
  baseline_mad     double precision,  -- median(|count − median|); null if none
  baseline_weeks   integer,           -- 0..12 qualifying weeks
  as_of            timestamptz        -- p_as_of, echoed on every row
)
```

- `p_geohash` null → all regions; otherwise one region.
- Declared `stable`, `set search_path = ''`, execute revoked from `public`,
  `anon`, `authenticated` (same pattern as `dirty_regions`).
- Median and MAD use `percentile_cont(0.5)`.
- Rows ordered by `geohash, disease_category` so paging is deterministic.
- Uses the existing `case_reports_geohash_event_idx`. No new tables or indexes.

## Scoring module — `src/shared/anomaly.ts`

Pure functions, no I/O.

- **Score:** `(current − median) / max(1.4826 · MAD, √median, 1)`.
  The `√median` term is a Poisson-like noise floor; the `1` floor stops sparse
  categories (median 0, MAD 0) producing huge scores. Rounded to 2 decimals in
  the response.
- **Category status**, first match wins:
  1. `baseline_weeks < 4` → `insufficient_data`, score `null`.
  2. `score ≥ 3` and `current_cases ≥ 5` → `anomalous`.
  3. `score ≥ 2` → `elevated` (includes `score ≥ 3` with fewer than 5 cases).
  4. otherwise `normal`.
- **Constants** (exported, single place to tune): `BASELINE_MIN_WEEKS = 4`,
  `ELEVATED_SCORE = 2`, `ANOMALOUS_SCORE = 3`, `ANOMALOUS_MIN_CASES = 5`.
- **Region rollup:**
  - `status` = worst category, by severity
    `anomalous > elevated > normal > insufficient_data`;
  - a region with no scored categories is `insufficient_data`;
  - `max_score` = highest non-null category score, or `null`.
- **Ordering:** regions by status severity, then `max_score` descending (nulls
  last), then `geohash` ascending. Categories within a region: same rule by
  status, `score`, then `category`.

## API

### `GET /anomalies`

Behind the existing bearer auth. JSON errors match `/similar`.

**Query:**

- no parameters → every region that has at least one scored category;
- `geohash` (5-char), **or** `lat` + `lon` → that one region.

Region parsing is extracted from `parseSimilarQuery` into a shared
`parseRegionQuery` in `src/api/region-query.ts`; `/similar` keeps its `limit`
handling on top. Behaviour of `/similar` is unchanged.

**Response 200:**

```json
{
  "as_of": "2026-09-23T14:05:00.000Z",
  "regions": [
    {
      "geohash": "9q8yy",
      "status": "anomalous",
      "max_score": 6.1,
      "categories": [
        { "category": "respiratory", "status": "anomalous", "score": 6.1,
          "current_cases": 41, "baseline_median": 5, "baseline_mad": 2, "baseline_weeks": 12 },
        { "category": "gastrointestinal", "status": "normal", "score": 0.3,
          "current_cases": 4, "baseline_median": 3.5, "baseline_mad": 1.5, "baseline_weeks": 12 }
      ]
    }
  ]
}
```

- `as_of` comes from the RPC rows (database clock). If the RPC returns no
  rows, the Worker's current time is used.
- The single-region form uses the same shape with a one-element `regions`
  array, so clients need one parser.
- A known region with no reports in the 98-day span returns
  `{ geohash, status: "insufficient_data", max_score: null, categories: [] }`.
- `baseline_median` and `baseline_mad` are `null` when `baseline_weeks` is 0.

**Errors:**

| Situation | Response |
|---|---|
| Bad/missing token | 401 `{ "error": "unauthorized" }` |
| Invalid geohash, lat/lon out of range, or only one of lat/lon | 400 `{ "error": "<message>" }` |
| Region not in `regions_index` | 404 `{ "error": "unknown region" }` |
| Supabase error | 500 `{ "error": "internal error" }`, logged |

## Repository

`Repository` gains:

```ts
getAnomalyStats(geohash: string | null, asOf?: Date): Promise<AnomalyStatsRow[]>
```

It calls the RPC, paging with `.range()` in chunks of `PAGE_SIZE` (1000),
following `getWindowReports`. The API never passes `asOf` (the database
default `now()` applies); contract tests pass a fixed `asOf`.

## Testing

- **Unit (Vitest), `anomaly.ts`:** score floors (MAD 0, median 0, median
  where `√median` dominates); every status boundary (score exactly 2 and 3;
  current 4 vs 5; baseline_weeks 3 vs 4); rollup severity; region and
  category ordering; null handling.
- **Unit, `region-query.ts`:** geohash, lat/lon, missing and invalid input.
  Existing `/similar` tests keep passing unchanged.
- **In-process API tests:** Hono app with the fake repository, covering list,
  single region (geohash and lat/lon), known region with no rows, 404, 400,
  401, and 500 when the repository throws.
- **Contract tests (local Supabase, fixed `p_as_of`):** week bucketing at exact
  7-day boundaries; guard week excluded; zero-filled weeks; partial first week
  excluded from `baseline_weeks`; median/MAD equal hand-computed values;
  categories with no reports in 98 days omitted; `p_geohash` filter; paging
  past 1000 rows.
- **Manual check:** after `supabase db reset`, `has_function_privilege('anon',
  …)` is false for `anomaly_stats` (contract tests only hold the secret key).

## Out of scope

- Seasonal baselines.
- Alerting or notifications.
- Configurable thresholds at runtime (constants only).
- An `as_of` query parameter on the public API.
- Storing score history.
- Aggregator, Vectorize or Workers AI changes.

## Docs

The README gains a `GET /anomalies` section with an example request and the
status rules.
