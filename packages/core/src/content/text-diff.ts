export interface WordPart {
  text: string;
  mark?: 'del' | 'ins';
}

// The longest run that kept its order stood still; two rows that swapped are one move, not two.
export function movers(before: string[], after: string[]): Map<string, 'moved-up' | 'moved-down'> {
  const kept = new Set(after);
  const had = new Set(before);
  const from = before.filter((k) => kept.has(k));
  const to = after.filter((k) => had.has(k));
  const same = lcs(from, to);
  const still = new Set(same ?? []);
  const fromIndex = new Map(from.map((key, index) => [key, index]));
  const moved = new Map<string, 'moved-up' | 'moved-down'>();
  for (const [index, key] of to.entries()) {
    const previous = fromIndex.get(key);
    if (previous === undefined || still.has(key) || (same === undefined && previous === index))
      continue;
    moved.set(key, index < previous ? 'moved-up' : 'moved-down');
  }
  return moved;
}

// The table uses four bytes per cell. Keeping both the allocation and loop count explicit prevents
// one comparison from consuming the Worker's isolate memory or CPU budget.
const MAX_LCS_CELLS = 1_000_000;

// Exact after trimming common edges; undefined asks the caller for a deterministic coarse diff.
function lcs<T extends string>(a: T[], b: T[]): T[] | undefined {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;

  const aLength = a.length - prefix - suffix;
  const bLength = b.length - prefix - suffix;
  const width = bLength + 1;
  const cells = (aLength + 1) * width;
  if (!Number.isSafeInteger(cells) || cells > MAX_LCS_CELLS) return undefined;

  const table = new Int32Array(cells);
  for (let i = aLength - 1; i >= 0; i--)
    for (let j = bLength - 1; j >= 0; j--)
      table[i * width + j] =
        a[prefix + i] === b[prefix + j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
  const out = a.slice(0, prefix);
  let i = 0;
  let j = 0;
  while (i < aLength && j < bLength) {
    const here = a[prefix + i];
    if (here !== undefined && here === b[prefix + j]) {
      out.push(here);
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) i++;
    else j++;
  }
  for (let at = a.length - suffix; at < a.length; at++) {
    const value = a[at];
    if (value !== undefined) out.push(value);
  }
  return out;
}

// Split on word boundaries, so adding a comma is not the whole word replaced; never on lines.
export function wordDiff(before: string, after: string): WordPart[] | undefined {
  const a = words(before);
  const b = words(after);
  const same = lcs(a, b);
  if (!same) return undefined;
  const parts: WordPart[] = [];
  const put = (text: string, mark?: 'del' | 'ins') => {
    const last = parts[parts.length - 1];
    if (last && last.mark === mark) last.text += text;
    else parts.push(mark ? { text, mark } : { text });
  };
  let i = 0;
  let j = 0;
  for (const word of [...same, undefined]) {
    while (i < a.length && a[i] !== word) put(a[i++] ?? '', 'del');
    while (j < b.length && b[j] !== word) put(b[j++] ?? '', 'ins');
    if (word !== undefined) {
      put(word);
      i++;
      j++;
    }
  }
  return parts;
}

// The arrow is its own token so an added break is one insertion, not its neighbours replaced.
const words = (text: string) => text.split(/(↵|[^\p{L}\p{N}↵]+)/u).filter((w) => w !== '');
