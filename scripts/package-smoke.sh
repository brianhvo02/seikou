#!/usr/bin/env bash
# Consumes the packages as an outside project would: a clean temp project installs them as file: dependencies (copied,
# not linked, so only what each package's "files" lists arrives), parses a disc and an ASS script with tsx, and builds
# a page that starts the engine's worker with Vite, whose output must carry the worker's wasm and font assets.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$repo/node_modules/.bin"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
fail() { echo "package-smoke: $*" >&2; exit 1; }

npm init -y >/dev/null
# The engine's own @seikou dependencies are unpublished, so they are installed from the repo as well.
npm install --no-audit --no-fund --install-links \
  "file:$repo/packages/bdmv" "file:$repo/packages/ass" "file:$repo/packages/nas" "file:$repo/packages/pg" \
  "file:$repo/packages/engine" >/dev/null

# Parsing through the barrels: disc1's index and first playlist, and a two-line ASS script.
cat > parse.ts <<'TS'
import { readFileSync } from 'node:fs';
import { parseIndex, parseMpls } from '@seikou/bdmv';
import { parseAss } from '@seikou/ass';
const disc = process.argv[2] + '/BDMV';
const index = parseIndex(readFileSync(disc + '/index.bdmv'));
const mpls = parseMpls(readFileSync(disc + '/PLAYLIST/00000.mpls'));
const ass = parseAss('[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,Hello\n');
console.log(typeof index, mpls.playItems.length > 0, ass.events.length, ass.events[0]?.text);
TS
parsed="$("$bin/tsx" parse.ts "$repo/fixtures/synthetic/disc1")"
echo "$parsed"
[ "$parsed" = 'object true 1 Hello' ] || fail "expected 'object true 1 Hello', got '$parsed'"

# A page that starts the engine's worker, built by Vite.
echo '<script type="module">import { createEngineWorker } from "@seikou/engine"; createEngineWorker("smoke");</script>' > index.html
"$bin/vite" build --logLevel warn >/dev/null || fail 'vite build of a page importing @seikou/engine failed'
for asset in audio.wasm default-font.ttf; do
  ls dist/assets | grep -Eq "^${asset%.*}-.*\.${asset##*.}$" || fail "dist/assets has no $asset: $(ls dist/assets | tr '\n' ' ')"
done
echo 'package-smoke: ok'
