import type { RichtextTier } from './richtext.js';

// The subset of `z.toJSONSchema()` output the walker reads; anything else is "unsupported".
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
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
  // `fields` and `item` are relative to the group / one array item; `item` is `[]` for a scalar.
  | { path: string[]; type: 'group'; required: boolean; fields: Field[] }
  | { path: string[]; type: 'array'; required: boolean; item: Field[] }
  | { path: string[]; type: 'blocks'; required: boolean; types: string[] }
  | { path: string[]; type: 'unsupported' };

// Block types are keyed by name, not nested under each `blocks` field, because a block
// can contain `blocks` of its own type.
export interface Form {
  fields: Field[];
  blocks: Record<string, Field[]>;
}

export function fieldsFrom(_siteId: string, schema: JsonSchema): Field[] {
  return objectFields(schema, schema);
}

export function formOf(_siteId: string, schema: JsonSchema): Form {
  const blocks: Record<string, Field[]> = {};
  const seen = new Set<JsonSchema>();
  const collect = (node: JsonSchema) => {
    const s = resolve(schema, node);
    if (seen.has(s)) return;
    seen.add(s);
    if (s.handover === 'blocks') {
      for (const b of blockObjects(schema, s.items)) {
        blocks[String(b.properties?._type?.const)] ??= objectFields(schema, b);
        collect(b);
      }
      return;
    }
    for (const child of [...Object.values(s.properties ?? {}), s.items, ...(s.anyOf ?? [])])
      if (child) collect(child);
  };
  collect(schema);
  return { fields: fieldsFrom(_siteId, schema), blocks };
}

function blockObjects(root: JsonSchema, node: JsonSchema | undefined): JsonSchema[] {
  if (!node) return [];
  const s = resolve(root, node);
  if (s.anyOf) return s.anyOf.flatMap((o) => blockObjects(root, o));
  return typeof s.properties?._type?.const === 'string' ? [s] : [];
}

function resolve(root: JsonSchema, node: JsonSchema): JsonSchema {
  const name = node.$ref?.match(/^#\/\$defs\/(.+)$/)?.[1];
  return name ? (root.$defs?.[name] ?? {}) : node;
}

function objectFields(root: JsonSchema, node: JsonSchema): Field[] {
  const schema = resolve(root, node);
  if (schema.type !== 'object' || !schema.properties) return [];
  const requiredKeys = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([name, child]): Field[] =>
    name.startsWith('_') ? [] : fieldOf(root, [name], child, requiredKeys.has(name)),
  );
}

function fieldOf(root: JsonSchema, path: string[], node: JsonSchema, required: boolean): Field[] {
  const child = resolve(root, node);
  // Shapes the package's own helpers tag with `.meta({ handover })`; see astro-handover.
  switch (child.handover) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
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
  if (child.type === 'object')
    return [{ path, type: 'group', required, fields: objectFields(root, child) }];
  if (child.type === 'string') {
    if (isStringArray(child.enum)) return [{ path, type: 'select', required, options: child.enum }];
    if (child.format === 'date') return [{ path, type: 'date', required }];
    return [{ path, type: 'text', required }];
  }
  if (child.type === 'number' || child.type === 'integer')
    return [{ path, type: 'number', required }];
  if (child.type === 'boolean') return [{ path, type: 'boolean', required }];
  if (child.type === 'array' && child.items) {
    const items = resolve(root, child.items);
    if (items.type === 'array') return [{ path, type: 'unsupported' }];
    const item =
      items.type === 'object' && !items.handover
        ? objectFields(root, items)
        : fieldOf(root, [], items, true);
    return [{ path, type: 'array', required, item }];
  }
  return [{ path, type: 'unsupported' }];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');

// Types with no valid empty value — a date, a media key, a reference — are left out; a new
// entry that requires one does not validate until the editor fills it in.
function blank(field: Field): unknown {
  switch (field.type) {
    case 'text':
    case 'richtext':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'select':
      return field.options[0];
    case 'array':
    case 'blocks':
      return [];
    case 'group':
      return blankValues('default', field.fields);
    default:
      return undefined;
  }
}

/** What a new entry holds before anything is typed: the required fields, empty. */
export function blankValues(_siteId: string, fields: readonly Field[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.path[0];
    if (!key || field.type === 'unsupported' || !field.required) continue;
    const value = blank(field);
    if (value !== undefined) values[key] = value;
  }
  return values;
}
