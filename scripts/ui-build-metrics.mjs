import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || !value) throw new Error('Use --ui <dir> [--worker <dir>]');
  args.set(flag, value);
}

const uiDir = resolve(args.get('--ui') ?? 'packages/astro/dist/ui');
const manifest = JSON.parse(await readFile(resolve(uiDir, 'manifest.json'), 'utf8'));

async function filesBelow(dir, include) {
  const files = [];
  async function visit(at = '') {
    for (const entry of await readdir(resolve(dir, at), { withFileTypes: true })) {
      const name = at ? `${at}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (include(name)) files.push(name);
    }
  }
  await visit();
  return files.sort();
}

function entryFiles(source) {
  const visited = new Set();
  const files = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`UI manifest has no ${key}`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) visit(imported);
  }
  visit(source);
  return [...files].sort();
}

async function sizes(dir, files) {
  let decoded = 0;
  let gzip = 0;
  let brotli = 0;
  for (const file of files) {
    const bytes = await readFile(resolve(dir, file));
    decoded += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
    brotli += brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
  }
  return { files, decoded, gzip, brotli };
}

const report = {
  uiDir,
  admin: await sizes(uiDir, entryFiles('src/main.ts')),
  canvas: await sizes(uiDir, entryFiles('src/canvas.ts')),
  canvasRichText: await sizes(uiDir, entryFiles('src/canvas/runtime/canvas-rich-text.ts')),
};
report.allUiAssets = await sizes(
  uiDir,
  await filesBelow(uiDir, (file) => /\.(?:js|css)$/.test(file)),
);

const workerDir = args.get('--worker');
if (workerDir) {
  const absolute = resolve(workerDir);
  report.workerModules = await sizes(
    absolute,
    await filesBelow(absolute, (file) => file.endsWith('.mjs')),
  );
}

console.log(JSON.stringify(report, null, 2));
