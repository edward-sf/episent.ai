# episent.ai — Phase 1: Core Edge API Design

**Date:** 2026-09-23
**Status:** Approved for implementation planning (revised during planning, see "Revisions")

## Purpose

episent.ai is an edge-deployed epidemiological anomaly detector. It ingests
regional case data, generates embeddings of aggregated regional outbreak
patterns, and lets a researcher find historically similar patterns via
vector similarity search.

This phase delivers the **core edge API**: streaming ingest, regional
pattern aggregation, embedding generation, and similarity query. It does
**not** include statistical anomaly scoring or a web dashboard. Those are
separate, later phases, each to be specced and built independently.

## Primary user

A researcher/data scientist exploring outbreak data via API calls (scripts,
notebooks), using similarity search as an investigative tool. No
human-in-the-loop alerting or dashboard in this phase.

## Out of scope for phase 1

- Statistical baseline / anomaly scoring (phase 2)
- Web dashboard (phase 3)
- Multi-tenant auth, per-user API keys, or rate limiting beyond a single
  shared bearer token
- Configurable geohash precision or window length (fixed constants)
- Dead-letter tracking for failed aggregations

## Architecture

Two Cloudflare Worker deployments sharing one Supabase Postgres database
and one Vectorize index:

1. **API Worker** (`episent-api`, TypeScript + Hono): handles HTTP requests.
2. **Aggregator Worker** (`episent-aggregator`): runs on an hourly Cron
   Trigger, aggregates regional patterns and updates Vectorize.

```
   POST /ingest ──► API Worker ──► Supabase (case_reports; trigger registers region)
   GET /similar ──► API Worker ──► Supabase (regions_index: latest window)
                                └► Vectorize (getByIds → query, exclude own geohash)

   hourly cron ──► Aggregator Worker
                     1. dirty_regions() RPC          (Supabase)
                     2. 14-day window reports        (Supabase)
                     3. aggregate → text description
                     4. embed                        (Workers AI)
                     5. upsert <geohash>:<date>      (Vectorize)
                     6. mark aggregated              (Supabase)
```

The API Worker is request-driven and latency-sensitive; the aggregator runs
a batch job on a schedule. Keeping them separate keeps the request path
simple and lets the batch job be deployed and reasoned about independently.

## Regions and pattern history

- A **region** is a geohash cell at precision 5 (5 characters, about
  4.9 km × 4.9 km), computed server-side from `lat`/`lon` on ingest.
- A **pattern vector** describes one region's 14-day window ending on a
  given UTC date. Vector id: `<geohash>:<YYYY-MM-DD>` (for example
  `9q8yy:2026-09-23`).
- Hourly runs on the same UTC day overwrite that day's vector. A new day
  produces a new vector, so earlier days stay in the index as history.
  This is what makes "find similar past outbreaks" possible.
- A region is only re-aggregated when it receives new reports. If a region
  gets no new reports, it gets no new daily vector, so its history reflects
  the days on which its data changed.

## Data model (Supabase Postgres)

```sql
create table case_reports (
  id               uuid primary key default gen_random_uuid(),
  received_at      timestamptz not null default now(),
  event_timestamp  timestamptz not null,
  lat              double precision not null,
  lon              double precision not null,
  geohash          text not null,         -- precision 5, derived from lat/lon
  disease_category text not null,         -- normalized to lowercase
  case_count       integer not null check (case_count > 0),
  age_band         text,
  symptom_codes    text[],
  raw_payload      jsonb not null         -- original request body, for audit/reprocessing
);

create table regions_index (
  geohash            text primary key,
  last_aggregated_at timestamptz,         -- null until first aggregation
  latest_window_end  date                 -- date of this region's newest vector
);
```

- An `after insert` trigger on `case_reports` inserts the region into
  `regions_index` (on conflict do nothing). A report is never orphaned from
  aggregation, even if something fails partway through.
- `dirty_regions(max_regions)` RPC returns regions that have never been
  aggregated, or that have reports received after `last_aggregated_at`.
  Never-aggregated regions come first, then the oldest. Each row also
  returns the database's `now()` as `checked_at`.
- RLS is enabled on both tables with no policies. Workers connect with the
  Supabase secret (service-role) key. The RPC is revoked from
  `anon`/`authenticated`.

## API Worker

All routes require `Authorization: Bearer <API_TOKEN>` (a Worker secret).
Missing or wrong token → 401. An unset `API_TOKEN` → 500 (fail closed).
Unhandled errors → 500 `{ "error": "internal error" }`.

### `POST /ingest`

- Body (JSON, max 64 KB): `event_timestamp` (ISO 8601 with offset), `lat`
  (−90..90), `lon` (−180..180), `disease_category` (non-empty, ≤100 chars,
  lowercased), `case_count` (positive integer), optional `age_band`,
  optional `symptom_codes` (string array).
- Invalid JSON → 400. Validation failure → 400 with
  `details: [{ field, message }]`. Nothing is written in either case.
- Computes `geohash` and inserts into `case_reports` with
  `raw_payload` = original body.
- Returns 201 `{ id, geohash }`.

### `GET /similar`

- Query: `geohash` (5-char geohash), **or** `lat` + `lon`; optional `limit`
  (integer 1–20, default 10; 20 is Vectorize's `topK` cap when metadata is
  returned).
- Reads `regions_index.latest_window_end` for the region, then fetches
  vector `<geohash>:<latest_window_end>` with `getByIds`. 404 if the region
  is unknown, has never been aggregated, or its vector is not visible yet
  (Vectorize upserts are eventually consistent).
- Queries Vectorize with that vector, filtering out **all** vectors of the
  query region (`geohash $ne`). Overlapping windows from the same region are
  trivially similar. This filter requires a Vectorize metadata index on
  `geohash`.
- Response:
  ```json
  {
    "query": { "geohash": "9q8yy", "window_end": "2026-09-23" },
    "matches": [
      { "id": "dr5ru:2026-08-02", "score": 0.93, "geohash": "dr5ru",
        "window_end": "2026-08-02", "total_cases": 61, "top_category": "respiratory" }
    ]
  }
  ```
  Match details come from Vectorize metadata. No Supabase join is needed.

## Aggregator Worker

Hourly Cron Trigger (`0 * * * *`):

1. `dirty_regions(20)`: at most 20 regions per run to stay within Workers
   subrequest limits. Any remaining regions are picked up on later runs.
2. For each dirty region, independently:
   a. Fetch its reports with `event_timestamp` in `(now − 14d, now]`.
      Page through results in chunks of 1000 because of PostgREST's row cap.
   b. No reports in window → mark aggregated (keep `latest_window_end`),
      no vector.
   c. Aggregate: total cases, cases per category, most common age band
      (weighted by case count), cases in the most recent 7 days vs. the
      prior 7 days.
   d. Render a **pattern-only** description. It leaves out the geohash and
      the date, because those tokens would bias similarity toward region
      identity or recency instead of the outbreak pattern. Example:
      > "14-day case pattern: 48 total cases. By category: respiratory 36,
      > gastrointestinal 12. Most common age band: 25-34. Trend: +18% in the
      > most recent 7 days versus the prior 7 days."
   e. Embed with Workers AI `@cf/baai/bge-base-en-v1.5` (768 dims).
   f. Upsert `<geohash>:<today UTC>` with metadata
      `{ geohash, window_end, total_cases, top_category }`.
   g. Mark aggregated: `last_aggregated_at = checked_at` (the DB time from
      step 1, so reports arriving mid-run still count as new next time),
      `latest_window_end = today`.
3. Any failure in steps a–g for a region is logged with `console.error`.
   That region is not marked, so the next run retries it. Upserts use
   deterministic ids, so a retry is idempotent.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Bad/missing token | 401 |
| Invalid JSON / validation failure | 400, nothing written |
| Body > 64 KB | 413 |
| Region unknown / not aggregated / vector not yet visible | 404 |
| Supabase or Vectorize error in API | 500 `internal error`, logged |
| Aggregation failure for one region | logged, region retried next run, other regions unaffected |

## Testing

Vectorize and Workers AI have no local simulation, so:

- **Unit tests (Vitest):** geohash encoding, request validation, window
  aggregation, description rendering, embedder adapter.
- **In-process integration tests:** the Hono app (`app.request`) and the
  aggregation orchestrator run end-to-end against in-memory fakes of the
  repository and Vectorize.
- **Repository contract tests:** exercise the real SQL (trigger, RPC,
  pagination) against local Supabase (`supabase start`). Skipped when the
  test DB env vars are absent.
- **Manual smoke test:** deploy both Workers against real Supabase +
  Vectorize, ingest sample records, trigger aggregation, query `/similar`.

## Revisions

Revised 2026-09-23 during implementation planning:
- Vector id changed from `<geohash>` (overwrote history) to
  `<geohash>:<date>`. Added `regions_index.latest_window_end`.
- Embedded text no longer includes the geohash/date.
- `last_aggregated_at` is set from the DB time captured before reading, not
  `now()` after processing.
- Region registration moved to a DB trigger. Added the per-run cap (20),
  pagination, RLS, `limit` max 20, and the metadata index requirement.
- `/similar` returns Vectorize metadata instead of joining Supabase.
- "Median age band" became "most common age band" (bands are labels, not
  numbers).
- Testing section reflects that Vectorize/Workers AI can't run locally.

## Open questions for later phases

- Phase 2 (statistical anomaly scoring): baseline per geohash/season, or a
  broader regional baseline for sparse regions?
- Phase 3 (dashboard): map vs. table as primary layout; refresh model.
