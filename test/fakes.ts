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
