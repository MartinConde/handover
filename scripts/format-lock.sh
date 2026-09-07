#!/usr/bin/env sh
# A changed golden changes how existing content round-trips, so it needs a FORMAT_VERSION bump.
set -eu

base=${1:-}
head=${2:-HEAD}
case "$base" in
  '' | 0000000000000000000000000000000000000000)
    echo "format-lock: no base commit to compare against, nothing to check."
    exit 0
    ;;
esac

# A base missing from the checkout was amended over, so compare against the commit before HEAD.
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "format-lock: $base is not in this checkout (amended and pushed over?); comparing against $head~1 instead."
  base="$head~1"
fi

# --no-renames so an edited rename shows as delete plus add, not an R the MD filter skips.
changed=$(git diff --name-only --no-renames --diff-filter=MD "$base...$head" -- packages/core/test/golden)
[ -n "$changed" ] || exit 0

version() {
  git show "$1:packages/core/src/content.ts" 2>/dev/null |
    sed -n 's/^export const FORMAT_VERSION = \([0-9][0-9]*\);$/\1/p'
}
before=$(version "$base")
after=$(version "$head")

if [ -z "$before" ] || [ -z "$after" ]; then
  echo "format-lock: could not read FORMAT_VERSION from packages/core/src/content.ts"
  echo "  at $base: '${before:-not found}'   at $head: '${after:-not found}'"
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
