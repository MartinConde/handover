declare module 'virtual:handover/ui' {
  const assets: {
    entries: Record<string, { script: string; styles: string[] }>;
    files: Record<string, string>;
  };
  export default assets;
}
