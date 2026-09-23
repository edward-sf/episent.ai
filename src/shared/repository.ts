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
