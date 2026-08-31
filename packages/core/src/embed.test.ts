import { expect, test } from 'vitest';
import { type EmbedValue, embedSrc, embedThumb, parseEmbedUrl } from './embed.js';

const UNKNOWN = 'We don’t recognise this link. Supported: YouTube, Vimeo, Google Maps.';

test.each([
  ['youtu.be', 'https://youtu.be/dQw4w9WgXcQ', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
  [
    'watch',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
    { provider: 'youtube', id: 'dQw4w9WgXcQ' },
  ],
  ['shorts', 'https://youtube.com/shorts/dQw4w9WgXcQ', { provider: 'youtube', id: 'dQw4w9WgXcQ' }],
  [
    'embed on the nocookie host',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    { provider: 'youtube', id: 'dQw4w9WgXcQ' },
  ],
  [
    'mobile watch',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    { provider: 'youtube', id: 'dQw4w9WgXcQ' },
  ],
  ['vimeo', 'https://vimeo.com/76979871', { provider: 'vimeo', id: '76979871' }],
  [
    'vimeo player',
    'https://player.vimeo.com/video/76979871',
    { provider: 'vimeo', id: '76979871' },
  ],
  [
    'vimeo inside a channel',
    'https://vimeo.com/channels/staffpicks/76979871',
    { provider: 'vimeo', id: '76979871' },
  ],
  [
    'a map place',
    'https://www.google.com/maps/place/Seaview+Cottage,+Devon/@50.5,-4.8,17z',
    { provider: 'google-maps', id: 'Seaview Cottage, Devon' },
  ],
  [
    'a map query',
    'https://maps.google.com/?q=Seaview+Cottage,+Devon',
    { provider: 'google-maps', id: 'Seaview Cottage, Devon' },
  ],
])('%s parses to the stored shape', (_name, url, embed) => {
  expect(parseEmbedUrl(url)).toEqual({ embed });
});

test.each([
  ['plain seconds', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42', 42],
  ['minutes and seconds', 'https://youtu.be/dQw4w9WgXcQ?t=1m30s', 90],
  ['hours too', 'https://youtu.be/dQw4w9WgXcQ?t=1h2m3s', 3723],
  ['the embed form spells it start', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=42', 42],
])('%s becomes a start time', (_name, url, start) => {
  expect(parseEmbedUrl(url)).toEqual({ embed: { provider: 'youtube', id: 'dQw4w9WgXcQ', start } });
});

test('vimeo carries its start time in the fragment', () => {
  expect(parseEmbedUrl('https://vimeo.com/76979871#t=1m30s')).toEqual({
    embed: { provider: 'vimeo', id: '76979871', start: 90 },
  });
});

// A link with no start time stores no key: the file says nothing about where the video begins.
test('a link with no time stores no start', () => {
  const parsed = parseEmbedUrl('https://youtu.be/dQw4w9WgXcQ');
  expect('embed' in parsed && 'start' in parsed.embed).toBe(false);
});

test.each([
  ['another video site', 'https://www.dailymotion.com/video/x8abc'],
  ['a youtube page that is not a video', 'https://www.youtube.com/@someone'],
  ['a watch link with no id', 'https://www.youtube.com/watch?list=PL1'],
  ['a vimeo page that is not a video', 'https://vimeo.com/staffpicks'],
  ['a map with neither a place nor a query', 'https://www.google.com/maps/@50.5,-4.8,17z'],
  ['not a URL at all', 'the mill house video'],
  ['a script URL', 'javascript:alert(1)'],
  ['iframe markup', '<iframe src="https://youtu.be/dQw4w9WgXcQ"></iframe>'],
  // The id reaches a provider template, so anything that is not one of their characters is
  // refused here rather than encoded and sent.
  ['an id that is markup', 'https://youtu.be/<script>'],
])('%s is refused with the allow-list', (_name, url) => {
  expect(parseEmbedUrl(url)).toEqual({ refused: UNKNOWN });
});

// The two things Google's own Share dialog hands over: each says what to do next instead.
test('a shortened map link says to open it first', () => {
  expect(parseEmbedUrl('https://maps.app.goo.gl/AbCdEf123')).toEqual({
    refused: 'Google Maps shortened this link. Open it, then copy the address from your browser.',
  });
});

test('googles own embed URL says to copy the address instead', () => {
  expect(parseEmbedUrl('https://www.google.com/maps/embed?pb=!1m18!1m12!1m3')).toEqual({
    refused:
      'That is Google’s embed code. Open the map itself and copy the address from your browser.',
  });
});

test.each([
  [
    { provider: 'youtube', id: 'dQw4w9WgXcQ' },
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  ],
  [
    { provider: 'youtube', id: 'dQw4w9WgXcQ', start: 42 },
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42',
  ],
  [{ provider: 'vimeo', id: '76979871' }, 'https://player.vimeo.com/video/76979871?dnt=1'],
  [
    { provider: 'vimeo', id: '76979871', start: 90 },
    'https://player.vimeo.com/video/76979871?dnt=1#t=90s',
  ],
  // The golden's own map id: spaces and a comma, which reach the template encoded or not at all.
  [
    { provider: 'google-maps', id: 'Seaview Cottage, Devon' },
    'https://www.google.com/maps?q=Seaview%20Cottage%2C%20Devon&output=embed',
  ],
])('the iframe address is built from the template', (value, src) => {
  expect(embedSrc(value as EmbedValue)).toBe(src);
});

test('only youtube has a still the browser can guess the address of', () => {
  expect(embedThumb({ provider: 'youtube', id: 'dQw4w9WgXcQ' })).toBe(
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  );
  expect(embedThumb({ provider: 'vimeo', id: '76979871' })).toBeUndefined();
  expect(embedThumb({ provider: 'google-maps', id: 'Seaview Cottage, Devon' })).toBeUndefined();
});
