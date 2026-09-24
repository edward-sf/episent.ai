import { encodeGeohash, isValidRegionGeohash } from '../shared/geohash';

export type RegionQuery = { ok: true; geohash: string } | { ok: false; error: string };

export function parseRegionQuery(query: Record<string, string>): RegionQuery {
  if (query.geohash !== undefined) {
    const geohash = query.geohash.toLowerCase();
    if (!isValidRegionGeohash(geohash)) {
      return { ok: false, error: 'geohash must be a 5-character geohash' };
    }
    return { ok: true, geohash };
  }
  if (query.lat !== undefined && query.lon !== undefined) {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    const blank = query.lat.trim() === '' || query.lon.trim() === '';
    if (blank || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, error: 'lat must be within -90..90 and lon within -180..180' };
    }
    return { ok: true, geohash: encodeGeohash(lat, lon) };
  }
  return { ok: false, error: 'provide geohash, or lat and lon' };
}
