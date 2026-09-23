import { createWorkersAiEmbedder } from '../shared/embedding';
import { createSupabaseRepository } from '../shared/repository';
import { runAggregation } from './run';

export interface CronEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  PATTERNS: Vectorize;
  AI: Ai;
}

export default {
  async scheduled(controller, env) {
    const result = await runAggregation(
      {
        repo: createSupabaseRepository(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY),
        vectors: env.PATTERNS,
        embed: createWorkersAiEmbedder(env.AI),
      },
      new Date(controller.scheduledTime),
    );
    console.log(
      JSON.stringify({
        event: 'aggregation_run',
        aggregated: result.aggregated.length,
        empty: result.empty.length,
        failed: result.failed,
      }),
    );
  },
} satisfies ExportedHandler<CronEnv>;
