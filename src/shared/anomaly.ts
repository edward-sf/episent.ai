import type { AnomalyStatus, CategoryAnomaly, RegionAnomaly } from './api-types';
import type { AnomalyStatsRow } from './repository';

export type { AnomalyStatus, CategoryAnomaly, RegionAnomaly } from './api-types';

export const BASELINE_MIN_WEEKS = 4;
export const ELEVATED_SCORE = 2;
export const ANOMALOUS_SCORE = 3;
export const ANOMALOUS_MIN_CASES = 5;
// Scales MAD to a standard-deviation estimate for normally distributed counts.
const MAD_TO_SD = 1.4826;

const SEVERITY: Record<AnomalyStatus, number> = {
  anomalous: 3,
  elevated: 2,
  normal: 1,
  insufficient_data: 0,
};

// Robust z-score. sqrt(median) is a Poisson-like noise floor; 1 keeps sparse categories
// (median 0, MAD 0) from producing huge scores.
export function robustScore(current: number, median: number, mad: number): number {
  return (current - median) / Math.max(MAD_TO_SD * mad, Math.sqrt(median), 1);
}

export function scoreCategory(row: AnomalyStatsRow): CategoryAnomaly {
  const stats = {
    category: row.disease_category,
    current_cases: row.current_cases,
    baseline_median: row.baseline_median,
    baseline_mad: row.baseline_mad,
    baseline_weeks: row.baseline_weeks,
  };
  if (row.baseline_weeks < BASELINE_MIN_WEEKS) {
    return { ...stats, status: 'insufficient_data', score: null };
  }
  const rawScore = robustScore(row.current_cases, row.baseline_median ?? 0, row.baseline_mad ?? 0);
  const score = Math.round(rawScore * 100) / 100;
  return { ...stats, status: statusFor(score, row.current_cases), score };
}

function statusFor(score: number, currentCases: number): AnomalyStatus {
  if (score >= ANOMALOUS_SCORE && currentCases >= ANOMALOUS_MIN_CASES) return 'anomalous';
  if (score >= ELEVATED_SCORE) return 'elevated';
  return 'normal';
}

export function regionAnomaly(geohash: string, categories: CategoryAnomaly[]): RegionAnomaly {
  const sorted = [...categories].sort((a, b) =>
    compareRanked(a.status, a.score, a.category, b.status, b.score, b.category),
  );
  const scores = sorted.flatMap((c) => (c.score === null ? [] : [c.score]));
  return {
    geohash,
    status: sorted[0]?.status ?? 'insufficient_data',
    max_score: scores.length > 0 ? Math.max(...scores) : null,
    categories: sorted,
  };
}

export function buildRegionAnomalies(rows: AnomalyStatsRow[]): RegionAnomaly[] {
  const byRegion = new Map<string, CategoryAnomaly[]>();
  for (const row of rows) {
    const categories = byRegion.get(row.geohash) ?? [];
    categories.push(scoreCategory(row));
    byRegion.set(row.geohash, categories);
  }
  return [...byRegion]
    .map(([geohash, categories]) => regionAnomaly(geohash, categories))
    .sort((a, b) => compareRanked(a.status, a.max_score, a.geohash, b.status, b.max_score, b.geohash));
}

// Severity descending, then score descending with nulls last, then name ascending.
function compareRanked(
  statusA: AnomalyStatus,
  scoreA: number | null,
  nameA: string,
  statusB: AnomalyStatus,
  scoreB: number | null,
  nameB: string,
): number {
  return (
    SEVERITY[statusB] - SEVERITY[statusA] ||
    compareScores(scoreA, scoreB) ||
    (nameA < nameB ? -1 : nameA > nameB ? 1 : 0)
  );
}

function compareScores(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}
