// `drizzle.config.ts` in the site repo points at this file: one schema, one generator,
// one migrations/ folder. The Better Auth tables are here too, so the auth and Handover
// tables land in the same D1 and the same migration.
export {
  account,
  activity,
  cronState,
  drafts,
  locks,
  media,
  rateLimit,
  session,
  settings,
  user,
  verification,
} from '@handover/core';
