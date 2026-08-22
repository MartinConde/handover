import type { RichtextTier } from './richtext.js';

// The subset of `z.toJSONSchema()` output the walker reads; anything else is "unsupported".
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [key: string]: unknown;
}

export type Field =
  | { path: string[]; type: 'text'; required: boolean }
  | { path: string[]; type: 'richtext'; required: boolean; tier: RichtextTier }
  | { path: string[]; type: 'number'; required: boolean }
  | { path: string[]; type: 'boolean'; required: boolean }
  | { path: string[]; type: 'date'; required: boolean }
  | { path: string[]; type: 'select'; required: boolean; options: string[] }
  | { path: string[]; type: 'link'; required: boolean }
  | { path: string[]; type: 'image'; required: boolean }
  | { path: string[]; type: 'file'; required: boolean }
  | { path: string[]; type: 'embed'; required: boolean }
  | { path: string[]; type: 'seo'; required: boolean }
  | { path: string[]; type: 'reference'; required: boolean; collection: string }
  // `item` is relative to one array item: the item's own fields, or `[]` for a scalar.
  | { path: string[]; type: 'array'; required: boolean; item: Field[] }
  | { path: string[]; type: 'blocks'; required: boolean; types: string[] }
  | { path: string[]; type: 'unsupported' };

export function fieldsFrom(_siteId: string, schema: JsonSchema, prefix: string[] = []): Field[] {
  if (schema.type !== 'object' || !schema.properties) return [];
  const requiredKeys = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([name, child]): Field[] => {
    if (name.startsWith('_')) return [];
    const path = [...prefix, name];
    // A group is its fields with a longer path, not a field of its own.
    if (child.type === 'object' && !child.handover) return fieldsFrom(_siteId, child, path);
    return fieldOf(_siteId, path, child, requiredKeys.has(name));
  });
}

function fieldOf(siteId: string, path: string[], child: JsonSchema, required: boolean): Field[] {
  // Shapes the package's own helpers tag with `.meta({ handover })`; see astro-handover.
  switch (child.handover) {
    case 'link':
    case 'image':
    case 'file':
    case 'embed':
    case 'seo':
      return [{ path, type: child.handover, required }];
    case 'richtext':
      return [{ path, type: 'richtext', required, tier: child.tier === 'full' ? 'full' : 'basic' }];
    case 'reference':
      return [{ path, type: 'reference', required, collection: String(child.collection) }];
    case 'blocks':
      return [
        { path, type: 'blocks', required, types: isStringArray(child.types) ? child.types : [] },
      ];
  }
  if (child.type === 'string') {
    if (isStringArray(child.enum)) return [{ path, type: 'select', required, options: child.enum }];
    if (child.format === 'date') return [{ path, type: 'date', required }];
    return [{ path, type: 'text', required }];
  }
  if (child.type === 'number' || child.type === 'integer')
    return [{ path, type: 'number', required }];
  if (child.type === 'boolean') return [{ path, type: 'boolean', required }];
  if (child.type === 'array' && child.items && child.items.type !== 'array') {
    const item =
      child.items.type === 'object' && !child.items.handover
        ? fieldsFrom(siteId, child.items)
        : fieldOf(siteId, [], child.items, true);
    return [{ path, type: 'array', required, item }];
  }
  return [{ path, type: 'unsupported' }];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');
