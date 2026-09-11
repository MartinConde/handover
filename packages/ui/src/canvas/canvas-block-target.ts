type BlockRow = Record<string, unknown>;

const blockRow = (value: unknown): value is BlockRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  if (!blockRow(left) || !blockRow(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
};

export type StagedBlockTarget =
  | { mode: 'replace'; targetId: string; original: unknown }
  | { mode: 'insert'; placement: 'before' | 'after'; anchorId: string }
  | { mode: 'insert'; placement: 'empty' };

type StagedBlockIndexResult =
  | { ok: true; index: number }
  | { ok: false; reason: 'ambiguous' | 'deleted' | 'stale' };

/** Resolve a staged Canvas action against the current list without trusting its old position. */
export function resolveStagedBlockIndex(
  target: StagedBlockTarget,
  rows: readonly unknown[],
): StagedBlockIndexResult {
  if (target.mode === 'insert' && target.placement === 'empty')
    return rows.length ? { ok: false, reason: 'stale' } : { ok: true, index: 0 };

  const id = target.mode === 'replace' ? target.targetId : target.anchorId;
  const matches = rows
    .map((row, index) => (blockRow(row) && row._id === id ? index : -1))
    .filter((index) => index >= 0);
  if (!matches.length) return { ok: false, reason: 'deleted' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };

  const index = matches[0] as number;
  if (target.mode === 'replace') {
    if (!equal(rows[index], target.original)) return { ok: false, reason: 'stale' };
    return { ok: true, index };
  }
  return { ok: true, index: target.placement === 'after' ? index + 1 : index };
}
