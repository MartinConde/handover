// Only `npx auth generate` loads this: the Worker must never hold a module-scope instance.
import { betterAuth } from 'better-auth/minimal';
import { authOptions } from '../packages/core/src/auth.js';
import { openDb } from '../packages/core/src/db.js';

export const auth = betterAuth(
  authOptions('default', openDb('default', {} as never), {
    secret: 'schema-generation-only',
    // Every optional method set so generation sees every table; `baseURL` gates the mailing two.
    baseURL: 'https://schema-generation-only.example',
    github: { clientId: '', clientSecret: '' },
    sendMagicLink: async () => {},
    sendPasswordReset: async () => {},
  }),
);
