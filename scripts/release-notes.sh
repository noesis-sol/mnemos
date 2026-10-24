#!/bin/sh
# scripts/release-notes.sh <version>: prints CHANGELOG.md's entry for <version>, the lines under its
# "## <version> (date)" heading up to the next "## ", as the GitHub release's notes. Fails when there
# is no such entry. release.yml runs it before the tests and again to create the release.
set -e
cd "$(dirname "$0")/.."

version=${1:?usage: scripts/release-notes.sh <version>}
awk -v v="$version" '
  index($0, "## " v " (") == 1 { found = 1; next }
  found && /^## / { exit }
  found { print }
  END { if (!found) exit 1 }
' CHANGELOG.md || {
  echo "CHANGELOG.md has no entry \"## $version (date)\"" >&2
  exit 1
}
