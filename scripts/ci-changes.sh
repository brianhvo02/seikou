#!/usr/bin/env bash
# Decides which CI jobs a change needs (ci.yml's `changes` job). Usage: ci-changes.sh <base commit or empty> [head]
# Prints key=true|false lines for $GITHUB_OUTPUT: unit, e2e, ass (the test jobs) and site, worker, image (the deploys).
# With no base, or a base this clone doesn't have (a force push), everything is true. The groups are coarse on purpose:
# the server bundles src/engine/{bdmv,decode,demux,disc,util} and the ASS page src/engine/ass and memory-profile.ts
# (checked with esbuild's metafile); a dependency that slips past them is caught by the weekly full run.
set -euo pipefail
base="${1:-}"
head="${2:-HEAD}"

keys=(unit e2e ass site worker image)
all() { for k in "${keys[@]}"; do echo "$k=true"; done; }

if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "No base commit to compare with: every job runs." >&2
  all
  exit 0
fi

files="$(git diff --name-only "$base" "$head")"
echo "Changed since ${base:0:7}:" >&2
printf '%s\n' "$files" | sed 's/^/  /' >&2

# Shared ground: dependencies, compiler settings, test helpers and this CI itself run every test job.
FORCE='^(package\.json|package-lock\.json|tsconfig[^/]*\.json|tests/helpers/|\.github/workflows/ci\.yml|\.github/actions/|scripts/ci-)'
PKG='package\.json|package-lock\.json'
# Everything but Markdown (except docs/*.md, the /help pages), the owner's deploy files and the other workflows.
UNIT_SKIP='(\.md$|^server/deploy/|^\.github/workflows/)'
UNIT_KEEP='^docs/[^/]+\.md$'
E2E='^(src/|server/|rendezvous/|fixtures/synthetic/|fixtures/shaders/|tests/e2e/|public/|vite/|vite\.config\.ts|playwright\.config\.ts|index\.html|probe\.html|docs/[^/]+\.md$)'
ASS='^(src/engine/ass/|src/engine/subs/|src/engine/memory-profile\.ts|fixtures/ass/|tests/ass-trace/|playwright\.ass\.config\.ts|vite/|vite\.config\.ts)'
SITE="^(src/|public/|vite/|vite\.config\.ts|index\.html|probe\.html|docs/[^/]+\.md$|tsconfig[^/]*\.json|$PKG)"
WORKER="^(rendezvous/|src/engine/disc/(cors-policy|nas-api|pairing-code)\.ts|tsconfig\.rendezvous\.json|$PKG)"
IMAGE="^(server/|src/engine/(bdmv|decode|demux|disc|util)/|tsconfig\.server\.json|$PKG)"

has() { printf '%s\n' "$files" | grep -Eq "$1"; }
# server/deploy/ is the owner's deploy (compose files, scripts): no test or image reads it.
files="$(printf '%s\n' "$files" | grep -Ev '^server/deploy/' || true)"
force=false; has "$FORCE" && force=true

unit=false
if $force || printf '%s\n' "$files" | grep -Ev "$UNIT_SKIP" | grep -q . || has "$UNIT_KEEP"; then unit=true; fi
e2e=false; { $force || has "$E2E"; } && e2e=true
ass=false; { $force || has "$ASS"; } && ass=true
site=false; has "$SITE" && site=true
worker=false; has "$WORKER" && worker=true
image=false; has "$IMAGE" && image=true

for k in "${keys[@]}"; do echo "$k=${!k}"; done
