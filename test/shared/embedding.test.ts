import { describe, expect, it, vi } from 'vitest';
import { createWorkersAiEmbedder, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../src/shared/embedding';

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);

function fakeAi(output: unknown) {
  const run = vi.fn(async () => output);
  return { run, ai: { run } as unknown as Ai };
}

describe('createWorkersAiEmbedder', () => {
  it('embeds text with the bge model and returns its vector', async () => {
    const { run, ai } = fakeAi({ shape: [1, EMBEDDING_DIMENSIONS], data: [vector] });
    await expect(createWorkersAiEmbedder(ai)('hello')).resolves.toEqual(vector);
    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, { text: ['hello'] });
  });

  it('throws when the model returns no vector', async () => {
    const { ai } = fakeAi({ shape: [0], data: [] });
    await expect(createWorkersAiEmbedder(ai)('hello')).rejects.toThrow(/unexpected embedding/);
  });

  it('throws when the vector has the wrong dimension', async () => {
    const { ai } = fakeAi({ shape: [1, 3], data: [[1, 2, 3]] });
    await expect(createWorkersAiEmbedder(ai)('hello')).rejects.toThrow(/unexpected embedding/);
  });
});
