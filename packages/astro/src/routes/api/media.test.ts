import { texts } from 'virtual:handover/index';
import { releaseUploadIntent } from '@handover/core';
import type { APIContext } from 'astro';
import { afterEach, expect, test, vi } from 'vitest';
import { DELETE, GET, PATCH, POST, PUT } from '../api.js';
import {
  confirmUpload,
  contentFiles,
  ctx,
  deleteMedia,
  draftFiles,
  findMedia,
  HASH,
  logged,
  mediaList,
  owner,
  post,
  privateUploads,
  put,
  resetContainers,
  resetMocks,
  resetState,
  setMediaDetails,
  state,
} from './harness.js';

const { workerMailerMock, configMock, indexMock, cloudflareMock, authMock, coreMock } =
  await vi.hoisted(async () => import('./harness.js'));

vi.mock('worker-mailer', () => workerMailerMock());
vi.mock('virtual:handover/config', () => configMock());
vi.mock('virtual:handover/index', () => indexMock());
vi.mock('cloudflare:workers', () => cloudflareMock());
vi.mock('../../auth.js', async (original) =>
  authMock((await original()) as Record<string, unknown>),
);
vi.mock('@handover/core', async (original) =>
  coreMock((await original()) as Record<string, unknown>),
);

const patch = (path: string, body: unknown, locals: Record<string, unknown> = {}) =>
  ctx(
    path,
    new Request(`https://x/admin/api/${path}`, { method: 'PATCH', body: JSON.stringify(body) }),
    locals,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  resetContainers();
  resetMocks();
  resetState();
  for (const key of Object.keys(texts)) delete texts[key];
});

const declared = JSON.stringify({
  hash: HASH,
  bytes: 12_345,
  mime: 'image/webp',
  filename: 'seaview.jpg',
  width: 2400,
  height: 1350,
});

// Step 3 of the upload flow: the free dedupe, and the reason the client hashes before it uploads.
test('bytes the site already holds are answered from the row, with nothing signed', async () => {
  findMedia.mockResolvedValueOnce({
    id: HASH,
    r2Key: `media/${HASH}.webp`,
    mime: 'image/webp',
    bytes: 12_345,
    width: 2400,
    height: 1350,
  });
  const res = await POST(post('media', declared));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    media: {
      id: HASH,
      src: `media/${HASH}.webp`,
      mime: 'image/webp',
      bytes: 12_345,
      width: 2400,
      height: 1350,
      // The picker draws the dot before anything is inserted, so the answer carries it.
      focal: [0.5, 0.5],
      url: `https://media.example.com/media/${HASH}.webp`,
    },
  });
});

test('a hash the site does not have is answered with an authenticated private upload route', async () => {
  const res = await POST(post('media', declared));
  expect(res.status).toBe(200);
  const { upload } = (await res.json()) as { upload: { key: string; url: string } };
  expect(upload.key).toMatch(new RegExp(`^uploads/[0-9a-f-]{36}/media/${HASH}\\.webp$`));
  expect(upload.url).toBe(`/admin/api/${upload.key}`);
});

const stagingRequest = (key: string, bytes: Uint8Array, type = 'image/webp') =>
  ctx(
    key,
    new Request(`https://x/admin/api/${key}`, {
      method: 'PUT',
      headers: { 'content-type': type, 'content-length': String(bytes.byteLength) },
      body: bytes,
    }),
  );

test('private ingestion requires a persisted upload intent for the exact key', async () => {
  state.uploadIntentAvailable = false;
  const key = `uploads/12345678-1234-1234-1234-123456789abc/media/${'b'.repeat(64)}.webp`;
  expect((await PUT(stagingRequest(key, new Uint8Array(4)))).status).toBe(404);
  expect(privateUploads).toEqual([]);
});

test('private ingestion binds the declared MIME and actual byte count', async () => {
  const key = `uploads/12345678-1234-1234-1234-123456789abc/media/${'b'.repeat(64)}.webp`;
  expect((await PUT(stagingRequest(key, new Uint8Array(4), 'text/plain'))).status).toBe(415);
  expect((await PUT(stagingRequest(key, new Uint8Array(5)))).status).toBe(422);
  expect(privateUploads).toEqual([]);

  const accepted = await PUT(stagingRequest(key, new Uint8Array(4)));
  expect({ status: accepted.status, body: await accepted.text() }).toEqual({
    status: 204,
    body: '',
  });
  expect(privateUploads).toEqual([{ key, bytes: 4, type: 'image/webp' }]);
});

test('a type the bucket does not serve is refused rather than signed', async () => {
  const res = await POST(
    post('media', JSON.stringify({ hash: HASH, bytes: 10, mime: 'text/html' })),
  );
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ error: expect.stringContaining('cannot be uploaded') });
});

test('a verified upload answers with the asset and is one line in the log', async () => {
  const key = `uploads/12345678-1234-1234-1234-123456789abc/media/${HASH}.webp`;
  const res = await PUT(put(`media/${HASH}`, JSON.stringify({ ...JSON.parse(declared), key })));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ media: { id: HASH, src: `media/${HASH}.webp` } });
  expect(confirmUpload).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    {
      accountId: 'acct-1',
      bucket: 'site-media',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
    },
    {
      hash: HASH,
      bytes: 12_345,
      mime: 'image/webp',
      filename: 'seaview.jpg',
      width: 2400,
      height: 1350,
      key,
    },
    expect.objectContaining({ staging: expect.any(Object) }),
  );
  expect(logged.at(-1)).toMatchObject({
    kind: 'upload',
    subject: HASH,
    detail: { name: 'seaview.jpg', bytes: 12_345 },
  });
});

// Bytes the site already had are a reuse, not an upload: the row is answered and nothing is logged.
test('confirming bytes that were already there writes no second log line', async () => {
  confirmUpload.mockImplementationOnce(async () => ({
    media: {
      id: HASH,
      r2Key: `media/${HASH}.webp`,
      filename: 'seaview.jpg',
      mime: 'image/webp',
      bytes: 12_345,
      width: null,
      height: null,
    },
    created: false,
  }));
  const key = `uploads/12345678-1234-1234-1234-123456789abc/media/${HASH}.webp`;
  await PUT(put(`media/${HASH}`, JSON.stringify({ ...JSON.parse(declared), key })));
  expect(logged.filter((row) => row.kind === 'upload')).toEqual([]);
});

// The query is on the url rather than in the path, so this one builds its context by hand.
const library = (query: string) =>
  ({
    params: { path: 'media' },
    request: undefined,
    url: new URL(`https://x/admin/api/media${query}`),
    locals: {},
  }) as unknown as APIContext;

test('the picker is answered the library of the kind its field takes', async () => {
  mediaList.mockResolvedValueOnce([
    {
      id: HASH,
      r2Key: `files/${HASH}.pdf`,
      filename: 'brochure.pdf',
      mime: 'application/pdf',
      bytes: 2_481_033,
      width: null,
      height: null,
      alt: null,
      tags: null,
      archived: 0,
      createdAt: 1_755_000_000_000,
    },
  ]);
  const res = await GET(library('?kind=files'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    media: [
      {
        id: HASH,
        src: `files/${HASH}.pdf`,
        filename: 'brochure.pdf',
        mime: 'application/pdf',
        bytes: 2_481_033,
        width: null,
        height: null,
        focal: [0.5, 0.5],
        alt: null,
        tags: [],
        archived: false,
        createdAt: 1_755_000_000_000,
        uses: [],
        url: `https://media.example.com/files/${HASH}.pdf`,
      },
    ],
  });
  expect(mediaList).toHaveBeenCalledWith('default', expect.anything(), {
    kind: 'files',
    q: undefined,
    withArchived: false,
  });
});

// An unknown kind is the pictures: a picker that asked for nothing is an image field.
test('the library defaults to the pictures', async () => {
  await GET(library(''));
  expect(mediaList).toHaveBeenCalledWith('default', expect.anything(), {
    kind: 'images',
    q: undefined,
    withArchived: false,
  });
});

// The search is the table's, not the browser's, and only the library sees what it put away.
test('a search and the archived are handed to the query, not filtered after it', async () => {
  await GET(library('?q=seaview&archived=1'));
  expect(mediaList).toHaveBeenCalledWith('default', expect.anything(), {
    kind: 'images',
    q: 'seaview',
    withArchived: true,
  });
});

const PHOTO = 'a'.repeat(64);
const asset = (id: string) => ({
  id,
  r2Key: `media/${id}.webp`,
  filename: 'front-of-house.jpg',
  mime: 'image/webp',
  bytes: 612_000,
  width: 2400,
  height: 1600,
  alt: null,
  tags: null,
  archived: 0,
});

test('a picture says which entries it is used in, one row per entry', async () => {
  mediaList.mockResolvedValueOnce([asset(PHOTO)]);
  const { media } = (await (await GET(library(''))).json()) as {
    media: { uses: { entry: string; title: string; href: string }[] }[];
  };
  // Two entries, though three files name the key: the German mill house is the same listing.
  expect(media[0]?.uses).toEqual([
    { entry: 'listings/mill-house', title: 'The Mill House', href: '/admin/c/listings/mill-house' },
    {
      entry: 'listings/seaview-cottage',
      title: 'Seaview Cottage',
      href: '/admin/c/listings/seaview-cottage',
    },
  ]);
});

test('an unpublished change is what the count reads, not the last build', async () => {
  mediaList.mockResolvedValueOnce([asset(PHOTO)]);
  draftFiles.mockResolvedValueOnce([
    { path: 'src/content/listings/en/mill-house.yaml', contents: 'title: "The Mill House"\n' },
    { path: 'src/content/listings/de/mill-house.yaml', contents: 'title: "The Mill House"\n' },
  ]);
  const { media } = (await (await GET(library(''))).json()) as {
    media: { uses: { entry: string }[] }[];
  };
  expect(media[0]?.uses.map((u) => u.entry)).toEqual(['listings/seaview-cottage']);
});

test('tags and a default alt are written to the row, and the empty alt is no default', async () => {
  const res = await PATCH(
    patch(`media/${PHOTO}`, {
      tags: ['exterior', ' seaview ', '', 'exterior'],
      alt: ' Front of the house ',
    }),
  );
  expect(res.status).toBe(200);
  expect(setMediaDetails).toHaveBeenCalledWith('default', expect.anything(), PHOTO, {
    tags: ['exterior', 'seaview'],
    alt: 'Front of the house',
  });
  expect((await PATCH(patch(`media/${PHOTO}`, { alt: '  ' }))).status).toBe(200);
  expect(setMediaDetails).toHaveBeenLastCalledWith('default', expect.anything(), PHOTO, {
    tags: undefined,
    alt: '',
  });
});

test('saving metadata returns the asset usage instead of marking it unused', async () => {
  const res = await PATCH(patch(`media/${PHOTO}`, { alt: 'Front of the house' }));

  expect(res.status).toBe(200);
  expect(((await res.json()) as { media: { uses: { entry: string }[] } }).media.uses).toEqual([
    { entry: 'listings/mill-house', title: 'The Mill House', href: '/admin/c/listings/mill-house' },
    {
      entry: 'listings/seaview-cottage',
      title: 'Seaview Cottage',
      href: '/admin/c/listings/seaview-cottage',
    },
  ]);
});

test('a write with nothing the row holds is refused, and an unknown asset is a 404', async () => {
  const invalid = await PATCH(patch(`media/${PHOTO}`, { focal: 0.5 }));
  expect({ status: invalid.status, body: await invalid.json() }).toEqual({
    status: 400,
    body: {
      code: 'MEDIA_METADATA_INVALID',
      error: 'a focal point is [x, y], each 0 to 1',
    },
  });
  setMediaDetails.mockResolvedValueOnce(undefined);
  const missing = await PATCH(patch(`media/${PHOTO}`, { tags: ['x'] }));
  expect({ status: missing.status, body: await missing.json() }).toEqual({
    status: 404,
    body: { code: 'MEDIA_NOT_FOUND', error: 'Not found' },
  });
});

// Archiving is the answer to "get rid of it" and is never gated on usage.
test('archiving is a write to the row, and unarchiving is the same write back', async () => {
  const res = await PATCH(patch(`media/${PHOTO}`, { archived: true }, { handover: owner }));
  expect(res.status).toBe(200);
  expect(setMediaDetails).toHaveBeenCalledWith('default', expect.anything(), PHOTO, {
    tags: undefined,
    alt: undefined,
    archived: true,
  });
  expect(logged.at(-1)).toMatchObject({ kind: 'media-archive', subject: PHOTO, userId: 'u1' });
  await PATCH(patch(`media/${PHOTO}`, { archived: false }));
  expect(setMediaDetails).toHaveBeenLastCalledWith('default', expect.anything(), PHOTO, {
    tags: undefined,
    alt: undefined,
    archived: false,
  });
});

test('renaming the tags is not an archive line in the log', async () => {
  await PATCH(patch(`media/${PHOTO}`, { tags: ['x'] }));
  expect(logged.filter((row) => row.kind === 'media-archive')).toEqual([]);
});

const deleteAsset = (id: string) =>
  DELETE(
    ctx(`media/${id}`, new Request(`https://x/admin/api/media/${id}`, { method: 'DELETE' }), {
      handover: owner,
    }),
  );

// The gate is not the badge.
test('a picture a file in the repository names cannot be deleted', async () => {
  findMedia.mockResolvedValueOnce({
    id: PHOTO,
    r2Key: `media/${PHOTO}.webp`,
    filename: 'front.jpg',
  });
  contentFiles.mockResolvedValueOnce([
    {
      path: 'src/content/pages/en/about.yaml',
      contents: `title: "About"\nphoto:\n  src: "media/${PHOTO}.webp"\n`,
    },
  ]);

  const res = await deleteAsset(PHOTO);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: 'MEDIA_IN_USE',
    error: expect.stringContaining('used in 1 place'),
    uses: ['pages/about'],
  });
  expect(deleteMedia).not.toHaveBeenCalled();
});

// A picture an editor dropped into a draft this morning is used, though no commit says so yet.
test('a picture only a draft names cannot be deleted either', async () => {
  findMedia.mockResolvedValueOnce({ id: PHOTO, r2Key: `media/${PHOTO}.webp` });
  contentFiles.mockResolvedValueOnce([]);
  draftFiles.mockResolvedValueOnce([
    { path: 'src/content/pages/en/home.yaml', contents: `image: "media/${PHOTO}.webp"\n` },
  ]);

  expect((await deleteAsset(PHOTO)).status).toBe(409);
  expect(deleteMedia).not.toHaveBeenCalled();
});

// The commonest refusal, and the one that must not read as "you did not remove it".
test('a picture only the published site still uses says so in those words', async () => {
  findMedia.mockResolvedValueOnce({ id: PHOTO, r2Key: `media/${PHOTO}.webp` });
  contentFiles.mockResolvedValueOnce([
    {
      path: 'src/content/pages/en/about.yaml',
      contents: `title: "About"\nphoto:\n  src: "media/${PHOTO}.webp"\n`,
    },
  ]);
  // The same file, with the picture taken out of it and not yet published.
  draftFiles.mockResolvedValueOnce([
    { path: 'src/content/pages/en/about.yaml', contents: 'title: "About"\n' },
  ]);

  const res = await deleteAsset(PHOTO);

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: 'MEDIA_PUBLISHED_IN_USE',
    error: expect.stringContaining('The published site still uses this in 3 places'),
    uses: ['listings/mill-house', 'listings/seaview-cottage', 'pages/about'],
  });
  expect(deleteMedia).not.toHaveBeenCalled();
});

test('a picture nothing names is deleted, bytes and row, and says so in the log', async () => {
  const unused = 'b'.repeat(64);
  findMedia.mockResolvedValueOnce({
    id: unused,
    r2Key: `media/${unused}.webp`,
    filename: 'front.jpg',
  });
  contentFiles.mockResolvedValueOnce([
    { path: 'src/content/pages/en/about.yaml', contents: 'title: "About"\n' },
  ]);

  const res = await deleteAsset(unused);

  expect(res.status).toBe(200);
  expect(deleteMedia).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.objectContaining({ bucket: 'site-media' }),
    expect.objectContaining({ id: unused, r2Key: `media/${unused}.webp` }),
  );
  expect(logged.at(-1)).toMatchObject({
    kind: 'media-delete',
    subject: unused,
    detail: { name: 'front.jpg' },
  });
});

// The one thing a gate must never do is read "I could not check" as "nothing uses it".
test('a repository that cannot be read refuses the delete rather than allowing it', async () => {
  findMedia.mockResolvedValueOnce({ id: PHOTO, r2Key: `media/${PHOTO}.webp` });
  contentFiles.mockImplementationOnce(async () => {
    const { RepoUnreachableError } = await import('@handover/core');
    throw new RepoUnreachableError('The GitHub App cannot see acme/site.');
  });

  const res = await deleteAsset(PHOTO);

  expect(res.status).toBe(503);
  expect(deleteMedia).not.toHaveBeenCalled();
});

test('an asset the site does not have is a 404, and nothing is read to answer it', async () => {
  expect((await deleteAsset(PHOTO)).status).toBe(404);
  expect(contentFiles).not.toHaveBeenCalled();
});

test('an asset delete without a bucket keeps the setup detail and a stable code', async () => {
  state.bucketed = false;
  const res = await deleteAsset(PHOTO);
  expect({ status: res.status, body: await res.json() }).toEqual({
    status: 503,
    body: {
      code: 'MEDIA_STORAGE_UNAVAILABLE',
      error: expect.stringContaining('R2_ACCOUNT_ID and R2_BUCKET in wrangler.jsonc'),
    },
  });
  expect(findMedia).not.toHaveBeenCalled();
});

test('a site that has not been told where its bucket is names all four values', async () => {
  state.bucketed = false;
  const res = await POST(post('media', declared));
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({
    error: expect.stringContaining('R2_ACCOUNT_ID and R2_BUCKET in wrangler.jsonc'),
  });
});

// The dot the library sets is the picture's own default, and a page that set its own keeps it.
test('a focal point is two fractions on the row, and anything else is refused', async () => {
  const res = await PATCH(patch(`media/${PHOTO}`, { focal: [0.42, 0.3] }));
  expect(res.status).toBe(200);
  expect(setMediaDetails).toHaveBeenCalledWith('default', expect.anything(), PHOTO, {
    tags: undefined,
    alt: undefined,
    focal: [0.42, 0.3],
  });
  expect((await PATCH(patch(`media/${PHOTO}`, { focal: [0.5, 1.4] }))).status).toBe(400);
  expect((await PATCH(patch(`media/${PHOTO}`, { focal: [0.5] }))).status).toBe(400);
});

test('the browser is handed the picture’s focal point, centred where nobody set one', async () => {
  mediaList.mockResolvedValueOnce([{ ...asset(PHOTO), focalX: 0.42, focalY: 0.3 }]);
  const { media } = (await (await GET(library(''))).json()) as { media: { focal: number[] }[] };
  expect(media[0]?.focal).toEqual([0.42, 0.3]);
  mediaList.mockResolvedValueOnce([{ ...asset(PHOTO), focalX: null, focalY: null }]);
  const { media: never } = (await (await GET(library(''))).json()) as {
    media: { focal: number[] }[];
  };
  expect(never[0]?.focal).toEqual([0.5, 0.5]);
});

// A crop is a new picture with a line back to the one it came from.
test('a cropped copy declares the picture it came from', async () => {
  const crop = 'b'.repeat(64);
  const parent = { hash: crop, bytes: 4, mime: 'image/webp', derivedFrom: PHOTO };
  await POST(post('media', JSON.stringify(parent)));
  const key = `uploads/12345678-1234-1234-1234-123456789abc/media/${crop}.webp`;
  await PUT(put(`media/${crop}`, JSON.stringify({ ...parent, key })));
  expect(confirmUpload).toHaveBeenCalledWith(
    'default',
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ hash: crop, derivedFrom: PHOTO }),
    expect.objectContaining({ staging: expect.any(Object) }),
  );
});

test('stalled ingestion stops after a minute even when stream cancellation never settles', async () => {
  vi.useFakeTimers();
  vi.mocked(releaseUploadIntent).mockClear();
  const key = `uploads/12345678-1234-1234-1234-123456789abc/media/${'b'.repeat(64)}.webp`;
  let status: number | undefined;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  try {
    const request = new Request(`https://x/admin/api/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/webp' },
      body: new ReadableStream<Uint8Array>({ cancel }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    void Promise.resolve(PUT(ctx(key, request))).then((response) => {
      status = response.status;
    });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(status).toBe(408);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseUploadIntent).toHaveBeenCalledExactlyOnceWith(
      'default',
      expect.anything(),
      key,
      'unknown',
    );
    expect(privateUploads).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
