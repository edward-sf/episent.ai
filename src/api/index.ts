import { createSupabaseRepository } from '../shared/repository';
import { createApp } from './app';

export default createApp((env) => ({
  repo: createSupabaseRepository(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY),
  vectors: env.PATTERNS,
}));
