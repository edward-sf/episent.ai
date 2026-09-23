import type { Context } from 'hono';
import { encodeGeohash, isValidRegionGeohash } from '../shared/geohash';
import { vectorId, type PatternMetadata } from '../shared/vectors';
import type { AppEnv } from './env';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 20;

type SimilarQuery = { ok: true; geohash: string; limit: number } | { ok: false; error: string };

export function parseSimilarQuery(query: Record<string, string>): SimilarQuery {
  let geohash: string;
  if (query.geohash !== undefined) {
    geohash = query.geohash.toLowerCase();
    if (!isValidRegionGeohash(geohash)) {
      return { ok: false, error: 'geohash must be a 5-character geohash' };
    }
  } else if (query.lat !== undefined && query.lon !== undefined) {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    const blank = query.lat.trim() === '' || query.lon.trim() === '';
    if (blank || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, error: 'lat must be within -90..90 and lon within -180..180' };
    }
    geohash = encodeGeohash(lat, lon);
  } else {
    return { ok: false, error: 'provide geohash, or lat and lon' };
  }

  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return { ok: true, geohash, limit };
}

const NOT_AGGREGATED = { error: 'no aggregated pattern for this region yet' };

export async function similarHandler(c: Context<AppEnv>) {
  const parsed = parseSimilarQuery(c.req.query());
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { geohash, limit } = parsed;
  const { repo, vectors } = c.get('deps');

  const region = await repo.getRegion(geohash);
  if (!region?.latest_window_end) return c.json(NOT_AGGREGATED, 404);

  const [queryVector] = await vectors.getByIds([vectorId(geohash, region.latest_window_end)]);
  if (!queryVector) return c.json(NOT_AGGREGATED, 404);

  const result = await vectors.query(queryVector.values, {
    topK: limit,
    returnMetadata: 'all',
    filter: { geohash: { $ne: geohash } },
  });

  return c.json({
    query: { geohash, window_end: region.latest_window_end },
    matches: result.matches.map((match) => {
      const metadata = match.metadata as unknown as PatternMetadata | undefined;
      return {
        id: match.id,
        score: match.score,
        geohash: metadata?.geohash,
        window_end: metadata?.window_end,
        total_cases: metadata?.total_cases,
        top_category: metadata?.top_category,
      };
    }),
  });
}
