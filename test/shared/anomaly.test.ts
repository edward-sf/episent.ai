import { describe, expect, it } from 'vitest';
import {
  buildRegionAnomalies,
  regionAnomaly,
  robustScore,
  scoreCategory,
  type CategoryAnomaly,
} from '../../src/shared/anomaly';
import type { AnomalyStatsRow } from '../../src/shared/repository';

function row(overrides: Partial<AnomalyStatsRow> = {}): AnomalyStatsRow {
  return {
    geohash: 'ezs42',
    disease_category: 'respiratory',
    current_cases: 4,
    baseline_median: 4,
    baseline_mad: 0,
    baseline_weeks: 12,
    as_of: '2026-09-23T12:00:00+00:00',
    ...overrides,
  };
}

describe('robustScore', () => {
  it('scales MAD to a standard deviation when it dominates', () => {
    expect(robustScore(10, 4, 2)).toBeCloseTo(6 / 2.9652, 6);
  });

  it('uses sqrt(median) as a floor when MAD is small', () => {
    expect(robustScore(20, 16, 0)).toBe(1);
  });

  it('uses 1 as a floor for sparse categories', () => {
    expect(robustScore(3, 0, 0)).toBe(3);
  });

  it('is negative when the current week is below the baseline', () => {
    expect(robustScore(0, 4, 0)).toBe(-2);
  });
});

describe('scoreCategory', () => {
  it('reports insufficient data with fewer than 4 baseline weeks', () => {
    expect(scoreCategory(row({ baseline_weeks: 3, current_cases: 50 }))).toEqual({
      category: 'respiratory',
      status: 'insufficient_data',
      score: null,
      current_cases: 50,
      baseline_median: 4,
      baseline_mad: 0,
      baseline_weeks: 3,
    });
  });

  it('scores once there are exactly 4 baseline weeks', () => {
    expect(scoreCategory(row({ baseline_weeks: 4 })).status).toBe('normal');
  });

  it.each([
    // median 4, MAD 0 → denominator 2, so score = (current − 4) / 2
    { current: 7, score: 1.5, status: 'normal' },
    { current: 8, score: 2, status: 'elevated' },
    { current: 9, score: 2.5, status: 'elevated' },
    { current: 10, score: 3, status: 'anomalous' },
    { current: 0, score: -2, status: 'normal' },
  ])('current $current → score $score, $status', ({ current, score, status }) => {
    const result = scoreCategory(row({ current_cases: current }));
    expect(result.score).toBe(score);
    expect(result.status).toBe(status);
  });

  it('caps a high score at elevated when the current week has fewer than 5 cases', () => {
    const result = scoreCategory(row({ current_cases: 4, baseline_median: 0 }));
    expect(result).toMatchObject({ score: 4, status: 'elevated' });
  });

  it('marks a high score with exactly 5 cases as anomalous', () => {
    expect(scoreCategory(row({ current_cases: 5, baseline_median: 0 })).status).toBe('anomalous');
  });

  it('rounds the score to 2 decimals', () => {
    expect(scoreCategory(row({ current_cases: 10, baseline_median: 4, baseline_mad: 2 })).score).toBe(2.02);
  });

  it('decides status from the rounded score so displayed score and status agree', () => {
    // raw = 9 / (1.4826 * 2.026) ≈ 2.9963, rounds to 3 → should be anomalous, not elevated
    const result = scoreCategory(row({ current_cases: 10, baseline_median: 1, baseline_mad: 2.026 }));
    expect(result.score).toBe(3);
    expect(result.status).toBe('anomalous');
  });
});

describe('regionAnomaly', () => {
  const category = (name: string, status: CategoryAnomaly['status'], score: number | null): CategoryAnomaly => ({
    category: name,
    status,
    score,
    current_cases: 0,
    baseline_median: 0,
    baseline_mad: 0,
    baseline_weeks: 12,
  });

  it('takes the worst category status and the highest score, sorting categories', () => {
    const region = regionAnomaly('ezs42', [
      category('b-normal', 'normal', 1.5),
      category('insufficient', 'insufficient_data', null),
      category('elevated', 'elevated', 2.4),
      category('a-normal', 'normal', 1.5),
      category('low-normal', 'normal', -1),
    ]);

    expect(region.status).toBe('elevated');
    expect(region.max_score).toBe(2.4);
    expect(region.categories.map((c) => c.category)).toEqual([
      'elevated',
      'a-normal',
      'b-normal',
      'low-normal',
      'insufficient',
    ]);
  });

  it('is insufficient_data with a null max_score when no category can be scored', () => {
    const region = regionAnomaly('ezs42', [category('respiratory', 'insufficient_data', null)]);
    expect(region).toMatchObject({ status: 'insufficient_data', max_score: null });
  });

  it('is insufficient_data with no categories', () => {
    expect(regionAnomaly('ezs42', [])).toEqual({
      geohash: 'ezs42',
      status: 'insufficient_data',
      max_score: null,
      categories: [],
    });
  });
});

describe('buildRegionAnomalies', () => {
  it('groups rows by region and sorts regions by severity, score, then geohash', () => {
    const regions = buildRegionAnomalies([
      row({ geohash: 'aaaaa', current_cases: 4 }), // normal, score 0
      row({ geohash: 'bbbbb', current_cases: 4 }), // normal, score 0
      row({ geohash: 'ccccc', current_cases: 20 }), // anomalous, score 8
      row({ geohash: 'ddddd', current_cases: 8 }), // elevated, score 2
      row({ geohash: 'ddddd', disease_category: 'gastrointestinal', current_cases: 5 }), // normal, score 0.5
      row({ geohash: 'eeeee', baseline_weeks: 0, baseline_median: null, baseline_mad: null }), // insufficient
      row({ geohash: 'fffff', current_cases: 7 }), // normal, score 1.5
    ]);

    expect(regions.map((r) => [r.geohash, r.status, r.max_score])).toEqual([
      ['ccccc', 'anomalous', 8],
      ['ddddd', 'elevated', 2],
      ['fffff', 'normal', 1.5],
      ['aaaaa', 'normal', 0],
      ['bbbbb', 'normal', 0],
      ['eeeee', 'insufficient_data', null],
    ]);
    expect(regions[1]!.categories.map((c) => c.category)).toEqual(['respiratory', 'gastrointestinal']);
  });

  it('returns an empty list for no rows', () => {
    expect(buildRegionAnomalies([])).toEqual([]);
  });
});
