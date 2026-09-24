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
