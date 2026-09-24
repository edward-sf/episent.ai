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
