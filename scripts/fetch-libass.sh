#!/usr/bin/env bash
# Clones libass at the commit Seikou ports from (tag 0.17.5), into .cache/libass (gitignored).
set -euo pipefail
COMMIT=4a05d8127f525943ebf45fdc6497c9e665947f0d
DEST="$(cd "$(dirname "$0")/.." && pwd)/.cache/libass"
if [[ -d "$DEST/.git" ]] && [[ "$(git -C "$DEST" rev-parse HEAD)" == "$COMMIT" ]]; then exit 0; fi
rm -rf "$DEST"
git clone --quiet https://github.com/libass/libass.git "$DEST"
git -C "$DEST" checkout --quiet "$COMMIT"
