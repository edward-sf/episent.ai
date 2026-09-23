import { describe, expect, it } from 'vitest';
import { encodeGeohash, isValidRegionGeohash, REGION_PRECISION } from '../../src/shared/geohash';

describe('encodeGeohash', () => {
  it('encodes the reference point from the geohash spec', () => {
    expect(encodeGeohash(42.605, -5.603)).toBe('ezs42');
  });

  it('supports longer precision', () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
  });

  it('defaults to region precision 5', () => {
    expect(REGION_PRECISION).toBe(5);
    expect(encodeGeohash(57.64911, 10.40744)).toBe('u4pru');
  });

  it('handles the origin and extreme corners', () => {
    expect(encodeGeohash(0, 0)).toBe('s0000');
    expect(encodeGeohash(-90, -180)).toBe('00000');
    expect(encodeGeohash(90, 180)).toBe('zzzzz');
  });
});

describe('isValidRegionGeohash', () => {
  it('accepts a 5-character geohash', () => {
    expect(isValidRegionGeohash('ezs42')).toBe(true);
  });

  it.each(['ezs4', 'ezs421', 'ezsa2', 'EZS42', ''])('rejects %j', (value) => {
    expect(isValidRegionGeohash(value)).toBe(false);
  });
});
