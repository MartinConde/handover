/**
 * One provider, in and out: the texts to translate, the language they are in and the one they
 * are wanted in, and the same list back in the same order. A site swaps DeepL for another
 * service by handing `i18n.translate` its own function — nothing above here knows which one
 * answered, only that a machine did and `_machine` says so.
 */
export type Translate = (texts: string[], from: string, to: string) => Promise<string[]>;

// DeepL's own cap on one request. A page of blocks goes over it, so the call is split and the
// answers are put back in the order they were asked in.
const PER_REQUEST = 50;

/**
 * DeepL behind the hook. A free key ends in `:fx` and its account only answers on the free
 * host, which is the one thing a key cannot be used without knowing.
 *
 * The language codes are the locale as the site declares it: `de` is `DE` and `pt-br` is
 * `PT-BR`, which is what DeepL wants of a target. A source is the language alone — it has no
 * regional variants — so `pt-br` asks in `PT`.
 */
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
      // DeepL says which of its rules was broken — an unsupported target language above all —
      // and that is more use to whoever configured it than a status code.
      if (!res.ok)
        throw new Error(
          `DeepL refused the translation (${res.status})${body.message ? `: ${body.message}` : ''}`,
        );
      out.push(...batch.map((_, n) => body.translations?.[n]?.text ?? ''));
    }
    return out;
  };
}

/**
 * One file with a machine's answers in it: each path it filled written where the path says,
 * and `_machine` naming every path a machine's words are still standing at. The badge those
 * draw comes off one at a time, as somebody types over them — see `keptMachine`.
 */
export function machineFilled(
  _siteId: string,
  data: unknown,
  filled: Record<string, string>,
): Record<string, unknown> {
  const out = structuredClone(isObject(data) ? data : {});
  const was = Array.isArray(out._machine) ? (out._machine as string[]) : [];
  // A path the file has no room for — a block another language alone has — writes nothing, and
  // a `_machine` naming a value that is not there would badge an empty field.
  const written = Object.entries(filled).filter(([path, text]) => writeAt(out, path, text));
  const put = new Set(written.map(([path]) => path));
  const machine = [...was.filter((p) => !put.has(p)), ...put];
  if (machine.length) out._machine = machine;
  return out;
}

/**
 * The paths of `before`'s `_machine` that are still a machine's words in `after`: the ones
 * whose value nobody has changed. A person typing over a machine-filled field is what takes
 * its badge off, and the save is where that is noticed — the browser sends values and never
 * says which of them it touched. A path whose field is gone goes with it.
 */
export function keptMachine(_siteId: string, before: unknown, after: unknown): string[] {
  const machine = isObject(before) && Array.isArray(before._machine) ? before._machine : [];
  return (machine as string[]).filter((path) => {
    const now = readAt(after, path);
    return now !== undefined && now === readAt(before, path);
  });
}

/**
 * The address of the field a form is drawing, the way `_machine` and the drift report write
 * one: `blocks[_id=k3nf9a2p].heading`. The form knows a field by where it sits — `blocks.1.
 * heading` — and a row's position changes when somebody moves it, so the ids are read out of
 * the data on the way down. A row without one is its position, as everywhere else.
 */
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

/**
 * `fieldAddress` read back: where the form draws the field that address names, as the steps
 * down the data — `['blocks', '1', 'heading']` — with each row looked up by its id where it
 * sits *now*. A row the data no longer has ends the walk.
 */
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

// `blocks[_id=k3nf9a2p].heading` split into the steps a walk takes: a key, or a row of the
// array under the key before it.
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

/**
 * Whether the value went in. A group the file does not have yet is made on the way down — a
 * translation whose every field is translated has no group at all until the first one is
 * filled — but a row it does not have is not: which blocks a file has is the entry's structure,
 * and a fill is not the place that changes it.
 */
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
