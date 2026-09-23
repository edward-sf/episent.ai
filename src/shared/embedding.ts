export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMENSIONS = 768;

export type Embedder = (text: string) => Promise<number[]>;

export function createWorkersAiEmbedder(ai: Ai): Embedder {
  return async (text) => {
    const output = await ai.run(EMBEDDING_MODEL, { text: [text] });
    const vector = 'data' in output ? output.data?.[0] : undefined;
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`unexpected embedding from ${EMBEDDING_MODEL}: expected ${EMBEDDING_DIMENSIONS} dimensions`);
    }
    return vector;
  };
}
