import type { Field } from '@handover/core';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Editing readiness only. The server remains authoritative for schema validation and publishing.
const read = (root: unknown, path: readonly string[]) =>
  path.reduce<unknown>((value, key) => (object(value) ? value[key] : undefined), root);

const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

export function requiredFieldProblems(
  fields: readonly Field[],
  root: unknown,
  blocks: Record<string, Field[]> = {},
  prefix: readonly string[] = [],
  translating = false,
) {
  const problems: Record<string, string> = {};
  for (const field of fields) {
    if (field.type === 'unsupported' || (translating && field.i18n === false)) {
      continue;
    }
    const path = [...prefix, ...field.path];
    const value = read(root, field.path);
    if (field.type === 'group') {
      if (value !== undefined || field.required)
        Object.assign(
          problems,
          requiredFieldProblems(
            field.fields,
            object(value) ? value : {},
            blocks,
            path,
            translating,
          ),
        );
      continue;
    }
    if ((field.type === 'array' || field.type === 'blocks') && Array.isArray(value)) {
      value.forEach((row, index) => {
        if (!object(row) || (field.type === 'blocks' && typeof row._ref === 'string')) return;
        const children = field.type === 'array' ? field.item : (blocks[String(row._type)] ?? []);
        Object.assign(
          problems,
          requiredFieldProblems(children, row, blocks, [...path, String(index)], translating),
        );
      });
    }
    if (!field.required) continue;
    const present =
      field.type === 'text' || field.type === 'richtext' || field.type === 'date'
        ? filled(value)
        : field.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : field.type === 'boolean'
            ? typeof value === 'boolean'
            : field.type === 'select'
              ? typeof value === 'string' && field.options.includes(value)
              : field.type === 'reference'
                ? filled(value)
                : field.type === 'array' || field.type === 'blocks' || field.type === 'menus'
                  ? Array.isArray(value)
                  : field.type === 'image' || field.type === 'file'
                    ? object(value) && filled(value.src)
                    : field.type === 'link'
                      ? object(value) &&
                        ((value.type === 'entry' && filled(value.ref)) ||
                          (value.type === 'url' && filled(value.href)))
                      : object(value);
    if (!present) problems[path.join('.')] = `${field.label || 'This field'} is required`;
  }
  return problems;
}
