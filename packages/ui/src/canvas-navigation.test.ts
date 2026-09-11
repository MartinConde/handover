import { afterEach, expect, test, vi } from 'vitest';
import {
  canvasDocumentUrl,
  classifyCanvasNavigation,
  createCanvasNavigationRuntime,
} from './canvas-navigation';

const index = {
  entries: [
    {
      collection: 'pages',
      path: 'pages/home',
      locales: ['en', 'de'],
      urls: { en: '/coastal/home', de: '/coastal/de/start' },
    },
    {
      collection: 'listings',
      path: 'listings/sea-view',
      locales: ['en', 'de'],
      urls: { en: '/coastal/listings/sea-view', de: '/coastal/de/listings/meerblick' },
    },
  ],
  indexes: [
    {
      collection: 'listings',
      path: 'listings',
      index: true as const,
      locales: ['en', 'de'],
      urls: { en: '/coastal/listings', de: '/coastal/de/listings' },
    },
  ],
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

test('the real document URL removes only the base-aware preview transport segment', () => {
  expect(
    canvasDocumentUrl('https://cms.example/coastal/_preview/de/listings/meerblick?x=1').href,
  ).toBe('https://cms.example/coastal/de/listings/meerblick?x=1');
  expect(canvasDocumentUrl('https://cms.example/_preview/').href).toBe('https://cms.example/');
});

test('localized entry URLs resolve to stable documents while indexes and outside URLs do not', () => {
  expect(
    classifyCanvasNavigation(
      'https://cms.example/coastal/de/listings/meerblick?from=canvas#photos',
      index,
      'https://cms.example',
    ),
  ).toEqual({
    kind: 'entry',
    href: 'https://cms.example/coastal/de/listings/meerblick?from=canvas#photos',
    collection: 'listings',
    id: 'sea-view',
    locale: 'de',
  });
  expect(
    classifyCanvasNavigation('https://cms.example/coastal/listings/', index, 'https://cms.example'),
  ).toEqual({ kind: 'preview', href: 'https://cms.example/coastal/listings/' });
  expect(
    classifyCanvasNavigation('https://outside.example/a', index, 'https://cms.example'),
  ).toEqual({ kind: 'external', href: 'https://outside.example/a' });
});

test('the iframe intercepts relative, absolute, modified and form navigation intents', () => {
  document.body.innerHTML = `
    <a id="relative" href="../home">Home</a>
    <a id="new" href="/coastal/listings/sea-view" target="_blank">Listing</a>
    <form id="form" action="../search" method="post"><button>Search</button></form>
  `;
  const onNavigate = vi.fn();
  const runtime = createCanvasNavigationRuntime({
    documentUrl: 'https://cms.example/coastal/_preview/de/listings/meerblick',
    onNavigate,
  });
  runtime.start();

  document
    .querySelector('#relative')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  document
    .querySelector('#new')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  document
    .querySelector('#form')
    ?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

  expect(onNavigate.mock.calls.map(([request]) => request)).toEqual([
    {
      kind: 'link',
      href: 'https://cms.example/coastal/de/home',
      newTab: false,
      download: false,
    },
    {
      kind: 'link',
      href: 'https://cms.example/coastal/listings/sea-view',
      newTab: true,
      download: false,
    },
    {
      kind: 'form',
      href: 'https://cms.example/coastal/de/search',
      method: 'post',
    },
  ]);
  runtime.dispose();
});
