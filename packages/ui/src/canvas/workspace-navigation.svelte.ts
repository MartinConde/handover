import type { EntrySession } from '../editor/entry-session.svelte';
import { EMPTY_ENTRY_DIRECTORY, readEntryDirectory } from '../entry-directory';
import type { messageOptions } from '../i18n.js';
import * as m from '../paraglide/messages.js';
import { previewPath } from '../request';
import type { CanvasNavigationMessage } from './canvas-protocol';
import {
  type CanvasNavigationDestination,
  classifyCanvasNavigation,
} from './runtime/canvas-navigation';

type NavigationError = 'form-get' | 'form-post' | 'navigation-save' | 'preview-save';

// Links and forms followed inside Canvas: saved first, then opened as an entry or offered as a new tab.
export function createWorkspaceNavigation({
  session,
  fullscreen,
  url,
  options,
  onnavigateentry,
}: {
  session: () => EntrySession;
  fullscreen: () => boolean;
  url: () => string;
  options: () => ReturnType<typeof messageOptions>;
  onnavigateentry: () => (target: {
    collection: string;
    id: string;
    locale: string;
    href: string;
  }) => void;
}) {
  let navigationError = $state<NavigationError>();
  let navigationBusy = false;
  let navigationAction = $state<{
    destination: CanvasNavigationDestination;
    download: boolean;
  }>();

  const navigationErrorText = $derived.by(() => {
    switch (navigationError) {
      case 'preview-save':
        return m.canvas_preview_save_failed({}, options());
      case 'navigation-save':
        return m.canvas_navigation_save_failed({}, options());
      case 'form-post':
        return m.canvas_form_submit_blocked({}, options());
      case 'form-get':
        return m.canvas_form_navigation_blocked({}, options());
      default:
        return '';
    }
  });

  const previewHref = (href: string) => {
    const target = new URL(href, location.href);
    return previewPath(`${target.pathname}${target.search}${target.hash}`);
  };

  async function openCurrentPreview() {
    navigationError = undefined;
    if (!(await session().flush())) {
      navigationError = 'preview-save';
      return;
    }
    window.open(previewPath(url() || '/'), '_blank', 'noopener,noreferrer');
  }

  async function canvasNavigate(message: CanvasNavigationMessage) {
    if (navigationBusy || !fullscreen()) return;
    navigationBusy = true;
    navigationError = undefined;
    navigationAction = undefined;
    if (message.kind === 'form') {
      navigationError = message.method === 'post' ? 'form-post' : 'form-get';
      navigationBusy = false;
      return;
    }
    let index = EMPTY_ENTRY_DIRECTORY;
    try {
      index = await readEntryDirectory();
    } catch {
      // An unavailable route index simply makes a same-site destination an explicit preview.
    }
    const destination = classifyCanvasNavigation(message.href, index, location.origin);
    if (!(await session().flush())) {
      navigationError = 'navigation-save';
      navigationBusy = false;
      return;
    }
    if (message.download || message.newTab || destination.kind !== 'entry') {
      navigationAction = { destination, download: message.download };
      navigationBusy = false;
      return;
    }
    onnavigateentry()(destination);
    navigationBusy = false;
  }

  function followNavigationAction() {
    const action = navigationAction;
    if (!action) return;
    const { destination } = action;
    const href =
      destination.kind === 'external' || action.download
        ? destination.href
        : previewHref(destination.href);
    window.open(href, '_blank', 'noopener,noreferrer');
    navigationAction = undefined;
  }

  return {
    get error() {
      return navigationError;
    },
    set error(next) {
      navigationError = next;
    },
    get errorText() {
      return navigationErrorText;
    },
    get action() {
      return navigationAction;
    },
    set action(next) {
      navigationAction = next;
    },
    openCurrentPreview,
    canvasNavigate,
    followNavigationAction,
  };
}
