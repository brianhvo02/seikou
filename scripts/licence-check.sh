#!/usr/bin/env bash
# Seikou's own code is LGPL-3.0-or-later. A source file keeps LGPL-2.1-or-later only when it ports or derives from an
# upstream released under that licence, and its header says so. This fails when a file carries LGPL-2.1-or-later with
# no upstream named in its first 15 lines, or when a package.json states a licence other than LGPL-3.0-or-later.
# src/bdj-classlib/ (GPLv2 with the Classpath Exception) is not checked.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# An upstream project or its authors, a porting line, or a copyright line for anyone but the project itself.
upstream='libbluray|libudfread|ffmpeg|libass|vlc|freetype|anime4k|ported from|derived from|port of|based on|adapted from'
own_holder='bluray-web contributors|seikou authors'

status=0
while IFS= read -r file; do
  header="$(head -n 15 "$file")"
  grep -q 'SPDX-License-Identifier: LGPL-2\.1-or-later' <<<"$header" || continue
  grep -qiE "$upstream" <<<"$header" && continue
  grep -i 'copyright' <<<"$header" | grep -qviE "$own_holder" && continue
  echo "licence-check: $file is LGPL-2.1-or-later but names no upstream; Seikou's own code is LGPL-3.0-or-later" >&2
  status=1
done < <(git ls-files -- '*.ts' '*.tsx' '*.c' ':!src/bdj-classlib/**')

while IFS= read -r manifest; do
  licence="$(node -p "require('./$manifest').license")"
  if [ "$licence" != 'LGPL-3.0-or-later' ]; then
    echo "licence-check: $manifest states \"$licence\"; expected LGPL-3.0-or-later" >&2
    status=1
  fi
done < <(git ls-files -- 'package.json' '**/package.json' ':!**/node_modules/**')

[ "$status" -eq 0 ] && echo 'licence-check: ok'
exit "$status"
