// A pasted link never reaches a content file. Each provider has its own reading of a URL, and
// what is stored is the provider and the id it names — the `src` a page renders is built back
// from a template here, so nothing a client pastes can become an iframe pointing anywhere.

export type EmbedProvider = 'youtube' | 'vimeo' | 'google-maps';

/** The stored shape. `title` is the translated half and is typed in the admin, never parsed. */
export interface EmbedValue {
  provider: EmbedProvider;
  id: string;
  title?: string;
  start?: number;
}

/** A pasted link is either something to store or the sentence saying why it is not. */
export type EmbedParse = { embed: EmbedValue } | { refused: string };

export const EMBED_LABELS: Record<EmbedProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  'google-maps': 'Google Maps',
};

// "Invalid URL" tells a client nothing they can act on, so the refusal is the allow-list.
const UNKNOWN = 'We don’t recognise this link. Supported: YouTube, Vimeo, Google Maps.';

// `90`, `90s`, `1m30s`, `1h2m3s` — the forms YouTube and Vimeo put in `t`.
function seconds(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!parts || parts[0] === '') return undefined;
  const [, h = '0', m = '0', s = '0'] = parts;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// Google writes spaces in a path segment as `+`, so they go back before the percent decoding
// rather than after it — a name really containing one arrives as `%2B` and must survive.
const place = (segment: string) => decodeURIComponent(segment.replace(/\+/g, '%20'));

const video = (
  provider: 'youtube' | 'vimeo',
  id: string | undefined,
  start?: number,
): EmbedParse =>
  id && /^[A-Za-z0-9_-]+$/.test(id)
    ? { embed: { provider, id, ...(start ? { start } : {}) } }
    : { refused: UNKNOWN };

/**
 * The paste box's whole job. `start` is kept only where the link carried one, so a plain link
 * stores no key at all and the file says nothing about where the video begins.
 */
export function parseEmbedUrl(input: string): EmbedParse {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { refused: UNKNOWN };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { refused: UNKNOWN };
  const host = url.hostname.replace(/^www\./, '');
  const path = url.pathname.split('/').filter(Boolean);
  const t = seconds(url.searchParams.get('t') ?? url.searchParams.get('start'));

  if (host === 'youtu.be') return video('youtube', path[0], t);
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (path[0] === 'watch') return video('youtube', url.searchParams.get('v') ?? undefined, t);
    if (path[0] === 'shorts' || path[0] === 'embed' || path[0] === 'live')
      return video('youtube', path[1], t);
    return { refused: UNKNOWN };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com')
    return video(
      'vimeo',
      path.find((s) => /^\d+$/.test(s)),
      seconds(/^#t=(.+)$/.exec(url.hash)?.[1]) ?? t,
    );

  // The two things Google's own Share dialog hands over, each named rather than lumped in with
  // a link from nowhere: a client who followed the instructions deserves the next instruction.
  if (host === 'maps.app.goo.gl' || (host === 'goo.gl' && path[0] === 'maps'))
    return {
      refused: 'Google Maps shortened this link. Open it, then copy the address from your browser.',
    };
  if (host === 'google.com' || host === 'maps.google.com') {
    if (path[0] === 'maps' && path[1] === 'embed')
      return {
        refused:
          'That is Google’s embed code. Open the map itself and copy the address from your browser.',
      };
    // `/maps/@lat,lng,zoom` is a view, not a place: a pin at its centre is not what was seen.
    if (path[0] === 'maps' && path[1]?.startsWith('@') && !url.searchParams.has('q'))
      return {
        refused:
          'This link is a map view with no place on it. Search for the place in Google Maps, then copy the address from your browser.',
      };
    const q =
      url.searchParams.get('q') ??
      (path[0] === 'maps' && path[1] === 'place' ? place(path[2] ?? '') : '');
    if (q && !/[<>]/.test(q)) return { embed: { provider: 'google-maps', id: q } };
  }
  return { refused: UNKNOWN };
}

/** The iframe's address, built from the provider's own template and the stored id. */
export function embedSrc(value: EmbedValue): string {
  const id = encodeURIComponent(value.id);
  switch (value.provider) {
    case 'youtube':
      return `https://www.youtube-nocookie.com/embed/${id}${value.start ? `?start=${value.start}` : ''}`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${id}?dnt=1${value.start ? `#t=${value.start}s` : ''}`;
    case 'google-maps':
      return `https://www.google.com/maps?q=${id}&output=embed`;
  }
}

/**
 * The still the browser loads straight from the provider — no thumbnail fetch through the
 * Worker. Only YouTube has one at an address that can be guessed from the id.
 */
export const embedThumb = (value: EmbedValue): string | undefined =>
  value.provider === 'youtube'
    ? `https://i.ytimg.com/vi/${encodeURIComponent(value.id)}/hqdefault.jpg`
    : undefined;
