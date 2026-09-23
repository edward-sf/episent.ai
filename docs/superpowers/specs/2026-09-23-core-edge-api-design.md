# episent.ai — Phase 1: Core Edge API Design

**Date:** 2026-09-23
**Status:** Approved for implementation planning

## Purpose

episent.ai is an edge-deployed epidemiological anomaly detector. It ingests
regional case data, generates embeddings of aggregated regional outbreak
patterns, and lets a researcher find historically similar patterns via
vector similarity search.

This phase delivers the **core edge API**: streaming ingest, regional
pattern aggregation, embedding generation, and similarity query. It does
**not** include statistical anomaly scoring or a web dashboard — those are
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
- Configurable geohash precision or window length (fixed defaults for now)
- Dead-letter tracking for failed aggregations

## Architecture

Two Cloudflare Worker deployments sharing the same Supabase Postgres
database and Vectorize index:

1. **API Worker** (TypeScript + [Hono](https://hono.dev)) — handles HTTP
   requests.
2. **Cron Worker** — runs on an hourly
   [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
   aggregates regional patterns and updates Vectorize.

```
                POST /ingest                 GET /similar?geohash=...
                     |                                 |
                     v                                 v
              +--------------+                 +--------------+
              |  API Worker  |                 |  API Worker  |
              +------+-------+                 +------+-------+
                     |                                 |
                     v                                 v
              +--------------+                 +--------------+
              |   Supabase   |<----------------+   Vectorize  |
              |   Postgres   |    metadata     |    Index     |
              +------+-------+     join        +------+-------+
                     ^                                 ^
                     |                                 |
                     |     aggregate 14d window         |
                     |     -> text description          |
                     |     -> Workers AI embed           |
                     |     -> upsert vector              |
                     +---------------+-------------------+
                                     |
                              +--------------+
                              |  Cron Worker |
                              | (hourly)     |
                              +--------------+
```

### Why two Worker deployments

The API Worker is request-driven and latency-sensitive; the Cron Worker
runs a batch aggregation job on a schedule. Separating them keeps the
ingest/query path simple and lets the aggregation job be reasoned about,
deployed, and scaled independently.

## Data model (Supabase Postgres)

```sql
create table case_reports (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  event_timestamp timestamptz not null,
  lat             double precision not null,
  lon             double precision not null,
  geohash         text not null,         -- precision 5, derived from lat/lon
  disease_category text not null,
  case_count      integer not null check (case_count > 0),
  age_band        text,
  symptom_codes   text[],
  raw_payload     jsonb not null         -- original request body, for audit/reprocessing
);

create index on case_reports (geohash, event_timestamp);

create table regions_index (
  geohash            text primary key,
  last_aggregated_at timestamptz         -- null until first aggregation run
);
```

`geohash` is computed server-side from `lat`/`lon` at precision 5
(~4.9km × 4.9km cells) on ingest.

## API Worker

### `POST /ingest`

- Auth: `Authorization: Bearer <shared token>`, checked against a Worker
  secret. 401 if missing/invalid.
- Body: JSON case record — `event_timestamp`, `lat`, `lon`,
  `disease_category`, `case_count`, optional `age_band`, optional
  `symptom_codes`.
- Validates required fields and types; 400 with field-level error details
  on failure.
- Computes `geohash` from `lat`/`lon`.
- Inserts a row into `case_reports` (including `raw_payload` = the
  original body).
- Upserts `regions_index` row for the geohash if absent (`last_aggregated_at
  = null`), so the cron job knows to pick it up.
- Returns 201 with the inserted record's `id`.

### `GET /similar`

- Auth: same bearer token.
- Query params: `geohash` (required — the region to find matches for) or
  `lat`/`lon` (converted to geohash server-side), `limit` (default 10).
- Looks up the most recent Vectorize vector for the given geohash (its
  current aggregated pattern) as the query vector. 404 if no aggregated
  vector exists yet for that region.
- Queries Vectorize for nearest neighbors (excluding the query region
  itself), returns geohash, similarity score, and window end date per
  match.
- Joins back to `case_reports`/aggregation metadata to include a summary
  (top disease categories, total cases) for each matched region.

## Cron Worker

Runs hourly via Cron Trigger:

1. Query `regions_index` for geohashes where `last_aggregated_at is null
   or` there exist `case_reports` with `received_at > last_aggregated_at`.
2. For each dirty geohash:
   a. Pull all `case_reports` rows in the 14-day window ending now.
   b. Aggregate: total case count, count per `disease_category`, age-band
      distribution, simple trend (this-week vs. prior-week case count).
   c. Render a text description, e.g.:
      > "Region 9q8yyk, 14-day window ending 2026-09-23: 42 respiratory
      > cases, 12 gastrointestinal cases, median age band 25-34, case
      > count trending +18% vs. prior window."
   d. Call Workers AI (`@cf/baai/bge-base-en-v1.5`) to embed the
      description.
   e. Upsert the resulting vector into Vectorize, id = `<geohash>`,
      metadata = `{ geohash, window_end, total_cases, top_category }`.
   f. On success, update `regions_index.last_aggregated_at = now()`.
   g. On failure (Workers AI error, etc.), log and leave
      `last_aggregated_at` unchanged so the region is retried next run.

## Error handling

- Ingest validation errors: 400, field-level messages, nothing written.
- Ingest auth errors: 401.
- Similarity query for a region with no aggregated vector yet: 404.
- Cron aggregation failures (embedding call, Vectorize upsert): logged via
  `console.error` (visible in Workers Observability), region stays dirty
  and is retried automatically on the next hourly run. No dead-letter
  table in phase 1 — bounded staleness (at most ~1-2 hours before an
  Workers AI outage resolves) is an acceptable trade-off for a research
  tool.

## Testing

- **Unit tests (Vitest):** geohash computation from lat/lon, case record
  validation, window aggregation logic, text description rendering.
- **Integration tests:** local Wrangler dev (Miniflare) exercising
  `/ingest` and `/similar` end-to-end against a test Supabase project (or
  a mocked Supabase client if a test project isn't available), and the
  cron `scheduled()` handler invoked directly against seeded test data.
- No live Cloudflare deploy required to validate phase 1.

## Open questions for later phases

- Phase 2 (statistical anomaly scoring): what's the baseline — historical
  average for that geohash/season, or a broader regional/global baseline
  for sparse regions?
- Phase 3 (dashboard): map view vs. table view as the primary layout;
  real-time vs. periodic refresh.
