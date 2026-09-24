# Web Dashboard (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only web dashboard (map + ranked list + detail panel) served by a new `episent-dashboard` Worker. The Worker proxies `GET /anomalies` and `GET /similar` to `episent-api` over a Service Binding and keeps the API token server-side.

**Architecture:** A new Worker serves Vite-built static assets and runs code only for `/api/*`. There, a small Hono proxy forwards two GET routes to `episent-api` through the `API` Service Binding, adding the bearer token. The browser app is vanilla TypeScript:
- `api.ts`: fetch client;
- `store.ts`: state;
- `view-model.ts`: pure display logic;
- thin DOM/Leaflet renderers.

All logic lives in the unit-tested modules, and the renderers stay thin.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers (Static Assets, Service Bindings), Vite 8, Leaflet 1.9, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-dashboard-design.md`

## Global Constraints

- The API Worker's behaviour and auth are unchanged. Existing tests must pass unmodified.
- Dashboard proxy routes:
  - `GET /api/anomalies` → upstream `/anomalies`, with no query params;
  - `GET /api/similar` → upstream `/similar`, forwarding only `geohash` and `limit`.
  - Everything else under `/api/*` → `404 {"error":"not found"}` without calling upstream.
- Upstream requests carry only `Authorization: Bearer ${API_TOKEN}`. No client headers or cookies are forwarded.
- Every proxy response has `Content-Type: application/json` and `Cache-Control: no-store`.
- Proxy failures:
  - `API_TOKEN` unset → `500 {"error":"internal error"}` plus `console.error`;
  - binding throws → `502 {"error":"upstream unavailable"}`;
  - upstream status and body otherwise pass through unchanged.
- The upstream origin string is `https://episent-api`. The host is ignored by Service Bindings, but must be a valid URL.
- `/similar` is requested with `limit=5` (`SIMILAR_LIMIT`).
- Status colours: anomalous `#d64545`, elevated `#e0a526`, normal `#3f9d5a`, insufficient_data `#9aa0a6`. Status labels: `Anomalous`, `Elevated`, `Normal`, `Insufficient data`. Status is always shown as text as well as colour.
- Map tiles: CARTO `light_all`, keyless, attribution always visible. CSP `img-src` allows `https://*.basemaps.cartocdn.com`.
- Browser code must never reference `API_TOKEN` or import server modules. Browser-side type imports come only from `src/shared/api-types.ts`, `src/shared/region-labels.ts` and `src/shared/geohash.ts`, which are pure modules.
- `src/dashboard/web/{api,store,view-model}.ts` must not use DOM-only globals (`document`, `window`, `HTMLElement`). They are type-checked under both the Workers tsconfig (via tests) and the browser tsconfig.
- Node 22.12+. Run commands from the repo root.

**Deviation from the spec (intentional):** the spec says to export `SimilarResponse` from `src/api/similar.ts`. Instead, all response types live in the new pure module `src/shared/api-types.ts`, and `src/shared/anomaly.ts` re-exports its three types from there. This keeps the browser type-check from pulling in server modules (Hono, Supabase, Vectorize types). Task 1 updates the spec to match.

## File Structure

```
src/shared/api-types.ts           NEW     response types: AnomalyStatus, CategoryAnomaly, RegionAnomaly, AnomaliesResponse, SimilarMatch, SimilarResponse
src/shared/anomaly.ts             MODIFY  import + re-export those types instead of defining them
src/api/anomalies.ts              MODIFY  `satisfies AnomaliesResponse`
src/api/similar.ts                MODIFY  body typed as SimilarResponse
src/shared/geohash.ts             MODIFY  add decodeGeohash
src/shared/region-labels.ts       NEW     demo city labels + findRegionLabel
src/dashboard/worker/app.ts       NEW     createDashboardApp (Hono proxy)
src/dashboard/worker/index.ts     NEW     Worker entry
src/dashboard/web/view-model.ts   NEW     pure display logic
src/dashboard/web/api.ts          NEW     fetch client
src/dashboard/web/store.ts        NEW     state + actions
src/dashboard/web/dom.ts          NEW     tiny DOM helpers
src/dashboard/web/map.ts          NEW     Leaflet renderer
src/dashboard/web/list.ts         NEW     list renderer
src/dashboard/web/detail.ts       NEW     detail renderer
src/dashboard/web/main.ts         NEW     wiring
src/dashboard/web/index.html      NEW     page shell
src/dashboard/web/styles.css      NEW     styles
src/dashboard/web/public/_headers NEW     CSP and security headers
tsconfig.json                     MODIFY  exclude src/dashboard/web; include vite.config.ts
tsconfig.web.json                 NEW     browser type-check (DOM lib)
vite.config.ts                    NEW     build src/dashboard/web → dist/dashboard
wrangler.dashboard.jsonc          NEW     dashboard Worker config
package.json                      MODIFY  deps + scripts
.github/workflows/ci.yml          MODIFY  build dashboard + dry-run bundle
README.md                         MODIFY  dashboard section
test/shared/geohash.test.ts       MODIFY  decodeGeohash tests
test/shared/region-labels.test.ts NEW
test/dashboard/proxy.test.ts      NEW
test/dashboard/view-model.test.ts NEW
test/dashboard/api.test.ts        NEW
test/dashboard/store.test.ts      NEW
```

Task order and dependencies:

| Task | Contents | Depends on |
|---|---|---|
| 1 | shared types | — |
| 2 | geohash decode + labels | — |
| 3 | proxy Worker | — |
| 4 | view-model | 1, 2 |
| 5 | API client + store | 1 |
| 6 | browser type-check + renderers | 4, 5 |
| 7 | page shell, build, CI, docs | 6 |

---

### Task 1: Shared API response types

**Files:**
- Create: `src/shared/api-types.ts`
- Modify: `src/shared/anomaly.ts:10-33` (type definitions), `src/api/anomalies.ts`, `src/api/similar.ts`
- Modify: `docs/superpowers/specs/2026-09-23-dashboard-design.md` (record the type location)
- Test: existing `test/shared/anomaly.test.ts`, `test/api/anomalies.test.ts`, `test/api/similar.test.ts` (unchanged)

**Interfaces:**
- Consumes: nothing new.
- Produces (`src/shared/api-types.ts`):
  ```ts
  export type AnomalyStatus = 'anomalous' | 'elevated' | 'normal' | 'insufficient_data';
  export interface CategoryAnomaly { category: string; status: AnomalyStatus; score: number | null; current_cases: number; baseline_median: number | null; baseline_mad: number | null; baseline_weeks: number; }
  export interface RegionAnomaly { geohash: string; status: AnomalyStatus; max_score: number | null; categories: CategoryAnomaly[]; }
  export interface AnomaliesResponse { as_of: string; regions: RegionAnomaly[]; }
  export interface SimilarMatch { id: string; score: number; geohash?: string; window_end?: string; total_cases?: number; top_category?: string; }
  export interface SimilarResponse { query: { geohash: string; window_end: string }; matches: SimilarMatch[]; }
  ```
  `src/shared/anomaly.ts` keeps exporting `AnomalyStatus`, `CategoryAnomaly` and `RegionAnomaly` (re-exported), so existing imports keep working.

This is a type-only refactor. The safety net is the typechecker plus the existing tests, which must pass unmodified.

- [ ] **Step 1: Create `src/shared/api-types.ts`**

```ts
// Response bodies of the episent-api HTTP API. Types only, with no imports, so
// browser code can import them without pulling in server modules.

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

export interface AnomaliesResponse {
  as_of: string;
  regions: RegionAnomaly[];
}

// Metadata fields are optional: a vector stored without metadata yields only id and score.
export interface SimilarMatch {
  id: string;
  score: number;
  geohash?: string;
  window_end?: string;
  total_cases?: number;
  top_category?: string;
}

export interface SimilarResponse {
  query: { geohash: string; window_end: string };
  matches: SimilarMatch[];
}
```

- [ ] **Step 2: Point `src/shared/anomaly.ts` at the new types**

At the top of `src/shared/anomaly.ts`, replace:

```ts
import type { AnomalyStatsRow } from './repository';
```

with:

```ts
import type { AnomalyStatus, CategoryAnomaly, RegionAnomaly } from './api-types';
import type { AnomalyStatsRow } from './repository';

export type { AnomalyStatus, CategoryAnomaly, RegionAnomaly } from './api-types';
```

Then delete these three definitions from the file, and keep everything else, including `SEVERITY` and the constants:

```ts
export type AnomalyStatus = 'anomalous' | 'elevated' | 'normal' | 'insufficient_data';
```

```ts
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
```

- [ ] **Step 3: Type the `/anomalies` response**

In `src/api/anomalies.ts`, add the import:

```ts
import type { AnomaliesResponse } from '../shared/api-types';
```

and change the two `return c.json(...)` lines to:

```ts
    return c.json({ as_of: asOf(rows), regions: buildRegionAnomalies(rows) } satisfies AnomaliesResponse);
```

```ts
  return c.json({
    as_of: asOf(rows),
    regions: [region ?? regionAnomaly(parsed.geohash, [])],
  } satisfies AnomaliesResponse);
```

- [ ] **Step 4: Type the `/similar` response**

In `src/api/similar.ts`, add the import:

```ts
import type { SimilarResponse } from '../shared/api-types';
```

and replace the final `return c.json({ ... });` of `similarHandler` with:

```ts
  const body: SimilarResponse = {
    query: { geohash, window_end: region.latest_window_end },
    matches: result.matches.map((match) => {
      const metadata = match.metadata as unknown as PatternMetadata | undefined;
      return {
        id: match.id,
        score: match.score,
        geohash: metadata?.geohash,
        window_end: metadata?.window_end,
        total_cases: metadata?.total_cases,
        top_category: metadata?.top_category,
      };
    }),
  };
  return c.json(body);
```

- [ ] **Step 5: Verify typecheck and existing tests**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0, and all tests pass (Supabase contract tests are skipped without env vars). No test files changed.

- [ ] **Step 6: Record the type location in the spec**

In `docs/superpowers/specs/2026-09-23-dashboard-design.md`, replace the bullet:

```markdown
- `src/api/similar.ts`: export a `SimilarResponse` type describing the
  existing response body. No behaviour change.
```

with:

```markdown
- `src/shared/api-types.ts` (new): the API response types
  (`AnomalyStatus`, `CategoryAnomaly`, `RegionAnomaly`, `AnomaliesResponse`,
  `SimilarMatch`, `SimilarResponse`) as a pure types-only module.
  `src/shared/anomaly.ts` re-exports its three types from there, and
  `src/api/anomalies.ts` and `src/api/similar.ts` type their bodies with it. No
  behaviour change. This keeps the browser type-check free of server modules.
```

and replace the paragraph starting "The frontend imports `RegionAnomaly`..." with:

```markdown
The frontend imports these types from `src/shared/api-types.ts` with type-only
imports, so the API contract is checked at compile time and no server code is
bundled into the browser.
```

- [ ] **Step 7: Commit**

```bash
git add src/shared/api-types.ts src/shared/anomaly.ts src/api/anomalies.ts src/api/similar.ts docs/superpowers/specs/2026-09-23-dashboard-design.md
git commit -m "Extract API response types into a pure shared module"
```

---

### Task 2: `decodeGeohash` and demo region labels

**Files:**
- Modify: `src/shared/geohash.ts` (append `decodeGeohash`)
- Create: `src/shared/region-labels.ts`
- Test: `test/shared/geohash.test.ts` (append), `test/shared/region-labels.test.ts` (new)

**Interfaces:**
- Consumes: `encodeGeohash`, `BASE32` (module-private) in `src/shared/geohash.ts`.
- Produces:
  ```ts
  // src/shared/geohash.ts
  export function decodeGeohash(hash: string): { lat: number; lon: number }; // cell centre; throws Error on an invalid character
  // src/shared/region-labels.ts
  export interface RegionLabel { geohash: string; name: string; lat: number; lon: number; }
  export const REGION_LABELS: readonly RegionLabel[];
  export function findRegionLabel(geohash: string): RegionLabel | undefined;
  ```

- [ ] **Step 1: Write the failing `decodeGeohash` tests**

In `test/shared/geohash.test.ts`, change the import line to:

```ts
import { decodeGeohash, encodeGeohash, isValidRegionGeohash, REGION_PRECISION } from '../../src/shared/geohash';
```

and append:

```ts
describe('decodeGeohash', () => {
  it('returns the centre of the reference cell', () => {
    const { lat, lon } = decodeGeohash('ezs42');
    expect(lat).toBeCloseTo(42.605, 1);
    expect(lon).toBeCloseTo(-5.603, 1);
  });

  it.each(['ezs42', 'u4pru', 's0000', '00000', 'zzzzz', 'gcpvj'])('round-trips %s through encodeGeohash', (hash) => {
    const { lat, lon } = decodeGeohash(hash);
    expect(encodeGeohash(lat, lon)).toBe(hash);
  });

  it('rejects invalid characters', () => {
    expect(() => decodeGeohash('ezsa2')).toThrow('invalid geohash character: a');
  });
});
```

- [ ] **Step 2: Write the failing region-labels tests**

Create `test/shared/region-labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encodeGeohash } from '../../src/shared/geohash';
import { findRegionLabel, REGION_LABELS } from '../../src/shared/region-labels';

describe('REGION_LABELS', () => {
  it.each(REGION_LABELS.map((label) => [label.name, label]))('%s has the geohash of its coordinates', (_name, label) => {
    expect(label.geohash).toBe(encodeGeohash(label.lat, label.lon));
  });

  it('has unique geohashes and names', () => {
    expect(new Set(REGION_LABELS.map((l) => l.geohash)).size).toBe(REGION_LABELS.length);
    expect(new Set(REGION_LABELS.map((l) => l.name)).size).toBe(REGION_LABELS.length);
  });
});

describe('findRegionLabel', () => {
  it('finds a label by geohash', () => {
    expect(findRegionLabel('u4xsu')?.name).toBe('Oslo');
  });

  it('returns undefined for an unlabelled geohash', () => {
    expect(findRegionLabel('ezs42')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/shared/geohash.test.ts test/shared/region-labels.test.ts`
Expected: FAIL. `decodeGeohash` is not exported, and `src/shared/region-labels` can't be resolved.

- [ ] **Step 4: Implement `decodeGeohash`**

Append to `src/shared/geohash.ts`:

```ts
// Centre of the geohash cell.
export function decodeGeohash(hash: string): { lat: number; lon: number } {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let isLonBit = true;

  for (const char of hash) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error(`invalid geohash character: ${char}`);
    for (let bit = 4; bit >= 0; bit -= 1) {
      const on = ((value >> bit) & 1) === 1;
      if (isLonBit) {
        const mid = (lonMin + lonMax) / 2;
        if (on) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid;
        else latMax = mid;
      }
      isLonBit = !isLonBit;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}
```

- [ ] **Step 5: Implement `src/shared/region-labels.ts`**

The geohashes below were computed with `encodeGeohash(lat, lon)`, and the test in Step 2 enforces this.

```ts
// Display names for the demo cities. The dashboard shows these instead of raw
// geohashes, and the Phase 4 story generator seeds reports at these coordinates.
// Each geohash must equal encodeGeohash(lat, lon) (enforced by a test).

export interface RegionLabel {
  geohash: string;
  name: string;
  lat: number;
  lon: number;
}

export const REGION_LABELS: readonly RegionLabel[] = [
  { geohash: 'u173z', name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { geohash: 'u33dc', name: 'Berlin', lat: 52.52, lon: 13.405 },
  { geohash: 'u3but', name: 'Copenhagen', lat: 55.6761, lon: 12.5683 },
  { geohash: 'u1x0e', name: 'Hamburg', lat: 53.5511, lon: 9.9937 },
  { geohash: 'gcpvj', name: 'London', lat: 51.5072, lon: -0.1276 },
  { geohash: 'u4xsu', name: 'Oslo', lat: 59.9139, lon: 10.7522 },
  { geohash: 'u09tv', name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { geohash: 'u2fkb', name: 'Prague', lat: 50.0755, lon: 14.4378 },
  { geohash: 'u6sce', name: 'Stockholm', lat: 59.3293, lon: 18.0686 },
  { geohash: 'u3qcn', name: 'Warsaw', lat: 52.2297, lon: 21.0122 },
];

const BY_GEOHASH = new Map(REGION_LABELS.map((label) => [label.geohash, label]));

export function findRegionLabel(geohash: string): RegionLabel | undefined {
  return BY_GEOHASH.get(geohash);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/shared/geohash.test.ts test/shared/region-labels.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/shared/geohash.ts src/shared/region-labels.ts test/shared/geohash.test.ts test/shared/region-labels.test.ts
git commit -m "Add geohash decoding and demo region labels"
```

---

### Task 3: Dashboard proxy Worker

**Files:**
- Create: `src/dashboard/worker/app.ts`, `src/dashboard/worker/index.ts`, `wrangler.dashboard.jsonc`
- Test: `test/dashboard/proxy.test.ts`

**Interfaces:**
- Consumes: `hono` (existing dependency). `Fetcher` type from `@cloudflare/workers-types` (global).
- Produces:
  ```ts
  // src/dashboard/worker/app.ts
  export interface DashboardEnv { API: Fetcher; API_TOKEN: string; }
  export const UPSTREAM_ORIGIN = 'https://episent-api';
  export function createDashboardApp(): Hono<{ Bindings: DashboardEnv }>;
  ```

- [ ] **Step 1: Write the failing proxy tests**

Create `test/dashboard/proxy.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardApp, type DashboardEnv } from '../../src/dashboard/worker/app';

afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = 'dashboard-test-token';

type Respond = (request: Request) => Response | Promise<Response>;

function setup(respond: Respond = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return respond(request);
  });
  const env: DashboardEnv = { API: { fetch } as unknown as Fetcher, API_TOKEN: TOKEN };
  const app = createDashboardApp();
  const call = (path: string, init?: RequestInit, overrides: Partial<DashboardEnv> = {}) =>
    app.request(path, init, { ...env, ...overrides });
  return { requests, fetch, call };
}

function expectJsonHeaders(res: Response) {
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('cache-control')).toBe('no-store');
}

describe('GET /api/anomalies', () => {
  it('forwards to /anomalies with the bearer token and passes the body through', async () => {
    const body = { as_of: '2026-09-23T12:00:00.000Z', regions: [] };
    const { requests, call } = setup(() => Response.json(body));

    const res = await call('/api/anomalies');

    expect(res.status).toBe(200);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual(body);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://episent-api/anomalies');
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('forwards no query parameters', async () => {
    const { requests, call } = setup();
    await call('/api/anomalies?geohash=ezs42&lat=1&lon=2');
    expect(requests[0].url).toBe('https://episent-api/anomalies');
  });
});

describe('GET /api/similar', () => {
  it('forwards only geohash and limit', async () => {
    const { requests, call } = setup();

    await call('/api/similar?geohash=u4pru&limit=5&lat=1&token=x');

    const url = new URL(requests[0].url);
    expect(url.origin + url.pathname).toBe('https://episent-api/similar');
    expect([...url.searchParams]).toEqual([
      ['geohash', 'u4pru'],
      ['limit', '5'],
    ]);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('forwards without a query string when no allowed params are given', async () => {
    const { requests, call } = setup();
    await call('/api/similar?lat=1');
    expect(requests[0].url).toBe('https://episent-api/similar');
  });
});

describe('upstream pass-through', () => {
  it.each([
    [400, { error: 'limit must be an integer from 1 to 20' }],
    [404, { error: 'no aggregated pattern for this region yet' }],
    [500, { error: 'internal error' }],
  ])('passes status %i and its body through', async (status, body) => {
    const { call } = setup(() => Response.json(body, { status }));

    const res = await call('/api/similar?geohash=u4pru');

    expect(res.status).toBe(status);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual(body);
  });

  it('does not forward client headers or cookies', async () => {
    const { requests, call } = setup();

    await call('/api/anomalies', {
      headers: { authorization: 'Bearer client-supplied', cookie: 'session=abc', 'x-forwarded-for': '1.2.3.4' },
    });

    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].headers.get('cookie')).toBeNull();
    expect(requests[0].headers.get('x-forwarded-for')).toBeNull();
  });
});

describe('unreachable routes', () => {
  it.each([
    ['GET', '/api/ingest'],
    ['POST', '/api/ingest'],
    ['POST', '/api/anomalies'],
    ['GET', '/api/unknown'],
    ['GET', '/api'],
  ])('%s %s returns 404 without calling upstream', async (method, path) => {
    const { fetch, call } = setup();

    const res = await call(path, { method });

    expect(res.status).toBe(404);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('returns 500 when API_TOKEN is not configured', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetch, call } = setup();

    const res = await call('/api/anomalies', undefined, { API_TOKEN: '' });

    expect(res.status).toBe(500);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });

  it('returns 502 when the binding throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { call } = setup(() => {
      throw new Error('service unavailable');
    });

    const res = await call('/api/anomalies');

    expect(res.status).toBe(502);
    expectJsonHeaders(res);
    expect(await res.json()).toEqual({ error: 'upstream unavailable' });
  });
});

describe('token confidentiality', () => {
  it.each<[string, string, Respond]>([
    ['success', '/api/anomalies', () => Response.json({ regions: [] })],
    ['upstream error', '/api/similar?geohash=u4pru', () => Response.json({ error: 'x' }, { status: 400 })],
    ['binding failure', '/api/anomalies', () => {
      throw new Error('boom');
    }],
    ['unknown route', '/api/ingest', () => Response.json({})],
  ])('never includes the token in the response (%s)', async (_name, path, respond) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { call } = setup(respond);

    const res = await call(path);

    expect(await res.text()).not.toContain(TOKEN);
    for (const [, value] of res.headers) expect(value).not.toContain(TOKEN);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard/proxy.test.ts`
Expected: FAIL, because `src/dashboard/worker/app` can't be resolved.

- [ ] **Step 3: Implement the proxy**

Create `src/dashboard/worker/app.ts`:

```ts
import { Hono, type Context } from 'hono';

export interface DashboardEnv {
  API: Fetcher;
  API_TOKEN: string;
}

type DashboardAppEnv = { Bindings: DashboardEnv };

// Service Bindings ignore the host, but fetch() needs an absolute URL.
export const UPSTREAM_ORIGIN = 'https://episent-api';

const SIMILAR_PARAMS = ['geohash', 'limit'] as const;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function jsonResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: JSON_HEADERS });
}

function jsonError(error: string, status: number): Response {
  return jsonResponse(JSON.stringify({ error }), status);
}

// Read-only proxy: forwards exactly two GET routes to episent-api with the
// server-side token. /ingest and everything else is unreachable.
export function createDashboardApp() {
  const app = new Hono<DashboardAppEnv>();

  app.onError((err) => {
    console.error('unhandled error', err);
    return jsonError('internal error', 500);
  });

  app.notFound(() => jsonError('not found', 404));

  app.get('/api/anomalies', (c) => forward(c, '/anomalies', new URLSearchParams()));

  app.get('/api/similar', (c) => {
    const params = new URLSearchParams();
    for (const name of SIMILAR_PARAMS) {
      const value = c.req.query(name);
      if (value !== undefined) params.set(name, value);
    }
    return forward(c, '/similar', params);
  });

  return app;
}

async function forward(c: Context<DashboardAppEnv>, path: string, params: URLSearchParams): Promise<Response> {
  if (!c.env.API_TOKEN) {
    console.error('API_TOKEN is not configured');
    return jsonError('internal error', 500);
  }

  const query = params.size > 0 ? `?${params}` : '';
  let upstream: Response;
  try {
    upstream = await c.env.API.fetch(`${UPSTREAM_ORIGIN}${path}${query}`, {
      headers: { authorization: `Bearer ${c.env.API_TOKEN}` },
    });
  } catch (err) {
    console.error('upstream fetch failed', err);
    return jsonError('upstream unavailable', 502);
  }

  return jsonResponse(await upstream.text(), upstream.status);
}
```

Create `src/dashboard/worker/index.ts`:

```ts
import { createDashboardApp } from './app';

export default createDashboardApp();
```

Create `wrangler.dashboard.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "episent-dashboard",
  "main": "src/dashboard/worker/index.ts",
  "compatibility_date": "2026-09-01",
  "observability": { "enabled": true },
  // Secret (wrangler secret put): API_TOKEN, the same value as episent-api's.
  // Built by `npm run build:dashboard`. Only /api/* runs Worker code; everything else is a static asset.
  "assets": { "directory": "./dist/dashboard", "run_worker_first": ["/api/*"] },
  // Deploy episent-api first: the binding targets an existing Worker.
  "services": [{ "binding": "API", "service": "episent-api" }]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dashboard/proxy.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/worker wrangler.dashboard.jsonc test/dashboard/proxy.test.ts
git commit -m "Add dashboard proxy Worker with service binding to the API"
```

---

### Task 4: Dashboard view-model

**Files:**
- Create: `src/dashboard/web/view-model.ts`
- Test: `test/dashboard/view-model.test.ts`

**Interfaces:**
- Consumes: types from `src/shared/api-types.ts` (Task 1); `decodeGeohash` (Task 2); `findRegionLabel` (Task 2).
- Produces (`src/dashboard/web/view-model.ts`):
  ```ts
  export const STATUS_COLORS: Record<AnomalyStatus, string>;
  export const STATUS_LABELS: Record<AnomalyStatus, string>;
  export const STATUS_ORDER: readonly AnomalyStatus[]; // legend order, most severe first
  export function regionName(geohash: string): string;
  export function regionPosition(geohash: string): { lat: number; lon: number };
  export function formatScore(score: number | null): string;      // null → '—', else 2 decimals
  export function formatSimilarity(score: number): string;        // 0.873 → '87%'
  export function formatAsOf(iso: string): string;                // '2026-09-23 14:05 UTC'
  export interface RegionRow { geohash: string; name: string; status: AnomalyStatus; statusLabel: string; color: string; scoreText: string; selected: boolean; }
  export function toRegionRows(regions: RegionAnomaly[], selected: string | null): RegionRow[];
  export interface MarkerSpec { geohash: string; name: string; lat: number; lon: number; color: string; statusLabel: string; selected: boolean; }
  export function toMarkerSpecs(regions: RegionAnomaly[], selected: string | null): MarkerSpec[]; // selected marker last (drawn on top)
  export interface CategoryRow { category: string; currentCases: string; baselineMedian: string; scoreText: string; statusLabel: string; color: string; }
  export function toCategoryRows(region: RegionAnomaly): CategoryRow[];
  export interface SimilarRow { id: string; name: string; windowEnd: string; similarityText: string; topCategory: string; totalCases: string; }
  export function toSimilarRows(response: SimilarResponse): SimilarRow[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/dashboard/view-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatAsOf,
  formatScore,
  formatSimilarity,
  regionName,
  regionPosition,
  STATUS_COLORS,
  STATUS_LABELS,
  STATUS_ORDER,
  toCategoryRows,
  toMarkerSpecs,
  toRegionRows,
  toSimilarRows,
} from '../../src/dashboard/web/view-model';
import type { RegionAnomaly } from '../../src/shared/api-types';
import { decodeGeohash } from '../../src/shared/geohash';

const OSLO: RegionAnomaly = {
  geohash: 'u4xsu',
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
      status: 'insufficient_data',
      score: null,
      current_cases: 2,
      baseline_median: null,
      baseline_mad: null,
      baseline_weeks: 1,
    },
  ],
};

const UNLABELLED: RegionAnomaly = { geohash: 'ezs42', status: 'normal', max_score: 0.22, categories: [] };

describe('status constants', () => {
  it('uses the agreed colours and labels', () => {
    expect(STATUS_COLORS).toEqual({
      anomalous: '#d64545',
      elevated: '#e0a526',
      normal: '#3f9d5a',
      insufficient_data: '#9aa0a6',
    });
    expect(STATUS_LABELS).toEqual({
      anomalous: 'Anomalous',
      elevated: 'Elevated',
      normal: 'Normal',
      insufficient_data: 'Insufficient data',
    });
    expect(STATUS_ORDER).toEqual(['anomalous', 'elevated', 'normal', 'insufficient_data']);
  });
});

describe('regionName and regionPosition', () => {
  it('uses the label for a labelled region', () => {
    expect(regionName('u4xsu')).toBe('Oslo');
    expect(regionPosition('u4xsu')).toEqual({ lat: 59.9139, lon: 10.7522 });
  });

  it('falls back to the geohash and its cell centre', () => {
    expect(regionName('ezs42')).toBe('ezs42');
    expect(regionPosition('ezs42')).toEqual(decodeGeohash('ezs42'));
  });
});

describe('formatters', () => {
  it.each([
    [null, '—'],
    [12.14, '12.14'],
    [0, '0.00'],
    [-1.5, '-1.50'],
  ])('formatScore(%j) → %s', (score, text) => {
    expect(formatScore(score)).toBe(text);
  });

  it.each([
    [0.873, '87%'],
    [1, '100%'],
    [0.006, '1%'],
  ])('formatSimilarity(%j) → %s', (score, text) => {
    expect(formatSimilarity(score)).toBe(text);
  });

  it('formats as_of in UTC to the minute', () => {
    expect(formatAsOf('2026-09-23T14:05:37.123Z')).toBe('2026-09-23 14:05 UTC');
    expect(formatAsOf('2026-09-23T16:05:00+02:00')).toBe('2026-09-23 14:05 UTC');
  });
});

describe('toRegionRows', () => {
  it('maps regions in order and marks the selection', () => {
    expect(toRegionRows([OSLO, UNLABELLED], 'ezs42')).toEqual([
      {
        geohash: 'u4xsu',
        name: 'Oslo',
        status: 'anomalous',
        statusLabel: 'Anomalous',
        color: '#d64545',
        scoreText: '12.14',
        selected: false,
      },
      {
        geohash: 'ezs42',
        name: 'ezs42',
        status: 'normal',
        statusLabel: 'Normal',
        color: '#3f9d5a',
        scoreText: '0.22',
        selected: true,
      },
    ]);
  });
});

describe('toMarkerSpecs', () => {
  it('positions markers from labels or cell centres and draws the selected one last', () => {
    const specs = toMarkerSpecs([OSLO, UNLABELLED], 'u4xsu');
    expect(specs.map((s) => s.geohash)).toEqual(['ezs42', 'u4xsu']);
    expect(specs[1]).toEqual({
      geohash: 'u4xsu',
      name: 'Oslo',
      lat: 59.9139,
      lon: 10.7522,
      color: '#d64545',
      statusLabel: 'Anomalous',
      selected: true,
    });
    expect(specs[0]).toMatchObject({ ...decodeGeohash('ezs42'), selected: false, color: '#3f9d5a' });
  });

  it('keeps API order when nothing is selected', () => {
    expect(toMarkerSpecs([OSLO, UNLABELLED], null).map((s) => s.geohash)).toEqual(['u4xsu', 'ezs42']);
  });
});

describe('toCategoryRows', () => {
  it('formats each category in API order', () => {
    expect(toCategoryRows(OSLO)).toEqual([
      {
        category: 'respiratory',
        currentCases: '41',
        baselineMedian: '5',
        scoreText: '12.14',
        statusLabel: 'Anomalous',
        color: '#d64545',
      },
      {
        category: 'gastrointestinal',
        currentCases: '2',
        baselineMedian: '—',
        scoreText: '—',
        statusLabel: 'Insufficient data',
        color: '#9aa0a6',
      },
    ]);
  });
});

describe('toSimilarRows', () => {
  it('labels matched regions and formats fields', () => {
    const rows = toSimilarRows({
      query: { geohash: 'u4xsu', window_end: '2026-09-23' },
      matches: [
        {
          id: 'u6sce:2026-04-20',
          score: 0.913,
          geohash: 'u6sce',
          window_end: '2026-04-20',
          total_cases: 61,
          top_category: 'respiratory',
        },
        { id: 'ezs42:2026-06-01', score: 0.5, geohash: 'ezs42', window_end: '2026-06-01', total_cases: 8, top_category: 'gastrointestinal' },
      ],
    });
    expect(rows).toEqual([
      {
        id: 'u6sce:2026-04-20',
        name: 'Stockholm',
        windowEnd: '2026-04-20',
        similarityText: '91%',
        topCategory: 'respiratory',
        totalCases: '61',
      },
      {
        id: 'ezs42:2026-06-01',
        name: 'ezs42',
        windowEnd: '2026-06-01',
        similarityText: '50%',
        topCategory: 'gastrointestinal',
        totalCases: '8',
      },
    ]);
  });

  it('shows placeholders when a match has no metadata', () => {
    const [row] = toSimilarRows({ query: { geohash: 'u4xsu', window_end: '2026-09-23' }, matches: [{ id: 'x', score: 0.7 }] });
    expect(row).toEqual({
      id: 'x',
      name: 'Unknown region',
      windowEnd: '—',
      similarityText: '70%',
      topCategory: '—',
      totalCases: '—',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard/view-model.test.ts`
Expected: FAIL, because `src/dashboard/web/view-model` can't be resolved.

- [ ] **Step 3: Implement the view-model**

Create `src/dashboard/web/view-model.ts`:

```ts
import type { AnomalyStatus, RegionAnomaly, SimilarResponse } from '../../shared/api-types';
import { decodeGeohash } from '../../shared/geohash';
import { findRegionLabel } from '../../shared/region-labels';

// Pure display logic. No DOM access here, so it is unit-tested under Node.

export const STATUS_COLORS: Record<AnomalyStatus, string> = {
  anomalous: '#d64545',
  elevated: '#e0a526',
  normal: '#3f9d5a',
  insufficient_data: '#9aa0a6',
};

export const STATUS_LABELS: Record<AnomalyStatus, string> = {
  anomalous: 'Anomalous',
  elevated: 'Elevated',
  normal: 'Normal',
  insufficient_data: 'Insufficient data',
};

export const STATUS_ORDER: readonly AnomalyStatus[] = ['anomalous', 'elevated', 'normal', 'insufficient_data'];

const MISSING = '—';

export function regionName(geohash: string): string {
  return findRegionLabel(geohash)?.name ?? geohash;
}

export function regionPosition(geohash: string): { lat: number; lon: number } {
  const label = findRegionLabel(geohash);
  return label ? { lat: label.lat, lon: label.lon } : decodeGeohash(geohash);
}

export function formatScore(score: number | null): string {
  return score === null ? MISSING : score.toFixed(2);
}

export function formatSimilarity(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function formatAsOf(iso: string): string {
  const text = new Date(iso).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

export interface RegionRow {
  geohash: string;
  name: string;
  status: AnomalyStatus;
  statusLabel: string;
  color: string;
  scoreText: string;
  selected: boolean;
}

export function toRegionRows(regions: RegionAnomaly[], selected: string | null): RegionRow[] {
  return regions.map((region) => ({
    geohash: region.geohash,
    name: regionName(region.geohash),
    status: region.status,
    statusLabel: STATUS_LABELS[region.status],
    color: STATUS_COLORS[region.status],
    scoreText: formatScore(region.max_score),
    selected: region.geohash === selected,
  }));
}

export interface MarkerSpec {
  geohash: string;
  name: string;
  lat: number;
  lon: number;
  color: string;
  statusLabel: string;
  selected: boolean;
}

// The selected marker comes last so Leaflet draws it on top.
export function toMarkerSpecs(regions: RegionAnomaly[], selected: string | null): MarkerSpec[] {
  const specs = regions.map((region) => ({
    geohash: region.geohash,
    name: regionName(region.geohash),
    ...regionPosition(region.geohash),
    color: STATUS_COLORS[region.status],
    statusLabel: STATUS_LABELS[region.status],
    selected: region.geohash === selected,
  }));
  return [...specs.filter((s) => !s.selected), ...specs.filter((s) => s.selected)];
}

export interface CategoryRow {
  category: string;
  currentCases: string;
  baselineMedian: string;
  scoreText: string;
  statusLabel: string;
  color: string;
}

export function toCategoryRows(region: RegionAnomaly): CategoryRow[] {
  return region.categories.map((c) => ({
    category: c.category,
    currentCases: String(c.current_cases),
    baselineMedian: c.baseline_median === null ? MISSING : String(c.baseline_median),
    scoreText: formatScore(c.score),
    statusLabel: STATUS_LABELS[c.status],
    color: STATUS_COLORS[c.status],
  }));
}

export interface SimilarRow {
  id: string;
  name: string;
  windowEnd: string;
  similarityText: string;
  topCategory: string;
  totalCases: string;
}

export function toSimilarRows(response: SimilarResponse): SimilarRow[] {
  return response.matches.map((m) => ({
    id: m.id,
    name: m.geohash === undefined ? 'Unknown region' : regionName(m.geohash),
    windowEnd: m.window_end ?? MISSING,
    similarityText: formatSimilarity(m.score),
    topCategory: m.top_category ?? MISSING,
    totalCases: m.total_cases === undefined ? MISSING : String(m.total_cases),
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dashboard/view-model.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/web/view-model.ts test/dashboard/view-model.test.ts
git commit -m "Add dashboard view-model"
```

---

### Task 5: Dashboard API client and store

**Files:**
- Create: `src/dashboard/web/api.ts`, `src/dashboard/web/store.ts`
- Test: `test/dashboard/api.test.ts`, `test/dashboard/store.test.ts`

**Interfaces:**
- Consumes: `AnomaliesResponse`, `RegionAnomaly`, `SimilarResponse` from `src/shared/api-types.ts` (Task 1).
- Produces:
  ```ts
  // src/dashboard/web/api.ts
  export const SIMILAR_LIMIT = 5;
  export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }; // status 0 = network error
  export interface DashboardApi { anomalies(): Promise<ApiResult<AnomaliesResponse>>; similar(geohash: string): Promise<ApiResult<SimilarResponse>>; }
  export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
  export function createApi(fetchFn?: FetchFn): DashboardApi;
  // src/dashboard/web/store.ts
  export type SimilarState = { status: 'loading' } | { status: 'loaded'; data: SimilarResponse } | { status: 'not_found' } | { status: 'error'; message: string };
  export interface DashboardState { anomalies: RegionAnomaly[]; asOf: string | null; selected: string | null; similar: ReadonlyMap<string, SimilarState>; loading: boolean; error: string | null; }
  export type Listener = (state: DashboardState) => void;
  export interface Store {
    getState(): DashboardState;
    subscribe(listener: Listener): () => void; // calls listener immediately with the current state
    refresh(): Promise<void>;                  // no-op while loading
    select(geohash: string): Promise<void>;    // ignores unknown regions
    retrySimilar(): Promise<void>;             // reloads similar for the selected region
  }
  export function createStore(api: DashboardApi): Store;
  ```

Store rules (from the spec, made precise):
- `refresh()`:
  1. sets `loading: true, error: null`, then fetches `/anomalies`.
  2. **On failure:** sets `loading: false, error: <message>`. Previously loaded regions stay on screen, so the list is empty only if the first load fails.
  3. **On success:**
     - replaces `anomalies` and `asOf`;
     - clears the similar cache;
     - keeps `selected` if that region is still present, otherwise selects the first region (or `null`);
     - then loads similar results for the selected region.
- `select(g)`: changes the selection and loads similar results unless the cache holds `loading`, `loaded` or `not_found` for `g`. A cached `error` is retried.
- Similar results that arrive after a successful refresh has cleared the cache are discarded (a generation counter).
- Upstream `404` on `/similar` → `not_found`. Any other failure → `error` with the message.

- [ ] **Step 1: Write the failing API client tests**

Create `test/dashboard/api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createApi, SIMILAR_LIMIT, type FetchFn } from '../../src/dashboard/web/api';

function fakeFetch(respond: () => Response | Promise<Response>) {
  return vi.fn<FetchFn>(async () => respond());
}

describe('createApi', () => {
  it('requests /api/anomalies and returns the body', async () => {
    const body = { as_of: '2026-09-23T12:00:00.000Z', regions: [] };
    const fetch = fakeFetch(() => Response.json(body));

    const result = await createApi(fetch).anomalies();

    expect(fetch).toHaveBeenCalledWith('/api/anomalies', { headers: { accept: 'application/json' } });
    expect(result).toEqual({ ok: true, data: body });
  });

  it('requests /api/similar with the geohash and the fixed limit', async () => {
    const fetch = fakeFetch(() => Response.json({ query: {}, matches: [] }));

    await createApi(fetch).similar('u4xsu');

    expect(SIMILAR_LIMIT).toBe(5);
    expect(fetch).toHaveBeenCalledWith('/api/similar?geohash=u4xsu&limit=5', { headers: { accept: 'application/json' } });
  });

  it('returns the API error message and status', async () => {
    const fetch = fakeFetch(() => Response.json({ error: 'no aggregated pattern for this region yet' }, { status: 404 }));

    expect(await createApi(fetch).similar('u4xsu')).toEqual({
      ok: false,
      status: 404,
      error: 'no aggregated pattern for this region yet',
    });
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    const fetch = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }));

    expect(await createApi(fetch).anomalies()).toEqual({ ok: false, status: 502, error: 'HTTP 502' });
  });

  it('reports an invalid successful body', async () => {
    const fetch = fakeFetch(() => new Response('not json', { status: 200 }));

    expect(await createApi(fetch).anomalies()).toEqual({ ok: false, status: 200, error: 'invalid response' });
  });

  it('reports network failures with status 0', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    expect(await createApi(fetch).anomalies()).toEqual({ ok: false, status: 0, error: 'network error' });
  });
});
```

- [ ] **Step 2: Write the failing store tests**

Create `test/dashboard/store.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, DashboardApi } from '../../src/dashboard/web/api';
import { createStore, type DashboardState } from '../../src/dashboard/web/store';
import type { AnomaliesResponse, RegionAnomaly, SimilarResponse } from '../../src/shared/api-types';

function region(geohash: string, status: RegionAnomaly['status'] = 'normal'): RegionAnomaly {
  return { geohash, status, max_score: null, categories: [] };
}

function anomalies(...geohashes: string[]): ApiResult<AnomaliesResponse> {
  return { ok: true, data: { as_of: '2026-09-23T12:00:00.000Z', regions: geohashes.map((g) => region(g)) } };
}

function similar(geohash: string): ApiResult<SimilarResponse> {
  return { ok: true, data: { query: { geohash, window_end: '2026-09-23' }, matches: [] } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Anomalies responses are consumed in order. Similar responses come from `similarFor`.
function fakeApi(anomalyResults: ApiResult<AnomaliesResponse>[], similarFor = (g: string) => Promise.resolve(similar(g))) {
  const api = {
    anomalies: vi.fn<DashboardApi['anomalies']>(async () => {
      const next = anomalyResults.shift();
      if (!next) throw new Error('no more anomalies responses');
      return next;
    }),
    similar: vi.fn<DashboardApi['similar']>((g) => similarFor(g)),
  };
  return api;
}

describe('createStore', () => {
  it('starts empty', () => {
    const store = createStore(fakeApi([]));
    expect(store.getState()).toEqual({
      anomalies: [],
      asOf: null,
      selected: null,
      similar: new Map(),
      loading: false,
      error: null,
    });
  });

  it('refresh loads regions, selects the first, and loads its similar patterns', async () => {
    const api = fakeApi([anomalies('u4xsu', 'u6sce')]);
    const store = createStore(api);

    await store.refresh();

    const state = store.getState();
    expect(state.anomalies.map((r) => r.geohash)).toEqual(['u4xsu', 'u6sce']);
    expect(state.asOf).toBe('2026-09-23T12:00:00.000Z');
    expect(state.selected).toBe('u4xsu');
    expect(state.loading).toBe(false);
    expect(api.similar).toHaveBeenCalledWith('u4xsu');
    expect(state.similar.get('u4xsu')).toEqual({ status: 'loaded', data: (similar('u4xsu') as { data: SimilarResponse }).data });
  });

  it('sets loading while fetching anomalies', async () => {
    const pending = deferred<ApiResult<AnomaliesResponse>>();
    const api = fakeApi([]);
    api.anomalies.mockReturnValueOnce(pending.promise);
    const store = createStore(api);

    const refreshing = store.refresh();
    expect(store.getState().loading).toBe(true);

    pending.resolve(anomalies());
    await refreshing;
    expect(store.getState().loading).toBe(false);
  });

  it('ignores refresh while one is in flight', async () => {
    const pending = deferred<ApiResult<AnomaliesResponse>>();
    const api = fakeApi([]);
    api.anomalies.mockReturnValueOnce(pending.promise);
    const store = createStore(api);

    const first = store.refresh();
    await store.refresh();
    pending.resolve(anomalies());
    await first;

    expect(api.anomalies).toHaveBeenCalledTimes(1);
  });

  it('selects nothing when there are no regions', async () => {
    const api = fakeApi([anomalies()]);
    const store = createStore(api);

    await store.refresh();

    expect(store.getState().selected).toBeNull();
    expect(api.similar).not.toHaveBeenCalled();
  });

  it('records an error on a failed first load and leaves the list empty', async () => {
    const store = createStore(fakeApi([{ ok: false, status: 500, error: 'internal error' }]));

    await store.refresh();

    expect(store.getState()).toMatchObject({ anomalies: [], loading: false, error: 'internal error' });
  });

  it('keeps previous regions when a later refresh fails, and clears the error on the next success', async () => {
    const store = createStore(
      fakeApi([anomalies('u4xsu'), { ok: false, status: 0, error: 'network error' }, anomalies('u4xsu')]),
    );

    await store.refresh();
    await store.refresh();
    expect(store.getState()).toMatchObject({ error: 'network error', selected: 'u4xsu' });
    expect(store.getState().anomalies).toHaveLength(1);

    await store.refresh();
    expect(store.getState().error).toBeNull();
  });

  it('keeps the selection across a refresh when the region is still present', async () => {
    const store = createStore(fakeApi([anomalies('u4xsu', 'u6sce'), anomalies('u6sce', 'u4xsu')]));
    await store.refresh();
    await store.select('u6sce');

    await store.refresh();

    expect(store.getState().selected).toBe('u6sce');
  });

  it('falls back to the new first region when the selection disappears', async () => {
    const store = createStore(fakeApi([anomalies('u4xsu', 'u6sce'), anomalies('u3qcn', 'u4xsu')]));
    await store.refresh();
    await store.select('u6sce');

    await store.refresh();

    expect(store.getState().selected).toBe('u3qcn');
  });

  it('clears the similar cache on refresh', async () => {
    const api = fakeApi([anomalies('u4xsu', 'u6sce'), anomalies('u4xsu', 'u6sce')]);
    const store = createStore(api);
    await store.refresh();
    await store.select('u6sce');

    await store.refresh(); // reloads u6sce (still selected)
    await store.select('u4xsu'); // cache was cleared, so u4xsu is fetched again

    expect(api.similar.mock.calls.map(([g]) => g)).toEqual(['u4xsu', 'u6sce', 'u6sce', 'u4xsu']);
  });

  it('select uses the cache and ignores unknown regions', async () => {
    const api = fakeApi([anomalies('u4xsu', 'u6sce')]);
    const store = createStore(api);
    await store.refresh();

    await store.select('u6sce');
    await store.select('u4xsu');
    await store.select('u6sce');
    await store.select('zzzzz');

    expect(store.getState().selected).toBe('u6sce');
    expect(api.similar.mock.calls.map(([g]) => g)).toEqual(['u4xsu', 'u6sce']);
  });

  it('maps a 404 from /similar to not_found', async () => {
    const store = createStore(
      fakeApi([anomalies('u4xsu')], async () => ({ ok: false, status: 404, error: 'no aggregated pattern for this region yet' })),
    );

    await store.refresh();

    expect(store.getState().similar.get('u4xsu')).toEqual({ status: 'not_found' });
  });

  it('maps other /similar failures to error, and retrySimilar reloads', async () => {
    const results: ApiResult<SimilarResponse>[] = [{ ok: false, status: 500, error: 'internal error' }, similar('u4xsu')];
    const api = fakeApi([anomalies('u4xsu')], async () => results.shift()!);
    const store = createStore(api);

    await store.refresh();
    expect(store.getState().similar.get('u4xsu')).toEqual({ status: 'error', message: 'internal error' });

    await store.retrySimilar();
    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');
  });

  it('retries a cached error when the region is selected again', async () => {
    const results: ApiResult<SimilarResponse>[] = [
      { ok: false, status: 500, error: 'internal error' },
      similar('u6sce'),
      similar('u4xsu'),
    ];
    const api = fakeApi([anomalies('u4xsu', 'u6sce')], async () => results.shift()!);
    const store = createStore(api);
    await store.refresh(); // u4xsu → error

    await store.select('u6sce');
    await store.select('u4xsu');

    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');
  });

  it('discards similar results that arrive after a refresh cleared the cache', async () => {
    const slow = deferred<ApiResult<SimilarResponse>>();
    let calls = 0;
    const api = fakeApi([anomalies('u4xsu'), anomalies('u4xsu')], (g) => {
      calls += 1;
      return calls === 1 ? slow.promise : Promise.resolve(similar(g));
    });
    const store = createStore(api);

    const first = store.refresh(); // starts the slow similar load
    await vi.waitFor(() => expect(api.similar).toHaveBeenCalledTimes(1));
    await store.refresh(); // clears the cache and reloads (fast)
    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');

    slow.resolve({ ok: false, status: 500, error: 'stale' });
    await first;
    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');
  });

  it('notifies subscribers immediately and on change until unsubscribed', async () => {
    const store = createStore(fakeApi([anomalies('u4xsu'), anomalies('u4xsu')]));
    const seen: DashboardState[] = [];

    const unsubscribe = store.subscribe((s) => seen.push(s));
    expect(seen).toHaveLength(1);

    await store.refresh();
    const count = seen.length;
    expect(count).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(store.getState());

    unsubscribe();
    await store.refresh();
    expect(seen).toHaveLength(count);
  });
});
```

Note on the stale-result test: `refresh()` is a no-op while `loading` is true. The first refresh sets `loading: false` before it awaits the similar load, so the second refresh runs.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/dashboard/api.test.ts test/dashboard/store.test.ts`
Expected: FAIL, because `src/dashboard/web/api` and `src/dashboard/web/store` can't be resolved.

- [ ] **Step 4: Implement the API client**

Create `src/dashboard/web/api.ts`:

```ts
import type { AnomaliesResponse, SimilarResponse } from '../../shared/api-types';

// Talks to the dashboard Worker's same-origin /api routes. The browser never
// sees the API token; the Worker adds it.

export const SIMILAR_LIMIT = 5;

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface DashboardApi {
  anomalies(): Promise<ApiResult<AnomaliesResponse>>;
  similar(geohash: string): Promise<ApiResult<SimilarResponse>>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createApi(fetchFn: FetchFn = (input, init) => fetch(input, init)): DashboardApi {
  async function getJson<T>(path: string): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await fetchFn(path, { headers: { accept: 'application/json' } });
    } catch {
      return { ok: false, status: 0, error: 'network error' };
    }

    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      return body === null ? { ok: false, status: response.status, error: 'invalid response' } : { ok: true, data: body as T };
    }
    return { ok: false, status: response.status, error: errorMessage(body) ?? `HTTP ${response.status}` };
  }

  return {
    anomalies: () => getJson<AnomaliesResponse>('/api/anomalies'),
    similar: (geohash) =>
      getJson<SimilarResponse>(`/api/similar?${new URLSearchParams({ geohash, limit: String(SIMILAR_LIMIT) })}`),
  };
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return undefined;
}
```

- [ ] **Step 5: Implement the store**

Create `src/dashboard/web/store.ts`:

```ts
import type { RegionAnomaly, SimilarResponse } from '../../shared/api-types';
import type { DashboardApi } from './api';

export type SimilarState =
  | { status: 'loading' }
  | { status: 'loaded'; data: SimilarResponse }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export interface DashboardState {
  anomalies: RegionAnomaly[];
  asOf: string | null;
  selected: string | null; // geohash
  similar: ReadonlyMap<string, SimilarState>;
  loading: boolean;
  error: string | null;
}

export type Listener = (state: DashboardState) => void;

export interface Store {
  getState(): DashboardState;
  subscribe(listener: Listener): () => void;
  refresh(): Promise<void>;
  select(geohash: string): Promise<void>;
  retrySimilar(): Promise<void>;
}

export function createStore(api: DashboardApi): Store {
  let state: DashboardState = {
    anomalies: [],
    asOf: null,
    selected: null,
    similar: new Map(),
    loading: false,
    error: null,
  };
  // Bumped whenever the similar cache is cleared; older in-flight loads are discarded.
  let generation = 0;
  const listeners = new Set<Listener>();

  function setState(patch: Partial<DashboardState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function setSimilar(geohash: string, value: SimilarState): void {
    const similar = new Map(state.similar);
    similar.set(geohash, value);
    setState({ similar });
  }

  async function loadSimilar(geohash: string): Promise<void> {
    const started = generation;
    setSimilar(geohash, { status: 'loading' });
    const result = await api.similar(geohash);
    if (started !== generation) return;
    if (result.ok) setSimilar(geohash, { status: 'loaded', data: result.data });
    else if (result.status === 404) setSimilar(geohash, { status: 'not_found' });
    else setSimilar(geohash, { status: 'error', message: result.error });
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },

    async refresh() {
      if (state.loading) return;
      setState({ loading: true, error: null });

      const result = await api.anomalies();
      if (!result.ok) {
        setState({ loading: false, error: result.error });
        return;
      }

      const { regions, as_of } = result.data;
      const keep = state.selected !== null && regions.some((r) => r.geohash === state.selected);
      const selected = keep ? state.selected : (regions[0]?.geohash ?? null);
      generation += 1;
      setState({ anomalies: regions, asOf: as_of, selected, similar: new Map(), loading: false });
      if (selected !== null) await loadSimilar(selected);
    },

    async select(geohash) {
      if (!state.anomalies.some((r) => r.geohash === geohash)) return;
      if (state.selected !== geohash) setState({ selected: geohash });
      const cached = state.similar.get(geohash);
      if (cached && cached.status !== 'error') return;
      await loadSimilar(geohash);
    },

    async retrySimilar() {
      if (state.selected !== null) await loadSimilar(state.selected);
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/dashboard/api.test.ts test/dashboard/store.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/web/api.ts src/dashboard/web/store.ts test/dashboard/api.test.ts test/dashboard/store.test.ts
git commit -m "Add dashboard API client and state store"
```

---

### Task 6: Browser type-check and renderers

**Files:**
- Create: `tsconfig.web.json`, `src/dashboard/web/dom.ts`, `src/dashboard/web/map.ts`, `src/dashboard/web/list.ts`, `src/dashboard/web/detail.ts`
- Modify: `tsconfig.json`, `package.json` (deps + `typecheck` script)

**Interfaces:**
- Consumes: `DashboardState`, `SimilarState` (Task 5); `toMarkerSpecs`, `toRegionRows`, `toCategoryRows`, `toSimilarRows`, `regionName`, `STATUS_COLORS`, `STATUS_LABELS`, `STATUS_ORDER` (Task 4).
- Produces:
  ```ts
  // src/dashboard/web/dom.ts
  export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K];
  export function statusBadge(label: string, color: string): HTMLSpanElement;
  // src/dashboard/web/map.ts
  export interface DashboardMap { render(state: DashboardState): void; }
  export function createMap(container: HTMLElement, legend: HTMLElement, onSelect: (geohash: string) => void): DashboardMap;
  // src/dashboard/web/list.ts
  export function renderList(container: HTMLElement, state: DashboardState, onSelect: (geohash: string) => void): void;
  // src/dashboard/web/detail.ts
  export function renderDetail(container: HTMLElement, state: DashboardState, onRetry: () => void): void;
  ```

The renderers are not unit-tested (see the spec). The gate for this task is the browser type-check plus the full test suite. They're exercised visually in Task 7.

- [ ] **Step 1: Install frontend dependencies**

Run:

```bash
npm install 'leaflet@^1.9'
npm install -D 'vite@^8' '@types/leaflet@^1.9'
```

Expected: `package.json` gains `leaflet` under `dependencies` and `vite` and `@types/leaflet` under `devDependencies`. Then run `npm test`. Expected: all tests still pass, which confirms Vitest works with the explicit Vite 8.

- [ ] **Step 2: Split the type-check between Workers and browser code**

In `tsconfig.json`, replace the `"include"` line with:

```json
  "include": ["src", "test", "vitest.config.ts", "vite.config.ts"],
  "exclude": ["src/dashboard/web"]
```

`api.ts`, `store.ts` and `view-model.ts` are still checked under this config through the tests that import them.

Create `tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/dashboard/web"]
}
```

In `package.json`, change the `typecheck` script to:

```json
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.web.json",
```

- [ ] **Step 3: Create `src/dashboard/web/dom.ts`**

```ts
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Status shown as a coloured dot plus text, never colour alone.
export function statusBadge(label: string, color: string): HTMLSpanElement {
  const badge = el('span', 'status');
  const dot = el('span', 'status-dot');
  dot.style.backgroundColor = color;
  badge.append(dot, document.createTextNode(label));
  return badge;
}
```

- [ ] **Step 4: Create `src/dashboard/web/map.ts`**

```ts
import * as L from 'leaflet';
import { el, statusBadge } from './dom';
import type { DashboardState } from './store';
import { STATUS_COLORS, STATUS_LABELS, STATUS_ORDER, toMarkerSpecs } from './view-model';

// Keyless CARTO basemap; the CSP img-src must allow https://*.basemaps.cartocdn.com.
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

export interface DashboardMap {
  render(state: DashboardState): void;
}

export function createMap(container: HTMLElement, legend: HTMLElement, onSelect: (geohash: string) => void): DashboardMap {
  const map = L.map(container).setView([52, 10], 4);
  L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, subdomains: 'abcd', maxZoom: 19 }).addTo(map);
  const markers = L.layerGroup().addTo(map);

  legend.replaceChildren(
    ...STATUS_ORDER.map((status) => {
      const item = el('li');
      item.append(statusBadge(STATUS_LABELS[status], STATUS_COLORS[status]));
      return item;
    }),
  );

  let fitted = false;
  let lastSelected: string | null = null;

  return {
    render(state) {
      const specs = toMarkerSpecs(state.anomalies, state.selected);
      markers.clearLayers();
      for (const spec of specs) {
        L.circleMarker([spec.lat, spec.lon], {
          radius: spec.selected ? 12 : 8,
          color: spec.selected ? '#1f2328' : '#ffffff',
          weight: spec.selected ? 3 : 1.5,
          fillColor: spec.color,
          fillOpacity: 0.9,
        })
          .bindTooltip(`${spec.name}: ${spec.statusLabel}`)
          .on('click', () => onSelect(spec.geohash))
          .addTo(markers);
      }

      if (!fitted && specs.length > 0) {
        map.fitBounds(L.latLngBounds(specs.map((s) => [s.lat, s.lon] as [number, number])), {
          padding: [40, 40],
          maxZoom: 7,
        });
        fitted = true;
      } else if (state.selected !== lastSelected) {
        const selected = specs.find((s) => s.selected);
        if (selected) map.panTo([selected.lat, selected.lon]);
      }
      lastSelected = state.selected;
    },
  };
}
```

- [ ] **Step 5: Create `src/dashboard/web/list.ts`**

```ts
import { el, statusBadge } from './dom';
import type { DashboardState } from './store';
import { toRegionRows } from './view-model';

export function renderList(container: HTMLElement, state: DashboardState, onSelect: (geohash: string) => void): void {
  // Re-rendering replaces the buttons, so restore keyboard focus afterwards.
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && container.contains(active) ? active.dataset.geohash : undefined;

  const rows = toRegionRows(state.anomalies, state.selected);
  if (rows.length === 0) {
    const message = state.loading ? 'Loading regions…' : state.error ? '' : 'No regions reported yet.';
    container.replaceChildren(...(message ? [el('li', 'muted', message)] : []));
    return;
  }

  container.replaceChildren(
    ...rows.map((row) => {
      const button = el('button', 'region-row');
      button.type = 'button';
      button.dataset.geohash = row.geohash;
      button.setAttribute('aria-pressed', String(row.selected));
      button.append(el('span', 'region-name', row.name), statusBadge(row.statusLabel, row.color), el('span', 'region-score', row.scoreText));
      button.addEventListener('click', () => onSelect(row.geohash));
      const item = el('li');
      item.append(button);
      return item;
    }),
  );

  if (focused) container.querySelector<HTMLButtonElement>(`button[data-geohash="${focused}"]`)?.focus();
}
```

- [ ] **Step 6: Create `src/dashboard/web/detail.ts`**

```ts
import { el, statusBadge } from './dom';
import type { DashboardState, SimilarState } from './store';
import { regionName, STATUS_COLORS, STATUS_LABELS, toCategoryRows, toSimilarRows, type CategoryRow } from './view-model';

const CATEGORY_HEADINGS = ['Category', 'Current cases', 'Baseline median', 'Score', 'Status'];

export function renderDetail(container: HTMLElement, state: DashboardState, onRetry: () => void): void {
  const region = state.anomalies.find((r) => r.geohash === state.selected);
  if (!region) {
    container.replaceChildren(el('p', 'muted', 'Select a region to see details.'));
    return;
  }

  const header = el('div', 'detail-header');
  header.append(el('h2', undefined, regionName(region.geohash)), statusBadge(STATUS_LABELS[region.status], STATUS_COLORS[region.status]));

  container.replaceChildren(
    header,
    categoriesTable(region.geohash, toCategoryRows(region)),
    el('h3', undefined, 'Similar past outbreaks'),
    similarSection(state.similar.get(region.geohash), onRetry),
  );
}

function categoriesTable(geohash: string, rows: CategoryRow[]): HTMLElement {
  if (rows.length === 0) return el('p', 'muted', 'No reports in the last 98 days.');

  const table = el('table', 'categories');
  table.append(el('caption', 'visually-hidden', `Categories for ${regionName(geohash)}`));
  const headRow = el('tr');
  headRow.append(...CATEGORY_HEADINGS.map((heading) => el('th', undefined, heading)));
  const head = el('thead');
  head.append(headRow);

  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const status = el('td');
    status.append(statusBadge(row.statusLabel, row.color));
    tr.append(
      el('td', undefined, row.category),
      el('td', 'num', row.currentCases),
      el('td', 'num', row.baselineMedian),
      el('td', 'num', row.scoreText),
      status,
    );
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

function similarSection(similar: SimilarState | undefined, onRetry: () => void): HTMLElement {
  if (!similar || similar.status === 'loading') return el('p', 'muted', 'Loading similar patterns…');
  if (similar.status === 'not_found') return el('p', 'muted', 'No pattern history yet for this region.');
  if (similar.status === 'error') {
    const message = el('p', 'inline-error', `Couldn't load similar patterns (${similar.message}). `);
    const retry = el('button', 'link-button', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    message.append(retry);
    return message;
  }

  const rows = toSimilarRows(similar.data);
  if (rows.length === 0) return el('p', 'muted', 'No similar patterns found.');

  const list = el('ol', 'similar-list');
  for (const row of rows) {
    const item = el('li', 'similar-item');
    const title = el('div', 'similar-title');
    title.append(el('strong', undefined, row.name), el('span', 'similarity', `${row.similarityText} similar`));
    item.append(
      title,
      el('div', 'similar-meta', `14 days ending ${row.windowEnd} · ${row.topCategory} · ${row.totalCases} cases`),
    );
    list.append(item);
  }
  return list;
}
```

- [ ] **Step 7: Verify both type-checks and the full test suite**

Run: `npm run typecheck && npm test`
Expected: both `tsc` runs exit 0 and all tests pass.

- [ ] **Step 8: Commit**

```bash
git add tsconfig.json tsconfig.web.json package.json package-lock.json src/dashboard/web/dom.ts src/dashboard/web/map.ts src/dashboard/web/list.ts src/dashboard/web/detail.ts
git commit -m "Add dashboard renderers and browser type-check"
```

---

### Task 7: Page shell, build, CI and docs

**Files:**
- Create: `src/dashboard/web/index.html`, `src/dashboard/web/main.ts`, `src/dashboard/web/styles.css`, `src/dashboard/web/public/_headers`, `vite.config.ts`
- Modify: `package.json` (scripts), `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: `createApi` (Task 5), `createStore` (Task 5), `createMap`, `renderList`, `renderDetail` (Task 6), `formatAsOf` (Task 4).
- Produces:
  - `npm run build:dashboard` → `dist/dashboard/` (the `index.html`, hashed assets and `_headers`);
  - `npm run dev:dashboard` and `npm run deploy:dashboard`.

- [ ] **Step 1: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';

// Builds the dashboard frontend into the directory wrangler.dashboard.jsonc serves.
export default defineConfig({
  root: 'src/dashboard/web',
  build: {
    outDir: '../../../dist/dashboard',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: Create `src/dashboard/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>episent.ai · Outbreak dashboard</title>
    <link rel="icon" href="data:," />
    <script type="module" src="./main.ts"></script>
  </head>
  <body>
    <header class="header">
      <div class="brand">
        <h1>episent.ai</h1>
        <span class="badge-synthetic">Synthetic data</span>
      </div>
      <div class="header-actions">
        <span id="as-of" class="as-of"></span>
        <button id="refresh" type="button">Refresh</button>
      </div>
    </header>

    <div id="banner" class="banner" role="alert" hidden>
      <span>Couldn't load data.</span>
      <button id="banner-retry" type="button">Retry</button>
    </div>

    <main class="layout">
      <section class="map-panel" aria-label="Map of regions">
        <div id="map"></div>
        <ul id="legend" class="legend" aria-label="Legend"></ul>
      </section>
      <section class="list-panel" aria-labelledby="list-heading">
        <h2 id="list-heading">Regions</h2>
        <ol id="region-list" class="region-list"></ol>
      </section>
      <section id="detail" class="detail-panel" aria-live="polite"></section>
    </main>
  </body>
</html>
```

- [ ] **Step 3: Create `src/dashboard/web/main.ts`**

```ts
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createApi } from './api';
import { renderDetail } from './detail';
import { renderList } from './list';
import { createMap } from './map';
import { createStore } from './store';
import { formatAsOf } from './view-model';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

const store = createStore(createApi());
const select = (geohash: string) => void store.select(geohash);

const map = createMap(byId('map'), byId('legend'), select);
const list = byId('region-list');
const detail = byId('detail');
const asOf = byId('as-of');
const refresh = byId<HTMLButtonElement>('refresh');
const banner = byId('banner');

refresh.addEventListener('click', () => void store.refresh());
byId('banner-retry').addEventListener('click', () => void store.refresh());

store.subscribe((state) => {
  map.render(state);
  renderList(list, state, select);
  renderDetail(detail, state, () => void store.retrySimilar());
  asOf.textContent = state.asOf ? `As of ${formatAsOf(state.asOf)}` : '';
  refresh.disabled = state.loading;
  refresh.textContent = state.loading ? 'Refreshing…' : 'Refresh';
  banner.hidden = state.error === null;
});

void store.refresh();
```

- [ ] **Step 4: Create `src/dashboard/web/styles.css`**

```css
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #1f2328;
  --muted: #5f6b7a;
  --border: #d8dde3;
  --accent: #2458d6;
  --danger-bg: #fdecec;
  --danger-text: #8a1c1c;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: var(--text);
  background: var(--bg);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
}

.header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  gap: 12px;
  align-items: center;
}

.brand h1 {
  margin: 0;
  font-size: 1.25rem;
}

.badge-synthetic {
  padding: 2px 8px;
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.header-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.as-of {
  color: var(--muted);
  font-size: 0.875rem;
}

button {
  font: inherit;
  cursor: pointer;
}

#refresh,
#banner-retry {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}

#refresh:disabled {
  cursor: progress;
  opacity: 0.6;
}

.banner {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px 20px;
  background: var(--danger-bg);
  color: var(--danger-text);
}

.banner[hidden] {
  display: none;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr);
  grid-template-areas:
    'map list'
    'map detail';
  grid-template-rows: auto 1fr;
  gap: 16px;
  padding: 16px 20px;
  height: calc(100vh - 60px);
}

.map-panel,
.list-panel,
.detail-panel {
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.map-panel {
  grid-area: map;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

#map {
  flex: 1;
  min-height: 320px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin: 0;
  padding: 8px 12px;
  list-style: none;
  border-top: 1px solid var(--border);
  font-size: 0.875rem;
}

.list-panel {
  grid-area: list;
  padding: 12px;
  max-height: 40vh;
  overflow-y: auto;
}

.list-panel h2 {
  margin: 0 0 8px;
  font-size: 1rem;
}

.region-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.region-row {
  display: grid;
  grid-template-columns: 1fr auto 3.5rem;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: inherit;
  text-align: left;
}

.region-row:hover {
  background: var(--bg);
}

.region-row[aria-pressed='true'] {
  border-color: var(--accent);
  background: #eef3ff;
}

.region-row:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.region-name {
  font-weight: 600;
}

.region-score,
.num {
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.status {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 0.875rem;
  white-space: nowrap;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.detail-panel {
  grid-area: detail;
  padding: 12px 16px;
  overflow-y: auto;
}

.detail-header {
  display: flex;
  gap: 12px;
  align-items: center;
}

.detail-header h2 {
  margin: 0;
  font-size: 1.25rem;
}

.detail-panel h3 {
  margin: 20px 0 8px;
  font-size: 1rem;
}

.categories {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.categories th,
.categories td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.categories th {
  color: var(--muted);
  font-weight: 600;
}

.categories td.num {
  text-align: right;
}

.similar-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.similar-item {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.similar-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.similarity {
  color: var(--accent);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.similar-meta {
  color: var(--muted);
  font-size: 0.875rem;
}

.muted {
  color: var(--muted);
}

.inline-error {
  color: var(--danger-text);
}

.link-button {
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  text-decoration: underline;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'map'
      'list'
      'detail';
    grid-template-rows: auto;
    height: auto;
    padding: 12px 16px;
  }

  #map {
    height: 50vh;
  }

  .list-panel {
    max-height: none;
  }
}
```

- [ ] **Step 5: Create `src/dashboard/web/public/_headers`**

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.basemaps.cartocdn.com; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
```

- [ ] **Step 6: Add the dashboard scripts**

In `package.json` `"scripts"`, add after `"deploy:cron"`:

```json
    "build:dashboard": "vite build",
    "dev:dashboard": "vite build && wrangler dev -c wrangler.dashboard.jsonc -c wrangler.api.jsonc",
    "deploy:dashboard": "vite build && wrangler deploy -c wrangler.dashboard.jsonc"
```

`dev:dashboard` runs both Workers in one `wrangler dev` session. The first config is the one served on `localhost:8787`, and the `API` Service Binding resolves to the local `episent-api`. Both configs read the same root `.dev.vars`.

- [ ] **Step 7: Build and verify the output**

Run: `npm run build:dashboard && ls dist/dashboard && grep -o '<script[^>]*>' dist/dashboard/index.html`
Expected:
- the build succeeds;
- `dist/dashboard` contains `index.html`, `_headers` and `assets/`;
- the only `<script>` tag has `type="module"` and a `src="/assets/…js"` attribute (no inline scripts, as the CSP requires).

Then run: `grep -rl API_TOKEN dist/dashboard || echo "no token references"`
Expected: `no token references`.

Then run: `npx wrangler deploy --dry-run -c wrangler.dashboard.jsonc --outdir dist/dashboard-worker`
Expected: exits 0 and lists the `API` service binding and the assets directory.

- [ ] **Step 8: Manual smoke run**

Prerequisites (from the README): Docker running, `npx supabase start && npx supabase db reset`, a `.dev.vars` copied from `.dev.vars.example` with the local secret key, and `wrangler login` (the API's Vectorize binding is remote).

1. Seed one report through the API alone. Run `npm run dev:api`, then in another terminal:

   ```bash
   curl -s -X POST localhost:8787/ingest -H "Authorization: Bearer local-dev-token" -H "content-type: application/json" -d "{\"event_timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"lat\":59.9139,\"lon\":10.7522,\"disease_category\":\"respiratory\",\"case_count\":3}"
   ```

   Expected: `201`. Stop `dev:api` (Ctrl-C).
2. Run `npm run dev:dashboard`.
3. Check the proxy:
   - `curl -si localhost:8787/api/anomalies` → `200` with `cache-control: no-store` and a `regions` array containing `u4xsu`;
   - `curl -si -X POST localhost:8787/api/ingest` → `404`;
   - `curl -si localhost:8787/ | grep -i content-security-policy` → the CSP header.
4. Open `http://localhost:8787/` in a browser and confirm:
   - the "Synthetic data" badge, the "As of …" stamp and the tile attribution are visible;
   - an Oslo marker (grey, "Insufficient data") and a list row for Oslo, auto-selected;
   - the detail panel shows the respiratory row and "No pattern history yet for this region." (not aggregated);
   - the browser console has no CSP violations;
   - Refresh disables briefly and keeps Oslo selected;
   - Tab to the Oslo row and press Enter: focus stays on the row;
   - at a 375px-wide viewport the panels stack with no horizontal scroll.

Record any deviation and fix it before committing.

- [ ] **Step 9: Add CI steps**

In `.github/workflows/ci.yml`, after the `Bundle aggregator Worker` step, add:

```yaml
      - name: Build dashboard
        run: npm run build:dashboard

      - name: Bundle dashboard Worker
        run: npx wrangler deploy --dry-run -c wrangler.dashboard.jsonc --outdir dist/dashboard-worker
```

The existing `Typecheck` step now covers the browser code through the updated `typecheck` script.

- [ ] **Step 10: Document the dashboard in the README**

In `README.md`, in the Workers list (after the `episent-aggregator` bullet), add:

```markdown
- `episent-dashboard` (`wrangler.dashboard.jsonc`): read-only web dashboard. Serves the Vite-built
  frontend as static assets and proxies `GET /api/anomalies` and `GET /api/similar` to `episent-api`
  over a Service Binding, adding the API token server-side. Deploy `episent-api` first.
```

Replace the line:

```markdown
Copy `.dev.vars.example` to `.dev.vars` for `npm run dev:api` / `npm run dev:cron`.
```

with:

```markdown
Copy `.dev.vars.example` to `.dev.vars` for `npm run dev:api` / `npm run dev:cron` / `npm run dev:dashboard`.
```

Append a new section at the end of the README:

~~~markdown
## Dashboard

A map and a ranked list of regions by anomaly status. Selecting a region shows its per-category
scores and its most similar past outbreak patterns (`/similar`, top 5).

```bash
npm run dev:dashboard      # builds the frontend, then runs the dashboard + API Workers on localhost:8787
npm run build:dashboard    # frontend only → dist/dashboard
npm run deploy:dashboard   # build + deploy (set the API_TOKEN secret first: same value as episent-api)
```

- The browser only ever calls the dashboard's own `/api/*` routes. The API token stays in the
  dashboard Worker, and `/ingest` isn't reachable through it.
- Region names come from `src/shared/region-labels.ts` (the demo cities). Other regions show their geohash.
- Data is loaded when the page opens and on **Refresh**. There's no polling.
- Map tiles: © OpenStreetMap contributors, © CARTO.
~~~

- [ ] **Step 11: Full verification**

Run: `npm run typecheck && npm test && npm run build:dashboard`
Expected: all exit 0.

- [ ] **Step 12: Commit**

```bash
git add vite.config.ts src/dashboard/web/index.html src/dashboard/web/main.ts src/dashboard/web/styles.css src/dashboard/web/public/_headers package.json .github/workflows/ci.yml README.md
git commit -m "Add dashboard page shell, build scripts, CI and docs"
```
