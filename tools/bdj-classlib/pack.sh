#!/usr/bin/env bash
# Runs inside the image with the repo mounted at /work (cwd). Called by build.sh.
set -euo pipefail

OUT=src/bdj-classlib
MK="python3 -I tools/bdj-classlib/make-jar.py"
LB=/usr/local/share/java
JRE="$JAVA_HOME/jre"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

$MK $OUT/libbluray-j2se.jar $LB/libbluray-j2se-1.5.1.jar -
$MK $OUT/libbluray-awt-j2se.jar $LB/libbluray-awt-j2se-1.5.1.jar -

# the synthetic disc's xlets: class version 47 (-source/-target 1.3), compiled against libbluray's own jars
mkdir "$T/xlets"
javac -nowarn -source 1.3 -target 1.3 \
  -bootclasspath "$LB/libbluray-j2se-1.5.1.jar:$LB/libbluray-awt-j2se-1.5.1.jar:$JRE/lib/rt.jar" \
  -d "$T/xlets" tests/bdj/xlets/src/bdjweb/test/*.java
$MK tests/bdj/xlets/00000.jar "$T/xlets" -
# the HDMV and BD-J disc's xlets (disc-bdj-mixed), in a jar of their own so disc-bdj's jar stays as it is
mkdir "$T/xlets-mixed"
javac -nowarn -source 1.3 -target 1.3 \
  -bootclasspath "$LB/libbluray-j2se-1.5.1.jar:$LB/libbluray-awt-j2se-1.5.1.jar:$JRE/lib/rt.jar" \
  -d "$T/xlets-mixed" tests/bdj/xlets/src/bdjweb/mixed/*.java
$MK tests/bdj/xlets/mixed.jar "$T/xlets-mixed" -
# the background still disc's xlet (disc-bdj-background), with the still it shows (bg.png) at the jar's root
mkdir "$T/xlets-background"
javac -nowarn -source 1.3 -target 1.3 \
  -bootclasspath "$LB/libbluray-j2se-1.5.1.jar:$LB/libbluray-awt-j2se-1.5.1.jar:$JRE/lib/rt.jar" \
  -d "$T/xlets-background" tests/bdj/xlets/src/bdjweb/background/*.java
cp tests/bdj/xlets/src/bdjweb/background/bg.png "$T/xlets-background/"
$MK tests/bdj/xlets/background.jar "$T/xlets-background" -
# the BD-J menu disc's xlet (disc-bdj-menu), with its logo (logo.png) and background still (bg.png) at the jar's root
mkdir "$T/xlets-menu"
javac -nowarn -source 1.3 -target 1.3 \
  -bootclasspath "$LB/libbluray-j2se-1.5.1.jar:$LB/libbluray-awt-j2se-1.5.1.jar:$JRE/lib/rt.jar" \
  -d "$T/xlets-menu" tests/bdj/xlets/src/bdjweb/menu/*.java
cp tests/bdj/xlets/src/bdjweb/menu/logo.png tests/bdj/xlets/src/bdjweb/menu/bg.png "$T/xlets-menu/"
$MK tests/bdj/xlets/menu.jar "$T/xlets-menu" -
# the saved-data disc's xlet (disc-bdj-store), which counts its own openings under /persistent and /buda
mkdir "$T/xlets-store"
javac -nowarn -source 1.3 -target 1.3 \
  -bootclasspath "$LB/libbluray-j2se-1.5.1.jar:$LB/libbluray-awt-j2se-1.5.1.jar:$JRE/lib/rt.jar" \
  -d "$T/xlets-store" tests/bdj/xlets/src/bdjweb/store/*.java
$MK tests/bdj/xlets/store.jar "$T/xlets-store" -

# the JVM conformance programs (package conformance) and HotSpot's stdout for each class with a main; every program runs
# twice and the outputs must match
mkdir "$T/conf"
javac -nowarn -source 1.8 -target 1.8 -d "$T/conf" tests/bdj/conformance/*.java
$MK tests/bdj/conformance.jar "$T/conf" -
# locale and encoding pinned so no output depends on the machine
JOPTS="-Xint -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8"
run_twice() { # <class> <classpath> <out>
  java $JOPTS -cp "$2" "$1" > "$3"
  java $JOPTS -cp "$2" "$1" > "$T/again"
  cmp "$3" "$T/again" || { echo "$1 output differs between runs" >&2; exit 1; }
  if LC_ALL=C grep -q -P '[^\x00-\x7F?]' "$3" || grep -q '?' "$3"; then echo "$3 has non-ASCII bytes or '?'" >&2; exit 1; fi
}
for src in tests/bdj/conformance/*.java; do
  name="$(basename "$src" .java)"
  grep -q 'static void main' "$src" || continue
  run_twice "conformance.$name" tests/bdj/conformance.jar "tests/bdj/conformance/$name.out"
done
# Bare has no main: a harness (not packed into the jar) prints each method's result
mkdir "$T/harness"
javac -nowarn -source 1.8 -target 1.8 -cp tests/bdj/conformance.jar -d "$T/harness" tests/bdj/conformance/harness/*.java
run_twice harness.BareMain "tests/bdj/conformance.jar:$T/harness" tests/bdj/conformance/Bare.out

# classes.txt plus every nested class of each listed class (X$*.class), from rt.jar and the other JRE jars whose
# classes HotSpot loads on the local discs (jsse.jar: the Sun and SunRsaSign providers; jce.jar: javax.crypto); the
# classes, then the resources (symlinks followed), are staged into one tree
JARS="rt jsse jce"
: > "$T/all-entries"
mkdir "$T/stage"
for j in $JARS; do
  unzip -Z1 "$JRE/lib/$j.jar" | grep '\.class$' | LC_ALL=C sort > "$T/$j-entries"
  cat "$T/$j-entries" >> "$T/all-entries"
  LC_ALL=C awk -v listfile=$OUT/classes.txt '
    BEGIN { while ((getline l < listfile) > 0) if (l != "") want[l] = 1 }
    { n = $0; sub(/\.class$/, "", n)
      keep = (n in want)
      p = n
      while (!keep && (i = match(p, /\$[^$]*$/)) > 0) { p = substr(p, 1, i - 1); if (p in want) keep = 1 }
      if (keep) print $0 }' "$T/$j-entries" > "$T/$j-names"
  echo "$(wc -l < "$T/$j-names") class entries from $j.jar" >&2
  python3 -I - "$JRE/lib/$j.jar" "$T/stage" "$T/$j-names" <<'PY'
import sys, zipfile
jar, dest, names = sys.argv[1:4]
z = zipfile.ZipFile(jar)
for n in open(names).read().split('\n'):
    if n:
        z.extract(n, dest)
PY
done
# every listed class must exist in one of the jars
LC_ALL=C sort -u "$T/all-entries" > "$T/entries"
sed 's/$/.class/' $OUT/classes.txt | LC_ALL=C sort | comm -23 - "$T/entries" > "$T/absent"
if [ -s "$T/absent" ]; then echo "classes.txt names not in $JARS:" >&2; head "$T/absent" >&2; exit 1; fi

while read -r r; do
  [ -n "$r" ] || continue
  mkdir -p "$T/stage/$(dirname "$r")"
  cp -L "$JRE/$r" "$T/stage/$r"
done < tools/bdj-classlib/resources.txt
# cacerts is generated when the image is built and dates each entry with that moment: pin the dates (to the apt
# snapshot, 2026-10-15T00:00:00Z) so every build of the image packs the same bytes
python3 -I tools/bdj-classlib/normalize-jks.py "$T/stage/lib/security/cacerts" changeit 1792022400
$MK $OUT/rt-bdj.jar "$T/stage" -

# licenses
cp /usr/share/common-licenses/GPL-2 $OUT/LICENSE
sed -n '/^"CLASSPATH" EXCEPTION TO THE GPL$/,/^OpenJDK Trademark Notice/p' \
  /usr/share/doc/openjdk-8-jre-headless/copyright | sed '$d' | sed '$d' > $OUT/ASSEMBLY_EXCEPTION
# the JDK's notice for its Apache-licensed components (Xerces among them): the section of THIRD_PARTY_README from its
# "%%" line to the end of the Apache License 2.0 text
awk '/^%% This notice is provided with respect to the following which may be/ { on = 1 }
     on { print }
     on && /^--- end of LICENSE ---$/ { exit }' "$JAVA_HOME/THIRD_PARTY_README" > $OUT/THIRD_PARTY_APACHE
grep -q '^  Apache Xerces Java ' $OUT/THIRD_PARTY_APACHE || { echo "THIRD_PARTY_README: no Apache Xerces section" >&2; exit 1; }
grep -q 'Apache License' $OUT/THIRD_PARTY_APACHE || { echo "THIRD_PARTY_README: no Apache License text" >&2; exit 1; }
# the JDK's notice for ICU4J, which sun/text/normalizer (behind java.text.Normalizer) derives from: its section of
# THIRD_PARTY_README, from its "%%" line to the end of its license text
awk '/^%% This notice is provided with respect to ICU4C / { on = 1 }
     on { print }
     on && /^--- end of LICENSE ---$/ { exit }' "$JAVA_HOME/THIRD_PARTY_README" > $OUT/THIRD_PARTY_ICU
grep -q 'International Business Machines Corporation' $OUT/THIRD_PARTY_ICU || { echo "THIRD_PARTY_README: no ICU section" >&2; exit 1; }
cat > $OUT/SAX_NOTICE <<'EOF'
The org/xml/sax classes in rt-bdj.jar are OpenJDK's copies of SAX (http://www.saxproject.org), which carry Oracle's
GPLv2 with the Classpath Exception header and, below it, the SAX project's own notice, for example in
org/xml/sax/helpers/DefaultHandler.java:

  // DefaultHandler.java - default implementation of the core handlers.
  // http://www.saxproject.org
  // Written by David Megginson
  // NO WARRANTY!  This class is in the public domain.
EOF
SRC_PKG="$(dpkg-query -W -f='${source:Package}' openjdk-8-jre-headless)"
SRC_VER="$(dpkg-query -W -f='${source:Version}' openjdk-8-jre-headless)"
SNAPSHOT=20261015T000000Z
{
  echo "rt-bdj.jar holds classes and files of the OpenJDK 8 runtime (GPLv2 with the Classpath Exception; see LICENSE and"
  echo "ASSEMBLY_EXCEPTION), unmodified, selected by src/bdj-classlib/classes.txt and tools/bdj-classlib/resources.txt."
  echo "The one exception is lib/security/cacerts, the keystore ca-certificates-java $(dpkg-query -W -f='${Version}' ca-certificates-java)"
  echo "generates from ca-certificates $(dpkg-query -W -f='${Version}' ca-certificates): its entries' creation dates are set to"
  echo "2026-10-15T00:00:00Z (tools/bdj-classlib/normalize-jks.py) so the jar is reproducible."
  echo
  echo "Third-party code among those classes:"
  echo "- com/sun/org/apache/xerces/internal/** (Apache Xerces Java, as bundled in OpenJDK's JAXP) and"
  echo "  com/sun/xml/internal/stream/Entity*: Apache License 2.0. The JDK's notice for its Apache components, with the"
  echo "  license text, is THIRD_PARTY_APACHE (from the JDK's THIRD_PARTY_README; it carries no separate Xerces NOTICE"
  echo "  file). The other JAXP classes (javax/xml/parsers, jdk/xml/internal, the rest of com/sun/xml/internal/stream) are"
  echo "  GPLv2 with the Classpath Exception."
  echo "- org/xml/sax/**: SAX, GPLv2 with the Classpath Exception in OpenJDK plus the SAX project's public-domain"
  echo "  notice (SAX_NOTICE)."
  echo "- sun/text/normalizer/** (behind java/text/Normalizer): derived from ICU4J, (C) Copyright IBM Corp. and others,"
  echo "  GPLv2 with the Classpath Exception in OpenJDK; the JDK's notice for ICU, with its permission notice, is"
  echo "  THIRD_PARTY_ICU (from the JDK's THIRD_PARTY_README)."
  echo
  echo "How classes.txt is collected: from HotSpot's -verbose:class in the libbluray harness (tools/bdj-classlib/collect.sh),"
  echo "run with no network, over the synthetic and local BD-J discs, the JVM conformance programs and, with the library"
  echo "check's generic key script, the start-up files of every BD-J disc of the developer's library, plus a keep-list of"
  echo "classes added by hand (in collect.sh). HotSpot's own platform font stack (sun/font, the X11 and fontconfig"
  echo "font managers), which its java.awt.Font loads, is left out: libbluray's java/awt/Font takes its place here. A few"
  echo "class families are listed whole, because a disc's use of them is open-ended:"
  echo "- sun/reflect/Unsafe*FieldAccessorImpl: reflection on a field picks one by the field's type and modifiers."
  echo "- sun/reflect/generics/**: the parser and model of generic signatures, behind java.lang.reflect's generic types."
  echo "- sun/util/locale/provider/{DateFormat,DateFormatSymbols,DecimalFormatSymbols,NumberFormat}ProviderImpl: the"
  echo "  JRE providers behind java.text's date and number formats."
  echo "- java/rmi/registry/Registry with java/rmi/Remote and the exceptions its methods declare (AccessException,"
  echo "  AlreadyBoundException, NotBoundException, RemoteException): discs name the interface; no RMI runs."
  echo
  echo "OpenJDK binary package: $(dpkg-query -W openjdk-8-jre-headless)"
  echo "Corresponding source:   Ubuntu source package $SRC_PKG $SRC_VER,"
  echo "  https://snapshot.ubuntu.com/ubuntu/$SNAPSHOT/pool/universe/${SRC_PKG:0:1}/$SRC_PKG/${SRC_PKG}_${SRC_VER#*:}.dsc"
  echo "Apt snapshot:           $SNAPSHOT (ubuntu 24.04)"
  echo
  echo "libbluray-j2se.jar and libbluray-awt-j2se.jar are libbluray's BD-J Java stack, LGPL-2.1-or-later (the license"
  echo "text is in LICENSE), built from libbluray commit 448f896,"
  echo "https://code.videolan.org/videolan/libbluray (source: https://code.videolan.org/videolan/libbluray/-/tree/448f896)."
} > $OUT/NOTICE
