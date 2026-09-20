// `drizzle.config.ts` points here; Better Auth's tables are in so both land in one migration.
export {
  account,
  activity,
  costlyOperations,
  cronState,
  drafts,
  locks,
  media,
  operations,
  pathReservations,
  rateLimit,
  resourceLimits,
  session,
  settings,
  uploadIntents,
  user,
  verification,
} from '@handover/core';
