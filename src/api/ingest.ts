import type { Context } from 'hono';
import { encodeGeohash } from '../shared/geohash';
import type { AppEnv } from './env';
import { validateCaseReport } from './validation';

export async function ingestHandler(c: Context<AppEnv>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const result = validateCaseReport(body);
  if (!result.ok) return c.json({ error: 'validation failed', details: result.errors }, 400);

  const report = result.value;
  const geohash = encodeGeohash(report.lat, report.lon);
  const { id } = await c.get('deps').repo.insertCaseReport({ ...report, geohash, raw_payload: body });
  return c.json({ id, geohash }, 201);
}
