import type { Db, GitClient } from '@handover/core';
import { db, gitClient } from './environment.js';

export type RequestContext = { db: () => Db; git: () => GitClient };

/** Lazy dependencies belong to one HTTP request, including all its parallel content reads. */
export function requestContext(): RequestContext {
  let database: Db | undefined;
  let git: GitClient | undefined;
  return {
    db: () => (database ??= db()),
    git: () => (git ??= gitClient()),
  };
}
