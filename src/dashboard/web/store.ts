import type { RegionAnomaly, SimilarResponse } from '../../shared/api-types';
import type { DashboardApi } from './api';

export type SimilarState =
  | { status: 'loading' }
  | { status: 'loaded'; data: SimilarResponse }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export interface DashboardState {
  anomalies: RegionAnomaly[];
  asOf: string | null;
  selected: string | null; // geohash
  similar: ReadonlyMap<string, SimilarState>;
  loading: boolean;
  error: string | null;
}

export type Listener = (state: DashboardState) => void;

export interface Store {
  getState(): DashboardState;
  subscribe(listener: Listener): () => void;
  refresh(): Promise<void>;
  select(geohash: string): Promise<void>;
  retrySimilar(): Promise<void>;
}

export function createStore(api: DashboardApi): Store {
  let state: DashboardState = {
    anomalies: [],
    asOf: null,
    selected: null,
    similar: new Map(),
    loading: false,
    error: null,
  };
  // Bumped whenever the similar cache is cleared; older in-flight loads are discarded.
  let generation = 0;
  const listeners = new Set<Listener>();

  function setState(patch: Partial<DashboardState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function setSimilar(geohash: string, value: SimilarState): void {
    const similar = new Map(state.similar);
    similar.set(geohash, value);
    setState({ similar });
  }

  async function loadSimilar(geohash: string): Promise<void> {
    const started = generation;
    setSimilar(geohash, { status: 'loading' });
    const result = await api.similar(geohash);
    if (started !== generation) return;
    if (result.ok) setSimilar(geohash, { status: 'loaded', data: result.data });
    else if (result.status === 404) setSimilar(geohash, { status: 'not_found' });
    else setSimilar(geohash, { status: 'error', message: result.error });
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },

    async refresh() {
      if (state.loading) return;
      setState({ loading: true, error: null });

      const result = await api.anomalies();
      if (!result.ok) {
        setState({ loading: false, error: result.error });
        return;
      }

      const { regions, as_of } = result.data;
      const keep = state.selected !== null && regions.some((r) => r.geohash === state.selected);
      const selected = keep ? state.selected : (regions[0]?.geohash ?? null);
      generation += 1;
      setState({ anomalies: regions, asOf: as_of, selected, similar: new Map(), loading: false });
      if (selected !== null) await loadSimilar(selected);
    },

    async select(geohash) {
      if (!state.anomalies.some((r) => r.geohash === geohash)) return;
      if (state.selected !== geohash) setState({ selected: geohash });
      const cached = state.similar.get(geohash);
      if (cached && cached.status !== 'error') return;
      await loadSimilar(geohash);
    },

    async retrySimilar() {
      if (state.selected !== null) await loadSimilar(state.selected);
    },
  };
}
