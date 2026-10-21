import { AwsClient } from 'aws4fetch';
import { imageDimensions, UploadRefusedError } from './upload-bytes.js';

export interface R2Store {
  /** The S3 endpoint is named after it. */
  accountId: string;
  /** `eu` or `fedramp`: those buckets answer only on `<account>.<jurisdiction>.r2…`. */
  jurisdiction?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the browser declares, and what the object is then held to. */
export interface Upload {
  /** sha-256 hex of the bytes; names the object, so it is also the row's id. */
  hash: string;
  /** The temporary key from the upload request; never a public key. */
  key?: string;
  bytes: number;
  mime: string;
  /** Kept for search, never for addressing. */
  filename?: string;
  width?: number;
  height?: number;
  /** The picture this one was cropped out of. */
  derivedFrom?: string;
}

/** The client downscales a picture long before this cap. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// The extension comes from the verified type, never from the client's filename.
const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

const SHA256 = /^[0-9a-f]{64}$/;

/** Content-addressed and checked before signing: R2 cannot bind a size to a presigned PUT. */
export function mediaKey(upload: Upload): string {
  const ext = EXTENSIONS[upload.mime];
  if (!ext)
    throw new UploadRefusedError(
      `${upload.mime} cannot be uploaded: this site takes ${Object.keys(EXTENSIONS).join(', ')}`,
    );
  if (!SHA256.test(upload.hash))
    throw new UploadRefusedError('an upload is named by the sha-256 of its own bytes');
  if (!(Number.isInteger(upload.bytes) && upload.bytes > 0 && upload.bytes <= MAX_UPLOAD_BYTES))
    throw new UploadRefusedError(
      `an upload may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024}MB, and this one is ${Math.round(upload.bytes / 1024 / 1024)}MB`,
      upload.bytes > MAX_UPLOAD_BYTES ? 'MEDIA_TOO_LARGE' : undefined,
      MAX_UPLOAD_BYTES,
    );
  // The server picks the prefix: a browser naming its own key is an overwrite waiting to happen.
  return `${upload.mime.startsWith('image/') ? 'media' : 'files'}/${upload.hash}.${ext}`;
}

/** The key format `mediaKey` writes, and nothing else. */
export const MEDIA_KEY = /^(?:media|files)\/([0-9a-f]{64})\.([a-z0-9]+)$/;

const bucketUrl = (store: R2Store) =>
  `https://${store.accountId}${store.jurisdiction ? `.${store.jurisdiction}` : ''}.r2.cloudflarestorage.com/${store.bucket}`;

export const objectUrl = (store: R2Store, key: string) => `${bucketUrl(store)}/${key}`;

export const signer = (store: R2Store) =>
  new AwsClient({
    accessKeyId: store.accessKeyId,
    secretAccessKey: store.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

/** The key is deliberately not `mediaKey`'s shape, or the reconciliation job would adopt it. */
export async function checkStore(
  store: R2Store,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<void> {
  const { fetch = globalThis.fetch } = deps;
  const url = objectUrl(store, CHECK_KEY);
  const aws = signer(store);
  const put = await fetch(await aws.sign(url, { method: 'PUT', body: CHECK_BODY }));
  if (!put.ok)
    throw new Error(`The bucket refused the upload (${put.status})${advice(store, put.status)}`);
  const read = await fetch(await aws.sign(url, { method: 'GET' }));
  const back = read.ok ? await read.text() : '';
  // Deleted whatever the read said: a check must not leave its own object behind.
  const gone = await fetch(await aws.sign(url, { method: 'DELETE' }));
  if (!read.ok) throw new Error(`The bucket would not read the object back (${read.status})`);
  if (back !== CHECK_BODY)
    throw new Error('The bucket read back something other than what was written');
  if (!gone.ok) throw new Error(`The bucket would not delete the object again (${gone.status})`);
}

// 403 is the credential and 404 is the bucket; a bare status leaves the key holder guessing.
const advice = (store: R2Store, status: number) =>
  status === 403
    ? `: check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and that the token has Object Read & Write on ${store.bucket}`
    : status === 404
      ? `: check R2_ACCOUNT_ID and R2_BUCKET — nothing answers for ${store.bucket} on this account`
      : '';

const CHECK_KEY = 'checks/connection.txt';
const CHECK_BODY = 'handover';

export const object = async (
  store: R2Store,
  key: string,
  method: string,
  fetch: typeof globalThis.fetch,
  headers?: Record<string, string>,
) => fetch(await signer(store).sign(objectUrl(store, key), { method, headers }));

/** Asked only for a key with no row; a key with neither is a broken image on the page. */
export async function objectExists(
  store: R2Store,
  key: string,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<boolean> {
  const { fetch = globalThis.fetch } = deps;
  return (await object(store, key, 'HEAD', fetch)).ok;
}

// workerd has no XML parser, and the keys read are hex and an extension, so regexes suffice.
export const CONTENTS = /<Contents>([\s\S]*?)<\/Contents>/g;
export const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

export const MIMES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]),
);

export const mimeForMediaKey = (key: string): string | undefined =>
  MIMES[key.match(/\.([a-z0-9]+)$/)?.[1] ?? ''];

export const listPage = async (store: R2Store, fetch: typeof globalThis.fetch, token?: string) => {
  const url = new URL(bucketUrl(store));
  url.searchParams.set('list-type', '2');
  if (token) url.searchParams.set('continuation-token', token);
  const res = await fetch(await signer(store).sign(url.toString(), { method: 'GET' }));
  if (!res.ok) throw new Error(`R2 LIST ${store.bucket} failed: ${res.status}`);
  return res.text();
};

export async function verifyObject(
  store: R2Store,
  key: string,
  upload: Upload,
  fetch: typeof globalThis.fetch,
) {
  mediaKey(upload);
  const response = await object(store, key, 'GET', fetch);
  if (response.status === 404) throw new UploadRefusedError('The upload never reached the bucket');
  if (!response.ok) throw new Error(`R2 GET ${key} failed: ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new UploadRefusedError('The upload is empty', 'MEDIA_EMPTY');
  const data = new Uint8Array(upload.bytes);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > data.length)
        throw new UploadRefusedError(
          'The uploaded size differs from its declaration',
          'MEDIA_SIZE_MISMATCH',
        );
      data.set(value, size - value.byteLength);
    }
  } finally {
    await reader.cancel();
  }
  if (size !== data.length)
    throw new UploadRefusedError(
      'The uploaded size differs from its declaration',
      'MEDIA_SIZE_MISMATCH',
    );
  return verifyStaged(
    {
      data,
      mime: response.headers.get('content-type') ?? '',
      disposition: response.headers.get('content-disposition') ?? undefined,
    },
    upload,
    key,
  );
}

export async function verifyStaged(
  staged: { data: Uint8Array; mime: string; disposition?: string } | undefined,
  upload: Upload,
  key = upload.key ?? '',
) {
  mediaKey(upload);
  if (!staged) throw new UploadRefusedError('The upload never reached the bucket');
  if (staged.mime !== upload.mime)
    throw new UploadRefusedError(
      'The uploaded content type differs from its declaration',
      'MEDIA_TYPE_MISMATCH',
    );
  const data = staged.data;
  if (data.byteLength !== upload.bytes)
    throw new UploadRefusedError(
      'The uploaded size differs from its declaration',
      'MEDIA_SIZE_MISMATCH',
    );
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== upload.hash)
    throw new UploadRefusedError('The uploaded SHA-256 does not match its key');
  if (upload.mime === 'application/pdf') {
    if (key.startsWith('files/') && !staged.disposition?.startsWith('attachment'))
      throw new UploadRefusedError('A public PDF must be stored as a download');
    if (!new TextDecoder().decode(data.slice(0, 5)).startsWith('%PDF-'))
      throw new UploadRefusedError('The uploaded bytes are not a PDF', 'MEDIA_TYPE_MISMATCH');
    return { data, width: undefined, height: undefined };
  }
  return { data, ...imageDimensions(data, upload.mime) };
}
