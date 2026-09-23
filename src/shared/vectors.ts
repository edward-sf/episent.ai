export type VectorStore = Pick<Vectorize, 'upsert' | 'query' | 'getByIds'>;

// A type alias (not an interface) so it is assignable to Vectorize's Record-typed metadata.
export type PatternMetadata = {
  geohash: string;
  window_end: string;
  total_cases: number;
  top_category: string;
};

export function vectorId(geohash: string, windowEnd: string): string {
  return `${geohash}:${windowEnd}`;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
