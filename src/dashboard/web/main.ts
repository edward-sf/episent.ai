import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createApi } from './api';
import { renderDetail } from './detail';
import { renderList } from './list';
import { createMap } from './map';
import { createStore } from './store';
import { formatAsOf } from './view-model';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

const store = createStore(createApi());
const select = (geohash: string) => void store.select(geohash);

const map = createMap(byId('map'), byId('legend'), select);
const list = byId('region-list');
const detail = byId('detail');
const asOf = byId('as-of');
const refresh = byId<HTMLButtonElement>('refresh');
const banner = byId('banner');

refresh.addEventListener('click', () => void store.refresh());
byId('banner-retry').addEventListener('click', () => void store.refresh());

store.subscribe((state) => {
  map.render(state);
  renderList(list, state, select);
  renderDetail(detail, state, () => void store.retrySimilar());
  asOf.textContent = state.asOf ? `As of ${formatAsOf(state.asOf)}` : '';
  refresh.disabled = state.loading;
  refresh.textContent = state.loading ? 'Refreshing…' : 'Refresh';
  banner.hidden = state.error === null;
});

void store.refresh();
