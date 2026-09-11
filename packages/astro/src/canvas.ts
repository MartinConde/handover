export const CANVAS_PROTOCOL = 1 as const;

export interface CanvasDocumentIdentity {
  collection: string;
  id: string;
}

export interface EditLocation {
  document: CanvasDocumentIdentity;
  locale: string;
  address: string;
}

/** Verified by the preview route before it is made visible to a site's templates. */
export interface HandoverCanvas {
  protocol: typeof CANVAS_PROTOCOL;
  requestId: string;
  epoch: string;
  entry: CanvasDocumentIdentity;
  locale: string;
  contentVersion: number;
}

interface AstroWithLocals {
  locals?: { handoverCanvas?: unknown };
}

export interface EditTarget extends EditLocation {
  /** Where this source is rendered when it belongs to a referenced document. */
  occurrence?: EditLocation;
}

export type EditAttributes = Partial<
  Record<
    'data-handover-field' | 'data-handover-list' | 'data-handover-block' | 'data-handover-name',
    string
  >
>;

/** What a block is called in Handover's own editors: the author's `_label`, else its `_type`. */
export interface EditBlock {
  _id: string;
  _ref?: string;
  _type?: string;
  _label?: string;
}

export interface EditContext extends EditAttributes {
  readonly active: boolean;
  readonly target?: EditTarget;
  child(name: string): EditContext;
  field(name: string): EditContext;
  list(name: string): EditContext;
  block(id: string | EditBlock): EditContext;
}

export interface CanvasSuccessManifest extends HandoverCanvas {
  mode: 'canvas';
  status: 'success';
  /** Authenticated, base-aware route used by the iframe's page and entry pickers. */
  entryDirectory: string;
}

export interface CanvasErrorManifest {
  mode: 'canvas';
  status: 'error';
  protocol: typeof CANVAS_PROTOCOL;
  requestId?: string;
  epoch?: string;
  contentVersion?: number;
  error: { status: number; message: string };
}

export type CanvasResultManifest = CanvasSuccessManifest | CanvasErrorManifest;

declare global {
  namespace App {
    interface Locals {
      handoverCanvas?: HandoverCanvas;
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Do not let an unrelated local with the same name turn public markup into editing markup. */
export function handoverCanvas(astro: AstroWithLocals): HandoverCanvas | undefined {
  const value = astro.locals?.handoverCanvas;
  if (!object(value) || !object(value.entry)) return undefined;
  if (
    value.protocol !== CANVAS_PROTOCOL ||
    typeof value.requestId !== 'string' ||
    typeof value.epoch !== 'string' ||
    typeof value.entry.collection !== 'string' ||
    typeof value.entry.id !== 'string' ||
    typeof value.locale !== 'string' ||
    !Number.isSafeInteger(value.contentVersion) ||
    (value.contentVersion as number) < 0
  )
    return undefined;
  return value as unknown as HandoverCanvas;
}

export function isCanvas(astro: AstroWithLocals): boolean {
  return handoverCanvas(astro) !== undefined;
}

const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32);

const name = (value: string, label: string) => {
  if (!value || hasControlCharacter(value)) throw new Error(`Canvas ${label} must not be empty.`);
  return value;
};

const join = (base: string, child: string) => (base ? `${base}.${child}` : child);

const location = (
  canvas: HandoverCanvas | undefined,
  document: CanvasDocumentIdentity | undefined,
  address: string,
): EditLocation | undefined =>
  canvas && document ? { document, locale: canvas.locale, address } : undefined;

const target = (
  canvas: HandoverCanvas | undefined,
  document: CanvasDocumentIdentity | undefined,
  address: string,
  occurrence?: EditLocation,
): EditTarget | undefined => {
  const source = location(canvas, document, address);
  return source ? { ...source, ...(occurrence ? { occurrence } : {}) } : undefined;
};

/** Matches the block cards in the form editor, so one block reads the same in both surfaces. */
const blockName = (block: EditBlock) => {
  const named =
    block._label?.trim() ||
    (block._type ?? '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .trim();
  if (!named || hasControlCharacter(named)) return undefined;
  return named.charAt(0).toUpperCase() + named.slice(1);
};

const globalDocument = (reference: string | undefined): CanvasDocumentIdentity | undefined => {
  const id = reference?.startsWith('globals/') ? reference.slice('globals/'.length) : '';
  return id ? { collection: 'globals', id } : undefined;
};

function editContext(
  canvas: HandoverCanvas | undefined,
  document: CanvasDocumentIdentity | undefined = canvas?.entry,
  address = '',
  mark?: 'field' | 'list' | 'block',
  occurrence?: EditLocation,
  marker?: EditTarget,
  named?: string,
): EditContext {
  const editTarget = target(canvas, document, address, occurrence);
  const context = {} as EditContext;
  if ((marker ?? editTarget) && mark) {
    Object.defineProperty(context, `data-handover-${mark}`, {
      enumerable: true,
      value: JSON.stringify(marker ?? editTarget),
    });
    if (named)
      Object.defineProperty(context, 'data-handover-name', { enumerable: true, value: named });
  }
  Object.defineProperties(context, {
    active: { enumerable: false, value: canvas !== undefined },
    target: { enumerable: false, value: editTarget },
    child: {
      enumerable: false,
      value: (child: string) =>
        editContext(canvas, document, join(address, name(child, 'child')), undefined, occurrence),
    },
    field: {
      enumerable: false,
      value: (field: string) =>
        editContext(canvas, document, join(address, name(field, 'field')), 'field', occurrence),
    },
    list: {
      enumerable: false,
      value: (list: string) =>
        editContext(canvas, document, join(address, name(list, 'list')), 'list', occurrence),
    },
    block: {
      enumerable: false,
      value: (block: string | EditBlock) => {
        const id = typeof block === 'string' ? block : block?._id;
        if (!id || id.includes(']') || hasControlCharacter(id))
          throw new Error('Canvas block needs a stable _id.');
        const blockAddress = `${address}[_id=${id}]`;
        const blockTarget = target(canvas, document, blockAddress, occurrence);
        const named = typeof block === 'string' ? undefined : blockName(block);
        const owner = typeof block === 'string' ? undefined : globalDocument(block._ref);
        if (!owner)
          return editContext(canvas, document, blockAddress, 'block', occurrence, undefined, named);

        const renderedAt = occurrence ?? location(canvas, document, blockAddress);
        return editContext(canvas, owner, '', 'block', renderedAt, blockTarget, named);
      },
    },
  });
  return context;
}

/** Safe to call in every render: without a verified Canvas local every spread is empty. */
export function createEditContext(astro: AstroWithLocals): EditContext {
  return editContext(handoverCanvas(astro));
}

export function successManifest(
  canvas: HandoverCanvas,
  entryDirectory: string,
): CanvasSuccessManifest {
  return { mode: 'canvas', status: 'success', entryDirectory, ...canvas };
}

export function errorManifest(
  status: number,
  message: string,
  request?: { requestId: string; epoch: string; contentVersion: number },
): CanvasErrorManifest {
  return {
    mode: 'canvas',
    status: 'error',
    protocol: CANVAS_PROTOCOL,
    ...(request
      ? {
          requestId: request.requestId,
          epoch: request.epoch,
          contentVersion: request.contentVersion,
        }
      : {}),
    error: { status, message },
  };
}

/** JSON inside an HTML script data block must not be able to close that block. */
export function serializeCanvasManifest(manifest: CanvasResultManifest): string {
  return JSON.stringify(manifest).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });

/** A complete iframe document lets the parent distinguish a known refusal from a timeout. */
export function canvasErrorDocument(manifest: CanvasErrorManifest): string {
  const message = escapeHtml(manifest.error.message);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Canvas render failed</title></head><body><main><h1>Canvas render failed</h1><p>${message}</p></main><script type="application/json" data-handover-canvas-manifest>${serializeCanvasManifest(manifest)}</script></body></html>`;
}
