import { z } from 'astro/zod';

export interface ProblemDescriptor {
  code: string;
  limit?: number;
  inclusive?: boolean;
  exact?: boolean;
}

/** One thing the schema will not accept, addressed the way the form addresses its fields. */
export interface Problem {
  /** Dotted, array indices included: `body.0.heading`. */
  path: string;
  message: string;
  /** Additive presentation identity; `message` remains the compatibility fallback. */
  descriptor?: ProblemDescriptor;
}

type Issue = {
  code: string;
  path: PropertyKey[];
  message: string;
  input?: unknown;
  expected?: unknown;
  origin?: unknown;
  format?: unknown;
  values?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  inclusive?: unknown;
  exact?: unknown;
  inst?: unknown;
  descriptor?: ProblemDescriptor;
  /** A union reports one list of issues per branch it tried. */
  errors?: Issue[][];
};

const dotted = (path: PropertyKey[]) => path.map(String).join('.');

function descriptorOf(issue: Issue): ProblemDescriptor | undefined {
  if (issue.input === undefined) return { code: 'FIELD_REQUIRED' };
  if (issue.code === 'invalid_type') {
    if (issue.expected === 'string') return { code: 'FIELD_EXPECTED_TEXT' };
    if (issue.expected === 'number' || issue.expected === 'int')
      return { code: 'FIELD_EXPECTED_NUMBER' };
    if (issue.expected === 'boolean') return { code: 'FIELD_EXPECTED_BOOLEAN' };
  }
  if (issue.code === 'invalid_format' && issue.format === 'date')
    return { code: 'FIELD_INVALID_DATE' };
  if (
    issue.code === 'invalid_value' &&
    issue.inst instanceof z.ZodEnum &&
    Array.isArray(issue.values) &&
    issue.values.every((value) => typeof value === 'string')
  )
    return { code: 'FIELD_INVALID_SELECTION' };
  if (
    (issue.code === 'too_small' || issue.code === 'too_big') &&
    (issue.origin === 'string' || issue.origin === 'number')
  ) {
    const limit = issue.code === 'too_small' ? issue.minimum : issue.maximum;
    if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined;
    if (issue.origin === 'number' && typeof issue.inclusive !== 'boolean') return undefined;
    return {
      code: `FIELD_${issue.origin === 'string' ? 'TEXT' : 'NUMBER'}_${issue.code === 'too_small' ? 'TOO_SMALL' : 'TOO_BIG'}`,
      limit,
      ...(issue.origin === 'number' && typeof issue.inclusive === 'boolean'
        ? { inclusive: issue.inclusive }
        : {}),
      ...(issue.origin === 'string' && issue.exact === true ? { exact: true } : {}),
    };
  }
  return undefined;
}

/** Branches that failed on a reserved key never applied; one left is the real list of issues. */
function problemsOf(issue: Issue, base: PropertyKey[]): Problem[] {
  const path = [...base, ...issue.path];
  // A missing key is what every new entry meets, so it gets the one word the form marks it with.
  if (issue.descriptor?.code === 'FIELD_REQUIRED')
    return [{ path: dotted(path), message: 'Required', descriptor: issue.descriptor }];
  if (issue.code !== 'invalid_union' || !issue.errors)
    return [
      {
        path: dotted(path),
        message: issue.message,
        ...(issue.descriptor ? { descriptor: issue.descriptor } : {}),
      },
    ];
  const applied = issue.errors.filter(
    (branch) => !branch.some((i) => String(i.path.at(-1) ?? '').startsWith('_')),
  );
  const only = applied.length === 1 ? applied[0] : undefined;
  if (!only) return [{ path: dotted(path), message: issue.message }];
  return only.flatMap((i) => problemsOf(i, path));
}

/** Every field of an entry the collection schema will not accept, in the schema's order. */
export function entryProblems(schema: z.ZodType, data: unknown): Problem[] {
  const customError = z.config().customError;
  const parsed = schema.safeParse(data, {
    error: (raw) => {
      // Returning nothing preserves Zod's normal message precedence. Reaching this callback proves
      // no schema/check message won; a consumer-wide custom map remains authored and unmarked.
      if (!customError) {
        const issue = raw as unknown as Issue;
        const descriptor = descriptorOf(issue);
        if (descriptor) issue.descriptor = descriptor;
      }
      return undefined;
    },
  });
  if (parsed.success) return [];
  const found = new Map<string, Problem>();
  for (const issue of parsed.error.issues as unknown as Issue[])
    for (const problem of problemsOf(issue, []))
      if (!found.has(problem.path)) found.set(problem.path, problem);
  return [...found.values()];
}
