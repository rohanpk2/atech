#!/bin/sh
# Container entrypoint for the Atech AI firmware builder.
#
# Keeps one dashboard key across restarts. The backend requires the key on every /api/* call of
# its non-loopback listener (the container listens on 0.0.0.0) and would otherwise mint a new
# random key at every start, breaking every saved dashboard session after a reboot.
# ATECH_BUILDER_KEY from the env file wins; otherwise the key lives in <builds dir>/dashboard.key
# on the persistent builds volume (mode 600). Then exec the command: the image's CMD is the
# backend, `docker compose run builder node deploy/warm-cache.js` reuses the same setup.
set -eu

BUILDS_DIR="${ATECH_BUILDS_DIR:-/data/builds}"
KEY_FILE="$BUILDS_DIR/dashboard.key"
mkdir -p "$BUILDS_DIR"

if [ -z "${ATECH_BUILDER_KEY:-}" ]; then
  if [ ! -s "$KEY_FILE" ]; then
    umask 077
    node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" > "$KEY_FILE"
    umask 022
  fi
  ATECH_BUILDER_KEY="$(cat "$KEY_FILE")"
  export ATECH_BUILDER_KEY
fi

exec "$@"
