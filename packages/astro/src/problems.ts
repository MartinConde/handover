import type { z } from 'astro/zod';

/** One thing the schema will not accept, addressed the way the form addresses its fields. */
export interface Problem {
  /** Dotted, array indices included: `body.0.heading`. */
  path: string;
  message: string;
}

type Issue = {
  code: string;
  path: PropertyKey[];
  message: string;
  /** A union reports one list of issues per branch it tried. */
  errors?: Issue[][];
};

const dotted = (path: PropertyKey[]) => path.map(String).join('.');

const at = (data: unknown, path: PropertyKey[]) =>
  path.reduce<unknown>(
    (node, key) => (node as Record<PropertyKey, unknown> | undefined)?.[key],
    data,
  );

/** Branches that failed on a reserved key never applied; one left is the real list of issues. */
function problemsOf(data: unknown, issue: Issue, base: PropertyKey[]): Problem[] {
  const path = [...base, ...issue.path];
  // A missing key is what every new entry meets, so it gets the one word the form marks it with.
  if (at(data, path) === undefined) return [{ path: dotted(path), message: 'Required' }];
  if (issue.code !== 'invalid_union' || !issue.errors)
    return [{ path: dotted(path), message: issue.message }];
  const applied = issue.errors.filter(
    (branch) => !branch.some((i) => String(i.path.at(-1) ?? '').startsWith('_')),
  );
  const only = applied.length === 1 ? applied[0] : undefined;
  if (!only) return [{ path: dotted(path), message: issue.message }];
  return only.flatMap((i) => problemsOf(data, i, path));
}

/** Every field of an entry the collection schema will not accept, in the schema's order. */
export function entryProblems(schema: z.ZodType, data: unknown): Problem[] {
  const parsed = schema.safeParse(data);
  if (parsed.success) return [];
  const found = new Map<string, Problem>();
  for (const issue of parsed.error.issues as unknown as Issue[])
    for (const problem of problemsOf(data, issue, []))
      if (!found.has(problem.path)) found.set(problem.path, problem);
  return [...found.values()];
}
