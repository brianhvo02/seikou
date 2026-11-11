# Build environment for the libbluray trace harness. Pinned: ubuntu 24.04 by digest, libbluray by commit.
FROM ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential meson ninja-build pkg-config git ca-certificates python3 patch \
 && rm -rf /var/lib/apt/lists/*

# libbluray at the commit Seikou ports from. This tree builds with meson (it has no autotools files);
# libudfread comes from the pinned submodule.
RUN git clone --quiet https://code.videolan.org/videolan/libbluray.git /src/libbluray \
 && cd /src/libbluray \
 && git checkout --quiet 448f896 \
 && git submodule update --init --quiet

COPY trace.patch /src/trace.patch
RUN cd /src/libbluray && patch -p1 < /src/trace.patch

RUN cd /src/libbluray \
 && meson setup build --buildtype=release --default-library=static -Dwrap_mode=nodownload \
      -Denable_tools=false -Denable_examples=false -Denable_devtools=false -Denable_docs=false \
      -Dbdj_jar=disabled -Dfreetype=disabled -Dfontconfig=disabled -Dlibxml2=disabled \
 && ninja -C build

COPY vm_trace.c /src/vm_trace.c
RUN cd /src/libbluray \
 && gcc -O1 -Wall -Wextra -Werror -static -I src /src/vm_trace.c -o /usr/local/bin/vm_trace \
      $(find build -name 'libbluray.a') $(find build -name 'libudfread.a') -ldl -lpthread -lm
