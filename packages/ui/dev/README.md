# Design preview

Run `pnpm --filter @handover/ui fixtures` from the monorepo and open
[the design preview](http://localhost:5173/review.html). The regular component fixtures remain at `/`.

This mounts the real application components with sample data and handles all admin API calls
in the browser. No site is connected, no service is contacted, and content writes are refused.
The production build uses only `src/main.ts`, so the preview and its fixtures do not ship.

Use `?screen=/admin/site`, `?screen=/admin/c/listings`, `?screen=/admin/c/pages/home`,
`?screen=/admin/media`, or `?screen=/admin/settings` to open a particular screen. Navigate using
the sidebar; reload the preview URL to reset the sample session. Images are labeled sample
swatches, not site assets. Complete publishing and upload checks require a connected test site.
