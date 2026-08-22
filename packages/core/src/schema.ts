// The subset of `z.toJSONSchema()` output the walker reads; anything else is "unsupported".
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

export type Field =
  | { path: string[]; type: 'text'; required: boolean }
  | { path: string[]; type: 'number'; required: boolean }
  | { path: string[]; type: 'boolean'; required: boolean }
  | { path: string[]; type: 'date'; required: boolean }
  | { path: string[]; type: 'select'; required: boolean; options: string[] }
  | { path: string[]; type: 'link'; required: boolean }
  | { path: string[]; type: 'unsupported' };

export function fieldsFrom(_siteId: string, schema: JsonSchema, prefix: string[] = []): Field[] {
  if (schema.type !== 'object' || !schema.properties) return [];
  const requiredKeys = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([name, child]): Field[] => {
    if (name.startsWith('_')) return [];
    const path = [...prefix, name];
    const required = requiredKeys.has(name);
    // Shapes the package's own helpers tag with `.meta({ handover })`; see astro-handover.
    if (child.handover === 'link') return [{ path, type: 'link', required }];
    if (child.type === 'string') {
      if (isStringArray(child.enum))
        return [{ path, type: 'select', required, options: child.enum }];
      if (child.format === 'date') return [{ path, type: 'date', required }];
      return [{ path, type: 'text', required }];
    }
    if (child.type === 'number' || child.type === 'integer')
      return [{ path, type: 'number', required }];
    if (child.type === 'boolean') return [{ path, type: 'boolean', required }];
    if (child.type === 'object') return fieldsFrom(_siteId, child, path);
    return [{ path, type: 'unsupported' }];
  });
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');
