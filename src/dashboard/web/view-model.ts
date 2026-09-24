import type { AnomalyStatus, RegionAnomaly, SimilarResponse } from '../../shared/api-types';
import { decodeGeohash } from '../../shared/geohash';
import { findRegionLabel } from '../../shared/region-labels';

// Pure display logic. No DOM access here, so it is unit-tested under Node.

export const STATUS_COLORS: Record<AnomalyStatus, string> = {
  anomalous: '#d64545',
  elevated: '#e0a526',
  normal: '#3f9d5a',
  insufficient_data: '#9aa0a6',
};

export const STATUS_LABELS: Record<AnomalyStatus, string> = {
  anomalous: 'Anomalous',
  elevated: 'Elevated',
  normal: 'Normal',
  insufficient_data: 'Insufficient data',
};

export const STATUS_ORDER: readonly AnomalyStatus[] = ['anomalous', 'elevated', 'normal', 'insufficient_data'];

const MISSING = '—';

export function regionName(geohash: string): string {
  return findRegionLabel(geohash)?.name ?? geohash;
}

export function regionPosition(geohash: string): { lat: number; lon: number } {
  const label = findRegionLabel(geohash);
  return label ? { lat: label.lat, lon: label.lon } : decodeGeohash(geohash);
}

export function formatScore(score: number | null): string {
  return score === null ? MISSING : score.toFixed(2);
}

export function formatSimilarity(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function formatAsOf(iso: string): string {
  const text = new Date(iso).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}

export interface RegionRow {
  geohash: string;
  name: string;
  status: AnomalyStatus;
  statusLabel: string;
  color: string;
  scoreText: string;
  selected: boolean;
}

export function toRegionRows(regions: RegionAnomaly[], selected: string | null): RegionRow[] {
  return regions.map((region) => ({
    geohash: region.geohash,
    name: regionName(region.geohash),
    status: region.status,
    statusLabel: STATUS_LABELS[region.status],
    color: STATUS_COLORS[region.status],
    scoreText: formatScore(region.max_score),
    selected: region.geohash === selected,
  }));
}

export interface MarkerSpec {
  geohash: string;
  name: string;
  lat: number;
  lon: number;
  color: string;
  statusLabel: string;
  selected: boolean;
}

// The selected marker comes last so Leaflet draws it on top.
export function toMarkerSpecs(regions: RegionAnomaly[], selected: string | null): MarkerSpec[] {
  const specs = regions.map((region) => ({
    geohash: region.geohash,
    name: regionName(region.geohash),
    ...regionPosition(region.geohash),
    color: STATUS_COLORS[region.status],
    statusLabel: STATUS_LABELS[region.status],
    selected: region.geohash === selected,
  }));
  return [...specs.filter((s) => !s.selected), ...specs.filter((s) => s.selected)];
}

export interface CategoryRow {
  category: string;
  currentCases: string;
  baselineMedian: string;
  scoreText: string;
  statusLabel: string;
  color: string;
}

export function toCategoryRows(region: RegionAnomaly): CategoryRow[] {
  return region.categories.map((c) => ({
    category: c.category,
    currentCases: String(c.current_cases),
    baselineMedian: c.baseline_median === null ? MISSING : String(c.baseline_median),
    scoreText: formatScore(c.score),
    statusLabel: STATUS_LABELS[c.status],
    color: STATUS_COLORS[c.status],
  }));
}

export interface SimilarRow {
  id: string;
  name: string;
  windowEnd: string;
  similarityText: string;
  topCategory: string;
  totalCases: string;
}

export function toSimilarRows(response: SimilarResponse): SimilarRow[] {
  return response.matches.map((m) => ({
    id: m.id,
    name: m.geohash === undefined ? 'Unknown region' : regionName(m.geohash),
    windowEnd: m.window_end ?? MISSING,
    similarityText: formatSimilarity(m.score),
    topCategory: m.top_category ?? MISSING,
    totalCases: m.total_cases === undefined ? MISSING : String(m.total_cases),
  }));
}
