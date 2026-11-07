#!/usr/bin/env bash
# Installs each workspace package into a clean temp project with file: and imports it, as a consumer would.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tsx="$repo/node_modules/.bin/tsx"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
npm init -y >/dev/null
npm install --no-audit --no-fund "file:$repo/packages/bdmv" >/dev/null
out="$("$tsx" -e "import { ByteReader } from '@seikou/bdmv/byte-reader'; console.log(typeof ByteReader)")"
echo "$out"
deep="$("$tsx" -e "import { SOURCE_PACKET_SIZE } from '@seikou/bdmv/demux/constants'; import { parseMpls } from '@seikou/bdmv'; console.log(SOURCE_PACKET_SIZE, typeof parseMpls)")"
echo "$deep"
[ "$deep" = "192 function" ] || { echo "package-smoke: expected '192 function', got '$deep'" >&2; exit 1; }
[ "$out" = "function" ] || { echo "package-smoke: expected 'function', got '$out'" >&2; exit 1; }
