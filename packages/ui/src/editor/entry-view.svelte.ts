import { siteBase } from '../request.js';

export type EditorMode = 'form' | 'split' | 'canvas';
type Beside = 'page' | 'language' | 'none';
const BESIDE: Beside[] = ['page', 'language', 'none'];

// A blocked browser preference must never block editing.
export function readPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Kept for this visit only.
  }
}

// One saved preference behind three flags whose setters edit each other.
export function createEntryView({
  userId,
  preview,
  route,
  section,
  many,
  toContent,
}: {
  userId: () => string;
  preview: () => boolean;
  route: () => string | undefined;
  section: () => string;
  many: () => boolean;
  toContent: () => void;
}) {
  // v3: Form and Split became one view, so earlier saved values mean nothing here.
  const viewKey = `handover:editor-view:v3:${siteBase() || '/'}:${userId()}`;
  const saved = readPreference(viewKey);
  let chosen = $state<Beside | undefined>(
    BESIDE.includes(saved as Beside) ? (saved as Beside) : undefined,
  );
  let canvasOpen = $state(saved === 'canvas');
  // Saved as 'form': a page could be shown, but the editor folded it away for a full-width form.
  let collapsed = $state(saved === 'form');
  const canvasSupported = $derived(preview() && Boolean(route()));
  const pageShown = $derived(section() === '' && canvasSupported);
  const besideOptions = $derived(
    BESIDE.filter((of) => (of === 'page' ? pageShown : of === 'language' ? many() : !pageShown)),
  );
  const beside = $derived<Beside>(
    chosen && besideOptions.includes(chosen) ? chosen : pageShown && !collapsed ? 'page' : 'none',
  );
  const side = $derived(beside === 'language');
  const mode = $derived<EditorMode>(
    pageShown && canvasOpen ? 'canvas' : beside === 'page' ? 'split' : 'form',
  );
  let canvasVisited = $state(false);
  let mobilePane = $state<'form' | 'page'>('form');

  // A link that opens a language is for this visit; only the person's own choice is saved.
  function setBeside(next: Beside, save = true) {
    if (next === 'none' && pageShown) next = 'page';
    chosen = next;
    collapsed = false;
    canvasOpen = false;
    if (save) savePreference(viewKey, next);
  }
  function collapse() {
    chosen = undefined;
    collapsed = true;
    canvasOpen = false;
    savePreference(viewKey, 'form');
  }
  function setCanvas(open: boolean) {
    if (open && !canvasSupported) return;
    canvasOpen = open;
    if (open) mobilePane = 'page';
    savePreference(viewKey, open ? 'canvas' : collapsed && pageShown ? 'form' : beside);
    if (open && section() !== '') toContent();
  }

  return {
    get canvasSupported() {
      return canvasSupported;
    },
    get pageShown() {
      return pageShown;
    },
    get besideOptions() {
      return besideOptions;
    },
    get beside() {
      return beside;
    },
    get side() {
      return side;
    },
    get mode() {
      return mode;
    },
    get canvasVisited() {
      return canvasVisited;
    },
    set canvasVisited(value: boolean) {
      canvasVisited = value;
    },
    get mobilePane() {
      return mobilePane;
    },
    set mobilePane(value: 'form' | 'page') {
      mobilePane = value;
    },
    setBeside,
    collapse,
    setCanvas,
  };
}
