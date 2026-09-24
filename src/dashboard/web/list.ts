import { el, statusBadge } from './dom';
import type { DashboardState } from './store';
import { toRegionRows } from './view-model';

export function renderList(container: HTMLElement, state: DashboardState, onSelect: (geohash: string) => void): void {
  // Re-rendering replaces the buttons, so restore keyboard focus afterwards.
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && container.contains(active) ? active.dataset.geohash : undefined;

  const rows = toRegionRows(state.anomalies, state.selected);
  if (rows.length === 0) {
    const message = state.loading ? 'Loading regions…' : state.error ? '' : 'No regions reported yet.';
    container.replaceChildren(...(message ? [el('li', 'muted', message)] : []));
    return;
  }

  container.replaceChildren(
    ...rows.map((row) => {
      const button = el('button', 'region-row');
      button.type = 'button';
      button.dataset.geohash = row.geohash;
      button.setAttribute('aria-pressed', String(row.selected));
      button.append(el('span', 'region-name', row.name), statusBadge(row.statusLabel, row.color), el('span', 'region-score', row.scoreText));
      button.addEventListener('click', () => onSelect(row.geohash));
      const item = el('li');
      item.append(button);
      return item;
    }),
  );

  if (focused) container.querySelector<HTMLButtonElement>(`button[data-geohash="${focused}"]`)?.focus();
}
