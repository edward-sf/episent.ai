import { WINDOW_DAYS, type RegionAggregate } from './aggregate';

export const MAX_DESCRIBED_CATEGORIES = 5;

export function describePattern(aggregate: RegionAggregate): string {
  const ageBand = aggregate.mostCommonAgeBand
    ? `Most common age band: ${aggregate.mostCommonAgeBand}.`
    : 'Age band: not reported.';
  return [
    `${WINDOW_DAYS}-day case pattern: ${aggregate.totalCases} total cases.`,
    `By category: ${describeCategories(aggregate)}.`,
    ageBand,
    describeTrend(aggregate),
  ].join(' ');
}

function describeCategories({ categories }: RegionAggregate): string {
  const shown = categories.slice(0, MAX_DESCRIBED_CATEGORIES).map((c) => `${c.category} ${c.cases}`);
  const hidden = categories.slice(MAX_DESCRIBED_CATEGORIES);
  if (hidden.length > 0) {
    const hiddenCases = hidden.reduce((sum, c) => sum + c.cases, 0);
    const noun = hidden.length === 1 ? 'category' : 'categories';
    const caseNoun = hiddenCases === 1 ? 'case' : 'cases';
    shown.push(`and ${hidden.length} other ${noun} with ${hiddenCases} ${caseNoun}`);
  }
  return shown.join(', ');
}

function describeTrend({ recentWeekCases, priorWeekCases }: RegionAggregate): string {
  if (priorWeekCases === 0) {
    return 'Trend: new cases in the most recent 7 days with none in the prior 7 days.';
  }
  const percent = Math.round(((recentWeekCases - priorWeekCases) / priorWeekCases) * 100);
  const sign = percent > 0 ? '+' : '';
  return `Trend: ${sign}${percent}% in the most recent 7 days versus the prior 7 days.`;
}
