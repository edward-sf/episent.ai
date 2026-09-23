# episent.ai
An edge-deployed epidemiological anomaly detector utilizing Cloudflare Workers AI and Vectorize to identify and match regional outbreak patterns.

**Domains:** `Public Health`, `AI`

## Tech Stack

- **Cloudflare Workers AI**
- **Cloudflare Vectorize**
- **Supabase Database**

## Architecture

Creates an edge API that ingests outbreak data and generates embeddings. It queries similar past outbreaks using Cloudflare Vectorize, while storing raw demographic datasets in Supabase Postgres.

## Development

Requires Node 22.12+, Docker (for local Supabase), and a Cloudflare account for Workers AI / Vectorize.

```bash
npm install
npm test                 # unit + in-process integration tests
npm run typecheck
```

Repository contract tests run against local Supabase:

```bash
npx supabase start && npx supabase db reset
SUPABASE_TEST_URL=http://127.0.0.1:54321 SUPABASE_TEST_SECRET_KEY=<secret key from `npx supabase status`> npm test
```

Workers:

- `episent-api` (`wrangler.api.jsonc`): `POST /ingest`, `GET /similar`, `GET /anomalies`, bearer-token auth.
- `episent-aggregator` (`wrangler.cron.jsonc`): hourly 14-day regional aggregation → Workers AI embedding → Vectorize.

The aggregator processes at most 20 regions per hourly run (never-aggregated regions first).
Pattern history accumulates from live operation only — a region gets at most one vector per
UTC day on which it received reports. The Supabase API's `max_rows` setting must stay ≥ 1000
for window-report pagination to work correctly.

Copy `.dev.vars.example` to `.dev.vars` for `npm run dev:api` / `npm run dev:cron`.

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
