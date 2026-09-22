declare module 'virtual:handover/screens' {
  import type { Component } from 'svelte';

  /** The site's screens by key, compiled into this bundle by the site's own build; empty here. */
  const screens: Record<string, Component<import('./screen.js').ScreenProps>>;
  export default screens;
}
