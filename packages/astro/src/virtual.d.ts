declare module 'virtual:handover/config' {
  const config: import('./index.js').HandoverConfig;
  export default config;
}

declare module 'virtual:handover/ui' {
  const assets: Record<string, string>;
  export default assets;
}
