import { el, statusBadge } from './dom';
import type { DashboardState, SimilarState } from './store';
import { regionName, STATUS_COLORS, STATUS_LABELS, toCategoryRows, toSimilarRows, type CategoryRow } from './view-model';

const CATEGORY_HEADINGS = ['Category', 'Current cases', 'Baseline median', 'Score', 'Status'];

export function renderDetail(container: HTMLElement, state: DashboardState, onRetry: () => void): void {
  const region = state.anomalies.find((r) => r.geohash === state.selected);
  if (!region) {
    container.replaceChildren(el('p', 'muted', 'Select a region to see details.'));
    return;
  }

  const header = el('div', 'detail-header');
  header.append(el('h2', undefined, regionName(region.geohash)), statusBadge(STATUS_LABELS[region.status], STATUS_COLORS[region.status]));

  container.replaceChildren(
    header,
    categoriesTable(region.geohash, toCategoryRows(region)),
    el('h3', undefined, 'Similar past outbreaks'),
    similarSection(state.similar.get(region.geohash), onRetry),
  );
}

function categoriesTable(geohash: string, rows: CategoryRow[]): HTMLElement {
  if (rows.length === 0) return el('p', 'muted', 'No reports in the last 98 days.');

  const table = el('table', 'categories');
  table.append(el('caption', 'visually-hidden', `Categories for ${regionName(geohash)}`));
  const headRow = el('tr');
  headRow.append(...CATEGORY_HEADINGS.map((heading) => el('th', undefined, heading)));
  const head = el('thead');
  head.append(headRow);

  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const status = el('td');
    status.append(statusBadge(row.statusLabel, row.color));
    tr.append(
      el('td', undefined, row.category),
      el('td', 'num', row.currentCases),
      el('td', 'num', row.baselineMedian),
      el('td', 'num', row.scoreText),
      status,
    );
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

function similarSection(similar: SimilarState | undefined, onRetry: () => void): HTMLElement {
  if (!similar || similar.status === 'loading') return el('p', 'muted', 'Loading similar patterns…');
  if (similar.status === 'not_found') return el('p', 'muted', 'No pattern history yet for this region.');
  if (similar.status === 'error') {
    const message = el('p', 'inline-error', `Couldn't load similar patterns (${similar.message}). `);
    const retry = el('button', 'link-button', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    message.append(retry);
    return message;
  }

  const rows = toSimilarRows(similar.data);
  if (rows.length === 0) return el('p', 'muted', 'No similar patterns found.');

  const list = el('ol', 'similar-list');
  for (const row of rows) {
    const item = el('li', 'similar-item');
    const title = el('div', 'similar-title');
    title.append(el('strong', undefined, row.name), el('span', 'similarity', `${row.similarityText} similar`));
    item.append(
      title,
      el('div', 'similar-meta', `14 days ending ${row.windowEnd} · ${row.topCategory} · ${row.totalCases} cases`),
    );
    list.append(item);
  }
  return list;
}
