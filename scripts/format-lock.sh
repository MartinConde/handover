#!/usr/bin/env sh
# A golden file is the byte-for-byte output of the serialiser for one shape. Changing one
# means every file already written in that shape now round-trips differently, which is the
# thing `_version` and `handover migrate` exist to carry. So a changed golden has to come
# with a format version bump; the step that goes with the bump is checked by
# `packages/core/src/migrate.test.ts`. Adding a golden is free — a new file cannot change
# the shape of one that already exists.
set -eu

base=${1:-}
case "$base" in
  '' | 0000000000000000000000000000000000000000)
    echo "format-lock: no base commit to compare against, nothing to check."
    exit 0
    ;;
esac

# --no-renames so a rename carrying an edit shows up as a delete plus an add, not as an R
# the MD filter would let through.
changed=$(git diff --name-only --no-renames --diff-filter=MD "$base...HEAD" -- packages/core/test/golden)
[ -n "$changed" ] || exit 0

version() {
  git show "$1:packages/core/src/content.ts" 2>/dev/null |
    sed -n 's/^export const FORMAT_VERSION = \([0-9][0-9]*\);$/\1/p'
}
before=$(version "$base")
after=$(version HEAD)

if [ -z "$before" ] || [ -z "$after" ]; then
  echo "format-lock: could not read FORMAT_VERSION from packages/core/src/content.ts"
  echo "  at $base: '${before:-not found}'   at HEAD: '${after:-not found}'"
  exit 1
fi

if [ "$after" -le "$before" ]; then
  echo "format-lock: the content format is locked, and these golden files changed:"
  echo "$changed" | sed 's/^/  /'
  echo "FORMAT_VERSION is still $after. Raise it in packages/core/src/content.ts and add the"
  echo "matching step to MIGRATIONS in packages/core/src/migrate.ts, so existing content files"
  echo "are migrated to the new shape instead of being read as if they were always in it."
  exit 1
fi

echo "format-lock: goldens changed with FORMAT_VERSION $before -> $after."
