import * as L from 'leaflet';
import { el, statusBadge } from './dom';
import type { DashboardState } from './store';
import { STATUS_COLORS, STATUS_LABELS, STATUS_ORDER, toMarkerSpecs } from './view-model';

// Keyless OSM tiles; the CSP img-src must allow https://tile.openstreetmap.org. Light use only
// (per the OSM tile usage policy).
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface DashboardMap {
  render(state: DashboardState): void;
}

export function createMap(container: HTMLElement, legend: HTMLElement, onSelect: (geohash: string) => void): DashboardMap {
  const map = L.map(container).setView([52, 10], 4);
  L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
  const markers = L.layerGroup().addTo(map);

  legend.replaceChildren(
    ...STATUS_ORDER.map((status) => {
      const item = el('li');
      item.append(statusBadge(STATUS_LABELS[status], STATUS_COLORS[status]));
      return item;
    }),
  );

  let fitted = false;
  let lastSelected: string | null = null;

  return {
    render(state) {
      const specs = toMarkerSpecs(state.anomalies, state.selected);
      markers.clearLayers();
      for (const spec of specs) {
        L.circleMarker([spec.lat, spec.lon], {
          radius: spec.selected ? 12 : 8,
          color: spec.selected ? '#1f2328' : '#ffffff',
          weight: spec.selected ? 3 : 1.5,
          fillColor: spec.color,
          fillOpacity: 0.9,
        })
          .bindTooltip(`${spec.name}: ${spec.statusLabel}`)
          .on('click', () => onSelect(spec.geohash))
          .addTo(markers);
      }

      if (!fitted && specs.length > 0) {
        map.fitBounds(L.latLngBounds(specs.map((s) => [s.lat, s.lon] as [number, number])), {
          padding: [40, 40],
          maxZoom: 7,
        });
        fitted = true;
      } else if (state.selected !== lastSelected) {
        const selected = specs.find((s) => s.selected);
        if (selected) map.panTo([selected.lat, selected.lon]);
      }
      lastSelected = state.selected;
    },
  };
}
