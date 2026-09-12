/** Cloudflare D1 rejects an individual statement with more than this many bindings. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** Split values so callers can account for every fixed and per-row binding in their query. */
export function chunksOf<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('Chunk size must be positive');
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}
