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

/**
 * `blocks()` is a union, so a missing field in one block is reported once per block type the
 * union holds, buried under the reasons the other types did not match. A branch that failed on
 * a reserved key — a `_type` belonging to another block, a `_ref` this one does not have — is a
 * branch that never applied; when discarding those leaves exactly one, its issues are the real
 * ones. Otherwise the union is as deep as we can name it.
 */
function problemsOf(data: unknown, issue: Issue, base: PropertyKey[]): Problem[] {
  const path = [...base, ...issue.path];
  // Zod's wording is written for whoever wrote the schema, and it says something different for
  // every kind — an enum lists its options, a union reports each branch it tried. A key that is
  // not there is the case every new entry meets, and nothing under it can be named, so it gets
  // the one word the form marks it with.
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
