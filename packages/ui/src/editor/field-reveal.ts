import { tick } from 'svelte';

const focusable = (node: Element) =>
  node.matches('input, textarea, select, [contenteditable="true"]');

function openAround(node: Element | null | undefined) {
  for (let at = node; at; at = at.parentElement)
    if (at instanceof HTMLDetailsElement) at.open = true;
}

// A picture's `src` has no control of its own, so the jump lands on the nearest drawn ancestor.
export function drawn(prefix: string, path: string | undefined) {
  const steps = path?.split('.') ?? [];
  for (; steps.length; steps.pop()) {
    const field = document.getElementById(`${prefix}-${steps.join('.')}`);
    if (field) return field;
  }
  return null;
}

// A folded block draws no fields at all, so the way in is the fold button of each closed card.
async function unfolded(id: string) {
  for (let guard = 0; guard <= id.split('.').length; guard++) {
    const field = document.getElementById(id);
    if (field && !field.classList.contains('is-folded')) return field;
    const steps = id.split('.');
    let card: HTMLElement | undefined = field ?? undefined;
    for (steps.pop(); steps.length && !card; steps.pop()) {
      const found = document.getElementById(steps.join('.'));
      if (found?.classList.contains('is-folded')) card = found;
    }
    if (!card) return null;
    card.querySelector<HTMLButtonElement>('button.fold')?.click();
    await tick();
  }
  return null;
}

// Scrolling there is not enough on its own: the count is a button, so it has to land somewhere.
export async function land(prefix: string, path: string | undefined) {
  const field = path ? ((await unfolded(`${prefix}-${path}`)) ?? drawn(prefix, path)) : null;
  openAround(field?.parentElement);
  await tick();
  field?.scrollIntoView({ block: 'center' });
  field?.focus();
}

// True only when the field itself took the focus.
export async function focusField(id: string): Promise<boolean> {
  const input = await unfolded(id);
  // The nearest drawn ancestor is not this field: a container taking focus is not a visit.
  if (!input || !focusable(input)) return false;
  openAround(input.parentElement);
  await tick();
  input.scrollIntoView({ block: 'center' });
  input.focus();
  return document.activeElement === input || input.getAttribute('contenteditable') === 'true';
}

// `wanted` is asked again after each wait: the selection that asked may have moved on.
export async function revealField(prefix: string, path: string, wanted: () => boolean) {
  const id = `${prefix}-${path}`;
  const field =
    (await unfolded(id)) ?? document.getElementById(`${id}-field`) ?? drawn(prefix, path);
  if (!field || !wanted()) return;
  openAround(field);
  await tick();
  const input = focusable(field)
    ? field
    : (field.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"]',
      ) ?? field.querySelector<HTMLElement>('button:not(:disabled), summary'));
  openAround(input?.parentElement);
  await tick();
  if (!wanted()) return;
  (input ?? field).scrollIntoView({ block: 'center' });
  input?.focus({ preventScroll: true });
}
