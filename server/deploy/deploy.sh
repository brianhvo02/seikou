#!/usr/bin/env bash
# The owner's deploy, run from the Mac: npm run server:deploy
# Builds the server image, ships it to the NAS, writes the generic compose files, (re)starts the service and adds the
# /bluray/* route to Caddy. The NAS's own settings stay on the NAS, in ~/bluray-server/.env and
# ~/bluray-server/compose.override.yaml (the drive mounts and the proxy's network); this script never writes either.
#
# Settings, from the environment or from .env.local at the repo root (gitignored; KEY=value lines):
#   BLURAY_NAS_HOST    the NAS's ssh host (required)
#   BLURAY_CADDY_SITE  the Caddy site that gets the /bluray/* route, as written in the Caddyfile, for example
#                      https://nas.example.com (required for a deploy)
#
# A deploy refuses while the NAS's .env has no PUBLIC_BASE, so a NAS that isn't set up can't take the server down.
# With --owner-code it deploys nothing: it mints one owner pairing code on the running server and prints it with its
# link and a terminal QR. Extra args go to the command: --owner-code --person <name> mints for that owner person.
# With --nas-id it deploys nothing: it prints the running server's rendezvous NAS id, for the Worker's NAS_IDS and
# TURN_NAS_IDS secrets.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# Reads KEY from .env.local unless the environment already sets it. Plain KEY=value lines; surrounding quotes go.
setting() {
  local key="$1" line value
  if [ -n "${!key:-}" ]; then printf '%s' "${!key}"; return; fi
  [ -f "$REPO/.env.local" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$key=" "$REPO/.env.local" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value="${value:1:${#value}-2}" ;;
    \'*\') value="${value:1:${#value}-2}" ;;
  esac
  printf '%s' "$value"
}

HOST="$(setting BLURAY_NAS_HOST)"
if [ -z "$HOST" ]; then
  echo "Set BLURAY_NAS_HOST (the NAS's ssh host) in the environment or in $REPO/.env.local." >&2
  exit 1
fi
# A host that starts with - would be read as an ssh option (every call also passes it after --).
case "$HOST" in
  -*) echo "BLURAY_NAS_HOST must not start with '-': $HOST" >&2; exit 1 ;;
esac

if [ "${1:-}" = "--owner-code" ]; then
  shift
  # Extra args (such as --person <name>) pass through, quoted for the remote shell.
  ARGS=""
  if [ $# -gt 0 ]; then ARGS="$(printf ' %q' "$@")"; fi
  exec ssh -- "$HOST" "docker exec bluray-server node server.mjs owner-code$ARGS"
fi

if [ "${1:-}" = "--nas-id" ]; then
  exec ssh -- "$HOST" "docker exec bluray-server node server.mjs nas-id"
fi

REMOTE_DIR='~/bluray-server'

if [ $# -gt 0 ]; then
  echo "Unknown argument: $1 (expected --owner-code or --nas-id, or nothing to deploy)" >&2
  exit 1
fi

CADDY_SITE="$(setting BLURAY_CADDY_SITE)"
# The Caddyfile's site address has no trailing slash (https://nas.example.com, not https://nas.example.com/).
while [ "${CADDY_SITE%/}" != "$CADDY_SITE" ]; do CADDY_SITE="${CADDY_SITE%/}"; done
if [ -z "$CADDY_SITE" ]; then
  echo "Set BLURAY_CADDY_SITE (the Caddy site for the /bluray/* route, e.g. https://nas.example.com) in the environment or in $REPO/.env.local." >&2
  exit 1
fi

# Before anything is built or shipped: the generic compose file takes every value from the NAS's .env, so without
# PUBLIC_BASE there the new service would not start. Only key names come back, never values.
echo "==> Checking $REMOTE_DIR/.env on $HOST"
env_keys() {
  ssh -- "$HOST" 'bash -s' <<'SH'
# Prints the names of the keys .env gives a non-empty value, one per line.
f="$HOME/bluray-server/.env"
test -f "$f" || exit 0
awk '
  /^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=/ {
    line = $0; sub(/^[ \t]*(export[ \t]+)?/, "", line)
    k = substr(line, 1, index(line, "=") - 1); sub(/[ \t]+$/, "", k)
    v = substr(line, index(line, "=") + 1); gsub(/^[ \t]+|[ \t]+$/, "", v)
    if (v != "" && v != "\"\"" && v != "\047\047") print k
  }' "$f"
SH
}
ENV_KEYS="$(env_keys)" || { echo "Could not read $REMOTE_DIR/.env on $HOST." >&2; exit 1; }
if ! printf '%s\n' "$ENV_KEYS" | grep -qx 'PUBLIC_BASE'; then
  echo "the NAS's .env has no PUBLIC_BASE: set it there (see server/deploy/.env.example and docs/self-hosting.md)" >&2
  exit 1
fi

cd "$REPO"

TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then TAG="$TAG-dirty"; fi

echo "==> Bundling the server"
npm run server:build

echo "==> Building bluray-server:$TAG for linux/amd64"
docker buildx build --platform linux/amd64 --load \
  -t "bluray-server:$TAG" -t bluray-server:latest \
  -f server/Dockerfile server

echo "==> Shipping the image to $HOST"
docker save "bluray-server:$TAG" bluray-server:latest | gzip | ssh -- "$HOST" 'gunzip | docker load'

echo "==> Writing $REMOTE_DIR/compose.yaml and compose.gpu.yaml (and compose.encodes.yaml when ENCODES_MOUNT is set) and starting the service"
ssh -- "$HOST" "mkdir -p $REMOTE_DIR && cat > $REMOTE_DIR/compose.yaml" < server/deploy/compose.yaml
ssh -- "$HOST" "cat > $REMOTE_DIR/compose.gpu.yaml" < server/deploy/compose.gpu.yaml
# The GPU override only when the render node exists: a missing device would stop the container from starting, while
# without it the server's self-test offers only Original.
COMPOSE_FILES="-f compose.yaml"
if ssh -- "$HOST" "test -e /dev/dri/renderD128"; then
  COMPOSE_FILES="$COMPOSE_FILES -f compose.gpu.yaml"
  echo "    /dev/dri/renderD128 found: with compose.gpu.yaml (quality levels on the GPU)"
else
  echo "    no /dev/dri/renderD128: without compose.gpu.yaml (Original only)"
fi
# The encodes folder (a writable bind) only when the NAS's .env sets ENCODES_MOUNT: without it the server has no
# /encodes and the Encodes library is off.
if printf '%s\n' "$ENV_KEYS" | grep -qx 'ENCODES_MOUNT'; then
  ssh -- "$HOST" "cat > $REMOTE_DIR/compose.encodes.yaml" < server/deploy/compose.encodes.yaml
  COMPOSE_FILES="$COMPOSE_FILES -f compose.encodes.yaml"
  echo "    ENCODES_MOUNT set: with compose.encodes.yaml (the Encodes library)"
else
  echo "    no ENCODES_MOUNT in .env: without compose.encodes.yaml (no Encodes library)"
fi
# The NAS's own drive mounts and networks. With -f, Compose no longer picks it up by itself, so name it.
if ssh -- "$HOST" "test -e $REMOTE_DIR/compose.override.yaml"; then
  COMPOSE_FILES="$COMPOSE_FILES -f compose.override.yaml"
  echo "    with compose.override.yaml"
fi
# The image just shipped, whatever BLURAY_IMAGE the .env names (the shell's value wins over .env in Compose).
ssh -- "$HOST" "cd $REMOTE_DIR && BLURAY_IMAGE=bluray-server:latest docker compose $COMPOSE_FILES up -d"
echo "    A manual restart must name the same files: cd $REMOTE_DIR && docker compose $COMPOSE_FILES up -d"

echo "==> Routing /bluray/* in Caddy"
ssh -- "$HOST" "bash -s -- $(printf '%q' "$CADDY_SITE")" < server/deploy/caddy-route.sh

echo "==> Done: $CADDY_SITE/bluray/api/health"
