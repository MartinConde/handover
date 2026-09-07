/** A site swaps DeepL for its own function; callers only know a machine answered. */
export type Translate = (texts: string[], from: string, to: string) => Promise<string[]>;

// DeepL's cap on one request, so the call is split and the answers reassembled in order.
const PER_REQUEST = 50;

/** A `:fx` key only answers on the free host; a source language has no regional variant. */
export function deeplTranslate(_siteId: string, key: string): Translate {
  const host = key.trimEnd().endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  return async (texts, from, to) => {
    const out: string[] = [];
    for (let i = 0; i < texts.length; i += PER_REQUEST) {
      const batch = texts.slice(i, i + PER_REQUEST);
      const res = await fetch(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: { authorization: `DeepL-Auth-Key ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: batch,
          source_lang: from.split('-')[0]?.toUpperCase(),
          target_lang: to.toUpperCase(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        translations?: { text?: string }[];
        message?: string;
      };
      // DeepL's message names the rule broken, which is more use than a status code.
      if (!res.ok)
        throw new Error(
          `DeepL refused the translation (${res.status})${body.message ? `: ${body.message}` : ''}`,
        );
      out.push(...batch.map((_, n) => body.translations?.[n]?.text ?? ''));
    }
    return out;
  };
}

/** `_machine` names every path a machine's words still stand at; see `keptMachine`. */
export function machineFilled(
  _siteId: string,
  data: unknown,
  filled: Record<string, string>,
): Record<string, unknown> {
  const out = structuredClone(isObject(data) ? data : {});
  const was = Array.isArray(out._machine) ? (out._machine as string[]) : [];
  // A path the file has no room for writes nothing, or `_machine` would badge an empty field.
  const written = Object.entries(filled).filter(([path, text]) => writeAt(out, path, text));
  const put = new Set(written.map(([path]) => path));
  const machine = [...was.filter((p) => !put.has(p)), ...put];
  if (machine.length) out._machine = machine;
  return out;
}

/** The browser never says which values it touched, so an unchanged value keeps its badge. */
export function keptMachine(_siteId: string, before: unknown, after: unknown): string[] {
  const machine = isObject(before) && Array.isArray(before._machine) ? before._machine : [];
  return (machine as string[]).filter((path) => {
    const now = readAt(after, path);
    return now !== undefined && now === readAt(before, path);
  });
}

/** Rows are addressed by `_id`, since a row's position changes when somebody moves it. */
export function fieldAddress(_siteId: string, path: readonly string[], root: unknown): string {
  let node: unknown = root;
  let out = '';
  for (const key of path) {
    if (Array.isArray(node)) {
      const row = node[Number(key)];
      const id = isObject(row) && typeof row._id === 'string' ? `_id=${row._id}` : key;
      out += `[${id}]`;
      node = row;
    } else {
      out += out ? `.${key}` : key;
      node = isObject(node) ? node[key] : undefined;
    }
  }
  return out;
}

/** `fieldAddress` read back to positions; a row the data no longer has ends the walk. */
export function fieldPosition(
  _siteId: string,
  address: string,
  root: unknown,
): string[] | undefined {
  let node: unknown = root;
  const out: string[] = [];
  for (const { row, key } of stepsOf(address)) {
    if (row !== undefined) {
      if (!Array.isArray(node)) return undefined;
      const i = node.findIndex((r, n) => rowKey(r, n) === row);
      if (i < 0) return undefined;
      out.push(String(i));
      node = node[i];
    } else {
      out.push(key ?? '');
      node = isObject(node) ? node[key ?? ''] : undefined;
    }
  }
  return out;
}

// A step is a key, or a row of the array under the key before it.
const STEPS = /\[(?:_id=)?([^\]]+)\]|([^.[\]]+)/g;

const stepsOf = (path: string) => [...path.matchAll(STEPS)].map(([, row, key]) => ({ row, key }));

function readAt(data: unknown, path: string): unknown {
  let node: unknown = data;
  for (const { row, key } of stepsOf(path)) {
    if (row !== undefined) node = rowOf(node, row);
    else node = isObject(node) ? node[key ?? ''] : undefined;
    if (node === undefined) return undefined;
  }
  return node;
}

/** A missing group is made on the way down; a missing row is not, as a fill never adds blocks. */
function writeAt(data: Record<string, unknown>, path: string, value: string): boolean {
  const steps = stepsOf(path);
  const last = steps.pop();
  if (!last) return false;
  let node: unknown = data;
  for (const { row, key } of steps) {
    if (row !== undefined) node = rowOf(node, row);
    else if (isObject(node)) node = node[key ?? ''] ??= {};
    else node = undefined;
    if (node === undefined) return false;
  }
  if (last.row !== undefined) {
    const rows = Array.isArray(node) ? node : undefined;
    const at = rows?.findIndex((r, i) => rowKey(r, i) === last.row) ?? -1;
    if (!rows || at < 0) return false;
    rows[at] = value;
    return true;
  }
  if (!isObject(node)) return false;
  node[last.key ?? ''] = value;
  return true;
}

const rowOf = (node: unknown, id: string) =>
  Array.isArray(node) ? node.find((row, i) => rowKey(row, i) === id) : undefined;

const rowKey = (row: unknown, i: number) =>
  isObject(row) && typeof row._id === 'string' ? row._id : String(i);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
