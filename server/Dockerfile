# syntax=docker/dockerfile:1.7
# Build context: server/ (after `npm run server:build`). See deploy/deploy.sh.
FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

# The quality levels' encoder (server/src/levels/), from Debian 13's own packages (see deploy/IMAGE-NOTICE): ffmpeg
# (a GPL build with libx264, libx265 and Quick Sync through oneVPL; no non-free codecs such as libfdk-aac, so the
# image can be redistributed), Intel's media driver (iHD; Debian's non-free section, because its GPU kernels ship as
# binaries, MIT-licensed and redistributable) and the oneVPL GPU runtime. ffmpeg runs only as a child process.
# Versions follow Debian 13's security updates; the base image is pinned.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg intel-media-va-driver-non-free libmfx-gen1.2 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    LIBVA_DRIVER_NAME=iHD

WORKDIR /app
COPY dist/server.mjs ./server.mjs
# 7-Zip's WASM build (LGPL + unRAR restriction, see NOTICE), read by the fansub archive code from next to the bundle.
COPY dist/7zz.wasm ./7zz.wasm
# TheDiscDB index (MIT, see NOTICE), read from env DISCDB_INDEX, default /app/data/discdb-index.json.
COPY data/discdb-index.json ./data/discdb-index.json
# The notices for what the image ships, TheDiscDB's MIT data and ffmpeg among them.
COPY NOTICE ./NOTICE
# The notice for the GPL parts (ffmpeg, Intel's media driver) and where their sources are.
COPY deploy/IMAGE-NOTICE /usr/share/doc/bluray-server/NOTICE
# Created here so the named volume mounted on /data starts out owned by `node`.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
