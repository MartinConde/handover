import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { init } from './init.js';
import { dbGenerate, migrate } from './migrate.js';

const USAGE = 'Usage: handover <init <owner-email> | migrate [--dry-run] | db generate [--check]>';

export interface Env {
  cwd: string;
  log: (line: string) => void;
  /** Runs a bin from the site's node_modules, output straight to the terminal. */
  run: (argv: string[]) => void;
  /** The same, but returns what it wrote to stdout. */
  capture: (argv: string[]) => string;
  /** Returns stdout on success and undefined on failure, without printing an expected miss. */
  probe?: (argv: string[]) => string | undefined;
}

export async function main(argv: string[], env: Env): Promise<number> {
  const [cmd, sub] = argv;
  if (
    ['--help', '-h'].includes(argv.at(-1) ?? '') &&
    (argv.length === 1 ||
      (argv.length === 2 && ['init', 'migrate', 'db'].includes(cmd ?? '')) ||
      (argv.length === 3 && cmd === 'db' && sub === 'generate'))
  ) {
    env.log(USAGE);
    return 0;
  }
  try {
    if (cmd === 'init' && argv.length === 2 && sub) return init(env, sub);
    if (cmd === 'migrate' && (argv.length === 1 || (argv.length === 2 && sub === '--dry-run')))
      return migrate(env, sub === '--dry-run');
    if (
      cmd === 'db' &&
      sub === 'generate' &&
      (argv.length === 2 || (argv.length === 3 && argv[2] === '--check'))
    )
      return dbGenerate(env, argv[2] === '--check');
  } catch (e) {
    env.log(e instanceof Error ? e.message : String(e));
    return 1;
  }
  env.log(USAGE);
  return 1;
}

/** The runners for a real terminal: the bin is the site's own install, not ours. */
export function bins(cwd: string): Pick<Env, 'run' | 'capture' | 'probe'> {
  const path = (bin: string) => {
    const p = join(cwd, 'node_modules/.bin', bin);
    if (!existsSync(p)) throw new Error(`${bin} is not installed here: pnpm add -D ${bin}`);
    return p;
  };
  return {
    run: ([bin = '', ...args]) => void execFileSync(path(bin), args, { cwd, stdio: 'inherit' }),
    // stderr stays on the terminal so wrangler's own progress is still visible.
    capture: ([bin = '', ...args]) =>
      execFileSync(path(bin), args, {
        cwd,
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit'],
      }),
    probe: ([bin = '', ...args]) => {
      const result = spawnSync(path(bin), args, { cwd, encoding: 'utf8', stdio: 'pipe' });
      return result.status === 0 ? result.stdout : undefined;
    },
  };
}
