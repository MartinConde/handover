declare module 'virtual:handover/config' {
  const config: import('./index.js').HandoverConfig;
  export default config;
}

declare module 'virtual:handover/index' {
  const index: import('@handover/core').ContentIndex;
  export default index;
}

declare module 'virtual:handover/ui' {
  const assets: Record<string, string>;
  export default assets;
}

declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
}

// What the session middleware puts in front of every handler under /admin/api/.
declare namespace App {
  interface Locals {
    handover?: import('./auth.js').Session;
  }
}
