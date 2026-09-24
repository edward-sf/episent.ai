import type { Context } from 'hono';
import { buildRegionAnomalies, regionAnomaly } from '../shared/anomaly';
import type { AnomaliesResponse } from '../shared/api-types';
import type { AnomalyStatsRow } from '../shared/repository';
import type { AppEnv } from './env';
import { parseRegionQuery } from './region-query';

export async function anomaliesHandler(c: Context<AppEnv>) {
  const query = c.req.query();
  const { repo } = c.get('deps');

  if (query.geohash === undefined && query.lat === undefined && query.lon === undefined) {
    const rows = await repo.getAnomalyStats(null);
    return c.json({ as_of: asOf(rows), regions: buildRegionAnomalies(rows) } satisfies AnomaliesResponse);
  }

  const parsed = parseRegionQuery(query);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  if (!(await repo.getRegion(parsed.geohash))) return c.json({ error: 'unknown region' }, 404);

  const rows = await repo.getAnomalyStats(parsed.geohash);
  const [region] = buildRegionAnomalies(rows);
  return c.json({
    as_of: asOf(rows),
    regions: [region ?? regionAnomaly(parsed.geohash, [])],
  } satisfies AnomaliesResponse);
}

// The database clock when there are rows; otherwise the Worker clock.
function asOf(rows: AnomalyStatsRow[]): string {
  return new Date(rows[0]?.as_of ?? Date.now()).toISOString();
}
