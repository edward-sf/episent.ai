# episent.ai — Phase 3: Web Dashboard Design

**Date:** 2026-09-23
**Status:** Approved for implementation planning

## Purpose

Phases 1 and 2 expose outbreak similarity (`GET /similar`) and anomaly scoring
(`GET /anomalies`) behind a bearer-token API. Phase 3 puts a read-only web
dashboard in front of them: a map and ranked list of regions by anomaly status,
and, for the selected region, its per-category scores and the most similar past
outbreak patterns.

The dashboard exists mainly to carry the Phase 4 demo video (about 2 minutes,
product-first, for recruiters). One moment must land on camera: the "now" city
is flagged, and its "similar past outbreaks" panel ranks the past outbreak city
first.

Phase order: 1 core edge API (done) → 2 anomaly scoring (done) → **3 web
dashboard** → 4 demo & teardown.

## Contract from Phase 4

Phase 4 (`2026-09-23-phase-4-demo-video-design.md`) requires that Phase 3:

- is deployed on a free Cloudflare option (Pages, or static assets on a Worker);
- shows regions on a map or list with anomaly status, plus a "similar past
  outbreaks" panel backed by `/similar`;
- keeps the API token server-side, never in browser code;
- runs within free tiers and is removed by `demo:down`.

The Phase 4 spec also requires the data to be labelled **synthetic** in the
video; the dashboard shows a permanent "Synthetic data" badge.

## Decisions

- **Layout:** map and ranked list side by side, with a detail panel for the
  selected region. The map carries the visual hook; the list gives exact
  scores and easy selection.
- **Region names:** a static `geohash → { name, lat, lon }` label file in the
  repo, shared with the Phase 4 story generator. Unlabelled regions show their
  geohash. No schema or API changes.
- **Refresh:** load on open, plus a Refresh button and an "as of" stamp taken
  from the `/anomalies` `as_of` field. No polling.
- **Access:** public and read-only while deployed. Only the two GET routes are
  forwarded; `/ingest` is unreachable through the dashboard.
- **Hosting:** a separate `episent-dashboard` Worker serving Workers Static
  Assets, with a small proxy that calls `episent-api` over a Service Binding.
  The API Worker and its auth are unchanged.
- **Frontend:** Vite + vanilla TypeScript + Leaflet. No UI framework.

Rejected alternatives:

- Serving the UI from `episent-api`: it mixes public and authenticated routes
  and needs carve-outs in the global `bearerAuth`.
- Cloudflare Pages + Pages Functions: equivalent capability, but a second
  tool and config model; Cloudflare now steers new projects to Workers static
  assets.
- Region names in the database: a migration and response-shape changes to
  Phases 1–2 for a demo-only benefit.

## Architecture

```
browser ──GET /, /assets/*──▶ episent-dashboard (static assets; Worker code not run)
browser ──GET /api/anomalies, /api/similar──▶ episent-dashboard Worker (Hono proxy)
                                                  │  Service Binding `API`
                                                  │  + Authorization: Bearer ${API_TOKEN}
                                                  ▼
                                             episent-api ──▶ Supabase / Vectorize
```

- `wrangler.dashboard.jsonc` sets `assets.directory` to `dist/dashboard` and
  `assets.run_worker_first: ["/api/*"]`, so only `/api/*` reaches the Worker.
  Static asset requests are free and don't count toward the Workers Free
  request limit.
- The browser calls same-origin `/api/*`, so no CORS configuration is needed.
- `services: [{ binding: "API", service: "episent-api" }]`.
- Secret: `API_TOKEN` (same value as the API Worker's).

### Files

New:

| Path | Responsibility |
|---|---|
| `src/shared/region-labels.ts` | Demo city list: `geohash → { name, lat, lon }`; also imported by the Phase 4 generator |
| `src/dashboard/worker/index.ts` | Entry point: `createDashboardApp()` |
| `src/dashboard/worker/app.ts` | Hono proxy: `GET /api/anomalies`, `GET /api/similar`, everything else 404 |
| `src/dashboard/web/index.html` | Layout shell: header (title, "Synthetic data" badge, "as of", Refresh), map, list, detail panel |
| `src/dashboard/web/main.ts` | Wiring: load → store → render |
| `src/dashboard/web/api.ts` | Typed fetch client for the two `/api` routes |
| `src/dashboard/web/store.ts` | State and subscriptions |
| `src/dashboard/web/view-model.ts` | Pure functions: API data + labels → list rows, marker specs, detail rows, similar rows |
| `src/dashboard/web/map.ts` | Leaflet rendering |
| `src/dashboard/web/list.ts` | Ranked list rendering |
| `src/dashboard/web/detail.ts` | Categories table and similar-outbreaks panel rendering |
| `src/dashboard/web/styles.css` | Styles |
| `src/dashboard/web/public/_headers` | Content-Security-Policy for the static assets |
| `vite.config.ts` | Root `src/dashboard/web`, output `dist/dashboard` |
| `wrangler.dashboard.jsonc` | Dashboard Worker config |

Changed:

- `src/shared/api-types.ts` (new): the API response types
  (`AnomalyStatus`, `CategoryAnomaly`, `RegionAnomaly`, `AnomaliesResponse`,
  `SimilarMatch`, `SimilarResponse`) as a pure types-only module.
  `src/shared/anomaly.ts` re-exports its three types from there, and
  `src/api/anomalies.ts` and `src/api/similar.ts` type their bodies with it. No
  behaviour change. This keeps the browser type-check free of server modules.
- `src/shared/geohash.ts`: add `decodeGeohash(hash): { lat, lon }` (cell
  centroid).
- `package.json`: scripts `dev:dashboard`, `build:dashboard`,
  `deploy:dashboard`; dependencies `vite`, `leaflet`, `@types/leaflet`.
- `.github/workflows/ci.yml`: build the dashboard and dry-run bundle its Worker.
- `README.md`: dashboard section.

The frontend imports these types from `src/shared/api-types.ts` with type-only
imports, so the API contract is checked at compile time and no server code is
bundled into the browser.

## Proxy Worker

`createDashboardApp()` builds a Hono app whose upstream is the `API` binding
(a `Fetcher`), so tests can inject a fake, following the API's
`createApp(makeDeps)` pattern.

| Route | Forwards to | Query params forwarded |
|---|---|---|
| `GET /api/anomalies` | `/anomalies` | none (always all regions) |
| `GET /api/similar` | `/similar` | `geohash` and `limit` only; others dropped |

- Any other method or path returns `404 {"error":"not found"}` without calling
  upstream. `/ingest` is never reachable.
- Validation stays in the API: the proxy passes upstream status and JSON body
  through unchanged, including 400 and 404 errors.
- Upstream request: only `Authorization: Bearer ${env.API_TOKEN}`. No client
  headers or cookies are forwarded.
- Response headers: `Content-Type: application/json`, `Cache-Control: no-store`.
- Failures:
  - `API_TOKEN` unset: `console.error` and `500 {"error":"internal error"}`.
  - The binding throws: `502 {"error":"upstream unavailable"}`.
  - An upstream 5xx passes through as is.
- The token never appears in the bundle, responses or logs. The dashboard
  holds no Supabase credentials.

Content-Security-Policy (via `_headers`, on all static assets):
`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:
<tile host>; connect-src 'self'`. The tile host is the chosen keyless tile
provider (OpenStreetMap or CARTO); its attribution is always shown on the map.

## UI behaviour

### Load and selection

1. On load, fetch `/api/anomalies`; render map, list and the "as of" stamp.
2. Auto-select the first region (the API sorts worst-first), so the demo opens
   on the "now" city.
3. Selecting a region fetches `/api/similar?geohash=<g>&limit=5`. Results are
   cached per geohash until the next Refresh.

### Map

- One circle marker per region, positioned from the label's lat/lon, or from
  `decodeGeohash` for unlabelled regions.
- Colour by status: anomalous red, elevated amber, normal green,
  insufficient_data grey. A legend shows the mapping.
- The selected region has a thicker outline. Clicking a marker selects it.
- On first load the map fits the bounds of all markers.

### List

Ranked rows in API order: name (or geohash), status badge (text and colour),
max score. Rows are `<button>` elements. Clicking selects the region and pans
the map to it.

### Detail panel

- Header: region name and status.
- Categories table, in API order: category, current cases, baseline median,
  score, status.
- "Similar past outbreaks": up to 5 matches, each showing city name (or
  geohash), window end date, similarity as a percentage, top category and
  total cases.
- The `/similar` 404 shows "No pattern history yet for this region". Other
  errors show an inline message with a Retry button.

### Refresh

Re-fetch `/anomalies` and clear the similar cache. Keep the current selection
if that region is still present; otherwise select the new first region. The
button is disabled while loading.

### Errors

If `/anomalies` fails, show a "Couldn't load data" banner with Retry; the map
and list stay empty.

### State

`store.ts` holds:

```ts
{
  anomalies: RegionAnomaly[];
  asOf: string | null;
  selected: string | null;              // geohash
  similar: Map<string, SimilarState>;   // per geohash: loading | loaded | not_found | error
  loading: boolean;
  error: string | null;
}
```

It notifies subscribers on change. Map, list and detail each re-render from
state; they don't call each other.

### Accessibility and layout

Statuses are always shown as text as well as colour. List rows are keyboard
selectable. The layout stacks vertically at phone width without horizontal
scrolling; no further mobile-specific design.

## Testing

Vitest, in the existing style:

- `test/dashboard/proxy.test.ts` (fake `Fetcher`):
  - both routes forward to the right upstream path with the bearer token;
  - `/api/similar` forwards only `geohash` and `limit`; `/api/anomalies`
    forwards no params;
  - upstream status and body pass through (200, 400, 404, 500) with
    `Cache-Control: no-store`;
  - `/api/ingest`, `POST /api/anomalies` and unknown paths return 404 and never
    call upstream;
  - missing `API_TOKEN` returns 500; a throwing binding returns 502;
  - the token never appears in any response body or header.
- `test/dashboard/view-model.test.ts`: label lookup and geohash fallback; marker
  colour and position; detail rows; similarity percentage formatting; labels
  for matched regions.
- `test/dashboard/store.test.ts`: auto-select the first region; keep the
  selection across refresh or fall back to the new first region; clear the
  similar cache on refresh; loading and error transitions; similar-state
  transitions including `not_found`.
- `test/shared/geohash.test.ts`: `decodeGeohash` centroid re-encodes to the same
  hash.
- `test/shared/region-labels.test.ts`: each entry's geohash equals
  `encodeGeohash(lat, lon)`, and names are unique.

The rendering modules (`map.ts`, `list.ts`, `detail.ts`) are not unit-tested.
They stay thin, with the logic in the view-model and store, and are checked by a
manual smoke run (`npm run dev:dashboard`) and by the Phase 4 recording run. No
DOM-emulation or browser-automation dependency is added.

CI adds `npm run build:dashboard` and
`wrangler deploy --dry-run -c wrangler.dashboard.jsonc`.

## Out of scope

Time-series charts, category filtering, region search, auto-refresh,
dashboard authentication, dark mode, write actions, region names in the
database, and mobile-specific design beyond not breaking at phone width.

## Notes for Phase 4b

- Deploy order: `episent-api` before `episent-dashboard` (the Service Binding
  targets an existing Worker). Delete the dashboard before, or together with,
  the API.
- `demo:up` sets the dashboard's `API_TOKEN` secret to the same value as the
  API's.
- `demo:down` deletes `episent-dashboard`; the teardown listing must show it gone.
