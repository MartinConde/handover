/// <reference types="vite/client" />

declare module 'virtual:handover/config' {
  const config: import('./index.js').HandoverConfig;
  export default config;
}

declare module 'virtual:handover/index' {
  const index: import('@handover/core').ContentIndex;
  export default index;
  /** Whether this build was told to serve `/_preview`, which is what the admin draws from. */
  export const preview: boolean;
  /** `site` from astro.config without its trailing slash, or empty: what an address is printed under. */
  export const site: string;
  /** The starters each collection ships under `src/content/_templates/`, by collection. */
  export const templates: Record<string, import('@handover/core').Template[]>;
  /** Which stored media keys each content file names, for the library's usage counts. */
  export const uses: import('@handover/core').MediaUses;
  /** `"listings/mill-house" -> ["de"]`: translations made from a source that has moved on since. */
  export const stale: Record<string, string[]>;
}

declare module 'virtual:handover/loaders' {
  const loaders: Record<string, import('./routes/preview.js').PageModule>;
  export default loaders;
}

declare module 'virtual:handover/ui' {
  const assets: Record<string, string>;
  export default assets;
}

declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
}

// What the session middleware puts in front of every handler under /admin/api/, and what
// @astrojs/cloudflare puts there before either of us — `cfContext` is its `ExecutionContext`.
declare namespace App {
  interface Locals {
    handover?: import('./auth.js').Session;
    cfContext?: import('./auth.js').CloudflareContext;
  }
}
