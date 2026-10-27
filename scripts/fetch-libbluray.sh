#!/usr/bin/env bash
# Clones libbluray at the commit Seikou ports from, into .cache/libbluray (gitignored).
set -euo pipefail
COMMIT=448f896
DEST="$(cd "$(dirname "$0")/.." && pwd)/.cache/libbluray"
if [[ -d "$DEST/.git" ]] && [[ "$(git -C "$DEST" rev-parse --short=7 HEAD)" == "$COMMIT" ]]; then exit 0; fi
rm -rf "$DEST"
git clone --quiet https://code.videolan.org/videolan/libbluray.git "$DEST"
git -C "$DEST" checkout --quiet "$COMMIT"
