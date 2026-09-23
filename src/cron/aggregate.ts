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
