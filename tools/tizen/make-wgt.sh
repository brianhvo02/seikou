#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Builds a hosted Samsung TV widget (.wgt) that opens a page of the player, signed with a Samsung certificate profile.
# Usage: tools/tizen/make-wgt.sh --profile <certificate profile> [--url <https URL>] [--name <app name>] [--package <10 letters/digits>] [--out <dir>]
# Needs the Tizen CLI (`tizen`) on PATH; see tools/tizen/README.md.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
url="https://bluray.pages.dev/probe.html"
name="Seikou probe"
appname="Probe"
package="SeikouPrb1"
profile=""
out="$repo/.cache/tizen"
version="0.1.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) url="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --app) appname="$2"; shift 2 ;;
    --package) package="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$profile" ]] || { echo "--profile <certificate profile> is required (the name you gave it in the Certificate Manager)" >&2; exit 2; }
[[ "$url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$ ]] || { echo "--url must be an https URL: the TV only isolates a secure page, and SharedArrayBuffer needs that" >&2; exit 2; }
[[ "$package" =~ ^[A-Za-z0-9]{10}$ ]] || { echo "--package must be exactly 10 letters or digits" >&2; exit 2; }
[[ "$appname" =~ ^[A-Za-z0-9]+$ ]] || { echo "--app must be letters and digits" >&2; exit 2; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--version must be x.y.z" >&2; exit 2; }
command -v tizen >/dev/null || { echo "the Tizen CLI (tizen) is not on PATH; see tools/tizen/README.md" >&2; exit 1; }

host="$(sed -E 's#^https://([^/:]+).*#\1#' <<<"$url")"
# XML-escape what goes into attributes and text
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' <<<"$1"; }

build="$out/$package"
rm -rf "$build"
mkdir -p "$build"
sed -e "s#@URL@#$(xml "$url" | sed 's/[#&\\]/\\&/g')#g" \
    -e "s#@HOST@#$host#g" \
    -e "s#@NAME@#$(xml "$name" | sed 's/[#&\\]/\\&/g')#g" \
    -e "s#@APPNAME@#$appname#g" \
    -e "s#@PACKAGE@#$package#g" \
    -e "s#@VERSION@#$version#g" \
    "$here/config.xml.in" > "$build/config.xml"
cp "$repo/public/icons/icon-512.png" "$build/icon.png"

tizen package -t wgt -s "$profile" -- "$build"
wgt="$(ls -t "$build"/*.wgt | head -1)"
echo
echo "Built $wgt"
echo "  opens  $url"
echo "  app id $package.$appname"
echo
echo "Install and start it on the TV (sdb devices lists its serial, such as 192.168.1.50:26101):"
echo "  tizen install -s <serial> -n \"$(basename "$wgt")\" -- \"$build\""
echo "  tizen run -s <serial> -p $package.$appname"
