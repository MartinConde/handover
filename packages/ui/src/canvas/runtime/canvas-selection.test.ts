import { afterEach, expect, test, vi } from 'vitest';
import type { CanvasTarget } from '../canvas-bridge';
import { createCanvasSelectionRuntime } from './canvas-selection';
import { createCanvasUiLocaleState } from './canvas-ui-locale';

// `Sortable#destroy` is an instance property (not on the prototype), so counting rebuilds needs a
// subclass wrapper rather than a plain vi.spyOn.
const sortableCounts = vi.hoisted(() => ({ constructed: 0, destroyed: 0 }));
vi.mock('@dnd-kit/dom/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/dom/sortable')>();
  class InstrumentedSortable extends actual.Sortable {
    constructor(...args: ConstructorParameters<typeof actual.Sortable>) {
      super(...args);
      sortableCounts.constructed += 1;
      const destroy = this.destroy;
      this.destroy = () => {
        sortableCounts.destroyed += 1;
        destroy();
      };
    }
  }
  return { ...actual, Sortable: InstrumentedSortable };
});

const target = (address: string): CanvasTarget => ({
  document: { collection: 'pages', id: 'home' },
  locale: 'en',
  address,
});

const mark = (kind: 'field' | 'list' | 'block', address: string) =>
  `data-handover-${kind}='${JSON.stringify(target(address))}'`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

test('builds a nested logical tree, groups repeated roots, and exposes explicit empty lists', () => {
  document.body.innerHTML = `
    <main ${mark('list', 'blocks')}>
      <h1 ${mark('field', 'title')}>Home</h1>
      <section ${mark('block', 'blocks[_id=one]')}>
        <h2 ${mark('field', 'blocks[_id=one].heading')}>One</h2>
        <p ${mark('field', 'blocks[_id=one].heading')}>One again</p>
      </section>
      <section ${mark('block', 'blocks[_id=columns]')}>
        <div ${mark('list', 'blocks[_id=columns].columns')}>
          <div ${mark('block', 'blocks[_id=columns].columns[_id=left]')} ${mark('list', 'blocks[_id=columns].columns[_id=left].blocks')}>
            <p>Empty</p>
          </div>
        </div>
      </section>
    </main>`;
  const runtime = createCanvasSelectionRuntime();
  runtime.start();

  const structure = runtime.structure();
  expect(structure.find((node) => node.target.address === 'title')?.parentId).toBeUndefined();
  const repeated = structure.find((node) => node.target.address === 'blocks[_id=one].heading');
  expect(repeated).toMatchObject({ kind: 'field', label: 'Heading', occurrences: 2, depth: 3 });
  expect(
    structure.find(
      (node) => node.target.address === 'blocks[_id=columns].columns[_id=left].blocks',
    ),
  ).toMatchObject({ kind: 'list', label: 'Blocks', empty: true, depth: 5 });

  runtime.dispose();
});

test('hit testing selects the nearest annotation and outlines every root for one field', async () => {
  document.body.innerHTML = `<section ${mark('block', 'blocks[_id=one]')}>
    <h2 ${mark('field', 'blocks[_id=one].heading')}>One</h2>
    <p ${mark('field', 'blocks[_id=one].heading')}><span id="hit">Again</span></p>
  </section><button id="plain">Unannotated</button>`;
  const selected = vi.fn();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 210,
    bottom: 60,
    width: 200,
    height: 40,
    toJSON: () => ({}),
  });
  const runtime = createCanvasSelectionRuntime({ onSelection: selected });
  runtime.start();

  document.querySelector('#hit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.querySelector('#plain')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();

  expect(selected).toHaveBeenCalledOnce();
  expect(selected).toHaveBeenCalledWith({
    kind: 'field',
    target: target('blocks[_id=one].heading'),
  });
  const overlay = document.querySelector<HTMLElement>('[data-handover-canvas-overlay]');
  expect(overlay?.shadowRoot?.querySelectorAll('.box.selected')).toHaveLength(2);
  expect(overlay?.shadowRoot?.querySelector('.path-current')?.textContent).toBe(
    'Heading · 2 occurrences',
  );
  expect(overlay?.shadowRoot?.querySelector('.path')?.getAttribute('title')).toBe(
    'Page / Block 1 / Heading · 2 occurrences',
  );

  runtime.dispose();
});

test('hit testing reaches a full-bleed image and exposes its direct replacement action', async () => {
  document.body.innerHTML = `<section id="hero" ${mark('block', 'blocks[_id=hero]')}>
    <h1 ${mark('field', 'blocks[_id=hero].heading')}>Home</h1>
    <img id="hero-image" ${mark('field', 'blocks[_id=hero].image')} alt="Harbour" />
  </section>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.id === 'hero-image' ? new DOMRect(0, 0, 800, 500) : new DOMRect(20, 20, 240, 80);
  });
  const selected = vi.fn();
  const action = vi.fn();
  const runtime = createCanvasSelectionRuntime({ onSelection: selected, onAction: action });
  runtime.start();

  document
    .querySelector('#hero')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 700, clientY: 400 }));

  expect(selected).toHaveBeenCalledWith({
    kind: 'field',
    target: target('blocks[_id=hero].image'),
  });
  const selection = { kind: 'field' as const, target: target('blocks[_id=hero].image') };
  runtime.actions(selection, ['replace-media']);
  await settle();
  const replace = document
    .querySelector<HTMLElement>('[data-handover-canvas-overlay]')
    ?.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Replace Image"]');
  expect(replace?.textContent).toBe('Replace image');
  replace?.click();
  expect(action).toHaveBeenCalledWith('replace-media', selection);

  runtime.dispose();
});

test('a single click activates an annotated link control without navigating it', () => {
  document.body.innerHTML = `<a id="cta" href="https://example.com" ${mark('field', 'button')}>Book now</a>`;
  const selected = vi.fn();
  const activate = vi.fn(() => true);
  const anchor = document.querySelector<HTMLAnchorElement>('#cta');
  const runtime = createCanvasSelectionRuntime({ onSelection: selected, onActivate: activate });
  runtime.start();

  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  anchor?.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(selected).toHaveBeenCalledWith({ kind: 'field', target: target('button') });
  expect(activate).toHaveBeenCalledWith({ kind: 'field', target: target('button') }, anchor, {
    trigger: anchor,
    point: { x: 0, y: 0 },
  });
  runtime.dispose();
});

test('arrow keys preview siblings, Enter selects, and Shift+ArrowUp cannot select a populated parent list', () => {
  document.body.innerHTML = `<main ${mark('list', 'blocks')}>
    <section id="one" ${mark('block', 'blocks[_id=one]')}>One</section>
    <section id="two" ${mark('block', 'blocks[_id=two]')}>Two</section>
  </main>`;
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const selected = vi.fn();
  const runtime = createCanvasSelectionRuntime({ onSelection: selected });
  runtime.start();

  document.querySelector('#one')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(selected).toHaveBeenLastCalledWith({ kind: 'block', target: target('blocks[_id=two]') });
  expect(scroll).toHaveBeenCalled();

  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }),
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(selected).toHaveBeenLastCalledWith({ kind: 'block', target: target('blocks[_id=two]') });

  runtime.dispose();
});

test('selected blocks expose direct permitted icons without Replace or a menu', async () => {
  document.body.innerHTML = `<main ${mark('list', 'blocks')}>
    <section id="one" ${mark('block', 'blocks[_id=one]')}>One</section>
    <div id="empty" ${mark('list', 'sidebar')}>Nothing here</div>
  </main>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 210,
    bottom: 60,
    width: 200,
    height: 40,
    toJSON: () => ({}),
  });
  const action = vi.fn();
  const runtime = createCanvasSelectionRuntime({ onAction: action } as never);
  runtime.start();

  document.querySelector('#one')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  runtime.actions({ kind: 'block', target: target('blocks[_id=one]') }, [
    'insert-before',
    'insert-after',
    'replace',
    'duplicate',
    'delete',
    'undo',
  ]);
  await settle();
  const overlay = document.querySelector<HTMLElement>('[data-handover-canvas-overlay]');
  const controls = Array.from(
    overlay?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.actions button') ?? [],
  );
  expect(controls.map((button) => button.getAttribute('aria-label'))).toEqual([
    'Insert before Block 1',
    'Insert after Block 1',
    'Duplicate Block 1',
    'Delete Block 1',
  ]);
  expect(overlay?.shadowRoot?.querySelector('[data-canvas-actions-toggle]')).toBeNull();
  expect(overlay?.shadowRoot?.querySelector('[data-canvas-action="replace"]')).toBeNull();
  for (const button of controls.slice(2)) {
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.title).toBe(button.getAttribute('aria-label'));
    button.click();
    expect(action).toHaveBeenLastCalledWith(button.dataset.canvasAction, {
      kind: 'block',
      target: target('blocks[_id=one]'),
    });
  }
  controls[1]?.click();
  expect(action).toHaveBeenCalledWith('insert-after', {
    kind: 'block',
    target: target('blocks[_id=one]'),
  });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  expect(action).toHaveBeenLastCalledWith('undo', {
    kind: 'block',
    target: target('blocks[_id=one]'),
  });

  document.querySelector('#empty')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  runtime.actions({ kind: 'list', target: target('sidebar') }, ['insert-empty']);
  await settle();
  const add = overlay?.shadowRoot?.querySelector<HTMLButtonElement>('.actions button');
  expect(add?.getAttribute('aria-label')).toBe('Add block to Sidebar');
  add?.click();
  expect(action).toHaveBeenCalledWith('insert-empty', {
    kind: 'list',
    target: target('sidebar'),
  });

  runtime.dispose();
});

test('live locale changes translate the retained selection, focused actions, and announcements', async () => {
  document.body.innerHTML = `<main ${mark('list', 'blocks')}>
    <section id="one" ${mark('block', 'blocks[_id=one]')}>One</section>
  </main>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 20, 200, 40),
  );
  const uiLocale = createCanvasUiLocaleState('en');
  const runtime = createCanvasSelectionRuntime({ uiLocale });
  runtime.start();

  document.querySelector('#one')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const selected = { kind: 'block' as const, target: target('blocks[_id=one]') };
  runtime.actions(selected, ['replace', 'duplicate', 'delete']);
  await settle();

  const overlay = document.querySelector<HTMLElement>('[data-handover-canvas-overlay]');
  const shadow = overlay?.shadowRoot;
  expect(overlay?.lang).toBe('en');
  expect(shadow?.querySelector('.live')?.textContent).toBe('Block 1, 1 of 1 in Blocks, selected.');
  shadow?.querySelector<HTMLButtonElement>('[data-canvas-action="duplicate"]')?.focus();
  const focused = shadow?.activeElement;
  expect(focused?.getAttribute('aria-label')).toBe('Duplicate Block 1');

  uiLocale.set('de');
  await settle();

  expect(document.querySelector('[data-handover-canvas-overlay]')).toBe(overlay);
  expect(overlay?.lang).toBe('de');
  expect(runtime.selection()).toEqual(selected);
  expect(shadow?.querySelector('.path')?.getAttribute('title')).toBe('Seite / Blocks / Block 1');
  expect(shadow?.activeElement?.getAttribute('aria-label')).toBe('Block 1 duplizieren');
  expect(
    Array.from(shadow?.querySelectorAll('.action-row button') ?? []).map((button) =>
      button.getAttribute('aria-label'),
    ),
  ).toEqual(['Block 1 duplizieren', 'Block 1 löschen']);
  expect(shadow?.querySelector('.live')?.textContent).toBe(
    'Block 1, 1 von 1 in Blocks, ausgewählt.',
  );

  runtime.dispose();
});

test('a block is named by the template, and only an unnamed one falls back to its position', () => {
  document.body.innerHTML = `
    <main ${mark('list', 'blocks')}>
      <section ${mark('block', 'blocks[_id=one]')} data-handover-name="Hero"></section>
      <section ${mark('block', 'blocks[_id=two]')} data-handover-name="Walk to the harbour"></section>
      <section ${mark('block', 'blocks[_id=three]')}></section>
    </main>`;
  const runtime = createCanvasSelectionRuntime();
  runtime.start();

  expect(runtime.structure().map((node) => node.label)).toEqual([
    'Blocks',
    'Hero',
    'Walk to the harbour',
    'Block 3',
  ]);
  expect(runtime.structure().every((node) => !('named' in node))).toBe(true);

  runtime.dispose();
});

test('a long authored block name stays within the Structure wire limit', () => {
  document.body.innerHTML = `
    <main ${mark('list', 'blocks')}>
      <section ${mark('block', 'blocks[_id=hero]')} data-handover-name="${'A'.repeat(201)}"></section>
    </main>`;
  const runtime = createCanvasSelectionRuntime();
  runtime.start();
  expect(runtime.structure().find((node) => node.kind === 'block')?.label).toHaveLength(200);
  runtime.dispose();
});

test('trimming a long block name to the wire limit does not split a surrogate pair', () => {
  const name = `${'A'.repeat(199)}\u{1F600}`; // 😀 straddles the 200-unit cutoff
  document.body.innerHTML = `
    <main ${mark('list', 'blocks')}>
      <section ${mark('block', 'blocks[_id=hero]')} data-handover-name="${name}"></section>
    </main>`;
  const runtime = createCanvasSelectionRuntime();
  runtime.start();
  const label = runtime.structure().find((node) => node.kind === 'block')?.label ?? '';
  const lastUnit = label.charCodeAt(label.length - 1);
  expect(lastUnit).not.toBeGreaterThanOrEqual(0xd800);
  expect(label).toBe('A'.repeat(199));
  runtime.dispose();
});

test('a list annotated on its own block element is ordered under that block, not before it', () => {
  document.body.innerHTML = `
    <main ${mark('list', 'blocks')}>
      <section ${mark('block', 'blocks[_id=hero]')} data-handover-name="Hero">
        <h1 ${mark('field', 'blocks[_id=hero].heading')}></h1>
      </section>
      <section ${mark('block', 'blocks[_id=cols]')} data-handover-name="Two columns" ${mark('list', 'blocks[_id=cols].columns')}>
        <div ${mark('block', 'blocks[_id=cols].columns[_id=left]')} ${mark('list', 'blocks[_id=cols].columns[_id=left].blocks')}></div>
      </section>
    </main>`;
  const runtime = createCanvasSelectionRuntime();
  runtime.start();

  expect(runtime.structure().map((node) => `${node.label}:${node.depth}`)).toEqual([
    'Blocks:1',
    'Hero:2',
    'Heading:3',
    'Two columns:2',
    'Columns:3',
    'Block 1:4',
    'Blocks:5',
  ]);

  runtime.dispose();
});

test('a first click activates a text field at the character the reader clicked', () => {
  document.body.innerHTML = `<h1 id="hero" ${mark('field', 'heading')}>Move to the coast</h1>`;
  const heading = document.querySelector<HTMLElement>('#hero');
  const text = heading?.firstChild as Text;
  document.caretPositionFromPoint = vi.fn(() => ({ offsetNode: text, offset: 8 })) as never;
  const activate = vi.fn(() => true);
  const runtime = createCanvasSelectionRuntime({ onActivate: activate });
  runtime.start();

  heading?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 120, clientY: 40 }),
  );

  expect(activate).toHaveBeenCalledWith({ kind: 'field', target: target('heading') }, heading, {
    caret: 8,
    point: { x: 120, y: 40 },
  });

  runtime.dispose();
  document.caretPositionFromPoint = undefined as never;
});

test('a field being edited keeps only its Inspector button', async () => {
  document.body.innerHTML = `<h1 id="hero" ${mark('field', 'heading')}>Move to the coast</h1>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 210,
    bottom: 60,
    width: 200,
    height: 40,
    toJSON: () => ({}),
  });
  const action = vi.fn();
  const runtime = createCanvasSelectionRuntime({ onAction: action, isEditing: () => true });
  runtime.start();

  document.querySelector('#hero')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const selection = { kind: 'field' as const, target: target('heading') };
  runtime.actions(selection, ['inspect', 'replace-media']);
  await settle();

  const controls = Array.from(
    document
      .querySelector<HTMLElement>('[data-handover-canvas-overlay]')
      ?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.actions button') ?? [],
  );
  expect(controls.map((button) => button.dataset.canvasAction)).toEqual(['inspect']);
  expect(controls[0]?.getAttribute('aria-label')).toBe('Open Heading in the Inspector');
  // The press commits on pointerdown: the blur it causes redraws the button before a click lands.
  controls[0]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  expect(action).toHaveBeenCalledWith('inspect', selection);

  runtime.dispose();
});

test('populated list wrappers have no hover or selection outline and leave their children selectable', async () => {
  document.body.innerHTML = `<main id="area" ${mark('list', 'blocks')}>
    <section id="block" ${mark('block', 'blocks[_id=one]')}>
      <h2 id="heading" ${mark('field', 'blocks[_id=one].heading')}>One</h2>
    </section>
  </main>`;
  const selected = vi.fn();
  const runtime = createCanvasSelectionRuntime({ onSelection: selected });
  runtime.start();
  const area = document.querySelector('#area');
  area?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
  area?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(runtime.select({ kind: 'list', target: target('blocks') })).toBe(false);
  await settle();
  expect(selected).not.toHaveBeenCalled();
  expect(runtime.selection()).toBeUndefined();
  const overlay = document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot;
  expect(overlay?.querySelectorAll('.box')).toHaveLength(0);
  document.querySelector('#block')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(runtime.selection()).toEqual({ kind: 'block', target: target('blocks[_id=one]') });
  document.querySelector('#heading')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(runtime.selection()).toEqual({ kind: 'field', target: target('blocks[_id=one].heading') });
  runtime.dispose();
});

test.each(['parent', 'image'])(
  'hovering %s outside active text shows its outline without changing selection',
  async (hover) => {
    document.body.innerHTML = `<section id="parent" ${mark('block', 'blocks[_id=hero]')}>
    <h1 id="heading" ${mark('field', 'blocks[_id=hero].heading')}>Home</h1>
    ${hover === 'image' ? `<img id="image" ${mark('field', 'blocks[_id=hero].image')} />` : ''}
  </section>`;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return this.id === 'heading' ? new DOMRect(20, 20, 240, 80) : new DOMRect(0, 0, 800, 500);
    });
    const runtime = createCanvasSelectionRuntime({ isEditing: () => true });
    runtime.start();
    runtime.select({ kind: 'field', target: target('blocks[_id=hero].heading') });
    document
      .querySelector('#parent')
      ?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 700, clientY: 400 }));
    await settle();
    const overlay = document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot;
    expect(overlay?.querySelectorAll('.box.selected')).toHaveLength(1);
    expect(overlay?.querySelector<HTMLElement>('.path:not(.hover-path)')?.hidden).toBe(false);
    expect(overlay?.querySelector('.path:not(.hover-path) .path-current')?.textContent).toBe(
      'Heading',
    );
    expect(overlay?.querySelector<HTMLElement>('.hover-path')?.hidden).toBe(false);
    expect(overlay?.querySelector('.hover-path .path-current')?.textContent).toBe(
      hover === 'image' ? 'Image' : 'Block 1',
    );
    expect(overlay?.querySelector<HTMLElement>('.box.hover')?.style.width).toBe('800px');
    expect(runtime.selection()).toEqual({
      kind: 'field',
      target: target('blocks[_id=hero].heading'),
    });
    document
      .querySelector('#heading')
      ?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }));
    await settle();
    expect(overlay?.querySelectorAll('.box.hover')).toHaveLength(0);
    runtime.dispose();
  },
);

test('shared targets explain ownership and link to their source in a new tab', async () => {
  const sharedTarget = {
    ...target('button'),
    document: { collection: 'globals', id: 'cta/newsletter' },
  };
  document.body.innerHTML = `<a id="shared" href="#" data-handover-field='${JSON.stringify(sharedTarget)}'>Newsletter</a>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(20, 40, 200, 50),
  );
  const activate = vi.fn();
  const runtime = createCanvasSelectionRuntime({
    entryDocument: target('').document,
    adminBase: '/demo/admin',
    onActivate: activate,
  });
  runtime.start();
  document.querySelector('#shared')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await settle();
  const overlay = document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot;
  expect(overlay?.querySelector('.box.selected.shared')).not.toBeNull();
  expect(overlay?.querySelector('.path.shared')?.textContent).toBe('Shared · Button');
  const panel = overlay?.querySelector<HTMLElement>('[role="dialog"]');
  expect(panel?.hidden).toBe(false);
  expect(panel?.textContent).toContain('Changes there appear everywhere');
  const link = panel?.querySelector('a');
  expect(link?.getAttribute('href')).toBe(
    '/demo/admin/site/cta%2Fnewsletter?field=button&locale=en',
  );
  expect(link?.target).toBe('_blank');
  expect(link?.rel).toContain('noopener');
  const enter = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  link?.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(activate).not.toHaveBeenCalled();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(panel?.hidden).toBe(true);
  runtime.dispose();
});

test('container rows retain their structure but skip pointer, external, and keyboard selection', async () => {
  document.body.innerHTML = `<section id="columns" ${mark('block', 'blocks[_id=columns]')}>
    <div id="row" data-handover-container="true" ${mark('block', 'blocks[_id=columns].columns[_id=right]')}>
      <h2 id="heading" ${mark('field', 'blocks[_id=columns].columns[_id=right].heading')}>Heading</h2>
    </div>
  </section>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.id === 'heading' ? new DOMRect(20, 20, 200, 80) : new DOMRect(0, 0, 800, 500);
  });
  Element.prototype.scrollIntoView = vi.fn();
  const runtime = createCanvasSelectionRuntime();
  runtime.start();
  const row = runtime.structure().find((node) => node.container);
  expect(row?.target.address).toBe('blocks[_id=columns].columns[_id=right]');
  document
    .querySelector('#row')
    ?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 700, clientY: 400 }));
  document
    .querySelector('#row')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 700, clientY: 400 }));
  expect(runtime.selection()).toBeUndefined();
  expect(row && runtime.select(row)).toBe(false);
  await settle();
  expect(
    document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot?.querySelectorAll('.box'),
  ).toHaveLength(0);
  document
    .querySelector('#heading')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 }));
  expect(runtime.selection()?.kind).toBe('field');
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }),
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(runtime.selection()).toEqual({ kind: 'block', target: target('blocks[_id=columns]') });
  runtime.dispose();
});

test.each(['pointer', 'keyboard'])(
  'a %s breadcrumb selects the owning block and leaves its fields directly selectable',
  async (input) => {
    document.body.innerHTML = `<section id="hero" data-handover-name="Hero" ${mark('block', 'blocks[_id=hero]')}>
    <div data-handover-container="true" ${mark('block', 'blocks[_id=hero].rows[_id=row]')}>
      <h1 id="heading" ${mark('field', 'blocks[_id=hero].rows[_id=row].heading')}>Home</h1>
    </div>
  </section>`;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(20, 80, 400, 200),
    );
    const selected = vi.fn();
    const runtime = createCanvasSelectionRuntime({ onSelection: selected });
    runtime.start();
    document
      .querySelector('#heading')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 100 }));
    await settle();
    const shadow = document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot;
    const breadcrumb = shadow?.querySelector<HTMLButtonElement>('.path:not(.hover-path) button');
    expect(breadcrumb?.getAttribute('aria-label')).toBe('Select Hero block');
    expect(shadow?.querySelectorAll('.path:not(.hover-path) button')).toHaveLength(2);
    if (input === 'pointer')
      breadcrumb?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    else {
      breadcrumb?.focus();
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      breadcrumb?.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(false);
      breadcrumb?.click();
    }
    expect(selected).toHaveBeenLastCalledWith({
      kind: 'block',
      target: target('blocks[_id=hero]'),
    });
    runtime.actions({ kind: 'block', target: target('blocks[_id=hero]') }, [
      'move',
      'move-up',
      'move-down',
    ]);
    await settle();
    expect(shadow?.querySelector('[data-canvas-action="move"]')).not.toBeNull();
    document
      .querySelector('#heading')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 100 }));
    expect(runtime.selection()?.kind).toBe('field');
    runtime.dispose();
  },
);

test.each(['pointer', 'keyboard'])(
  'the hovered element breadcrumb selects that field via %s',
  async (input) => {
    document.body.innerHTML = `<section id="hero" data-handover-name="Hero" ${mark('block', 'blocks[_id=hero]')}>
    <h1 id="heading" ${mark('field', 'blocks[_id=hero].heading')}>Home</h1>
  </section>`;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(20, 80, 400, 200),
    );
    const selected = vi.fn();
    const runtime = createCanvasSelectionRuntime({ onSelection: selected });
    runtime.start();
    runtime.select({ kind: 'block', target: target('blocks[_id=hero]') });
    document
      .querySelector('#heading')
      ?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 100 }));
    await settle();
    const shadow = document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot;
    const button = shadow?.querySelector<HTMLButtonElement>('.hover-path .path-current');
    expect(button?.getAttribute('aria-label')).toBe('Select Heading');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    if (input === 'pointer')
      button?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    else {
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      button?.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(false);
      button?.click();
    }
    expect(selected).toHaveBeenLastCalledWith({
      kind: 'field',
      target: target('blocks[_id=hero].heading'),
    });
    await settle();
    expect(
      shadow?.querySelector('.path:not(.hover-path) .path-current')?.getAttribute('aria-pressed'),
    ).toBe('true');
    runtime.dispose();
  },
);

test('validation outlines the closest rendered owner, excludes shared content, and clears live', async () => {
  document.body.innerHTML = `<section ${mark('block', 'blocks[_id=one]')}>
    <h2 ${mark('field', 'blocks[_id=one].heading')}>Heading</h2>
  </section><p data-handover-field='${JSON.stringify({
    ...target('blocks[_id=one].heading'),
    document: { collection: 'globals', id: 'header' },
  })}'>Shared</p>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 20, 200, 40),
  );
  const runtime = createCanvasSelectionRuntime({ entryDocument: target('').document });
  runtime.start();
  runtime.problems(['blocks[_id=one].heading', 'blocks[_id=one].image']);
  await settle();
  const shadow = document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot;
  expect(shadow?.querySelectorAll('.box.invalid')).toHaveLength(2);
  runtime.problems([]);
  await settle();
  expect(shadow?.querySelectorAll('.box.invalid')).toHaveLength(0);
  runtime.dispose();
});

test('a redraw with the same block selected reuses Sortables; a selection change rebuilds them', async () => {
  document.body.innerHTML = `
    <main ${mark('list', 'blocks')}>
      <section data-handover-name="One" ${mark('block', 'blocks[_id=one]')}><p>One</p></section>
      <section data-handover-name="Two" ${mark('block', 'blocks[_id=two]')}><p>Two</p></section>
      <section data-handover-name="Three" ${mark('block', 'blocks[_id=three]')}><p>Three</p></section>
    </main>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 40));
  sortableCounts.constructed = 0;
  sortableCounts.destroyed = 0;
  const runtime = createCanvasSelectionRuntime();
  runtime.start();
  runtime.select({ kind: 'block', target: target('blocks[_id=one]') });
  runtime.actions({ kind: 'block', target: target('blocks[_id=one]') }, ['move']);
  await settle();
  expect(sortableCounts.destroyed).toBe(0);

  window.dispatchEvent(new Event('resize'));
  await settle();
  window.dispatchEvent(new Event('resize'));
  await settle();
  expect(sortableCounts.destroyed).toBe(0);

  runtime.select({ kind: 'block', target: target('blocks[_id=two]') });
  runtime.actions({ kind: 'block', target: target('blocks[_id=two]') }, ['move']);
  await settle();
  expect(sortableCounts.destroyed).toBeGreaterThan(0);

  runtime.dispose();
});

test('hovering with nothing selected never builds the hidden hover breadcrumb', async () => {
  document.body.innerHTML = `<h1 id="hero" ${mark('field', 'heading')}>Move to the coast</h1>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 20, 200, 40),
  );
  const runtime = createCanvasSelectionRuntime();
  runtime.start();

  document
    .querySelector('#hero')
    ?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }));
  await settle();

  const shadow = document.querySelector('[data-handover-canvas-overlay]')?.shadowRoot;
  expect(shadow?.querySelector('.hover-path .path-current')).toBeNull();
  runtime.dispose();
});
