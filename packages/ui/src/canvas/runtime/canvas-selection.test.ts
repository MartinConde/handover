import { afterEach, expect, test, vi } from 'vitest';
import type { CanvasTarget } from '../canvas-bridge';
import { createCanvasSelectionRuntime } from './canvas-selection';
import { canvasNodeKey, visibleCanvasNodes } from '../canvas-structure';

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
  expect(overlay?.shadowRoot?.querySelector('.path')?.textContent).toBe('Heading · 2 occurrences');
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
  expect(activate).toHaveBeenCalledWith(
    { kind: 'field', target: target('button') },
    anchor,
    anchor,
  );
  runtime.dispose();
});

test('arrow keys preview siblings, Enter selects, and Shift+ArrowUp reaches the parent list', () => {
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
  expect(selected).toHaveBeenLastCalledWith({ kind: 'list', target: target('blocks') });

  runtime.dispose();
});

test('selected blocks and empty lists expose every permitted structural control', async () => {
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
    overlay?.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [],
  );
  expect(controls.map((button) => button.getAttribute('aria-label'))).toEqual([
    'Insert before Block 1',
    'Insert after Block 1',
    'Actions for Block 1',
  ]);
  controls[2]?.click();
  expect(
    Array.from(overlay?.shadowRoot?.querySelectorAll('.menu-item') ?? []).map((button) =>
      button.getAttribute('aria-label'),
    ),
  ).toEqual(['Replace Block 1', 'Duplicate Block 1', 'Delete Block 1']);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(overlay?.shadowRoot?.querySelector('.menu-item')).toBeNull();
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
  const add = overlay?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  expect(add?.getAttribute('aria-label')).toBe('Add block to Sidebar');
  add?.click();
  expect(action).toHaveBeenCalledWith('insert-empty', {
    kind: 'list',
    target: target('sidebar'),
  });

  runtime.dispose();
});

test('a nested pointer drag stays projected until drop and Escape cancels without an action', async () => {
  document.body.innerHTML = `<main ${mark('list', 'blocks')}>
    <section ${mark('block', 'blocks[_id=columns]')}>
      <div ${mark('list', 'blocks[_id=columns].items')}>
        <article id="nested-one" ${mark('block', 'blocks[_id=columns].items[_id=one]')}>One</article>
        <article id="nested-two" ${mark('block', 'blocks[_id=columns].items[_id=two]')}>Two</article>
      </div>
    </section>
  </main>`;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = this.id === 'nested-two' ? 200 : this.id === 'nested-one' ? 100 : 0;
    return new DOMRect(10, top, 200, 80);
  });
  const action = vi.fn();
  const interaction = vi.fn();
  const runtime = createCanvasSelectionRuntime({ onAction: action, onInteraction: interaction });
  runtime.start();
  const one = document.querySelector('#nested-one');
  one?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const selected = {
    kind: 'block' as const,
    target: target('blocks[_id=columns].items[_id=one]'),
  };
  runtime.actions(selected, ['move', 'move-down']);
  await settle();

  const overlay = document.querySelector<HTMLElement>('[data-handover-canvas-overlay]');
  const drag = () => overlay?.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label^="Drag"]');
  const pointer = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      button: { value: 0 },
      clientY: { value: y },
      pointerId: { value: 7 },
    });
    return event;
  };
  drag()?.dispatchEvent(pointer('pointerdown', 120));
  document.dispatchEvent(pointer('pointermove', 230));
  await settle();
  expect(action).not.toHaveBeenCalled();
  expect(overlay?.shadowRoot?.querySelector('.drop-slot:not([hidden])')).not.toBeNull();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(action).not.toHaveBeenCalled();
  expect(interaction).toHaveBeenLastCalledWith(selected, { dragging: false });

  await settle();
  drag()?.dispatchEvent(pointer('pointerdown', 120));
  document.dispatchEvent(pointer('pointermove', 230));
  document.dispatchEvent(pointer('pointerup', 230));
  expect(action).toHaveBeenCalledWith('move', selected, {
    kind: 'block',
    target: target('blocks[_id=columns].items[_id=two]'),
  });
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
  );
  expect(action).toHaveBeenLastCalledWith('move-down', selected);
  expect(interaction.mock.calls.map(([, state]) => state.dragging)).toEqual([
    true,
    false,
    true,
    false,
  ]);
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

test('collapsing a branch hides every row beneath it, however deep', () => {
  const node = (id: string, address: string, parentId?: string) => ({
    id,
    kind: 'block' as const,
    target: target(address),
    label: id,
    ...(parentId ? { parentId } : {}),
    depth: 1,
    position: 1,
    setSize: 1,
    occurrences: 1,
  });
  const nodes = [
    node('a', 'blocks[_id=a]'),
    node('b', 'blocks[_id=a].columns[_id=b]', 'a'),
    node('c', 'blocks[_id=a].columns[_id=b].blocks[_id=c]', 'b'),
    node('d', 'blocks[_id=d]'),
  ];

  expect(visibleCanvasNodes(nodes, {}).map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(
    visibleCanvasNodes(nodes, { [canvasNodeKey(nodes[1] as (typeof nodes)[0])]: true }).map(
      (row) => row.id,
    ),
  ).toEqual(['a', 'b', 'd']);
  expect(
    visibleCanvasNodes(nodes, { [canvasNodeKey(nodes[0] as (typeof nodes)[0])]: true }).map(
      (row) => row.id,
    ),
  ).toEqual(['a', 'd']);
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
