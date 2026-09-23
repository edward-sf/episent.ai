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
