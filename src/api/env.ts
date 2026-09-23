import type { Repository } from '../shared/repository';
import type { VectorStore } from '../shared/vectors';

export interface ApiEnv {
  API_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  PATTERNS: Vectorize;
}

export interface ApiDeps {
  repo: Repository;
  vectors: VectorStore;
}

export type AppEnv = { Bindings: ApiEnv; Variables: { deps: ApiDeps } };
