# episent.ai — Phase 4: Demo Deploy, Video & Teardown Design

**Date:** 2026-09-23
**Status:** Approved design. Depends on Phases 2 and 3, which are not yet designed (see "Contracts").

## Purpose

episent.ai is a portfolio project. Phase 4 deploys it briefly, on free tiers only, and loads a scripted synthetic dataset. The user records a demo video from a prepared script, and then everything is torn down.

**The deliverable is the demo video.** The repo gains the tooling and documents that make the video reproducible.

Phase order: 1 core edge API (done) → 2 anomaly scoring → 3 web dashboard → **4 demo & teardown**.

## Deliverables

1. **Demo video.** About 2 minutes, for recruiters and product-first, recorded and narrated by the user. It is hosted outside the repo (YouTube unlisted or Loom) and linked from the README with a thumbnail. The video file is never committed.
2. **Video script and runbook** in `docs/demo/`:
   - `video-script.md`: timed shot list and voiceover text.
   - `runbook.md`: pre-flight checklist, exact command and click order, recording tips.
   - `architecture.svg`: diagram used in the video.
3. **Demo tooling:**
   - a deterministic synthetic story generator;
   - a backfill capability for historical pattern vectors;
   - lifecycle scripts `demo:up`, `demo:seed`, `demo:verify`, `demo:reset`, `demo:down`.
4. **Verified teardown.** Every Worker, the Pages project (if any), the Vectorize index and the Supabase project are deleted, and the deletion is confirmed by listing what remains.

## Out of scope

Automated screen capture, AI voiceover, video-editing tooling, real public health data, and keeping anything deployed after recording.

## Contracts on Phases 2 and 3

Phases 2 and 3 must satisfy these requirements. If they can't, this spec is revised.

- **Phase 2 (anomaly scoring):**
  - Exposes a per-region anomaly score for the current window through the API.
  - Its baseline is computable from about 6 months of history on a small dataset (about 10 regions, 5–10k reports).
- **Phase 3 (dashboard):**
  - Deployed on a free Cloudflare option (Pages, or static assets on a Worker).
  - Shows regions on a map or list with anomaly status, plus a "similar past outbreaks" panel backed by `/similar`.
  - Keeps the API token server-side, never in browser code.
- **Both:** run within free tiers, and are removed by `demo:down`.

## Cost constraint

Everything runs on free tiers: Workers Free, the Workers AI free daily allocation, the Vectorize free tier, and a Supabase free project. At the time of writing these include:

- **Workers Free:** 100k requests/day, 50 outbound requests and about 10 ms CPU per invocation.
- **Workers AI:** about 10k free neurons/day.
- **Vectorize:** about 5M stored dimensions and 30M queried dimensions/month.

**Re-check current pricing before `demo:up`.** Expected demo usage:

| Resource | Expected usage |
|---|---|
| Embeddings | ~1,800 bge-base embeddings |
| Stored vectors | ~1,800 vectors × 768 dims ≈ 1.4M stored dimensions |
| Ingest requests | ~5–10k |

If a free-plan limit blocks the demo, the fallback is one month of Workers Paid (about $5), cancelled at teardown. It is not planned.

## Demo story (synthetic)

The data is built so that one "aha" moment reliably lands on camera. Cities use real coordinates for a believable map; no real case data is used. The video and README label the data as **synthetic**.

- **Background:** about 8 cities with steady, low, mixed-category case counts over the last 6 months.
- **Past outbreak (the hook):** one city with a respiratory surge about 5 months ago. It rises steeply over about 3 weeks, skews to the `0-4` age band, then subsides.
- **Distractor:** a gastrointestinal outbreak in another city about 3 months ago.
- **Now:** a different city in the early, steeply rising stage of a respiratory surge with a `0-4` skew.
- **Expected result:**
  - Phase 2 flags the "now" city as anomalous.
  - `/similar` for the "now" city ranks a past-outbreak-city vector from about 10 days before its peak **above** every distractor-city vector.

## Components

### Story generator — `scripts/demo/generate.ts`

- Deterministic: a seeded pseudo-random generator, so the same seed produces identical output.
- Emits newline-delimited JSON case reports in the `/ingest` body format. The story parameters (cities, dates, magnitudes, category mix, age skew) sit at the top of the file.
- All `event_timestamp` values are in the past relative to the generation time. The 6-month span ends at "today" when seeding.

### Seeding — `demo:seed`

1. Generate the story.
2. POST every report to the deployed `/ingest` with modest concurrency (about 10 in flight). Stop at the first non-201 response.
3. Call `POST /admin/run` once. This aggregates all regions now, which sets each region's `latest_window_end` for `/similar`.
4. For each region, call `POST /admin/backfill` in 30-day chunks covering the 6-month span. The span ends **yesterday** (UTC); today's vector comes only from step 3's live run.

### Backfill — `runBackfill` in `src/cron/`

`runBackfill(deps, { geohash, fromDate, toDate })`:

- Reads the region's reports for `(fromDate − 14d, toDate]` **once**, paging through them.
- For each UTC date `d` in `[fromDate, toDate]`:
  - takes the window `(d_end − 14d, d_end]` where `d_end = <d>T23:59:59.999Z`;
  - skips `d` if the window has no reports;
  - otherwise runs `aggregateWindow` then `describePattern`.
- Embeds descriptions in batches of at most 100 per Workers AI call. Upserts `<geohash>:<d>` vectors with the standard metadata `{ geohash, window_end, total_cases, top_category }`.
- **Never** writes `regions_index`, so the hourly run's watermarks stay correct.
- Uses about 5 outbound requests per call (page reads, 1 AI batch, 1 upsert).
- **Risk:** the 10 ms CPU limit on the free plan. Mitigation: the chunk size is a single constant (`BACKFILL_MAX_DATES = 30`) that can be lowered.

### Admin routes on the aggregator Worker

The aggregator gains an HTTP handler for these routes:

- `POST /admin/run` runs `runAggregation` immediately.
- `POST /admin/backfill` takes the JSON body `{ geohash, fromDate, toDate }`:
  - dates are `YYYY-MM-DD`, with `fromDate ≤ toDate`;
  - the range is at most `BACKFILL_MAX_DATES` dates;
  - the geohash must be a valid 5-character region.

Protections:

- **Disabled by default.** If the `ADMIN_TOKEN` secret is unset, every route returns 404 `{ "error": "not found" }`.
- **Authentication.** A bearer `ADMIN_TOKEN` is required. A missing or wrong token returns 401 `{ "error": "unauthorized" }`.
- **Bad input.** Invalid bodies return 400 with `details`.
- Errors return 500 `{ "error": "internal error" }`, logged. All bodies are JSON, matching the API Worker.
- `ADMIN_TOKEN` is set only by `demo:up`. The whole Worker is deleted by `demo:down`.

### Lifecycle scripts — `scripts/demo/*.sh` via npm scripts

The user runs these; they prompt for secrets and act on the user's accounts. All use `set -euo pipefail`.

- **`demo:up`:**
  1. Check prerequisites: `wrangler` logged in; a Supabase free project already created and `supabase link`ed. Creating the Supabase project is the one manual step.
  2. Create the Vectorize index (768 dims, cosine) and the `geohash` metadata index. Skip either if it already exists; the metadata index must exist before any vectors do.
  3. `supabase db push`.
  4. `wrangler secret put` for each secret, entered at a prompt so values never reach files or shell history: `API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ADMIN_TOKEN`, plus any the dashboard needs.
  5. Deploy the API, aggregator and dashboard.
- **`demo:seed`:** as described above.
- **`demo:verify`:** the pre-recording story check. It exits non-zero unless both hold:
  - the "now" city's top `/similar` match belongs to the past-outbreak city, not the distractor;
  - the "now" city's Phase 2 anomaly score is elevated.

  If it fails, tune the story parameters, `demo:reset`, and re-seed.
- **`demo:reset`:** `supabase db reset --linked`, then delete and recreate the Vectorize index and its metadata index. It prints the linked project ref and requires the user to type it to confirm.
- **`demo:down`:**
  1. `wrangler delete` for both Workers and the dashboard.
  2. Delete the Vectorize index.
  3. `supabase projects delete <ref>`, with the same type-the-ref confirmation.
  4. Print what remains (`wrangler vectorize list`, `supabase projects list`, plus the Cloudflare dashboard check for Workers and Pages) so the user can confirm nothing is left.

### Video materials — `docs/demo/`

- **`video-script.md`** (about 2:00):

  | Time | Shot |
  |---|---|
  | 0:00 | Problem: spotting unusual outbreaks early |
  | 0:15 | Dashboard flags the "now" city |
  | 0:45 | "Similar past outbreaks" surfaces the earlier city at the same stage |
  | 1:15 | Architecture slide: edge Workers, Workers AI embeddings, Vectorize, Supabase |
  | 1:40 | Close: runs at the edge for $0, repo link |

  Voiceover text sits under each shot.
- **`runbook.md`:**
  - Pre-flight: `demo:verify` passes, browser zoom and window size, notifications off, bookmarks bar hidden.
  - The exact order of clicks and commands.
  - Recording tips: QuickTime or OBS, 1080p, mic check.
  - After recording: upload, add the README link, then `demo:down`.
- **`architecture.svg`:** the diagram for the 1:15 shot.

## Error handling

- **Seeding** stops at the first failure. Because `/ingest` isn't idempotent, recovery is `demo:reset` then `demo:seed`. The fixed seed makes this reproducible.
- **Backfill:** a failed chunk is safe to retry, since vector ids are deterministic and upserts overwrite.
- **Destructive commands** (`demo:reset`, `demo:down`) require typing the Supabase project ref.

## Testing

- **Generator:** deterministic output for a fixed seed. Story invariants hold: the past-outbreak peak date and `0-4` skew, the distractor is gastrointestinal, and every timestamp is in the past.
- **`runBackfill`** (existing in-memory fakes):
  - per-date window bounds;
  - empty dates skipped;
  - embed batches of at most 100;
  - vector ids and metadata correct;
  - no `markAggregated` calls;
  - a failure propagates.
- **Admin routes:** 404 when `ADMIN_TOKEN` is unset, 401 for a missing or wrong token, 400 for a bad body and for more than 30 dates, and a happy path for each route.
- **Lifecycle scripts:** not unit-tested; they are exercised by the acceptance run.

**Acceptance:** `demo:up` → `demo:seed` → `demo:verify` passes → video recorded and linked in the README → `demo:down` → teardown listing shows nothing remaining.

## Build order

- **4a** can be built now; it depends only on Phase 1:
  - generator;
  - `runBackfill` and admin routes;
  - `demo:up`, `demo:seed`, `demo:reset`, `demo:down` for the two existing Workers;
  - a first draft of the runbook.
- **4b** comes after Phase 3:
  - adding the dashboard to up and down;
  - the anomaly check in `demo:verify`;
  - finalizing the video script, the architecture diagram, recording, and the README link.
