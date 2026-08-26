import { DEFAULT_MAX } from '@handover/core';
/** One asset as the admin answers for it: the key a content file stores, and where it is served. */
export interface MediaItem {
  id: string;
  src: string;
  /** The name it was uploaded under: what the library lists it by, and a file field's first name. */
  filename?: string | null;
  url?: string;
  mime?: string | null;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
}

/** A size a client reads rather than a byte count; nothing stored is ever "0 KB". */
export const fileSize = (bytes?: number | null) => {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / 104_857.6) / 10} MB`;
};

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const refusal = async (res: Response, what: string) => {
  const said = await res.json().catch(() => undefined);
  return new Error(
    (said as { error?: string } | undefined)?.error ?? `${what} failed (${res.status})`,
  );
};

/**
 * The upload protocol, from bytes that are ready to store: name them by their own sha-256, ask
 * the Worker whether it has them already, and only otherwise PUT them to the url it signs —
 * the bytes go to the bucket and never through the Worker. The confirm afterwards is what
 * turns the object into a row, and it is the Worker that checks the object against this
 * declaration rather than taking it.
 */
export async function uploadBlob(
  blob: Blob,
  about: { filename?: string; width?: number; height?: number },
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<MediaItem> {
  const { fetch = globalThis.fetch } = deps;
  const hash = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const declared = { hash, bytes: blob.size, mime: blob.type, ...about };
  const asked = await fetch('/admin/api/media', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(declared),
  });
  if (!asked.ok) throw await refusal(asked, 'the upload');
  const answer = (await asked.json()) as { media?: MediaItem; upload?: { url: string } };
  if (answer.media) return answer.media;
  const put = await fetch(answer.upload?.url ?? '', {
    method: 'PUT',
    headers: {
      'content-type': blob.type,
      // A file the bucket's own domain would render is an XSS vector against that domain, so it
      // is stored as a download. The confirm below holds the object to it.
      ...(blob.type.startsWith('image/') ? {} : { 'content-disposition': 'attachment' }),
    },
    body: blob,
  });
  if (!put.ok) throw new Error(`the bucket would not take the upload (${put.status})`);
  const confirmed = await fetch(`/admin/api/media/${hash}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(declared),
  });
  if (!confirmed.ok) throw await refusal(confirmed, 'the upload');
  return ((await confirmed.json()) as { media: MediaItem }).media;
}

/**
 * Step 1, and it is not about the delivery format — Cloudflare re-encodes on the way out. It
 * caps what goes over the client's uplink, bakes in the EXIF orientation and strips the rest of
 * the EXIF with it (the GPS of somebody's house must not land in a public bucket), reads the
 * dimensions the content file needs, and turns a phone's HEIC into something the admin can draw.
 * Quality 0.9 because this is the original every later crop is re-encoded from.
 */
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
  const { blob, width, height } = await normaliseImage(file, opts.max);
  return uploadBlob(blob, { filename: file.name, width, height }, { fetch: opts.fetch });
}
