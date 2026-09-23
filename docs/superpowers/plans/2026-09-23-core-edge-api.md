# Core Edge API (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two Cloudflare Workers. The first ingests geolocated case reports into Supabase and serves similarity search over regional outbreak patterns. The second hourly aggregates each region's 14-day window into a Workers AI embedding stored in Vectorize.

**Architecture:** TypeScript project with two Worker entrypoints (`src/api`, `src/cron`) that share modules in `src/shared`. All I/O goes through narrow interfaces (`Repository`, `VectorStore`, `Embedder`). Business logic is therefore tested in-process against in-memory fakes, and the real SQL is tested separately against local Supabase.

**Tech Stack:** TypeScript, Hono, Zod 4, @supabase/supabase-js, Cloudflare Workers + Workers AI + Vectorize, Wrangler, Vitest, Supabase CLI.

**Spec:** `docs/superpowers/specs/2026-09-23-core-edge-api-design.md`

## Global Constraints

- Region = geohash at precision **5**. The regex for a valid region geohash is `^[0-9bcdefghjkmnpqrstuvwxyz]{5}$`.
- Aggregation window: **14 days**, `(now − 14d, now]` by `event_timestamp`. The trend compares the most recent **7** days with the prior 7.
- At most **20** regions per aggregation run. The cron schedule is `0 * * * *`.
- Embedding model: `@cf/baai/bge-base-en-v1.5`, **768** dimensions. Vectorize index `episent-patterns`, metric `cosine`, with a string metadata index on `geohash`.
- Vector id: `<geohash>:<YYYY-MM-DD>` (UTC date). Metadata: `{ geohash, window_end, total_cases, top_category }`.
- The embedded description text must **not** contain the geohash or any date.
- `/similar` `limit`: integer 1–20, default 10. `/ingest` body max 64 KB.
- Error response bodies are `{ "error": string }`. Validation failures add `details: [{ field, message }]`.
- Secrets `API_TOKEN`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` are never committed. Local values go in `.dev.vars`, which is git-ignored.
- Supabase `max_rows` (default 1000) must be ≥ `PAGE_SIZE` (1000) in the repository.

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .dev.vars.example
wrangler.api.jsonc              API Worker config (episent-api)
wrangler.cron.jsonc             Aggregator Worker config (episent-aggregator)
supabase/config.toml            created by `supabase init`
supabase/migrations/20260923000000_core_schema.sql
src/shared/geohash.ts           encodeGeohash, isValidRegionGeohash, REGION_PRECISION
src/shared/repository.ts        Repository interface, row types, Supabase implementation
src/shared/vectors.ts           VectorStore type, PatternMetadata, vectorId, toIsoDate
src/shared/embedding.ts         Embedder type, Workers AI implementation
src/api/env.ts                  ApiEnv, ApiDeps, AppEnv types
src/api/validation.ts           Zod case-report schema + validateCaseReport
src/api/ingest.ts               POST /ingest handler
src/api/similar.ts              GET /similar handler + query parsing
src/api/app.ts                  createApp: error handling, auth, deps, routes
src/api/index.ts                API Worker entrypoint (real deps)
src/cron/aggregate.ts           aggregateWindow, windowStartFor, WINDOW_DAYS
src/cron/describe.ts            describePattern
src/cron/run.ts                 runAggregation orchestrator, MAX_REGIONS_PER_RUN
src/cron/index.ts               Aggregator Worker entrypoint (scheduled handler)
test/fakes.ts                   FakeRepository, FakeVectorStore
test/shared/geohash.test.ts
test/shared/repository.contract.test.ts
test/shared/embedding.test.ts
test/api/validation.test.ts
test/api/ingest.test.ts
test/api/similar.test.ts
test/cron/aggregate.test.ts
test/cron/describe.test.ts
test/cron/run.test.ts
```

---

### Task 1: Project scaffold and geohash encoding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/shared/geohash.ts`
- Test: `test/shared/geohash.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `REGION_PRECISION: 5`
  - `encodeGeohash(lat: number, lon: number, precision?: number): string` (precision defaults to `REGION_PRECISION`)
  - `isValidRegionGeohash(value: string): boolean` (true only for a 5-char lowercase geohash)
  - npm scripts `test` (`vitest run`) and `typecheck` (`tsc --noEmit`)

- [ ] **Step 1: Create project files**

`package.json`:

```json
{
  "name": "episent-ai",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev:api": "wrangler dev -c wrangler.api.jsonc",
    "dev:cron": "wrangler dev -c wrangler.cron.jsonc --test-scheduled",
    "deploy:api": "wrangler deploy -c wrangler.api.jsonc",
    "deploy:cron": "wrangler deploy -c wrangler.cron.jsonc"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

`.gitignore`:

```
node_modules/
.wrangler/
dist/
.dev.vars
```

- [ ] **Step 2: Install dependencies**

Run:

```bash
npm install hono zod@^4 @supabase/supabase-js
npm install -D typescript vitest wrangler @cloudflare/workers-types @types/node
```

Expected: `package.json` gains `dependencies` and `devDependencies`, and `package-lock.json` is created.

- [ ] **Step 3: Write the failing test**

`test/shared/geohash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { encodeGeohash, isValidRegionGeohash, REGION_PRECISION } from '../../src/shared/geohash';

describe('encodeGeohash', () => {
  it('encodes the reference point from the geohash spec', () => {
    expect(encodeGeohash(42.605, -5.603)).toBe('ezs42');
  });

  it('supports longer precision', () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
  });

  it('defaults to region precision 5', () => {
    expect(REGION_PRECISION).toBe(5);
    expect(encodeGeohash(57.64911, 10.40744)).toBe('u4pru');
  });

  it('handles the origin and extreme corners', () => {
    expect(encodeGeohash(0, 0)).toBe('s0000');
    expect(encodeGeohash(-90, -180)).toBe('00000');
    expect(encodeGeohash(90, 180)).toBe('zzzzz');
  });
});

describe('isValidRegionGeohash', () => {
  it('accepts a 5-character geohash', () => {
    expect(isValidRegionGeohash('ezs42')).toBe(true);
  });

  it.each(['ezs4', 'ezs421', 'ezsa2', 'EZS42', ''])('rejects %j', (value) => {
    expect(isValidRegionGeohash(value)).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/shared/geohash.test.ts`
Expected: FAIL. The error is that `../../src/shared/geohash` can't be resolved.

- [ ] **Step 5: Write the implementation**

`src/shared/geohash.ts`:

```ts
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const REGION_GEOHASH = /^[0-9bcdefghjkmnpqrstuvwxyz]{5}$/;

export const REGION_PRECISION = 5;

export function encodeGeohash(lat: number, lon: number, precision = REGION_PRECISION): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bits = 0;
  let charIndex = 0;
  let isLonBit = true;

  while (hash.length < precision) {
    if (isLonBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        charIndex = (charIndex << 1) | 1;
        lonMin = mid;
      } else {
        charIndex = charIndex << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        charIndex = (charIndex << 1) | 1;
        latMin = mid;
      } else {
        charIndex = charIndex << 1;
        latMax = mid;
      }
    }
    isLonBit = !isLonBit;
    bits += 1;
    if (bits === 5) {
      hash += BASE32.charAt(charIndex);
      bits = 0;
      charIndex = 0;
    }
  }
  return hash;
}

export function isValidRegionGeohash(value: string): boolean {
  return REGION_GEOHASH.test(value);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/shared/geohash.test.ts && npm run typecheck`
Expected: all tests PASS and tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/shared/geohash.ts test/shared/geohash.test.ts
git commit -m "Scaffold TypeScript project and add geohash encoding"
```

---

### Task 2: Database schema and Supabase repository

**Files:**
- Create: `supabase/config.toml` (via `supabase init`)
- Create: `supabase/migrations/20260923000000_core_schema.sql`
- Create: `src/shared/repository.ts`
- Test: `test/shared/repository.contract.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces (from `src/shared/repository.ts`):

```ts
export interface NewCaseReport {
  event_timestamp: string; lat: number; lon: number; geohash: string;
  disease_category: string; case_count: number;
  age_band?: string; symptom_codes?: string[]; raw_payload: unknown;
}
export interface RegionRow { geohash: string; last_aggregated_at: string | null; latest_window_end: string | null }
export interface DirtyRegion { geohash: string; checkedAt: string }
export interface WindowReport { event_timestamp: string; disease_category: string; case_count: number; age_band: string | null }
export interface Repository {
  insertCaseReport(report: NewCaseReport): Promise<{ id: string }>;
  getRegion(geohash: string): Promise<RegionRow | null>;
  listDirtyRegions(maxRegions: number): Promise<DirtyRegion[]>;
  getWindowReports(geohash: string, windowStart: Date, windowEnd: Date): Promise<WindowReport[]>; // event_timestamp in (start, end]
  markAggregated(geohash: string, checkedAt: string, latestWindowEnd: string | null): Promise<void>; // null keeps existing latest_window_end
}
export const PAGE_SIZE = 1000;
export function createSupabaseRepository(url: string, secretKey: string): Repository;
```

**Prerequisite:** Docker must be running for `supabase start`. If Docker is unavailable, the contract tests skip. In that case, report that the SQL was **not** verified. Do not claim it passed.

- [ ] **Step 1: Initialise Supabase locally**

Run:

```bash
npm install -D supabase
npx supabase init
```

Expected: `supabase/config.toml` and `supabase/.gitignore` are created.

- [ ] **Step 2: Write the migration**

`supabase/migrations/20260923000000_core_schema.sql`:

```sql
create table public.case_reports (
  id               uuid primary key default gen_random_uuid(),
  received_at      timestamptz not null default now(),
  event_timestamp  timestamptz not null,
  lat              double precision not null,
  lon              double precision not null,
  geohash          text not null,
  disease_category text not null,
  case_count       integer not null check (case_count > 0),
  age_band         text,
  symptom_codes    text[],
  raw_payload      jsonb not null
);

create index case_reports_geohash_event_idx on public.case_reports (geohash, event_timestamp);
create index case_reports_geohash_received_idx on public.case_reports (geohash, received_at);

create table public.regions_index (
  geohash            text primary key,
  last_aggregated_at timestamptz,
  latest_window_end  date
);

-- Workers use the secret key, which bypasses RLS; no policies means no anon/authenticated access.
alter table public.case_reports enable row level security;
alter table public.regions_index enable row level security;

create function public.register_region() returns trigger
language plpgsql
as $$
begin
  insert into public.regions_index (geohash) values (new.geohash)
  on conflict (geohash) do nothing;
  return new;
end;
$$;

create trigger case_reports_register_region
after insert on public.case_reports
for each row execute function public.register_region();

create function public.dirty_regions(max_regions integer)
returns table (geohash text, checked_at timestamptz)
language sql
stable
as $$
  select r.geohash, now() as checked_at
  from public.regions_index r
  where r.last_aggregated_at is null
     or exists (
       select 1
       from public.case_reports c
       where c.geohash = r.geohash
         and c.received_at > r.last_aggregated_at
     )
  order by r.last_aggregated_at asc nulls first, r.geohash
  limit max_regions;
$$;

revoke execute on function public.dirty_regions(integer) from public, anon, authenticated;
revoke execute on function public.register_region() from public, anon, authenticated;
```

- [ ] **Step 3: Start local Supabase and apply the migration**

Run:

```bash
npx supabase start
npx supabase db reset
npx supabase status
```

Expected: `db reset` reports applying `20260923000000_core_schema.sql` with no errors. From `status`, note the **API URL** (normally `http://127.0.0.1:54321`) and the **Secret key**. Older CLI versions call it the **service_role key**.

- [ ] **Step 4: Write the failing contract tests**

`test/shared/repository.contract.test.ts`:

```ts
import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSupabaseRepository, type NewCaseReport } from '../../src/shared/repository';

const url = process.env.SUPABASE_TEST_URL;
const key = process.env.SUPABASE_TEST_SECRET_KEY;

describe.skipIf(!url || !key)('Supabase repository (contract)', () => {
  const admin = createClient(url!, key!, { auth: { persistSession: false } });
  const repo = createSupabaseRepository(url!, key!);

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
});
```

- [ ] **Step 5: Run the contract tests to verify they fail**

Run (substitute the key from Step 3):

```bash
SUPABASE_TEST_URL=http://127.0.0.1:54321 SUPABASE_TEST_SECRET_KEY='<secret key from supabase status>' npx vitest run test/shared/repository.contract.test.ts
```

Expected: FAIL. The error is that `../../src/shared/repository` can't be resolved.

- [ ] **Step 6: Write the implementation**

`src/shared/repository.ts`:

```ts
import { createClient } from '@supabase/supabase-js';

export interface NewCaseReport {
  event_timestamp: string;
  lat: number;
  lon: number;
  geohash: string;
  disease_category: string;
  case_count: number;
  age_band?: string;
  symptom_codes?: string[];
  raw_payload: unknown;
}

export interface RegionRow {
  geohash: string;
  last_aggregated_at: string | null;
  latest_window_end: string | null;
}

export interface DirtyRegion {
  geohash: string;
  checkedAt: string;
}

export interface WindowReport {
  event_timestamp: string;
  disease_category: string;
  case_count: number;
  age_band: string | null;
}

export interface Repository {
  insertCaseReport(report: NewCaseReport): Promise<{ id: string }>;
  getRegion(geohash: string): Promise<RegionRow | null>;
  listDirtyRegions(maxRegions: number): Promise<DirtyRegion[]>;
  getWindowReports(geohash: string, windowStart: Date, windowEnd: Date): Promise<WindowReport[]>;
  markAggregated(geohash: string, checkedAt: string, latestWindowEnd: string | null): Promise<void>;
}

// Must not exceed Supabase's API max_rows (default 1000), or pagination stops early.
export const PAGE_SIZE = 1000;

export function createSupabaseRepository(url: string, secretKey: string): Repository {
  const db = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async insertCaseReport(report) {
      const { data, error } = await db
        .from('case_reports')
        .insert({
          event_timestamp: report.event_timestamp,
          lat: report.lat,
          lon: report.lon,
          geohash: report.geohash,
          disease_category: report.disease_category,
          case_count: report.case_count,
          age_band: report.age_band ?? null,
          symptom_codes: report.symptom_codes ?? null,
          raw_payload: report.raw_payload,
        })
        .select('id')
        .single();
      if (error) throw new Error(`insertCaseReport failed: ${error.message}`);
      return { id: data.id as string };
    },

    async getRegion(geohash) {
      const { data, error } = await db
        .from('regions_index')
        .select('geohash, last_aggregated_at, latest_window_end')
        .eq('geohash', geohash)
        .maybeSingle();
      if (error) throw new Error(`getRegion failed: ${error.message}`);
      return data as RegionRow | null;
    },

    async listDirtyRegions(maxRegions) {
      const { data, error } = await db.rpc('dirty_regions', { max_regions: maxRegions });
      if (error) throw new Error(`listDirtyRegions failed: ${error.message}`);
      return ((data ?? []) as Array<{ geohash: string; checked_at: string }>).map((row) => ({
        geohash: row.geohash,
        checkedAt: row.checked_at,
      }));
    },

    async getWindowReports(geohash, windowStart, windowEnd) {
      const rows: WindowReport[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await db
          .from('case_reports')
          .select('event_timestamp, disease_category, case_count, age_band')
          .eq('geohash', geohash)
          .gt('event_timestamp', windowStart.toISOString())
          .lte('event_timestamp', windowEnd.toISOString())
          .order('id')
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`getWindowReports failed: ${error.message}`);
        rows.push(...(data as WindowReport[]));
        if (data.length < PAGE_SIZE) return rows;
      }
    },

    async markAggregated(geohash, checkedAt, latestWindowEnd) {
      const update: { last_aggregated_at: string; latest_window_end?: string } = {
        last_aggregated_at: checkedAt,
      };
      if (latestWindowEnd !== null) update.latest_window_end = latestWindowEnd;
      const { error } = await db.from('regions_index').update(update).eq('geohash', geohash);
      if (error) throw new Error(`markAggregated failed: ${error.message}`);
    },
  };
}
```

- [ ] **Step 7: Run the contract tests to verify they pass**

Run the same command as Step 5.
Expected: 8 tests PASS, with none skipped. If they were skipped, the env vars were not set.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: geohash tests pass, the contract tests are **skipped** (no env vars), and tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json supabase/config.toml supabase/.gitignore supabase/migrations/20260923000000_core_schema.sql src/shared/repository.ts test/shared/repository.contract.test.ts
git commit -m "Add Supabase schema, dirty-region RPC, and repository"
```

---

### Task 3: Ingest endpoint

**Files:**
- Create: `src/shared/vectors.ts`, `src/api/env.ts`, `src/api/validation.ts`, `src/api/ingest.ts`, `src/api/app.ts`
- Create: `test/fakes.ts`
- Test: `test/api/validation.test.ts`, `test/api/ingest.test.ts`

**Interfaces:**
- Consumes: `encodeGeohash` (Task 1); `Repository`, `NewCaseReport`, `RegionRow`, `DirtyRegion`, `WindowReport` (Task 2)
- Produces:
  - `src/shared/vectors.ts`: `type VectorStore = Pick<Vectorize, 'upsert' | 'query' | 'getByIds'>`, `type PatternMetadata = { geohash: string; window_end: string; total_cases: number; top_category: string }`, `vectorId(geohash: string, windowEnd: string): string` (returns `` `${geohash}:${windowEnd}` ``), `toIsoDate(date: Date): string` (UTC `YYYY-MM-DD`)
  - `src/api/env.ts`: `ApiEnv { API_TOKEN; SUPABASE_URL; SUPABASE_SECRET_KEY; PATTERNS: Vectorize }`, `ApiDeps { repo: Repository; vectors: VectorStore }`, `AppEnv = { Bindings: ApiEnv; Variables: { deps: ApiDeps } }`
  - `src/api/validation.ts`: `validateCaseReport(body: unknown): { ok: true; value: CaseReportInput } | { ok: false; errors: FieldError[] }`, `FieldError { field: string; message: string }`
  - `src/api/app.ts`: `createApp(makeDeps: (env: ApiEnv) => ApiDeps): Hono<AppEnv>`, `MAX_INGEST_BYTES = 65536`
  - `test/fakes.ts`: `FakeRepository` (public fields `inserted`, `regions`, `dirty`, `windowReports`, `windowRequests`, `marked`, `lastMaxRegions`, `failures`) and `FakeVectorStore` (public fields `stored`, `lastQueryOptions`, `failUpsertFor`)

- [ ] **Step 1: Create shared vector types and API env types**

`src/shared/vectors.ts`:

```ts
export type VectorStore = Pick<Vectorize, 'upsert' | 'query' | 'getByIds'>;

// A type alias (not an interface) so it is assignable to Vectorize's Record-typed metadata.
export type PatternMetadata = {
  geohash: string;
  window_end: string;
  total_cases: number;
  top_category: string;
};

export function vectorId(geohash: string, windowEnd: string): string {
  return `${geohash}:${windowEnd}`;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
```

`src/api/env.ts`:

```ts
import type { Repository } from '../shared/repository';
import type { VectorStore } from '../shared/vectors';

export interface ApiEnv {
  API_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  PATTERNS: Vectorize;
}

export interface ApiDeps {
  repo: Repository;
  vectors: VectorStore;
}

export type AppEnv = { Bindings: ApiEnv; Variables: { deps: ApiDeps } };
```

- [ ] **Step 2: Create the test fakes**

`test/fakes.ts`:

```ts
import type {
  DirtyRegion,
  NewCaseReport,
  RegionRow,
  Repository,
  WindowReport,
} from '../src/shared/repository';
import type { VectorStore } from '../src/shared/vectors';

export class FakeRepository implements Repository {
  inserted: NewCaseReport[] = [];
  regions = new Map<string, RegionRow>();
  dirty: DirtyRegion[] = [];
  windowReports = new Map<string, WindowReport[]>();
  windowRequests: Array<{ geohash: string; start: Date; end: Date }> = [];
  marked: Array<{ geohash: string; checkedAt: string; latestWindowEnd: string | null }> = [];
  lastMaxRegions: number | undefined;
  // Keys such as 'insertCaseReport' or 'getWindowReports:ezs42' make that call throw.
  failures = new Set<string>();

  private failIfRequested(key: string): void {
    if (this.failures.has(key)) throw new Error(`fake failure: ${key}`);
  }

  async insertCaseReport(report: NewCaseReport): Promise<{ id: string }> {
    this.failIfRequested('insertCaseReport');
    this.inserted.push(report);
    return { id: `report-${this.inserted.length}` };
  }

  async getRegion(geohash: string): Promise<RegionRow | null> {
    this.failIfRequested('getRegion');
    return this.regions.get(geohash) ?? null;
  }

  async listDirtyRegions(maxRegions: number): Promise<DirtyRegion[]> {
    this.failIfRequested('listDirtyRegions');
    this.lastMaxRegions = maxRegions;
    return this.dirty.slice(0, maxRegions);
  }

  async getWindowReports(geohash: string, start: Date, end: Date): Promise<WindowReport[]> {
    this.failIfRequested(`getWindowReports:${geohash}`);
    this.windowRequests.push({ geohash, start, end });
    return this.windowReports.get(geohash) ?? [];
  }

  async markAggregated(geohash: string, checkedAt: string, latestWindowEnd: string | null): Promise<void> {
    this.failIfRequested(`markAggregated:${geohash}`);
    this.marked.push({ geohash, checkedAt, latestWindowEnd });
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export class FakeVectorStore implements VectorStore {
  stored = new Map<string, VectorizeVector>();
  lastQueryOptions: VectorizeQueryOptions | undefined;
  failUpsertFor = new Set<string>();

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    for (const vector of vectors) {
      if (this.failUpsertFor.has(vector.id)) throw new Error(`fake upsert failure: ${vector.id}`);
      this.stored.set(vector.id, vector);
    }
    return { mutationId: `mutation-${this.stored.size}` };
  }

  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    return ids.flatMap((id) => {
      const vector = this.stored.get(id);
      return vector ? [vector] : [];
    });
  }

  async query(vector: VectorFloatArray | number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches> {
    this.lastQueryOptions = options;
    const excluded = (options?.filter?.geohash as unknown as { $ne?: string } | undefined)?.$ne;
    const queryValues = Array.from(vector);
    const matches = [...this.stored.values()]
      .filter((v) => excluded === undefined || v.metadata?.geohash !== excluded)
      .map((v) => ({ id: v.id, score: cosine(queryValues, Array.from(v.values)), metadata: v.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.topK ?? 5);
    return { matches, count: matches.length };
  }
}
```

- [ ] **Step 3: Write the failing validation tests**

`test/api/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateCaseReport } from '../../src/api/validation';

const valid = {
  event_timestamp: '2026-09-20T08:00:00Z',
  lat: 42.605,
  lon: -5.603,
  disease_category: 'respiratory',
  case_count: 3,
  age_band: '25-34',
  symptom_codes: ['R05'],
};

describe('validateCaseReport', () => {
  it('accepts a valid report and normalizes the category', () => {
    expect(validateCaseReport({ ...valid, disease_category: '  Respiratory ' })).toEqual({
      ok: true,
      value: valid,
    });
  });

  it('accepts a report without optional fields', () => {
    const { age_band, symptom_codes, ...required } = valid;
    expect(validateCaseReport(required)).toEqual({ ok: true, value: required });
  });

  it('accepts timestamps with a numeric offset', () => {
    expect(validateCaseReport({ ...valid, event_timestamp: '2026-09-20T08:00:00+02:00' }).ok).toBe(true);
  });

  it.each([
    ['lat', { lat: 91 }],
    ['lon', { lon: -181 }],
    ['case_count', { case_count: 0 }],
    ['case_count', { case_count: 1.5 }],
    ['event_timestamp', { event_timestamp: '2026-09-20' }],
    ['event_timestamp', { event_timestamp: '2026-09-20T08:00:00' }],
    ['disease_category', { disease_category: '   ' }],
    ['symptom_codes', { symptom_codes: 'R05' }],
  ])('rejects an invalid %s', (field, override) => {
    const result = validateCaseReport({ ...valid, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.field)).toContain(field);
  });

  it('reports every missing required field', () => {
    const result = validateCaseReport({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field)).toEqual(
        expect.arrayContaining(['event_timestamp', 'lat', 'lon', 'disease_category', 'case_count']),
      );
    }
  });

  it.each([null, [], 'text', 42])('rejects a non-object body %j', (body) => {
    expect(validateCaseReport(body).ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/api/validation.test.ts`
Expected: FAIL. The error is that `../../src/api/validation` can't be resolved.

- [ ] **Step 5: Implement validation**

`src/api/validation.ts`:

```ts
import { z } from 'zod';

export const caseReportSchema = z.object({
  event_timestamp: z.iso.datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  disease_category: z.string().trim().toLowerCase().min(1).max(100),
  case_count: z.number().int().positive(),
  age_band: z.string().trim().min(1).max(20).optional(),
  symptom_codes: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
});

export type CaseReportInput = z.infer<typeof caseReportSchema>;

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult = { ok: true; value: CaseReportInput } | { ok: false; errors: FieldError[] };

export function validateCaseReport(body: unknown): ValidationResult {
  const result = caseReportSchema.safeParse(body);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.') || '(body)',
      message: issue.message,
    })),
  };
}
```

- [ ] **Step 6: Run validation tests to verify they pass**

Run: `npx vitest run test/api/validation.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing ingest endpoint tests**

`test/api/ingest.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app';
import type { ApiEnv } from '../../src/api/env';
import { FakeRepository, FakeVectorStore } from '../fakes';

const TOKEN = 'test-token';
const env = { API_TOKEN: TOKEN } as ApiEnv;

const valid = {
  event_timestamp: '2026-09-20T08:00:00Z',
  lat: 42.605,
  lon: -5.603,
  disease_category: 'respiratory',
  case_count: 3,
  age_band: '25-34',
  symptom_codes: ['R05'],
};

function setup(testEnv: ApiEnv = env) {
  const repo = new FakeRepository();
  const vectors = new FakeVectorStore();
  const app = createApp(() => ({ repo, vectors }));
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    app.request(
      '/ingest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      testEnv,
    );
  return { repo, post };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /ingest', () => {
  it('stores a valid report with its geohash and the raw payload', async () => {
    const { repo, post } = setup();
    const body = { ...valid, disease_category: 'Respiratory', extra_field: 'kept in raw payload' };

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'report-1', geohash: 'ezs42' });
    expect(repo.inserted).toEqual([{ ...valid, geohash: 'ezs42', raw_payload: body }]);
  });

  it('rejects a request without a bearer token', async () => {
    const { repo, post } = setup();
    const res = await post(valid, {});
    expect(res.status).toBe(401);
    expect(repo.inserted).toHaveLength(0);
  });

  it('rejects a wrong bearer token', async () => {
    const { repo, post } = setup();
    const res = await post(valid, { authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
    expect(repo.inserted).toHaveLength(0);
  });

  it('fails closed when API_TOKEN is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, post } = setup({ ...env, API_TOKEN: '' });
    const res = await post(valid);
    expect(res.status).toBe(500);
    expect(repo.inserted).toHaveLength(0);
  });

  it('returns 400 for malformed JSON', async () => {
    const { post } = setup();
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid JSON body' });
  });

  it('returns 400 with field details for an invalid report', async () => {
    const { repo, post } = setup();
    const res = await post({ ...valid, lat: 200 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: Array<{ field: string }> };
    expect(body.error).toBe('validation failed');
    expect(body.details.map((d) => d.field)).toContain('lat');
    expect(repo.inserted).toHaveLength(0);
  });

  it('returns 413 for a body over 64 KB', async () => {
    const { repo, post } = setup();
    const res = await post({ ...valid, padding: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(repo.inserted).toHaveLength(0);
  });

  it('returns a generic 500 when storage fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repo, post } = setup();
    repo.failures.add('insertCaseReport');

    const res = await post(valid);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(errorLog).toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run to verify failure**

Run: `npx vitest run test/api/ingest.test.ts`
Expected: FAIL. The error is that `../../src/api/app` can't be resolved.

- [ ] **Step 9: Implement the handler and app**

`src/api/ingest.ts`:

```ts
import type { Context } from 'hono';
import { encodeGeohash } from '../shared/geohash';
import type { AppEnv } from './env';
import { validateCaseReport } from './validation';

export async function ingestHandler(c: Context<AppEnv>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const result = validateCaseReport(body);
  if (!result.ok) return c.json({ error: 'validation failed', details: result.errors }, 400);

  const report = result.value;
  const geohash = encodeGeohash(report.lat, report.lon);
  const { id } = await c.get('deps').repo.insertCaseReport({ ...report, geohash, raw_payload: body });
  return c.json({ id, geohash }, 201);
}
```

`src/api/app.ts`:

```ts
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ApiDeps, ApiEnv, AppEnv } from './env';
import { ingestHandler } from './ingest';

export const MAX_INGEST_BYTES = 64 * 1024;

export function createApp(makeDeps: (env: ApiEnv) => ApiDeps) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error('unhandled error', err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.use('*', async (c, next) => {
    if (!c.env.API_TOKEN) {
      console.error('API_TOKEN is not configured');
      return c.json({ error: 'internal error' }, 500);
    }
    return bearerAuth({ token: c.env.API_TOKEN })(c, next);
  });

  app.use('*', async (c, next) => {
    c.set('deps', makeDeps(c.env));
    await next();
  });

  app.post(
    '/ingest',
    bodyLimit({
      maxSize: MAX_INGEST_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    ingestHandler,
  );

  return app;
}
```

- [ ] **Step 10: Run tests and typecheck**

Run: `npx vitest run test/api && npm run typecheck`
Expected: all validation and ingest tests PASS, and tsc exits 0.

- [ ] **Step 11: Commit**

```bash
git add src/shared/vectors.ts src/api/env.ts src/api/validation.ts src/api/ingest.ts src/api/app.ts test/fakes.ts test/api/validation.test.ts test/api/ingest.test.ts
git commit -m "Add authenticated ingest endpoint with validation"
```

---

### Task 4: Similarity endpoint

**Files:**
- Create: `src/api/similar.ts`
- Modify: `src/api/app.ts` (register `GET /similar`)
- Test: `test/api/similar.test.ts`

**Interfaces:**
- Consumes: `encodeGeohash`, `isValidRegionGeohash` (Task 1); `Repository.getRegion` (Task 2); `vectorId`, `PatternMetadata`, `AppEnv`, `createApp`, `FakeRepository`, `FakeVectorStore` (Task 3)
- Produces: `GET /similar` returning `{ query: { geohash, window_end }, matches: Array<{ id, score, geohash, window_end, total_cases, top_category }> }`. Also exports `parseSimilarQuery(query: Record<string, string>)`, `DEFAULT_LIMIT = 10`, `MAX_LIMIT = 20`.

- [ ] **Step 1: Write the failing tests**

`test/api/similar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import type { ApiEnv } from '../../src/api/env';
import { FakeRepository, FakeVectorStore } from '../fakes';

const TOKEN = 'test-token';
const env = { API_TOKEN: TOKEN } as ApiEnv;

function pattern(geohash: string, windowEnd: string, values: number[], totalCases: number, topCategory: string) {
  return {
    id: `${geohash}:${windowEnd}`,
    values,
    metadata: { geohash, window_end: windowEnd, total_cases: totalCases, top_category: topCategory },
  };
}

async function setup() {
  const repo = new FakeRepository();
  const vectors = new FakeVectorStore();
  repo.regions.set('ezs42', {
    geohash: 'ezs42',
    last_aggregated_at: '2026-09-23T10:00:00+00:00',
    latest_window_end: '2026-09-23',
  });
  await vectors.upsert([
    pattern('ezs42', '2026-09-23', [1, 0, 0], 48, 'respiratory'),
    pattern('ezs42', '2026-09-20', [1, 0, 0], 40, 'respiratory'),
    pattern('u4pru', '2026-08-02', [0.9, 0.1, 0], 61, 'respiratory'),
    pattern('s0000', '2026-07-15', [0, 1, 0], 8, 'gastrointestinal'),
  ]);
  const app = createApp(() => ({ repo, vectors }));
  const get = (query: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
    app.request(`/similar?${query}`, { headers }, env);
  return { repo, vectors, get };
}

type SimilarBody = {
  query: { geohash: string; window_end: string };
  matches: Array<{
    id: string;
    score: number;
    geohash: string;
    window_end: string;
    total_cases: number;
    top_category: string;
  }>;
};

describe('GET /similar', () => {
  it('returns the nearest patterns from other regions, excluding the query region history', async () => {
    const { get } = await setup();

    const res = await get('geohash=ezs42');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SimilarBody;
    expect(body.query).toEqual({ geohash: 'ezs42', window_end: '2026-09-23' });
    expect(body.matches.map((m) => m.id)).toEqual(['u4pru:2026-08-02', 's0000:2026-07-15']);
    expect(body.matches[0]).toMatchObject({
      geohash: 'u4pru',
      window_end: '2026-08-02',
      total_cases: 61,
      top_category: 'respiratory',
    });
    expect(body.matches[0]!.score).toBeCloseTo(0.9939, 3);
  });

  it('queries Vectorize with the limit, full metadata, and the region exclusion filter', async () => {
    const { vectors, get } = await setup();
    await get('geohash=ezs42');
    expect(vectors.lastQueryOptions).toEqual({
      topK: 10,
      returnMetadata: 'all',
      filter: { geohash: { $ne: 'ezs42' } },
    });
  });

  it('respects limit', async () => {
    const { vectors, get } = await setup();
    const body = (await (await get('geohash=ezs42&limit=1')).json()) as SimilarBody;
    expect(body.matches.map((m) => m.id)).toEqual(['u4pru:2026-08-02']);
    expect(vectors.lastQueryOptions?.topK).toBe(1);
  });

  it('resolves lat/lon to the region geohash', async () => {
    const { get } = await setup();
    const res = await get('lat=42.605&lon=-5.603');
    expect(res.status).toBe(200);
    expect(((await res.json()) as SimilarBody).query.geohash).toBe('ezs42');
  });

  it('accepts an uppercase geohash', async () => {
    const { get } = await setup();
    expect((await get('geohash=EZS42')).status).toBe(200);
  });

  it.each([
    'geohash=abc',
    'geohash=ezsa2',
    'lat=91&lon=0',
    'lat=&lon=0',
    'lat=10',
    '',
    'geohash=ezs42&limit=0',
    'geohash=ezs42&limit=21',
    'geohash=ezs42&limit=2.5',
  ])('returns 400 for query %j', async (query) => {
    const { get } = await setup();
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
  });

  it('returns 404 for an unknown region', async () => {
    const { get } = await setup();
    expect((await get('geohash=u4pru')).status).toBe(404);
  });

  it('returns 404 for a region that has never been aggregated', async () => {
    const { repo, get } = await setup();
    repo.regions.set('dr5ru', { geohash: 'dr5ru', last_aggregated_at: null, latest_window_end: null });
    expect((await get('geohash=dr5ru')).status).toBe(404);
  });

  it('returns 404 when the region vector is not visible in Vectorize yet', async () => {
    const { repo, get } = await setup();
    repo.regions.set('dr5ru', {
      geohash: 'dr5ru',
      last_aggregated_at: '2026-09-23T10:00:00+00:00',
      latest_window_end: '2026-09-23',
    });
    expect((await get('geohash=dr5ru')).status).toBe(404);
  });

  it('requires a bearer token', async () => {
    const { get } = await setup();
    expect((await get('geohash=ezs42', {})).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/api/similar.test.ts`
Expected: FAIL, because `/similar` returns 404 for every request (route not registered), so the 200/400 assertions fail.

- [ ] **Step 3: Implement the handler**

`src/api/similar.ts`:

```ts
import type { Context } from 'hono';
import { encodeGeohash, isValidRegionGeohash } from '../shared/geohash';
import { vectorId, type PatternMetadata } from '../shared/vectors';
import type { AppEnv } from './env';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 20;

type SimilarQuery = { ok: true; geohash: string; limit: number } | { ok: false; error: string };

export function parseSimilarQuery(query: Record<string, string>): SimilarQuery {
  let geohash: string;
  if (query.geohash !== undefined) {
    geohash = query.geohash.toLowerCase();
    if (!isValidRegionGeohash(geohash)) {
      return { ok: false, error: 'geohash must be a 5-character geohash' };
    }
  } else if (query.lat !== undefined && query.lon !== undefined) {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    const blank = query.lat.trim() === '' || query.lon.trim() === '';
    if (blank || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, error: 'lat must be within -90..90 and lon within -180..180' };
    }
    geohash = encodeGeohash(lat, lon);
  } else {
    return { ok: false, error: 'provide geohash, or lat and lon' };
  }

  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return { ok: true, geohash, limit };
}

const NOT_AGGREGATED = { error: 'no aggregated pattern for this region yet' };

export async function similarHandler(c: Context<AppEnv>) {
  const parsed = parseSimilarQuery(c.req.query());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { geohash, limit } = parsed;
  const { repo, vectors } = c.get('deps');

  const region = await repo.getRegion(geohash);
  if (!region?.latest_window_end) return c.json(NOT_AGGREGATED, 404);

  const [queryVector] = await vectors.getByIds([vectorId(geohash, region.latest_window_end)]);
  if (!queryVector) return c.json(NOT_AGGREGATED, 404);

  const result = await vectors.query(queryVector.values, {
    topK: limit,
    returnMetadata: 'all',
    filter: { geohash: { $ne: geohash } },
  });

  return c.json({
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
  });
}
```

- [ ] **Step 4: Register the route**

In `src/api/app.ts`, add the import next to the ingest import:

```ts
import { similarHandler } from './similar';
```

and register the route directly after the `app.post('/ingest', ...)` call:

```ts
  app.get('/similar', similarHandler);
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/api && npm run typecheck`
Expected: all API tests PASS, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/api/similar.ts src/api/app.ts test/api/similar.test.ts
git commit -m "Add similarity endpoint over regional pattern vectors"
```

---

### Task 5: Window aggregation and pattern description

**Files:**
- Create: `src/cron/aggregate.ts`, `src/cron/describe.ts`
- Test: `test/cron/aggregate.test.ts`, `test/cron/describe.test.ts`

**Interfaces:**
- Consumes: `WindowReport` (Task 2)
- Produces:
  - `WINDOW_DAYS = 14`
  - `windowStartFor(windowEnd: Date): Date` (returns `windowEnd − 14 days`)
  - `aggregateWindow(reports: WindowReport[], windowEnd: Date): RegionAggregate` (throws on an empty array)
  - `RegionAggregate { totalCases: number; categories: CategoryCount[]; topCategory: string; mostCommonAgeBand: string | null; recentWeekCases: number; priorWeekCases: number }` and `CategoryCount { category: string; cases: number }`. Categories are ordered by cases desc, then name asc.
  - `MAX_DESCRIBED_CATEGORIES = 5`, `describePattern(aggregate: RegionAggregate): string`

- [ ] **Step 1: Write the failing aggregation tests**

`test/cron/aggregate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aggregateWindow, windowStartFor, WINDOW_DAYS } from '../../src/cron/aggregate';
import type { WindowReport } from '../../src/shared/repository';

const WINDOW_END = new Date('2026-09-23T12:00:00Z');

function report(
  event_timestamp: string,
  disease_category: string,
  case_count: number,
  age_band: string | null = null,
): WindowReport {
  return { event_timestamp, disease_category, case_count, age_band };
}

describe('windowStartFor', () => {
  it('is 14 days before the window end', () => {
    expect(WINDOW_DAYS).toBe(14);
    expect(windowStartFor(WINDOW_END)).toEqual(new Date('2026-09-09T12:00:00Z'));
  });
});

describe('aggregateWindow', () => {
  it('totals cases by category, age band, and week', () => {
    const result = aggregateWindow(
      [
        report('2026-09-22T08:00:00Z', 'respiratory', 24, '25-34'),
        report('2026-09-20T08:00:00Z', 'respiratory', 12, '35-44'),
        report('2026-09-12T08:00:00Z', 'gastrointestinal', 12, '25-34'),
      ],
      WINDOW_END,
    );

    expect(result).toEqual({
      totalCases: 48,
      categories: [
        { category: 'respiratory', cases: 36 },
        { category: 'gastrointestinal', cases: 12 },
      ],
      topCategory: 'respiratory',
      mostCommonAgeBand: '25-34',
      recentWeekCases: 36,
      priorWeekCases: 12,
    });
  });

  it('breaks category ties alphabetically', () => {
    const result = aggregateWindow(
      [report('2026-09-22T08:00:00Z', 'rash', 5), report('2026-09-22T08:00:00Z', 'fever', 5)],
      WINDOW_END,
    );
    expect(result.categories.map((c) => c.category)).toEqual(['fever', 'rash']);
    expect(result.topCategory).toBe('fever');
  });

  it('weights the most common age band by case count', () => {
    const result = aggregateWindow(
      [
        report('2026-09-22T08:00:00Z', 'respiratory', 1, '0-4'),
        report('2026-09-22T09:00:00Z', 'respiratory', 1, '0-4'),
        report('2026-09-22T10:00:00Z', 'respiratory', 5, '65+'),
      ],
      WINDOW_END,
    );
    expect(result.mostCommonAgeBand).toBe('65+');
  });

  it('reports no age band when none were given', () => {
    const result = aggregateWindow([report('2026-09-22T08:00:00Z', 'respiratory', 3)], WINDOW_END);
    expect(result.mostCommonAgeBand).toBeNull();
  });

  it('counts a report exactly 7 days before the end as the prior week', () => {
    const result = aggregateWindow(
      [
        report('2026-09-16T12:00:00Z', 'respiratory', 2),
        report('2026-09-16T12:00:00.001Z', 'respiratory', 3),
      ],
      WINDOW_END,
    );
    expect(result.priorWeekCases).toBe(2);
    expect(result.recentWeekCases).toBe(3);
  });

  it('throws on an empty window', () => {
    expect(() => aggregateWindow([], WINDOW_END)).toThrow();
  });
});
```

- [ ] **Step 2: Write the failing description tests**

`test/cron/describe.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RegionAggregate } from '../../src/cron/aggregate';
import { describePattern } from '../../src/cron/describe';

function aggregate(overrides: Partial<RegionAggregate> = {}): RegionAggregate {
  return {
    totalCases: 48,
    categories: [
      { category: 'respiratory', cases: 36 },
      { category: 'gastrointestinal', cases: 12 },
    ],
    topCategory: 'respiratory',
    mostCommonAgeBand: '25-34',
    recentWeekCases: 26,
    priorWeekCases: 22,
    ...overrides,
  };
}

describe('describePattern', () => {
  it('renders the full pattern sentence', () => {
    expect(describePattern(aggregate())).toBe(
      '14-day case pattern: 48 total cases. By category: respiratory 36, gastrointestinal 12. ' +
        'Most common age band: 25-34. Trend: +18% in the most recent 7 days versus the prior 7 days.',
    );
  });

  it('renders a falling trend', () => {
    expect(describePattern(aggregate({ recentWeekCases: 5, priorWeekCases: 10 }))).toContain(
      'Trend: -50% in the most recent 7 days',
    );
  });

  it('renders a flat trend', () => {
    expect(describePattern(aggregate({ recentWeekCases: 10, priorWeekCases: 10 }))).toContain('Trend: 0% in');
  });

  it('describes cases that only appeared in the most recent week', () => {
    expect(describePattern(aggregate({ recentWeekCases: 48, priorWeekCases: 0 }))).toContain(
      'Trend: new cases in the most recent 7 days with none in the prior 7 days.',
    );
  });

  it('notes a missing age band', () => {
    expect(describePattern(aggregate({ mostCommonAgeBand: null }))).toContain('Age band: not reported.');
  });

  it('summarizes categories beyond the top five', () => {
    const categories = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((category, i) => ({ category, cases: 10 - i }));
    expect(describePattern(aggregate({ categories }))).toContain(
      'By category: a 10, b 9, c 8, d 7, e 6, and 2 other categories with 9 cases.',
    );
  });

  it('uses the singular for one extra category', () => {
    const categories = ['a', 'b', 'c', 'd', 'e', 'f'].map((category) => ({ category, cases: 1 }));
    expect(describePattern(aggregate({ categories }))).toContain('and 1 other category with 1 cases.');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/cron`
Expected: FAIL. The error is that `../../src/cron/aggregate` and `../../src/cron/describe` can't be resolved.

- [ ] **Step 4: Implement aggregation**

`src/cron/aggregate.ts`:

```ts
import type { WindowReport } from '../shared/repository';

export const WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 7;

export interface CategoryCount {
  category: string;
  cases: number;
}

export interface RegionAggregate {
  totalCases: number;
  categories: CategoryCount[];
  topCategory: string;
  mostCommonAgeBand: string | null;
  recentWeekCases: number;
  priorWeekCases: number;
}

export function windowStartFor(windowEnd: Date): Date {
  return new Date(windowEnd.getTime() - WINDOW_DAYS * DAY_MS);
}

export function aggregateWindow(reports: WindowReport[], windowEnd: Date): RegionAggregate {
  if (reports.length === 0) throw new Error('aggregateWindow requires at least one report');

  const recentBoundary = windowEnd.getTime() - TREND_DAYS * DAY_MS;
  const casesByCategory = new Map<string, number>();
  const casesByAgeBand = new Map<string, number>();
  let totalCases = 0;
  let recentWeekCases = 0;
  let priorWeekCases = 0;

  for (const report of reports) {
    totalCases += report.case_count;
    addTo(casesByCategory, report.disease_category, report.case_count);
    if (report.age_band) addTo(casesByAgeBand, report.age_band, report.case_count);
    if (Date.parse(report.event_timestamp) > recentBoundary) {
      recentWeekCases += report.case_count;
    } else {
      priorWeekCases += report.case_count;
    }
  }

  const categories = rank(casesByCategory).map(([category, cases]) => ({ category, cases }));
  return {
    totalCases,
    categories,
    topCategory: categories[0]!.category,
    mostCommonAgeBand: rank(casesByAgeBand)[0]?.[0] ?? null,
    recentWeekCases,
    priorWeekCases,
  };
}

function addTo(counts: Map<string, number>, key: string, amount: number): void {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

function rank(counts: Map<string, number>): Array<[string, number]> {
  return [...counts].sort(([keyA, a], [keyB, b]) => b - a || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
}
```

- [ ] **Step 5: Implement the description**

`src/cron/describe.ts`:

```ts
import { WINDOW_DAYS, type RegionAggregate } from './aggregate';

export const MAX_DESCRIBED_CATEGORIES = 5;

export function describePattern(aggregate: RegionAggregate): string {
  const ageBand = aggregate.mostCommonAgeBand
    ? `Most common age band: ${aggregate.mostCommonAgeBand}.`
    : 'Age band: not reported.';
  return [
    `${WINDOW_DAYS}-day case pattern: ${aggregate.totalCases} total cases.`,
    `By category: ${describeCategories(aggregate)}.`,
    ageBand,
    describeTrend(aggregate),
  ].join(' ');
}

function describeCategories({ categories }: RegionAggregate): string {
  const shown = categories.slice(0, MAX_DESCRIBED_CATEGORIES).map((c) => `${c.category} ${c.cases}`);
  const hidden = categories.slice(MAX_DESCRIBED_CATEGORIES);
  if (hidden.length > 0) {
    const hiddenCases = hidden.reduce((sum, c) => sum + c.cases, 0);
    const noun = hidden.length === 1 ? 'category' : 'categories';
    shown.push(`and ${hidden.length} other ${noun} with ${hiddenCases} cases`);
  }
  return shown.join(', ');
}

function describeTrend({ recentWeekCases, priorWeekCases }: RegionAggregate): string {
  if (priorWeekCases === 0) {
    return 'Trend: new cases in the most recent 7 days with none in the prior 7 days.';
  }
  const percent = Math.round(((recentWeekCases - priorWeekCases) / priorWeekCases) * 100);
  const sign = percent > 0 ? '+' : '';
  return `Trend: ${sign}${percent}% in the most recent 7 days versus the prior 7 days.`;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/cron && npm run typecheck`
Expected: PASS, and tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/cron/aggregate.ts src/cron/describe.ts test/cron/aggregate.test.ts test/cron/describe.test.ts
git commit -m "Add 14-day window aggregation and pattern description"
```

---

### Task 6: Embedder and aggregation run

**Files:**
- Create: `src/shared/embedding.ts`, `src/cron/run.ts`
- Test: `test/shared/embedding.test.ts`, `test/cron/run.test.ts`

**Interfaces:**
- Consumes: `Repository`, `WindowReport` (Task 2); `VectorStore`, `PatternMetadata`, `vectorId`, `toIsoDate`, `FakeRepository`, `FakeVectorStore` (Task 3); `aggregateWindow`, `windowStartFor`, `describePattern` (Task 5)
- Produces:
  - `src/shared/embedding.ts`: `EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5'`, `EMBEDDING_DIMENSIONS = 768`, `type Embedder = (text: string) => Promise<number[]>`, `createWorkersAiEmbedder(ai: Ai): Embedder`
  - `src/cron/run.ts`: `MAX_REGIONS_PER_RUN = 20`, `AggregationDeps { repo: Repository; vectors: VectorStore; embed: Embedder }`, `RunResult { aggregated: string[]; empty: string[]; failed: string[] }`, `runAggregation(deps: AggregationDeps, now: Date): Promise<RunResult>`

- [ ] **Step 1: Write the failing embedder tests**

`test/shared/embedding.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createWorkersAiEmbedder, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../src/shared/embedding';

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);

function fakeAi(output: unknown) {
  const run = vi.fn(async () => output);
  return { run, ai: { run } as unknown as Ai };
}

describe('createWorkersAiEmbedder', () => {
  it('embeds text with the bge model and returns its vector', async () => {
    const { run, ai } = fakeAi({ shape: [1, EMBEDDING_DIMENSIONS], data: [vector] });
    await expect(createWorkersAiEmbedder(ai)('hello')).resolves.toEqual(vector);
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: ['hello'] });
  });

  it('throws when the model returns no vector', async () => {
    const { ai } = fakeAi({ shape: [0], data: [] });
    await expect(createWorkersAiEmbedder(ai)('hello')).rejects.toThrow(/unexpected embedding/);
  });

  it('throws when the vector has the wrong dimension', async () => {
    const { ai } = fakeAi({ shape: [1, 3], data: [[1, 2, 3]] });
    await expect(createWorkersAiEmbedder(ai)('hello')).rejects.toThrow(/unexpected embedding/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/shared/embedding.test.ts`
Expected: FAIL. The error is that `../../src/shared/embedding` can't be resolved.

- [ ] **Step 3: Implement the embedder**

`src/shared/embedding.ts`:

```ts
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMENSIONS = 768;

export type Embedder = (text: string) => Promise<number[]>;

export function createWorkersAiEmbedder(ai: Ai): Embedder {
  return async (text) => {
    const output = await ai.run(EMBEDDING_MODEL, { text: [text] });
    const vector = 'data' in output ? output.data?.[0] : undefined;
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`unexpected embedding from ${EMBEDDING_MODEL}: expected ${EMBEDDING_DIMENSIONS} dimensions`);
    }
    return vector;
  };
}
```

The `'data' in output` guard is there because newer `@cloudflare/workers-types` type the model output as a union that includes an async-queue response. If tsc still rejects `output.data`, check the installed type of `Ai_Cf_Baai_Bge_Base_En_V1_5_Output` and narrow on it. Do not cast to `any`.

- [ ] **Step 4: Run embedder tests to verify they pass**

Run: `npx vitest run test/shared/embedding.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing orchestrator tests**

`test/cron/run.test.ts`:

```ts
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
      { geohash: 'ezs42', start: new Date('2026-09-09T12:00:00Z'), end: NOW },
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
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run test/cron/run.test.ts`
Expected: FAIL. The error is that `../../src/cron/run` can't be resolved.

- [ ] **Step 7: Implement the orchestrator**

`src/cron/run.ts`:

```ts
import type { Embedder } from '../shared/embedding';
import type { Repository } from '../shared/repository';
import { toIsoDate, vectorId, type PatternMetadata, type VectorStore } from '../shared/vectors';
import { aggregateWindow, windowStartFor } from './aggregate';
import { describePattern } from './describe';

// Keeps Supabase fetches per run (1 + 2 per region) under the Workers free-plan subrequest limit.
export const MAX_REGIONS_PER_RUN = 20;

export interface AggregationDeps {
  repo: Repository;
  vectors: VectorStore;
  embed: Embedder;
}

export interface RunResult {
  aggregated: string[];
  empty: string[];
  failed: string[];
}

export async function runAggregation(deps: AggregationDeps, now: Date): Promise<RunResult> {
  const result: RunResult = { aggregated: [], empty: [], failed: [] };
  const windowStart = windowStartFor(now);
  const windowEnd = toIsoDate(now);
  const dirty = await deps.repo.listDirtyRegions(MAX_REGIONS_PER_RUN);

  for (const { geohash, checkedAt } of dirty) {
    try {
      const reports = await deps.repo.getWindowReports(geohash, windowStart, now);
      if (reports.length === 0) {
        await deps.repo.markAggregated(geohash, checkedAt, null);
        result.empty.push(geohash);
        continue;
      }

      const aggregate = aggregateWindow(reports, now);
      const values = await deps.embed(describePattern(aggregate));
      const metadata: PatternMetadata = {
        geohash,
        window_end: windowEnd,
        total_cases: aggregate.totalCases,
        top_category: aggregate.topCategory,
      };
      await deps.vectors.upsert([{ id: vectorId(geohash, windowEnd), values, metadata }]);
      await deps.repo.markAggregated(geohash, checkedAt, windowEnd);
      result.aggregated.push(geohash);
    } catch (err) {
      console.error(`aggregation failed for region ${geohash}; it will be retried next run`, err);
      result.failed.push(geohash);
    }
  }
  return result;
}
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: every test passes except the contract tests, which are skipped. tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/shared/embedding.ts src/cron/run.ts test/shared/embedding.test.ts test/cron/run.test.ts
git commit -m "Add Workers AI embedder and hourly aggregation run"
```

---

### Task 7: Worker entrypoints, Wrangler config, and deployment smoke test

**Files:**
- Create: `src/api/index.ts`, `src/cron/index.ts`, `wrangler.api.jsonc`, `wrangler.cron.jsonc`, `.dev.vars.example`
- Modify: `README.md` (append a Development section)

**Interfaces:**
- Consumes: `createApp` (Tasks 3–4); `createSupabaseRepository` (Task 2); `createWorkersAiEmbedder` (Task 6); `runAggregation` (Task 6)
- Produces: deployable Workers `episent-api` (fetch) and `episent-aggregator` (scheduled, `0 * * * *`), both bound to Vectorize index `episent-patterns` as `PATTERNS`; the aggregator also has Workers AI as `AI`.

- [ ] **Step 1: Write the entrypoints**

`src/api/index.ts`:

```ts
import { createSupabaseRepository } from '../shared/repository';
import { createApp } from './app';

export default createApp((env) => ({
  repo: createSupabaseRepository(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY),
  vectors: env.PATTERNS,
}));
```

`src/cron/index.ts`:

```ts
import { createWorkersAiEmbedder } from '../shared/embedding';
import { createSupabaseRepository } from '../shared/repository';
import { runAggregation } from './run';

export interface CronEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  PATTERNS: Vectorize;
  AI: Ai;
}

export default {
  async scheduled(controller, env) {
    const result = await runAggregation(
      {
        repo: createSupabaseRepository(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY),
        vectors: env.PATTERNS,
        embed: createWorkersAiEmbedder(env.AI),
      },
      new Date(controller.scheduledTime),
    );
    console.log(
      JSON.stringify({
        event: 'aggregation_run',
        aggregated: result.aggregated.length,
        empty: result.empty.length,
        failed: result.failed,
      }),
    );
  },
} satisfies ExportedHandler<CronEnv>;
```

- [ ] **Step 2: Write the Wrangler configs and local secrets template**

`wrangler.api.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "episent-api",
  "main": "src/api/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  // Secrets (wrangler secret put): API_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY
  "vectorize": [{ "binding": "PATTERNS", "index_name": "episent-patterns", "remote": true }]
}
```

`wrangler.cron.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "episent-aggregator",
  "main": "src/cron/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "triggers": { "crons": ["0 * * * *"] },
  // Secrets (wrangler secret put): SUPABASE_URL, SUPABASE_SECRET_KEY
  "ai": { "binding": "AI" },
  "vectorize": [{ "binding": "PATTERNS", "index_name": "episent-patterns", "remote": true }]
}
```

`.dev.vars.example`:

```
API_TOKEN=local-dev-token
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SECRET_KEY=paste-the-secret-key-from-supabase-status
```

- [ ] **Step 3: Verify typecheck and bundling**

Run:

```bash
npm run typecheck
npx wrangler deploy --dry-run -c wrangler.api.jsonc --outdir dist/api
npx wrangler deploy --dry-run -c wrangler.cron.jsonc --outdir dist/cron
```

Expected: tsc exits 0, and both dry runs end with `--dry-run: exiting now.` and no build errors. If Wrangler warns that `compatibility_date` is newer than its runtime supports, set both configs to the latest date it names and re-run.

- [ ] **Step 4: Document development in the README**

Append to `README.md`:

````markdown
## Development

Requires Node 20+, Docker (for local Supabase), and a Cloudflare account for Workers AI / Vectorize.

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

- `episent-api` (`wrangler.api.jsonc`): `POST /ingest`, `GET /similar`, bearer-token auth.
- `episent-aggregator` (`wrangler.cron.jsonc`): hourly 14-day regional aggregation → Workers AI embedding → Vectorize.

Copy `.dev.vars.example` to `.dev.vars` for `npm run dev:api` / `npm run dev:cron`.
````

- [ ] **Step 5: Commit**

```bash
git add src/api/index.ts src/cron/index.ts wrangler.api.jsonc wrangler.cron.jsonc .dev.vars.example README.md
git commit -m "Add Worker entrypoints, Wrangler configs, and dev docs"
```

- [ ] **Step 6: Deployment smoke test (needs the user's go-ahead)**

These steps create billable cloud resources and deploy public endpoints. **Ask the user before running any of them**, and have them run the `secret put` steps themselves so secret values never pass through the agent.

1. Create the Vectorize index and its metadata index. The metadata index must exist **before** any vectors are inserted:

```bash
npx wrangler vectorize create episent-patterns --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index episent-patterns --property-name=geohash --type=string
```

2. Apply the schema to the hosted Supabase project:

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push
```

3. The user sets the secrets. `API_TOKEN` can be generated with `openssl rand -hex 32`:

```bash
npx wrangler secret put API_TOKEN -c wrangler.api.jsonc
npx wrangler secret put SUPABASE_URL -c wrangler.api.jsonc
npx wrangler secret put SUPABASE_SECRET_KEY -c wrangler.api.jsonc
npx wrangler secret put SUPABASE_URL -c wrangler.cron.jsonc
npx wrangler secret put SUPABASE_SECRET_KEY -c wrangler.cron.jsonc
```

4. Deploy both Workers:

```bash
npm run deploy:api
npm run deploy:cron
```

5. Ingest three reports: two similar respiratory regions and one different gastrointestinal region. Adjust `event_timestamp` to a time within the last 7 days, and set `API` to the URL printed by `deploy:api`:

```bash
for body in \
  '{"event_timestamp":"2026-09-21T08:00:00Z","lat":42.605,"lon":-5.603,"disease_category":"respiratory","case_count":30,"age_band":"25-34"}' \
  '{"event_timestamp":"2026-09-21T08:00:00Z","lat":57.64911,"lon":10.40744,"disease_category":"respiratory","case_count":28,"age_band":"25-34"}' \
  '{"event_timestamp":"2026-09-21T08:00:00Z","lat":0,"lon":0,"disease_category":"gastrointestinal","case_count":5,"age_band":"65+"}'; do
  curl -s -X POST "$API/ingest" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$body"; echo
done
```

Expected: three `201` responses with geohashes `ezs42`, `u4pru`, `s0000`.

6. Trigger aggregation. Either wait for the next hourly run while watching `npx wrangler tail episent-aggregator`, or run it locally against the hosted resources. For the local option, put the hosted `SUPABASE_URL`/`SUPABASE_SECRET_KEY` in `.dev.vars` and run `npm run dev:cron`, then in another shell:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

Newer Wrangler versions also accept `/cdn-cgi/handler/scheduled`. Expected: the log line shows `"event":"aggregation_run","aggregated":3,"empty":0,"failed":[]`.

7. Wait about 30 seconds for Vectorize to become consistent, then query:

```bash
curl -s "$API/similar?geohash=ezs42" -H "authorization: Bearer $TOKEN"
```

Expected: `200` with `query.geohash = "ezs42"`. Matches should be `u4pru` first and then `s0000` with a lower score, and no `ezs42` entry.
