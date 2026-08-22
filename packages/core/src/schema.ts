// The subset of `z.toJSONSchema()` output the walker reads; anything else is "unsupported".
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

export type Field =
  | { path: string[]; type: 'text'; required: boolean }
  | { path: string[]; type: 'unsupported' };

export function fieldsFrom(_siteId: string, schema: JsonSchema, prefix: string[] = []): Field[] {
  if (schema.type !== 'object' || !schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([name, child]): Field[] => {
    if (name.startsWith('_')) return [];
    const path = [...prefix, name];
    if (child.type === 'string') return [{ path, type: 'text', required: required.has(name) }];
    if (child.type === 'object') return fieldsFrom(_siteId, child, path);
    return [{ path, type: 'unsupported' }];
  });
}
