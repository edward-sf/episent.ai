import { describe, expect, it } from 'vitest';
import { encodeGeohash } from '../../src/shared/geohash';
import { findRegionLabel, REGION_LABELS } from '../../src/shared/region-labels';

describe('REGION_LABELS', () => {
  it.each(REGION_LABELS.map((label) => [label.name, label]))('%s has the geohash of its coordinates', (_name, label) => {
    expect(label.geohash).toBe(encodeGeohash(label.lat, label.lon));
  });

  it('has unique geohashes and names', () => {
    expect(new Set(REGION_LABELS.map((l) => l.geohash)).size).toBe(REGION_LABELS.length);
    expect(new Set(REGION_LABELS.map((l) => l.name)).size).toBe(REGION_LABELS.length);
  });
});

describe('findRegionLabel', () => {
  it('finds a label by geohash', () => {
    expect(findRegionLabel('u4xsu')?.name).toBe('Oslo');
  });

  it('returns undefined for an unlabelled geohash', () => {
    expect(findRegionLabel('ezs42')).toBeUndefined();
  });
});
