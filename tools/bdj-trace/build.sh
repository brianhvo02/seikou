#!/usr/bin/env bash
# Builds patched libbluray (with BD-J) and the trace harness in Docker. The image is linux/amd64 everywhere so CI
# and Apple-silicon hosts agree; BDJ_TRACE_PLATFORM overrides that for local runs only (see README.md).
# The build context is a copy of this folder plus the bundled fallback font (packages/ass/src/default-font.ttf).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=bluray-web-bdj-trace
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"

CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT
cp "$HERE/Dockerfile" "$HERE/trace.patch" "$HERE/bdj_trace.c" "$CTX/"
cp "$ROOT/packages/ass/src/default-font.ttf" "$CTX/"

docker build --platform "$PLATFORM" -t "$IMAGE" "$CTX"
echo "built image $IMAGE ($PLATFORM)"
