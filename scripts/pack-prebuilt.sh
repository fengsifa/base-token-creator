#!/usr/bin/env bash
#
# Turn a finished `next build` into the tarball that becomes the production image.
#
#   npm run build
#   scripts/pack-prebuilt.sh
#
# Produces:
#   build/prebuilt/           staging tree, exactly what lands at /app in the image
#   tokenapp-prebuilt.tar.gz  upload this to the host
#
# The tarball is the whole application: server.js, the traced node_modules, the
# server chunks, the browser chunks and public/. Nothing is installed or compiled
# again on the host — see Dockerfile.prebuilt for why.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$(cd "$REPO/.." && pwd)/tokenapp-prebuilt.tar.gz}"
STAGE="$REPO/build/prebuilt"

cd "$REPO"

# ---------------------------------------------------------------------------
# Refuse to package a tree that was never built, rather than shipping a broken
# image that only fails once it is running.
# ---------------------------------------------------------------------------
missing=""
for need in .next/standalone/server.js .next/static .next/BUILD_ID; do
  [ -e "$need" ] || missing="$missing $need"
done
if [ -n "$missing" ]; then
  echo "cannot package — missing:$missing" >&2
  echo "run 'npm run build' first" >&2
  exit 1
fi

rm -rf "$REPO/build"
mkdir -p "$STAGE"

echo "=== 1/4 server bundle (.next/standalone) ==="
# Carries server.js, .next/server/** and the file-tracing-pruned node_modules.
cp -r .next/standalone/. "$STAGE"/

echo "=== 2/4 browser chunks (.next/static) ==="
# Next leaves these out of standalone; without them every page 404s its JS.
mkdir -p "$STAGE/.next/static"
cp -r .next/static/. "$STAGE/.next/static/"

echo "=== 3/4 public/ ==="
mkdir -p "$STAGE/public"
cp -r public/. "$STAGE/public/"

# The webpack cache only helps a subsequent build, and it is hundreds of
# megabytes. It has no business in a runtime image.
rm -rf "$STAGE/.next/cache"

# Compose mounts the uploads volume here; the mount point must already exist.
mkdir -p "$STAGE/public/uploads"

# ---------------------------------------------------------------------------
# Provenance. If a deployed image ever behaves unlike the source checkout, these
# two lines are what settle which build it actually is.
# ---------------------------------------------------------------------------
{
  echo "build_id=$(cat .next/BUILD_ID)"
  echo "commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "commit_subject=$(git log -1 --pretty=%s 2>/dev/null || echo unknown)"
  echo "packed_at_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "source_working_tree_clean=$([ -z "$(git status --porcelain 2>/dev/null)" ] && echo yes || echo no)"
} > "$STAGE/BUILD-PROVENANCE.txt"

echo "=== 4/4 tarball ==="
tar -czf "$OUT" -C "$STAGE" .

echo
echo "packed     $OUT"
echo "size       $(du -h "$OUT" | cut -f1)"
echo "entries    $(tar -tzf "$OUT" | wc -l)"
echo "BUILD_ID   $(cat .next/BUILD_ID)"
echo "commit     $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
