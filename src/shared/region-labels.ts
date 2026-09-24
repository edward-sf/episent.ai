// Display names for the demo cities. The dashboard shows these instead of raw
// geohashes, and the Phase 4 story generator seeds reports at these coordinates.
// Each geohash must equal encodeGeohash(lat, lon) (enforced by a test).

export interface RegionLabel {
  geohash: string;
  name: string;
  lat: number;
  lon: number;
}

export const REGION_LABELS: readonly RegionLabel[] = [
  { geohash: 'u173z', name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
  { geohash: 'u33dc', name: 'Berlin', lat: 52.52, lon: 13.405 },
  { geohash: 'u3but', name: 'Copenhagen', lat: 55.6761, lon: 12.5683 },
  { geohash: 'u1x0e', name: 'Hamburg', lat: 53.5511, lon: 9.9937 },
  { geohash: 'gcpvj', name: 'London', lat: 51.5072, lon: -0.1276 },
  { geohash: 'u4xsu', name: 'Oslo', lat: 59.9139, lon: 10.7522 },
  { geohash: 'u09tv', name: 'Paris', lat: 48.8566, lon: 2.3522 },
  { geohash: 'u2fkb', name: 'Prague', lat: 50.0755, lon: 14.4378 },
  { geohash: 'u6sce', name: 'Stockholm', lat: 59.3293, lon: 18.0686 },
  { geohash: 'u3qcn', name: 'Warsaw', lat: 52.2297, lon: 21.0122 },
];

const BY_GEOHASH = new Map(REGION_LABELS.map((label) => [label.geohash, label]));

export function findRegionLabel(geohash: string): RegionLabel | undefined {
  return BY_GEOHASH.get(geohash);
}
