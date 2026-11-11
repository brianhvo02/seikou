#!/usr/bin/env bash
# Seikou's own code is LGPL-3.0-or-later. A source file keeps LGPL-2.1-or-later only when it ports or derives from an
# upstream released under that licence, and its header says so. src/bdj-classlib/ (GPLv2 with the Classpath Exception)
# is not checked. This fails when:
# - a file carries LGPL-2.1 but its leading comment block (within its first 15 lines) has no porting line ("Ported
#   from", "Derived from", "Port of", "Based on", "Adapted from"), no upstream's copyright line, and no stated reason
#   ("LGPL-2.1-or-later because"); naming an upstream in running text is not enough;
# - a file a NOTICE lists as derived from libbluray, libudfread, FFmpeg or libass is missing or does not carry
#   LGPL-2.1-or-later in its header (the NOTICE lists are the one record of derived files; the check reads them);
# - a package holding LGPL-2.1 files does not ship the LGPL-2.1 text (LICENSES/LGPL-2.1.txt, listed in "files");
# - a package.json states a licence other than LGPL-3.0-or-later.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# A porting line: one that says so at the start of a comment line. A file that only mentions libbluray or libass in its
# explanation is not ported from it. Original code that stays LGPL-2.1 says why ("LGPL-2.1-or-later because").
upstream='^[[:space:]]*(\*|//)?[[:space:]]*(ported( to typescript)? from|derived from|port of|based on|adapted from)\b|lgpl-2\.1-or-later because'
own_holder='seikou (authors|contributors)'
lgpl21='SPDX-License-Identifier: LGPL-2\.1'

status=0
problem() { echo "licence-check: $*" >&2; status=1; }

# The file's leading comment block, within its first 15 lines: the comments before the first line of code. Only the
# header counts, so a code line that merely names an upstream (an import of libbluray-j2se.jar) is no upstream line.
leading_comments() {
  awk '
    NR > 15 { exit }
    incomment { print; if ($0 ~ /\*\//) incomment = 0; next }
    /^[ \t]*$/ { next }
    /^[ \t]*\/\// { print; next }
    /^[ \t]*\/\*/ { print; rest = substr($0, index($0, "/*") + 2); if (rest !~ /\*\//) incomment = 1; next }
    { exit }' "$1"
}

while IFS= read -r file; do
  header="$(leading_comments "$file")"
  grep -q "$lgpl21" <<<"$header" || continue
  grep -qiE "$upstream" <<<"$header" && continue
  grep -i 'copyright' <<<"$header" | grep -qviE "$own_holder" && continue
  problem "$file is LGPL-2.1 but has no porting line, upstream copyright or stated reason; Seikou's own code is LGPL-3.0-or-later"
done < <(git ls-files -- '*.ts' '*.tsx' '*.c' ':!src/bdj-classlib/**')

# Derived files, as each NOTICE lists them: under a libbluray, libudfread, FFmpeg or libass heading, the lines after
# "Derived file(s)" up to a blank line whose first word is a .ts path followed (perhaps after a note) by "from".
derived() {
  awk '
    /^[^ \t]/ { upstream = ($0 ~ /^(libbluray|libudfread|FFmpeg|libass) /); inlist = 0; next }
    /^[ \t]*$/ { inlist = 0; next }
    upstream && /^[ \t]+Derived files?[ :(]/ { inlist = 1; next }
    inlist && match($0, /^[ \t]+[A-Za-z0-9_.\/-]+\.ts[ \t]+(.*[ \t])?from[ \t]/) {
      split(substr($0, RSTART, RLENGTH), f, /[ \t]+/); print f[2]
    }' "$1" | sort -u
}
# Each NOTICE with its paths' base: a package's are relative to its src/, src/bdj/NOTICE's to src/.
count=0
for pair in packages/ass/NOTICE:packages/ass/src packages/bdmv/NOTICE:packages/bdmv/src \
  packages/engine/NOTICE:packages/engine/src packages/pg/NOTICE:packages/pg/src src/bdj/NOTICE:src; do
  notice="${pair%%:*}" base="${pair#*:}"
  while IFS= read -r path; do
    count=$((count + 1))
    file="$base/$path"
    if [ ! -f "$file" ]; then problem "$notice lists $path as derived, but $file does not exist"; continue; fi
    # libass ports carry their SPDX line just past the 15-line window, after the ported-function list.
    head -n 30 "$file" | grep -q 'SPDX-License-Identifier: LGPL-2\.1-or-later' ||
      problem "$file is listed as derived in $notice but does not carry LGPL-2.1-or-later"
  done < <(derived "$notice")
done
[ "$count" -gt 0 ] || problem 'no derived files found in the NOTICE files; has their format changed?'

[ -f LICENSES/LGPL-2.1.txt ] || problem 'LICENSES/LGPL-2.1.txt is missing'
for dir in packages/*/; do
  dir="${dir%/}"
  git grep -q "$lgpl21" -- "$dir/src" || continue
  cmp -s LICENSES/LGPL-2.1.txt "$dir/LICENSES/LGPL-2.1.txt" ||
    problem "$dir holds LGPL-2.1 files but $dir/LICENSES/LGPL-2.1.txt is missing or differs from the root copy"
  node -e 'process.exit(require(`./${process.argv[1]}/package.json`).files.includes("LICENSES") ? 0 : 1)' "$dir" ||
    problem "$dir holds LGPL-2.1 files but its package.json \"files\" does not list LICENSES"
done

while IFS= read -r manifest; do
  licence="$(node -p "require('./$manifest').license")"
  [ "$licence" = 'LGPL-3.0-or-later' ] || problem "$manifest states \"$licence\"; expected LGPL-3.0-or-later"
done < <(git ls-files -- 'package.json' '**/package.json' ':!**/node_modules/**')

[ "$status" -eq 0 ] && echo "licence-check: ok ($count derived files checked against the NOTICEs)"
exit "$status"
