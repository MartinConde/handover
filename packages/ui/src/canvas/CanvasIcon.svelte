<script lang="ts">
let { name }: { name: string } = $props();
const paths: Record<string, string> = {
  back: 'm12 4-6 6 6 6M6 10h12',
  undo: 'M7 4 3 8l4 4M3 8h8a5 5 0 1 1 0 10',
  redo: 'm13 4 4 4-4 4M17 8H9a5 5 0 1 0 0 10',
  desktop: 'M3 3h14v11H3zM10 14v4M6 18h8',
  tablet: 'M4 2h12v16H4zM9 15h2',
  phone: 'M6 2h8v16H6zM9 15h2',
  structure: 'M3 3h14v14H3zM7 3v14M10 7h4M10 10h4M10 13h3',
  inspector: 'M3 3h14v14H3zM13 3v14M6 7h4M6 10h4',
  'collapse-left': 'M4 3v14m10-12-5 5 5 5',
  'collapse-right': 'M16 3v14M6 5l5 5-5 5',
  external: 'M11 3h6v6M17 3l-9 9M7 4H3v13h13v-4',
  image: 'M3 3h14v14H3zM3 14l5-5 4 4 2-2 3 3M13 6h.01',
  text: 'M4 4h12M10 4v13M7 17h6M4 4v3M16 4v3',
  block: 'M3 3h14v14H3zM3 8h14',
  duplicate: 'M7 7h10v10H7zM13 7V3H3v10h4',
  up: 'm5 9 5-5 5 5M10 4v13',
  down: 'm5 11 5 5 5-5M10 3v13',
  plus: 'M10 3v14M3 10h14',
};
</script>

<svg class="canvas-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name] || paths.block} /></svg>
