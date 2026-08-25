// Only `npx auth generate` loads this. The CLI needs a Better Auth instance at module
// scope and the Worker must never have one, so the instance lives here rather than in
// packages/, and it is built from `authOptions` so the generated tables come from the
// same config the app runs. Nothing here is published.
//
//   npx auth@1.7.1 generate --config scripts/auth-config.ts \
//     --adapter drizzle --dialect sqlite --output packages/core/src/auth-schema.ts --yes
import { betterAuth } from 'better-auth/minimal';
import { authOptions } from '../packages/core/src/auth.js';
import { openDb } from '../packages/core/src/db.js';

export const auth = betterAuth(
  authOptions(openDb('default', {} as never), {
    secret: 'schema-generation-only',
    // Every optional method concretely, so generation sees the widest set of tables the
    // package can mount. `baseURL` is what gates the two that mail a link.
    baseURL: 'https://schema-generation-only.example',
    github: { clientId: '', clientSecret: '' },
    sendMagicLink: async () => {},
    sendPasswordReset: async () => {},
  }),
);
