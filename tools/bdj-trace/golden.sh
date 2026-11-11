#!/usr/bin/env bash
# Regenerates the golden traces in tests/bdj/golden/ from libbluray, each reduced to the control calls. Diagnostic calls
# are dropped because their text or count varies between runs (logN carries timing, cacheBdRomFileN a random cache
# directory).
#   disc-bdj.jsonl:       up to the disc's second playlist selection (the one TitleXlet makes when the first playlist
#                         ends)
#   disc-bdj-mixed.jsonl: up to its first playlist selection from Java (PlaylistXlet in BD-J title 2, after First Play's
#                         selectTitleN of HDMV title 1 and that title's playlist and JumpTitle 2)
#   disc-bdj-menu.<script>.jsonl: the run of tests/bdj/scripts/disc-bdj-menu.<script>.keys, reduced by settled.py to the
#                         control calls and the plane hash at each `wait still` step and at the end (flush counts vary
#                         between runs)
#   disc-bdj-store.<script>.<n>.jsonl: the n-th of three runs of tests/bdj/scripts/disc-bdj-store.<script>.keys on one
#                         storage (run.sh --storage, a Docker volume made for them and removed after), reduced as the
#                         menu disc's: the disc counts its openings in /persistent and /buda, so each run draws the next
#                         count
#   local/<script>.jsonl: the same for tests/bdj/scripts/<script>.keys on a developer's disc in fixtures/local/<disc>
#                         (gitignored); written only when that disc is present, and kept as it is otherwise, so CI,
#                         which has no local discs, leaves them unchanged. Hashes and calls only, no disc content.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTROL='selectTitleN|selectPlaylistN|seekN|selectAngleN|selectRateN|writeRegN|setUOMaskN|setKeyInterestN|soundEffectN|setVirtualPackageN'
mkdir -p "$ROOT/tests/bdj/golden"

golden() { # <disc> <selectPlaylistN count>
  local out="$ROOT/tests/bdj/golden/$1.jsonl"
  "$ROOT/tools/bdj-trace/run.sh" "$1" --until "selectPlaylistN#$2" \
    | { grep -E "^\{\"call\":\"($CONTROL)\"" || true; } > "$out"
  if [ "$(grep -c '"call":"selectPlaylistN"' "$out")" != "$2" ]; then
    echo "golden.sh: the $1 run ended before selectPlaylistN #$2" >&2
    exit 1
  fi
  echo "wrote tests/bdj/golden/$1.jsonl"
}

golden_keys() { # <disc> <script name>
  local out="$ROOT/tests/bdj/golden/$1.$2.jsonl"
  "$ROOT/tools/bdj-trace/run.sh" "$1" --keys "$ROOT/tests/bdj/scripts/$1.$2.keys" --seconds 120 --wait-timeout 60 \
    | python3 -I "$ROOT/tools/bdj-trace/settled.py" "$ROOT/tests/bdj/scripts/$1.$2.keys" > "$out"
  echo "wrote tests/bdj/golden/$1.$2.jsonl"
}

golden_openings() { # <disc> <script name> <runs>
  local volume="bluray-web-bdj-golden-$$"
  docker volume create "$volume" > /dev/null
  trap "docker volume rm -f $volume > /dev/null" EXIT
  local n
  for n in $(seq 1 "$3"); do
    local out="$ROOT/tests/bdj/golden/$1.$2.$n.jsonl"
    "$ROOT/tools/bdj-trace/run.sh" "$1" --keys "$ROOT/tests/bdj/scripts/$1.$2.keys" --seconds 120 --wait-timeout 60 --storage "$volume" \
      | python3 -I "$ROOT/tools/bdj-trace/settled.py" "$ROOT/tests/bdj/scripts/$1.$2.keys" > "$out"
    echo "wrote tests/bdj/golden/$1.$2.$n.jsonl"
  done
  docker volume rm -f "$volume" > /dev/null
  trap - EXIT
}

golden_local() { # <fixtures/local disc> <script name>
  local disc="$ROOT/fixtures/local/$1"
  if [ ! -d "$disc/BDMV" ]; then
    echo "kept tests/bdj/golden/local/$2.jsonl (no fixtures/local/$1)"
    return
  fi
  mkdir -p "$ROOT/tests/bdj/golden/local"
  local out="$ROOT/tests/bdj/golden/local/$2.jsonl"
  "$ROOT/tools/bdj-trace/run.sh" "$disc" --keys "$ROOT/tests/bdj/scripts/$2.keys" --seconds 180 --wait-timeout 60 \
    | python3 -I "$ROOT/tools/bdj-trace/settled.py" "$ROOT/tests/bdj/scripts/$2.keys" > "$out.tmp" || { rm -f "$out.tmp"; exit 1; }
  mv "$out.tmp" "$out"
  echo "wrote tests/bdj/golden/local/$2.jsonl"
}

golden disc-bdj 2
golden disc-bdj-mixed 1
golden_keys disc-bdj-menu arrows
golden_keys disc-bdj-menu mouse
golden_openings disc-bdj-store open 3
golden_local BDJ_DISC_A bdj_disc_a.play
golden_local BDJ_DISC_A bdj_disc_a.chapters
golden_local BDJ_DISC_B bdj_disc_b.play
