import { describe, expect, it } from 'vitest';
import { parseRegionQuery } from '../../src/api/region-query';

describe('parseRegionQuery', () => {
  it('accepts and lowercases a geohash', () => {
    expect(parseRegionQuery({ geohash: 'EZS42' })).toEqual({ ok: true, geohash: 'ezs42' });
  });

  it('encodes lat/lon to the region geohash', () => {
    expect(parseRegionQuery({ lat: '42.605', lon: '-5.603' })).toEqual({ ok: true, geohash: 'ezs42' });
  });

  it('prefers geohash when both forms are given', () => {
    expect(parseRegionQuery({ geohash: 'u4pru', lat: '42.605', lon: '-5.603' })).toEqual({
      ok: true,
      geohash: 'u4pru',
    });
  });

  it.each([{ geohash: 'abc' }, { geohash: 'ezsa2' }])('rejects geohash %j', (query) => {
    expect(parseRegionQuery(query)).toEqual({ ok: false, error: 'geohash must be a 5-character geohash' });
  });

  it.each([
    { lat: '91', lon: '0' },
    { lat: '0', lon: '-181' },
    { lat: '', lon: '0' },
    { lat: 'x', lon: '0' },
  ])('rejects lat/lon %j', (query) => {
    expect(parseRegionQuery(query)).toEqual({
      ok: false,
      error: 'lat must be within -90..90 and lon within -180..180',
    });
  });

  it.each([{}, { lat: '10' }, { lon: '10' }])('requires a region for %j', (query) => {
    expect(parseRegionQuery(query as Record<string, string>)).toEqual({ ok: false, error: 'provide geohash, or lat and lon' });
  });
});
