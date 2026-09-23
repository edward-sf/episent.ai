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
