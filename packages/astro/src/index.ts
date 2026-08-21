import type { AstroIntegration } from 'astro';

export const NO_ADAPTER_MESSAGE =
  'astro-handover needs an SSR adapter: add `adapter: cloudflare()` from `@astrojs/cloudflare` to astro.config.';

export default function handover(): AstroIntegration {
  return {
    name: 'astro-handover',
    hooks: {
      'astro:config:setup': ({ config, logger }) => {
        if (!config.adapter) throw new Error(NO_ADAPTER_MESSAGE);
        logger.info('astro-handover integration loaded');
      },
    },
  };
}
