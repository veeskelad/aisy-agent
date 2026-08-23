#!/usr/bin/env bash
set -euo pipefail

# Cut a release. Bumps every package version, commits, tags, and pushes — the
# Release workflow (.github/workflows/release.yml) then builds + publishes to npm
# (with provenance) and cuts the GitHub Release. No manual `pnpm publish`.
#
# Usage:
#   1. Add the new version's entry to CHANGELOG.md by hand.
#   2. scripts/release.sh X.Y.Z
#
# Requires: on master, clean tree (CHANGELOG.md edit is allowed), a pushable remote,
# and the NPM_TOKEN GitHub secret set to a granular read-write + bypass-2FA token.

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release.sh X.Y.Z   (semver, e.g. 0.1.3)" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

[[ "$(git branch --show-current)" == "master" ]] || { echo "error: not on master" >&2; exit 1; }

# Allow a modified CHANGELOG.md (the release note); reject any other dirty tracked file.
dirty="$(git status --porcelain --untracked-files=no | grep -v ' CHANGELOG.md$' || true)"
if [[ -n "$dirty" ]]; then
  echo "error: uncommitted changes other than CHANGELOG.md:" >&2
  echo "$dirty" >&2
  exit 1
fi

# Bump the top-of-file "version" line only (regex; never re-serialize the JSON, so
# diffs stay minimal and key order/formatting is preserved). Dep version strings live
# lower in the file, so the $. < 6 guard keeps the replace to the package's own version.
for f in package.json packages/app/package.json packages/core-ts/package.json packages/telegram-gw/package.json; do
  perl -i -pe 's/^(\s*"version":\s*")[0-9]+\.[0-9]+\.[0-9]+(")/${1}'"$VERSION"'${2}/ if $. < 6' "$f"
done

git add package.json packages/*/package.json CHANGELOG.md
git commit -m "release($VERSION)"
git tag "v$VERSION"
git push origin master "v$VERSION"

echo "Pushed v$VERSION → the Release workflow builds + publishes to npm and cuts the GitHub Release."
echo "Watch: gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
