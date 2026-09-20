import { DEFAULT_MAX } from '@handover/core';
import { messageText, responseMessage, type UiMessage } from '../errors.js';
import { languageTag, type UiLocale } from '../i18n.js';
import { request, uncertainResponse } from '../request.js';
/** One asset as the admin answers for it: the key a content file stores, and where it is served. */
export interface MediaItem {
  id: string;
  src: string;
  /** What the library lists it by, and a file field's first name. */
  filename?: string | null;
  url?: string;
  mime?: string | null;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
  /** The library default copied into content when this picture is first chosen. */
  alt?: string | null;
  /** Where every crop of this picture holds, as a fraction of its width and of its height. */
  focal?: [number, number] | null;
}

/** The same asset as the library screen knows it: what it is called, and where it is used. */
export interface LibraryItem extends MediaItem {
  tags?: string[];
  archived?: boolean;
  createdAt?: number;
  uses?: { entry: string; title: string; href: string }[];
}

/** A size a client reads rather than a byte count; nothing stored is ever "0 KB". */
export const fileSize = (bytes?: number | null, locale: UiLocale = 'en') => {
  if (!bytes) return '';
  const value =
    bytes < 1024 * 1024
      ? Math.max(1, Math.round(bytes / 1024))
      : Math.round(bytes / 104_857.6) / 10;
  let formatter = fileSizeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(languageTag(locale));
    fileSizeFormatters.set(locale, formatter);
  }
  return `${formatter.format(value)} ${bytes < 1024 * 1024 ? 'KB' : 'MB'}`;
};

const fileSizeFormatters = new Map<UiLocale, Intl.NumberFormat>();

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export class MediaUploadError extends Error {
  constructor(
    readonly descriptor: UiMessage,
    message = descriptor.detail ?? messageText(descriptor, 'en'),
  ) {
    super(message);
    this.name = 'MediaUploadError';
  }
}

const detailOf = (error: unknown) => (error instanceof Error ? error.message : undefined);
const failure = (code: string, error?: unknown, status?: number, message?: string) =>
  new MediaUploadError(
    {
      code,
      ...(status ? { status } : {}),
      ...(detailOf(error) ? { detail: detailOf(error) } : {}),
    },
    message ?? detailOf(error),
  );
const responseFailure = async (response: Response, code: string) => {
  const descriptor = await responseMessage(response, code);
  return new MediaUploadError(
    descriptor,
    descriptor.detail ?? `the upload failed (${response.status})`,
  );
};
const mediaItem = (value: unknown): value is MediaItem => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MediaItem>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.src === 'string' &&
    item.src.length > 0
  );
};

/** Bytes pass through the authenticated upload route into private staging, then confirmation publishes them. */
export async function uploadBlob(
  blob: Blob,
  about: { filename?: string; width?: number; height?: number; derivedFrom?: string },
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<MediaItem> {
  const { fetch = request } = deps;
  let hash: string;
  try {
    hash = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  } catch (error) {
    throw failure('MEDIA_UPLOAD_FAILED', error);
  }
  const declared = { hash, bytes: blob.size, mime: blob.type, ...about };
  let asked: Response;
  try {
    asked = await fetch('/admin/api/media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(declared),
    });
  } catch (error) {
    throw failure('MEDIA_UPLOAD_DECLARATION_UNCONFIRMED', error);
  }
  if (!asked.ok) {
    if (uncertainResponse(asked))
      throw failure('MEDIA_UPLOAD_DECLARATION_UNCONFIRMED', undefined, asked.status);
    throw await responseFailure(asked, 'MEDIA_UPLOAD_DECLARATION_FAILED');
  }
  let body: unknown;
  try {
    body = await asked.json();
  } catch (error) {
    throw failure('MEDIA_UPLOAD_DECLARATION_INVALID', error);
  }
  if (!body || typeof body !== 'object') throw failure('MEDIA_UPLOAD_DECLARATION_INVALID');
  const answer = body as { media?: unknown; upload?: { url?: unknown; key?: unknown } };
  if (answer.media !== undefined) {
    if (!mediaItem(answer.media)) throw failure('MEDIA_UPLOAD_DECLARATION_INVALID');
    return answer.media;
  }
  if (
    typeof answer.upload?.url !== 'string' ||
    !answer.upload.url ||
    typeof answer.upload.key !== 'string' ||
    !answer.upload.key
  )
    throw failure('MEDIA_UPLOAD_DECLARATION_INVALID');
  let put: Response;
  try {
    put = await fetch(answer.upload.url, {
      method: 'PUT',
      headers: {
        'content-type': blob.type,
        // A file the bucket's domain would render is an XSS vector, so it is stored as a download.
        ...(blob.type.startsWith('image/') ? {} : { 'content-disposition': 'attachment' }),
      },
      body: blob,
    });
  } catch (error) {
    throw failure('MEDIA_UPLOAD_BUCKET_UNCONFIRMED', error);
  }
  if (!put.ok)
    throw failure(
      'MEDIA_UPLOAD_BUCKET_FAILED',
      undefined,
      put.status,
      `the bucket would not take the upload (${put.status})`,
    );
  let confirmed: Response;
  try {
    confirmed = await fetch(`/admin/api/media/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...declared, key: answer.upload.key }),
    });
  } catch (error) {
    throw failure('MEDIA_UPLOAD_CONFIRMATION_UNCONFIRMED', error);
  }
  if (!confirmed.ok) {
    if (uncertainResponse(confirmed))
      throw failure('MEDIA_UPLOAD_CONFIRMATION_UNCONFIRMED', undefined, confirmed.status);
    throw await responseFailure(confirmed, 'MEDIA_UPLOAD_CONFIRMATION_FAILED');
  }
  let confirmedBody: unknown;
  try {
    confirmedBody = await confirmed.json();
  } catch (error) {
    throw failure('MEDIA_UPLOAD_CONFIRMATION_INVALID', error);
  }
  if (!confirmedBody || typeof confirmedBody !== 'object')
    throw failure('MEDIA_UPLOAD_CONFIRMATION_INVALID');
  const result = confirmedBody as { media?: unknown };
  if (!mediaItem(result.media)) throw failure('MEDIA_UPLOAD_CONFIRMATION_INVALID');
  return result.media;
}

/** Strips EXIF so no GPS reaches a public bucket; 0.9 because every crop re-encodes from this. */
export async function normaliseImage(
  file: File,
  max = DEFAULT_MAX,
): Promise<{ blob: Blob; width: number; height: number }> {
  const source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, max / Math.max(source.width, source.height));
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(source, 0, 0, width, height);
  source.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.9),
  );
  if (!blob) throw new Error('the image could not be read');
  return { blob, width, height };
}

/** A file chosen in the admin: hashed and stored as it is, since only a picture is re-encoded. */
export function uploadFile(
  file: File,
  opts: { fetch?: typeof globalThis.fetch } = {},
): Promise<MediaItem> {
  return uploadBlob(file, { filename: file.name }, { fetch: opts.fetch });
}

/** A picture chosen in the admin, normalised and stored. */
export async function uploadImage(
  file: File,
  opts: { max?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<MediaItem> {
  let normalised: Awaited<ReturnType<typeof normaliseImage>>;
  try {
    normalised = await normaliseImage(file, opts.max);
  } catch (error) {
    throw failure('MEDIA_UPLOAD_NORMALIZATION_FAILED', error);
  }
  const { blob, width, height } = normalised;
  return uploadBlob(blob, { filename: file.name, width, height }, { fetch: opts.fetch });
}
