import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, DashboardApi } from '../../src/dashboard/web/api';
import { createStore, type DashboardState } from '../../src/dashboard/web/store';
import type { AnomaliesResponse, RegionAnomaly, SimilarResponse } from '../../src/shared/api-types';

function region(geohash: string, status: RegionAnomaly['status'] = 'normal'): RegionAnomaly {
  return { geohash, status, max_score: null, categories: [] };
}

function anomalies(...geohashes: string[]): ApiResult<AnomaliesResponse> {
  return { ok: true, data: { as_of: '2026-09-23T12:00:00.000Z', regions: geohashes.map((g) => region(g)) } };
}

function similar(geohash: string): ApiResult<SimilarResponse> {
  return { ok: true, data: { query: { geohash, window_end: '2026-09-23' }, matches: [] } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Anomalies responses are consumed in order. Similar responses come from `similarFor`.
function fakeApi(anomalyResults: ApiResult<AnomaliesResponse>[], similarFor = (g: string) => Promise.resolve(similar(g))) {
  const api = {
    anomalies: vi.fn<DashboardApi['anomalies']>(async () => {
      const next = anomalyResults.shift();
      if (!next) throw new Error('no more anomalies responses');
      return next;
    }),
    similar: vi.fn<DashboardApi['similar']>((g) => similarFor(g)),
  };
  return api;
}

describe('createStore', () => {
  it('starts empty', () => {
    const store = createStore(fakeApi([]));
    expect(store.getState()).toEqual({
      anomalies: [],
      asOf: null,
      selected: null,
      similar: new Map(),
      loading: false,
      error: null,
    });
  });

  it('refresh loads regions, selects the first, and loads its similar patterns', async () => {
    const api = fakeApi([anomalies('u4xsu', 'u6sce')]);
    const store = createStore(api);

    await store.refresh();

    const state = store.getState();
    expect(state.anomalies.map((r) => r.geohash)).toEqual(['u4xsu', 'u6sce']);
    expect(state.asOf).toBe('2026-09-23T12:00:00.000Z');
    expect(state.selected).toBe('u4xsu');
    expect(state.loading).toBe(false);
    expect(api.similar).toHaveBeenCalledWith('u4xsu');
    expect(state.similar.get('u4xsu')).toEqual({ status: 'loaded', data: (similar('u4xsu') as { data: SimilarResponse }).data });
  });

  it('sets loading while fetching anomalies', async () => {
    const pending = deferred<ApiResult<AnomaliesResponse>>();
    const api = fakeApi([]);
    api.anomalies.mockReturnValueOnce(pending.promise);
    const store = createStore(api);

    const refreshing = store.refresh();
    expect(store.getState().loading).toBe(true);

    pending.resolve(anomalies());
    await refreshing;
    expect(store.getState().loading).toBe(false);
  });

  it('ignores refresh while one is in flight', async () => {
    const pending = deferred<ApiResult<AnomaliesResponse>>();
    const api = fakeApi([]);
    api.anomalies.mockReturnValueOnce(pending.promise);
    const store = createStore(api);

    const first = store.refresh();
    await store.refresh();
    pending.resolve(anomalies());
    await first;

    expect(api.anomalies).toHaveBeenCalledTimes(1);
  });

  it('selects nothing when there are no regions', async () => {
    const api = fakeApi([anomalies()]);
    const store = createStore(api);

    await store.refresh();

    expect(store.getState().selected).toBeNull();
    expect(api.similar).not.toHaveBeenCalled();
  });

  it('records an error when the response body is malformed', async () => {
    const api = fakeApi([{ ok: true, data: {} as AnomaliesResponse }]);
    const store = createStore(api);

    await store.refresh();

    expect(store.getState()).toMatchObject({ loading: false, error: 'invalid response', anomalies: [] });
    expect(api.similar).not.toHaveBeenCalled();
  });

  it('records an error on a failed first load and leaves the list empty', async () => {
    const store = createStore(fakeApi([{ ok: false, status: 500, error: 'internal error' }]));

    await store.refresh();

    expect(store.getState()).toMatchObject({ anomalies: [], loading: false, error: 'internal error' });
  });

  it('keeps previous regions when a later refresh fails, and clears the error on the next success', async () => {
    const store = createStore(
      fakeApi([anomalies('u4xsu'), { ok: false, status: 0, error: 'network error' }, anomalies('u4xsu')]),
    );

    await store.refresh();
    await store.refresh();
    expect(store.getState()).toMatchObject({ error: 'network error', selected: 'u4xsu' });
    expect(store.getState().anomalies).toHaveLength(1);

    await store.refresh();
    expect(store.getState().error).toBeNull();
  });

  it('keeps the selection across a refresh when the region is still present', async () => {
    const store = createStore(fakeApi([anomalies('u4xsu', 'u6sce'), anomalies('u6sce', 'u4xsu')]));
    await store.refresh();
    await store.select('u6sce');

    await store.refresh();

    expect(store.getState().selected).toBe('u6sce');
  });

  it('falls back to the new first region when the selection disappears', async () => {
    const store = createStore(fakeApi([anomalies('u4xsu', 'u6sce'), anomalies('u3qcn', 'u4xsu')]));
    await store.refresh();
    await store.select('u6sce');

    await store.refresh();

    expect(store.getState().selected).toBe('u3qcn');
  });

  it('clears the similar cache on refresh', async () => {
    const api = fakeApi([anomalies('u4xsu', 'u6sce'), anomalies('u4xsu', 'u6sce')]);
    const store = createStore(api);
    await store.refresh();
    await store.select('u6sce');

    await store.refresh(); // reloads u6sce (still selected)
    await store.select('u4xsu'); // cache was cleared, so u4xsu is fetched again

    expect(api.similar.mock.calls.map(([g]) => g)).toEqual(['u4xsu', 'u6sce', 'u6sce', 'u4xsu']);
  });

  it('select uses the cache and ignores unknown regions', async () => {
    const api = fakeApi([anomalies('u4xsu', 'u6sce')]);
    const store = createStore(api);
    await store.refresh();

    await store.select('u6sce');
    await store.select('u4xsu');
    await store.select('u6sce');
    await store.select('zzzzz');

    expect(store.getState().selected).toBe('u6sce');
    expect(api.similar.mock.calls.map(([g]) => g)).toEqual(['u4xsu', 'u6sce']);
  });

  it('maps a 404 from /similar to not_found', async () => {
    const store = createStore(
      fakeApi([anomalies('u4xsu')], async () => ({ ok: false, status: 404, error: 'no aggregated pattern for this region yet' })),
    );

    await store.refresh();

    expect(store.getState().similar.get('u4xsu')).toEqual({ status: 'not_found' });
  });

  it('maps other /similar failures to error, and retrySimilar reloads', async () => {
    const results: ApiResult<SimilarResponse>[] = [{ ok: false, status: 500, error: 'internal error' }, similar('u4xsu')];
    const api = fakeApi([anomalies('u4xsu')], async () => results.shift()!);
    const store = createStore(api);

    await store.refresh();
    expect(store.getState().similar.get('u4xsu')).toEqual({ status: 'error', message: 'internal error' });

    await store.retrySimilar();
    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');
  });

  it('retries a cached error when the region is selected again', async () => {
    const results: ApiResult<SimilarResponse>[] = [
      { ok: false, status: 500, error: 'internal error' },
      similar('u6sce'),
      similar('u4xsu'),
    ];
    const api = fakeApi([anomalies('u4xsu', 'u6sce')], async () => results.shift()!);
    const store = createStore(api);
    await store.refresh(); // u4xsu → error

    await store.select('u6sce');
    await store.select('u4xsu');

    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');
  });

  it('discards similar results that arrive after a refresh cleared the cache', async () => {
    const slow = deferred<ApiResult<SimilarResponse>>();
    let calls = 0;
    const api = fakeApi([anomalies('u4xsu'), anomalies('u4xsu')], (g) => {
      calls += 1;
      return calls === 1 ? slow.promise : Promise.resolve(similar(g));
    });
    const store = createStore(api);

    const first = store.refresh(); // starts the slow similar load
    await vi.waitFor(() => expect(api.similar).toHaveBeenCalledTimes(1));
    await store.refresh(); // clears the cache and reloads (fast)
    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');

    slow.resolve({ ok: false, status: 500, error: 'stale' });
    await first;
    expect(store.getState().similar.get('u4xsu')?.status).toBe('loaded');
  });

  it('notifies subscribers immediately and on change until unsubscribed', async () => {
    const store = createStore(fakeApi([anomalies('u4xsu'), anomalies('u4xsu')]));
    const seen: DashboardState[] = [];

    const unsubscribe = store.subscribe((s) => seen.push(s));
    expect(seen).toHaveLength(1);

    await store.refresh();
    const count = seen.length;
    expect(count).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(store.getState());

    unsubscribe();
    await store.refresh();
    expect(seen).toHaveLength(count);
  });
});
