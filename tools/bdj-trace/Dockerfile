# Build environment for the libbluray BD-J trace harness. Pinned: ubuntu 24.04 by digest, apt by snapshot,
# libbluray by commit. libbluray is built with its BD-J stack (OpenJDK 8) and its JNI natives patched to trace.
FROM ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

# The base image has no ca-certificates, which the https snapshot service needs: bootstrap that one package from the
# live archive, then switch apt to the snapshot for everything else. ca-certificates is then reinstalled at the snapshot's
# version (downgrading a newer live one): the class library's cacerts is generated from it, so it must not drift.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
 && echo 'APT::Snapshot "20261015T000000Z";' > /etc/apt/apt.conf.d/50snapshot \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --allow-downgrades \
    build-essential meson ninja-build pkg-config git ca-certificates=20260601~24.04.1 python3 patch \
    openjdk-8-jdk-headless ant libfreetype-dev \
 && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64 LIBBLURAY_CP=/usr/local/share/java/

# libbluray at the commit bluray-web ports from; libudfread comes from the pinned submodule.
RUN git clone --quiet https://code.videolan.org/videolan/libbluray.git /src/libbluray \
 && cd /src/libbluray \
 && git checkout --quiet 448f896 \
 && git submodule update --init --quiet

COPY trace.patch /src/trace.patch
RUN cd /src/libbluray && patch -p1 < /src/trace.patch

RUN cd /src/libbluray \
 && JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64 meson setup build --buildtype=release -Dwrap_mode=nodownload \
      -Denable_tools=false -Denable_examples=false -Denable_devtools=false -Denable_docs=false \
      -Dbdj_jar=enabled -Dfreetype=enabled -Dfontconfig=disabled -Dlibxml2=disabled \
 && ninja -C build && ninja -C build install && ldconfig

# Font fallback. fontconfig is off, so libbluray's BDFontMetrics maps the JRE logical names (serif, sansserif,
# monospaced, dialog, dialoginput, default; plain/bold/italic/bold-italic) to the Lucida files under
# $JAVA_HOME/jre/lib/fonts/, which the headless JDK does not ship. Every one of those files is a link to the bundled
# default-font.ttf (packages/ass/src/default-font.ttf, staged into the build context by build.sh), so bluray-web can
# resolve the same names to the same file. See README.md.
COPY default-font.ttf /usr/local/share/fonts/default-font.ttf
RUN mkdir -p $JAVA_HOME/jre/lib/fonts && cd $JAVA_HOME/jre/lib/fonts \
 && for f in LucidaBrightRegular LucidaBrightDemiBold LucidaBrightItalic LucidaBrightDemiItalic \
             LucidaSansRegular LucidaSansDemiBold LucidaSansOblique LucidaSansDemiOblique \
             LucidaTypewriterRegular LucidaTypewriterBold LucidaTypewriterOblique LucidaTypewriterBoldOblique; do \
      ln -s /usr/local/share/fonts/default-font.ttf $f.ttf; \
    done

# libpng (for --dump-planes) is already installed as a dependency of libfreetype-dev.
COPY bdj_trace.c /src/bdj_trace.c
RUN gcc -O1 -Wall -Wextra -Werror -pthread -o /usr/local/bin/bdj_trace /src/bdj_trace.c \
      $(pkg-config --cflags --libs libbluray libpng)
