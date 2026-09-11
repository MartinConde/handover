import { expect, test, vi } from 'vitest';
import { createEntryDirectoryReader, type Pickable } from './entry-directory';

const directory = (title: string): Pickable => ({
  entries: [
    {
      collection: 'pages',
      path: 'pages/home',
      title,
      locales: ['en'],
      urls: { en: '/home' },
    },
  ],
  locales: ['en'],
});

test('concurrent and later catalogue consumers share one app-lifetime read', async () => {
  let answer!: (response: Response) => void;
  const fetcher = vi.fn(
    () => new Promise<Response>((resolve) => (answer = resolve)),
  ) as unknown as typeof fetch;
  const reader = createEntryDirectoryReader(fetcher);

  const first = reader.read();
  const second = reader.read();
  expect(fetcher).toHaveBeenCalledOnce();
  answer(Response.json(directory('Home')));

  await expect(first).resolves.toEqual(directory('Home'));
  await expect(second).resolves.toEqual(directory('Home'));
  await expect(reader.read()).resolves.toEqual(directory('Home'));
  expect(fetcher).toHaveBeenCalledOnce();
});

test('invalidating an entry rename drops the cached catalogue', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(directory('Old home')))
    .mockResolvedValueOnce(Response.json(directory('New home'))) as unknown as typeof fetch;
  const reader = createEntryDirectoryReader(fetcher);

  await expect(reader.read()).resolves.toEqual(directory('Old home'));
  reader.invalidate();
  await expect(reader.read()).resolves.toEqual(directory('New home'));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('a response invalidated in flight joins the replacement read', async () => {
  const answers: ((response: Response) => void)[] = [];
  const fetcher = vi.fn(
    () => new Promise<Response>((resolve) => answers.push(resolve)),
  ) as unknown as typeof fetch;
  const reader = createEntryDirectoryReader(fetcher);

  const stale = reader.read();
  reader.invalidate();
  const current = reader.read();
  answers[0]?.(Response.json(directory('Old home')));
  answers[1]?.(Response.json(directory('New home')));

  await expect(stale).resolves.toEqual(directory('New home'));
  await expect(current).resolves.toEqual(directory('New home'));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('failed reads are not cached and a Canvas reader uses its configured site base', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json(directory('Home'))) as unknown as typeof fetch;
  const reader = createEntryDirectoryReader(fetcher, '/coastal/admin/api/entries');

  await expect(reader.read()).rejects.toThrow('could not be read (503)');
  await expect(reader.read()).resolves.toEqual(directory('Home'));
  expect(fetcher).toHaveBeenNthCalledWith(1, '/coastal/admin/api/entries');
  expect(fetcher).toHaveBeenNthCalledWith(2, '/coastal/admin/api/entries');
});
