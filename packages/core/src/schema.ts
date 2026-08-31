import { DEFAULT_MAX, type Preset } from './media.js';
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

/**
 * A field's translation mode, `.meta({ i18n })` in the schema: `true` is a value per locale,
 * `'duplicate'` the same value in every one, `false` the source locale alone. Absent is the
 * default — translatable, or the group's mode where the group declared one.
 */
export type Translation = true | 'duplicate' | false;

type FieldOf =
  | { path: string[]; label: string; type: 'text'; required: boolean }
  | { path: string[]; label: string; type: 'richtext'; required: boolean; tier: RichtextTier }
  | { path: string[]; label: string; type: 'number'; required: boolean }
  | { path: string[]; label: string; type: 'boolean'; required: boolean }
  | { path: string[]; label: string; type: 'date'; required: boolean }
  | { path: string[]; label: string; type: 'select'; required: boolean; options: string[] }
  | { path: string[]; label: string; type: 'link'; required: boolean }
  | { path: string[]; label: string; type: 'image'; required: boolean; preset: Preset }
  | { path: string[]; label: string; type: 'file'; required: boolean; accept: string[] }
  | { path: string[]; label: string; type: 'embed'; required: boolean }
  | { path: string[]; label: string; type: 'seo'; required: boolean }
  // The `navigation` global's menus, whole: a tree of items nesting through `children`, which
  // is recursive and so has no fields the walker could flatten.
  | { path: string[]; label: string; type: 'menus'; required: boolean }
  | { path: string[]; label: string; type: 'reference'; required: boolean; collection: string }
  // `fields` and `item` are relative to the group / one array item; `item` is `[]` for a scalar.
  | { path: string[]; label: string; type: 'group'; required: boolean; fields: Field[] }
  | { path: string[]; label: string; type: 'array'; required: boolean; item: Field[] }
  | { path: string[]; label: string; type: 'blocks'; required: boolean; types: string[] }
  | { path: string[]; label: string; type: 'unsupported' };

export type Field = FieldOf & { i18n?: Translation };

// Block types are keyed by name, not nested under each `blocks` field, because a block
// can contain `blocks` of its own type.
export interface Form {
  fields: Field[];
  blocks: Record<string, Field[]>;
}

export function fieldsFrom(_siteId: string, schema: JsonSchema): Field[] {
  return objectFields(schema, schema);
}

/**
 * One menu item as the walkers read it. The schema walker stops at `menus` — the shape is
 * recursive and has no fields to flatten — but the CMS keeps the tree in step across languages
 * the way it keeps blocks, and that needs the same fields every other row has: the label is the
 * one thing a language owns, the link and the shape belong to all of them at once. The order is
 * the order the files carry, because `ordered` writes the keys in it.
 */
const menuItem: Field[] = [
  { path: ['label'], label: 'Label', type: 'text', required: false, i18n: true },
  // One value the CMS never looks inside: swapping a page for a URL replaces the whole target.
  { path: ['link'], label: 'Links to', type: 'unsupported' },
  { path: ['newTab'], label: 'Open in a new tab', type: 'boolean', required: false },
];
menuItem.push({
  path: ['children'],
  label: 'Items',
  type: 'array',
  required: false,
  item: menuItem,
});
const menuFields: Field[] = [
  { path: ['key'], label: 'Key', type: 'text', required: true },
  { path: ['items'], label: 'Items', type: 'array', required: true, item: menuItem },
];

/**
 * The fields of one row of a field that holds rows, and nothing for a field that holds none:
 * where every walk that keeps an entry's languages in step goes down. `menuItem` names itself,
 * so this is deliberately not on the `Field` the form hands the browser — that one is JSON, and
 * a cycle in it has no end.
 */
export const rowFields = (field: Field): readonly Field[] | undefined =>
  field.type === 'menus'
    ? menuFields
    : field.type === 'array' && field.item.some((f) => f.path.length > 0)
      ? field.item
      : undefined;

/**
 * Every ratio a picture is shown at on this site, once each, named by the first field asking for
 * it. The focal picker previews these: one dot, and under it what that dot does to each crop the
 * site actually renders. A field with no ratio crops nothing and has nothing to preview.
 */
export function imagePresets(forms: Iterable<Form>): { label: string; preset: Preset }[] {
  const found = new Map<string, { label: string; preset: Preset }>();
  // An array of pictures labels its item with nothing, so the row is named after the field it
  // is a row of — *Gallery*, which is what the client called it.
  const walk = (fields: Field[], within: string) => {
    for (const field of fields) {
      const label = field.label || within;
      if (field.type === 'image') {
        if (field.preset.ratio && !found.has(field.preset.ratio))
          found.set(field.preset.ratio, { label, preset: field.preset });
      } else if (field.type === 'group') walk(field.fields, label);
      else if (field.type === 'array') walk(field.item, label);
    }
  };
  for (const form of forms) {
    walk(form.fields, '');
    for (const fields of Object.values(form.blocks)) walk(fields, '');
  }
  return [...found.values()];
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
  return Object.entries(schema.properties).flatMap(([name, child]): Field[] => {
    if (name.startsWith('_')) return [];
    const mode = resolve(root, child).i18n;
    const declared = mode === true || mode === 'duplicate' || mode === false;
    return fieldOf(root, [name], child, requiredKeys.has(name)).map((f) =>
      declared ? { ...f, i18n: mode } : f,
    );
  });
}

export const humanise = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

function fieldOf(root: JsonSchema, path: string[], node: JsonSchema, required: boolean): Field[] {
  const child = resolve(root, node);
  // Named by the schema when it says so, by its own key when it does not; an array item has
  // no key, and the form numbers its rows instead.
  const label =
    typeof child.label === 'string' ? child.label : humanise(path[path.length - 1] ?? '');
  // Shapes the package's own helpers tag with `.meta({ handover })`; see astro-handover.
  switch (child.handover) {
    case 'text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'link':
    case 'embed':
    case 'menus':
    case 'seo':
      return [{ path, label, type: child.handover, required }];
    // The field's preset: the ratio it shows at, the cap an upload is downscaled to on the way in
    // and the optional floor the picker refuses under. Only the cap has a value where none is set.
    case 'image':
      return [
        {
          path,
          label,
          type: 'image',
          required,
          preset: {
            ...(typeof child.ratio === 'string' ? { ratio: child.ratio } : {}),
            max: typeof child.max === 'number' ? child.max : DEFAULT_MAX,
            ...(typeof child.min === 'number' ? { min: child.min } : {}),
          },
        },
      ];
    case 'file':
      return [
        {
          path,
          label,
          type: 'file',
          required,
          accept: isStringArray(child.accept) ? child.accept : ['application/pdf'],
        },
      ];
    case 'richtext':
      return [
        { path, label, type: 'richtext', required, tier: child.tier === 'full' ? 'full' : 'basic' },
      ];
    case 'reference':
      return [{ path, label, type: 'reference', required, collection: String(child.collection) }];
    case 'blocks':
      return [
        {
          path,
          label,
          type: 'blocks',
          required,
          types: isStringArray(child.types) ? child.types : [],
        },
      ];
  }
  if (child.type === 'object')
    return [{ path, label, type: 'group', required, fields: objectFields(root, child) }];
  if (child.type === 'string') {
    if (isStringArray(child.enum))
      return [{ path, label, type: 'select', required, options: child.enum }];
    if (child.format === 'date') return [{ path, label, type: 'date', required }];
    return [{ path, label, type: 'text', required }];
  }
  if (child.type === 'number' || child.type === 'integer')
    return [{ path, label, type: 'number', required }];
  if (child.type === 'boolean') return [{ path, label, type: 'boolean', required }];
  if (child.type === 'array' && child.items) {
    const items = resolve(root, child.items);
    if (items.type === 'array') return [{ path, label, type: 'unsupported' }];
    const item =
      items.type === 'object' && !items.handover
        ? objectFields(root, items)
        : fieldOf(root, [], items, true);
    return [{ path, label, type: 'array', required, item }];
  }
  return [{ path, label, type: 'unsupported' }];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');
