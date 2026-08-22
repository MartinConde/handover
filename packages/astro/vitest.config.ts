import { getViteConfig } from 'astro/config';

// Astro's Vite plugins so `.astro` components can be rendered through the Container API.
export default getViteConfig({ test: { environment: 'node' } });
