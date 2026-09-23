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
    expect(describePattern(aggregate({ categories }))).toContain('and 1 other category with 1 case.');
  });
});
