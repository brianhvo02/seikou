#!/usr/bin/env bash
# Grows src/bdj-classlib/classes.txt and tests/bdj/natives.txt from real runs: each BD-J disc runs through libbluray up
# to its first playlist selection with -verbose:class and -verbose:jni, and a synthetic disc with key scripts
# (tests/bdj/scripts/<disc>.<name>.keys, <disc> in lower case) runs each script to its end as well. A disc of the
# library check (a folder under $BDJ_LIBRARY_DIR/discs, default `~/.cache/bluray-web/bdj-library/discs`) runs the
# check's generic script instead (tools/bdj-library/generic.keys: menu, two arrows, ok), with the check's limits. The
# conformance programs (tests/bdj/conformance) run too, for their classes only.
# The runs are offline (tools/bdj-trace/run.sh), so classes HotSpot loads only once a BD-Live server answers are never
# collected. Names are only ever added, together with the keep-list below; a removal is a deliberate edit of
# classes.txt (5e: the http response classes that an online run had collected).
#   collect.sh [disc...]: only these discs (folder names under fixtures/synthetic or paths); default: disc-bdj,
#                         disc-bdj-menu and every BD-J disc under fixtures/local
#   BDJ_COLLECT_JOBS=N:   discs run N at a time (default 1)
#   BDJ_COLLECT_FRESH=1:  start classes.txt from the keep-list instead of its current names (natives.txt still only
#                         grows); over every disc the list was collected from, this reproduces classes.txt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PLATFORM="${BDJ_TRACE_PLATFORM:-linux/amd64}"
LIBRARY="${BDJ_LIBRARY_DIR:-$HOME/.cache/bluray-web/bdj-library}"

# one disc: collect.sh --one <disc> <out> <err>
if [ "${1:-}" = "--one" ]; then
  d="$2"; out="$3"; err="$4"
  : > "$out"; : > "$err"
  case "$(cd "$d" 2> /dev/null && pwd)/" in
    "$(cd "$LIBRARY" 2> /dev/null && pwd)"/discs/*)
      echo "collecting from $d with the generic script" >&2
      # HotSpot under amd64 emulation now and then dies at once (SIGSEGV in libzip): run once more without a script end
      for attempt in 1 2; do
        tools/bdj-trace/run.sh "$d" --keys tools/bdj-library/generic.keys --seconds 140 --wait-timeout 60 --tail 5 \
          --jvm-option -verbose:class --jvm-option -verbose:jni > "$out.run" 2>> "$err" || true
        cat "$out.run" >> "$out"
        if grep -q '"script":"end"' "$out.run"; then break; fi
      done
      rm -f "$out.run"
      ;;
    *)
      echo "collecting from $d" >&2
      # HotSpot prints -verbose output on stdout, between the trace lines
      tools/bdj-trace/run.sh "$d" --until selectPlaylistN --jvm-option -verbose:class --jvm-option -verbose:jni \
        > "$out" 2> "$err" || true
      # scripts for a local disc are named in lower case (bdj_disc_a.play.keys for fixtures/local/BDJ_DISC_A)
      for k in tests/bdj/scripts/"$(basename "$d" | tr '[:upper:]' '[:lower:]')".*.keys; do
        [ -f "$k" ] || continue
        echo "collecting from $d with $k" >&2
        tools/bdj-trace/run.sh "$d" --keys "$k" --seconds 180 --wait-timeout 60 --jvm-option -verbose:class \
          --jvm-option -verbose:jni >> "$out" 2>> "$err" || true
      done
      ;;
  esac
  exit 0
fi

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

DISCS=()
if [ $# -gt 0 ]; then
  for d in "$@"; do
    case "$(basename "$d")" in .tmp-*) continue ;; esac
    if [ -d "$d" ]; then DISCS+=("$d"); else DISCS+=("fixtures/synthetic/$d"); fi
  done
else
  for d in fixtures/synthetic/disc-bdj fixtures/synthetic/disc-bdj-menu fixtures/local/*; do
    [ -d "$d/BDMV/BDJO" ] && DISCS+=("$d")
  done
fi

mkdir "$T/runs"
i=0
for d in "${DISCS[@]}"; do
  i=$((i + 1))
  printf '%s\0%s\0%s\0' "$d" "$T/runs/$i.out" "$T/runs/$i.err"
done | xargs -0 -n 3 -P "${BDJ_COLLECT_JOBS:-1}" bash "$0" --one

# the JVM conformance programs (tests/bdj/conformance.jar, built by build.sh) under HotSpot with -verbose:class, as
# pack.sh records their output: what they load is what the class library must hold for them to run in our JVM
echo "collecting from the conformance programs" >&2
docker run --rm --network none --platform "$PLATFORM" -v "$ROOT:/work:ro" -w /work bluray-web-bdj-trace bash -c '
  for src in tests/bdj/conformance/*.java; do
    grep -q "static void main" "$src" || continue
    java -Xint -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8 -verbose:class -cp tests/bdj/conformance.jar \
      "conformance.$(basename "$src" .java)" || echo "conformance.$(basename "$src" .java) failed" >&2
  done' > "$T/runs/conformance.out"

: > "$T/loaded"
: > "$T/natives"
for out in "$T"/runs/*.out; do
  [ -f "$out" ] || continue
  # classes of rt.jar ("shared objects file" is the CDS archive, also built from rt.jar), jsse.jar and jce.jar (the
  # JAR signature check's providers and javax.crypto); pack.sh takes them from the same three jars
  { grep -E '^\[Loaded [^ ]+ from (/usr/lib/jvm/[^]]*/(rt|jsse|jce)\.jar|shared objects file)\]' "$out" || true; } \
    | sed -E 's/^\[Loaded ([^ ]+) from .*/\1/' | tr . / >> "$T/loaded"
  { grep -E '^\[(Dynamic-linking native method [^ ]+ \.\.\. JNI|Registering JNI native method [^ ]+)\]' "$out" || true; } \
    | sed -E 's/^\[(Dynamic-linking native method|Registering JNI native method) ([^] ]+).*/\2/' >> "$T/natives"
done

mkdir -p src/bdj-classlib tests/bdj
touch src/bdj-classlib/classes.txt tests/bdj/natives.txt

# The keep-list: classes added by hand, which no disc run or conformance program loads under HotSpot. Each line is a class name or, ending in
# a regular expression after "re ", a whole family (matched against the class entries of rt.jar, jsse.jar and jce.jar;
# nested classes come with their outer class in pack.sh anyway). The families are the ones src/bdj-classlib/NOTICE
# lists (text in pack.sh).
cat > "$T/keep" <<'KEEP'
# thrown by our interpreter (the VM's own errors), which HotSpot throws without a disc run loading them
java/lang/AbstractMethodError
java/lang/ClassCircularityError
java/lang/IllegalAccessError
java/lang/InstantiationError
java/lang/UnsupportedClassVersionError
java/lang/VerifyError
# thrown by our natives (zip, jar, io, fonts)
java/io/InterruptedIOException
java/io/UTFDataFormatException
java/util/jar/JarException
java/util/zip/ZipError
java/util/zip/ZipException
java/awt/AWTError
# a disc throws it in our JVM where HotSpot never loaded it (5e Task 2)
java/lang/IllegalThreadStateException
# collected in 5e Task 2 from runs that had a network; not network classes, and kept although the offline runs did
# not load them again
java/util/OptionalInt
java/awt/Polygon$PolygonPathIterator
# DateFormat.parse and Polygon.contains(Rectangle), from the conformance programs' -verbose:class (5e Task 2)
java/text/ParsePosition
java/text/CalendarBuilder
sun/awt/geom/Crossings
# reflection on a field picks an accessor by the field's type and modifiers
re ^sun/reflect/Unsafe[A-Za-z]*FieldAccessorImpl$
# the parser and model of generic signatures, behind java.lang.reflect's generic types
re ^sun/reflect/generics/
# the JRE providers behind java.text's date and number formats
sun/util/locale/provider/DateFormatProviderImpl
sun/util/locale/provider/DateFormatSymbolsProviderImpl
sun/util/locale/provider/DecimalFormatSymbolsProviderImpl
sun/util/locale/provider/NumberFormatProviderImpl
# discs name the interface; no RMI runs
java/rmi/registry/Registry
java/rmi/Remote
java/rmi/AccessException
java/rmi/AlreadyBoundException
java/rmi/NotBoundException
java/rmi/RemoteException
KEEP
grep -vE '^(#|re |$)' "$T/keep" > "$T/keep-names"
sed -n 's/^re //p' "$T/keep" > "$T/keep-res"
docker run --rm --network none --platform "$PLATFORM" -v "$T:/in:ro" bluray-web-bdj-trace python3 -I -c '
import re, sys, zipfile
res = [re.compile(l) for l in open("/in/keep-res").read().split("\n") if l]
jre = "/usr/lib/jvm/java-8-openjdk-amd64/jre/lib/"
for j in ("rt", "jsse", "jce"):
    for n in zipfile.ZipFile(jre + j + ".jar").namelist():
        if n.endswith(".class") and "$" not in n and any(r.search(n[:-6]) for r in res):
            print(n[:-6])
' >> "$T/keep-names"
if [ "${BDJ_COLLECT_FRESH:-}" = 1 ]; then cp "$T/keep-names" "$T/base"; else cat src/bdj-classlib/classes.txt "$T/keep-names" > "$T/base"; fi
# HotSpot's own java.awt.Font loads its platform font stack (sun/font, the X11 and fontconfig font managers); libbluray's
# java/awt/Font takes its place in our JVM, so neither those classes nor their natives are collected
PLATFORM_FONTS='sun/font/|sun/awt/(X11FontManager|FcFontManager|FontConfiguration|FontDescriptor|motif/)|sun/java2d/FontSupport'
{ cat "$T/base"; grep -vE '\$\$Lambda\$|LambdaForm\$|\$Proxy' "$T/loaded" | grep -vE "^($PLATFORM_FONTS)" || true; } \
  | grep -v '^$' | LC_ALL=C sort -u > "$T/classes.new"
cp "$T/classes.new" src/bdj-classlib/classes.txt

# "class.method" -> "class method", minus the natives that are the Java side's own table (Task 13)
sed -E 's/^(.*)\.([^.]+)$/\1 \2/' "$T/natives" | sort -u \
  | { grep -vE '^org\.videolan\.|^java\.awt\.BDFontMetrics |^java\.awt\.BDGraphicsBase |^java\.io\.FileInputStream ' || true; } \
  | { grep -vE "^($(echo "$PLATFORM_FONTS" | tr / .))" || true; } \
  > "$T/native-names"

# descriptors via javap inside the image
docker run --rm --network none --platform "$PLATFORM" -v "$T:/in:ro" -v "$ROOT/tools/bdj-classlib:/tools:ro" \
  bluray-web-bdj-trace bash /tools/resolve-natives.sh > "$T/natives.resolved"
{ cat tests/bdj/natives.txt; cat "$T/natives.resolved"; } | grep -v '^$' | LC_ALL=C sort -u > "$T/natives.new"
cp "$T/natives.new" tests/bdj/natives.txt
wc -l src/bdj-classlib/classes.txt tests/bdj/natives.txt >&2
