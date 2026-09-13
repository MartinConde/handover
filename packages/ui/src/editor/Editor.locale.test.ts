import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import EditorLocaleFixture from './EditorLocaleFixture.svelte';

let app: ReturnType<typeof mount>;
afterEach(() => {
  unmount(app);
  localStorage.clear();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) =>
  Array.from(document.body.querySelectorAll<T>(selector));

test('live interface language updates editor chrome and dates without replacing the active field', async () => {
  const turnedOffAt = new Date(2026, 7, 12, 12).getTime();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    url.startsWith('/admin/api/locks/')
      ? Response.json({ held_by: null, mine: true, expires_at: turnedOffAt + 120_000 })
      : url === '/admin/api/deleted/listings'
        ? Response.json({
            deleted: [
              {
                at: turnedOffAt,
                slug: 'seaview-cottage',
                locales: ['de'],
                whole: false,
                commit_sha: 'off-1',
              },
            ],
          })
        : url === '/admin/api/drafts/listings/seaview-cottage' && init?.method === 'PUT'
          ? Response.json({ updated_at: turnedOffAt, pending: true, problems: [] })
          : url === '/admin/api/publish/checks'
            ? Response.json({ results: [] })
            : Response.json({}),
  );
  vi.stubGlobal('fetch', fetchMock);
  app = mount(EditorLocaleFixture, { target: document.body });
  await new Promise((resolve) => setTimeout(resolve));
  flushSync();
  const input = q<HTMLInputElement>('input#f-title');
  if (!input) throw new Error('title input missing');
  input.value = 'Unsaved harbour words';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dataset.localeProof = 'same-editor-field';
  input.focus();
  const requestsBeforeSwitch = fetchMock.mock.calls.length;

  q<HTMLButtonElement>('[data-locale-switch]')?.click();
  flushSync();

  const current = q<HTMLInputElement>('input#f-title');
  expect(q('.editor-modes')?.getAttribute('aria-label')).toBe('Editoransicht');
  expect(qa<HTMLButtonElement>('.editor-modes button').map((button) => button.textContent)).toEqual(
    ['Formular', 'Geteilt', 'Canvas'],
  );
  expect(q('.tabs')?.getAttribute('aria-label')).toBe('Eintragsbereiche');
  expect(qa<HTMLAnchorElement>('.tabs a').map((link) => link.textContent)).toEqual([
    'Inhalt',
    'Verlauf',
  ]);
  expect(q('.entry-header button.btn-primary')?.textContent).toBe('Diesen Eintrag veröffentlichen');
  expect(q('.slug-row .mode')?.textContent).toBe('Wie der Dateiname');
  expect(current).toBe(input);
  expect(current?.value).toBe('Unsaved harbour words');
  expect(current?.dataset.localeProof).toBe('same-editor-field');
  expect(document.activeElement).toBe(current);
  expect(
    q<HTMLButtonElement>('[aria-label="Language"] button[aria-pressed="true"]')?.textContent,
  ).toContain('EN');
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeSwitch);

  q<HTMLButtonElement>('[aria-label="Weitere Aktionen"]')?.click();
  flushSync();
  expect(
    qa<HTMLButtonElement>('[role="menu"][aria-label="Weitere Aktionen"] button').map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(['Umbenennen', 'Ausblenden', 'Löschen']);
  qa<HTMLButtonElement>('[role="menu"][aria-label="Weitere Aktionen"] button')[0]?.click();
  flushSync();
  expect(q('.dialog h2')?.textContent).toBe('Unsaved harbour words umbenennen');
  expect(q('.dialog label[for="rename-to"]')?.textContent).toBe('Dateiname');
  q<HTMLButtonElement>('.dialog button:not(.btn-primary)')?.click();
  flushSync();

  qa<HTMLButtonElement>('[aria-label="Language"] button')[1]?.click();
  for (let attempt = 0; attempt < 10 && !q('.pane time'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync();
  }
  expect(q('.pane time')?.textContent ?? '').toBe('12. August 2026 um 12:00');
});
