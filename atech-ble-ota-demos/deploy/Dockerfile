# syntax=docker/dockerfile:1
# Atech AI firmware builder: the Node backend plus the PlatformIO ESP32-S3 toolchain in one
# image, so a prompt can be turned into compiled firmware with no network access at build time.
# Build context is atech-ble-ota-demos/ (see deploy/compose.yaml and deploy/README.md).
# No secrets enter the image: ANTHROPIC_API_KEY and friends arrive at run time from the env file.

# Stages: `base` builds everything, `test` runs every automated suite on top of it (never
# shipped), and `runtime`, the last stage and therefore the default target, is the image to run.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base

ARG PLATFORMIO_VERSION=6.2.0
ARG ATECH_UID=10001

# python3 + venv run PlatformIO Core; git fetches the pinned BLEOTA library for Demo 2.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-venv git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid "${ATECH_UID}" atech \
 && useradd --uid "${ATECH_UID}" --gid atech --create-home --shell /usr/sbin/nologin atech \
 && mkdir -p /app /data/builds \
 && chown -R atech:atech /app /data

# PlatformIO lives in the non-root user's home; the backend reads PLATFORMIO_CORE_DIR for
# boot_app0.bin (USB installer) and PLATFORMIO_BIN for every pio call.
ENV PLATFORMIO_CORE_DIR=/home/atech/.platformio \
    PLATFORMIO_BIN=/home/atech/.platformio/penv/bin/pio \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=false \
    PLATFORMIO_DISABLE_PROGRESSBAR=true \
    PLATFORMIO_NO_ANSI=true \
    ATECH_BUILDS_DIR=/data/builds \
    ATECH_PIO_JOBS=1 \
    NODE_ENV=production

USER atech
WORKDIR /app

# 1. PlatformIO Core in its own virtualenv at the default penv location.
RUN python3 -m venv "${PLATFORMIO_CORE_DIR}/penv" \
 && "${PLATFORMIO_CORE_DIR}/penv/bin/pip" install --no-cache-dir --disable-pip-version-check \
      "platformio==${PLATFORMIO_VERSION}"

# 2. Platform, both toolchains, Arduino framework packages and the pinned libraries, exactly as
#    the two demo projects declare them. Only platformio.ini enters this layer so source edits
#    never re-download the toolchain (about 4 GB). `pio run` reinstalls any missing required
#    package at run time, so nothing is trimmed afterwards. tool-scons is PlatformIO's build engine.
COPY --chown=atech:atech demo1-custom-gatt/platformio.ini demo1-custom-gatt/
COPY --chown=atech:atech demo2-bleota-library/platformio.ini demo2-bleota-library/
RUN "${PLATFORMIO_BIN}" pkg install -g -t "platformio/tool-scons@~4.41101.0" \
 && "${PLATFORMIO_BIN}" pkg install -d demo1-custom-gatt -e base -e ai \
 && "${PLATFORMIO_BIN}" pkg install -d demo2-bleota-library -e base -e ai \
 && rm -rf "${PLATFORMIO_CORE_DIR}/.cache" && mkdir -p "${PLATFORMIO_CORE_DIR}/.cache"

# 3. Backend dependencies, production only (@anthropic-ai/sdk, zod).
COPY --chown=atech:atech builder/package.json builder/package-lock.json builder/
RUN cd builder && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 4. The application: both demos, shared firmware libraries, dashboards, backend and deploy
#    scripts. The warm step pre-populates both AI workspaces' libraries under /data/builds so
#    the first job on a fresh volume compiles without fetching anything.
COPY --chown=atech:atech . .
RUN chmod +x deploy/entrypoint.sh deploy/healthcheck.js deploy/warm-cache.js \
 && node deploy/warm-cache.js --install-only \
 && rm -rf "${PLATFORMIO_CORE_DIR}/.cache" && mkdir -p "${PLATFORMIO_CORE_DIR}/.cache"

# ---------------------------------------------------------------------------------------------
# Optional: run every automated test inside the image (never shipped; dev dependencies included
# explicitly because NODE_ENV=production would otherwise drop jsdom):
#   docker build -f deploy/Dockerfile --target test .
FROM base AS test
RUN cd builder && npm ci --include=dev --no-audit --no-fund && npm test \
 && cd /app \
 && node demo1-custom-gatt/web/protocol.test.js \
 && node demo1-custom-gatt/web/dashboard.test.js \
 && node demo2-bleota-library/firmware.test.js \
 && node demo2-bleota-library/web/bleota-client.test.js \
 && node demo2-bleota-library/web/dashboard.test.js \
 && node shared/AtechCore/core.test.js \
 && node shared/AtechWifiOta/portal.test.js \
 && node shared/AtechCloudOta/agent.test.js \
 && node shared/AtechBleProv/prov.test.js \
 && cd web-shared && node atech-identity.test.js && node atech-builder.test.js && node atech-provision.test.js \
 && cd /app && node --test "deploy/*.test.js"

# ---------------------------------------------------------------------------------------------
# The image compose runs.
FROM base AS runtime
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "/app/deploy/healthcheck.js"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "/app/builder/server.js"]
