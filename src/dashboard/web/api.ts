import type { AnomaliesResponse, SimilarResponse } from '../../shared/api-types';

// Talks to the dashboard Worker's same-origin /api routes. The browser never
// sees the API token; the Worker adds it.

export const SIMILAR_LIMIT = 5;

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface DashboardApi {
  anomalies(): Promise<ApiResult<AnomaliesResponse>>;
  similar(geohash: string): Promise<ApiResult<SimilarResponse>>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createApi(fetchFn: FetchFn = (input, init) => fetch(input, init)): DashboardApi {
  async function getJson<T>(path: string): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await fetchFn(path, { headers: { accept: 'application/json' } });
    } catch {
      return { ok: false, status: 0, error: 'network error' };
    }

    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      return body === null ? { ok: false, status: response.status, error: 'invalid response' } : { ok: true, data: body as T };
    }
    return { ok: false, status: response.status, error: errorMessage(body) ?? `HTTP ${response.status}` };
  }

  return {
    anomalies: () => getJson<AnomaliesResponse>('/api/anomalies'),
    similar: (geohash) =>
      getJson<SimilarResponse>(`/api/similar?${new URLSearchParams({ geohash, limit: String(SIMILAR_LIMIT) })}`),
  };
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return undefined;
}
