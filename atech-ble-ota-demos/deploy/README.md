# Running the AI firmware builder on a server with Docker

One container holds the Node backend (`builder/server.js`), PlatformIO Core 6.2.0 and the pinned
`espressif32 @ 8.0.0` platform with both ESP32 toolchains, the Arduino-ESP32 3.3.12 packages and
the libraries the two demos declare. It serves `/demo1/`, `/demo2/`, `/shared/` and `/api/*`,
generates C++ with Claude, compiles ESP32-S3 firmware with `pio run`, validates the image and
serves the download. The AI builder itself is unchanged; this directory only packages it.

Files:

| File | Role |
| --- | --- |
| `Dockerfile` | the image (stage `runtime`), plus an optional `test` stage that runs every automated test |
| `compose.yaml` | service definition: loopback port, env file, volumes, memory limits, health check |
| `entrypoint.sh` | keeps one dashboard key across restarts, then starts the backend |
| `healthcheck.js` | Docker HEALTHCHECK against `/api/health` with the dashboard key |
| `warm-cache.js` | compiles the stock app through the real workspace (cache warm-up and a hardware-free compile check) |
| `builder.env.example` | template for `/etc/atech/builder.env` |
| `compose.tls.yaml`, `Caddyfile`, `caddy.env.example` | optional HTTPS front (Caddy) for the Vercel-hosted dashboards, see below |
| `../.dockerignore` | keeps `node_modules`, `.pio`, `.env*`, `.ai-builds` and docs out of the image |

## Prerequisites on the server

- Ubuntu 24.04 with Docker Engine 25+ and Compose v2.24+ (`docker compose version`), 2 GB RAM and 2 GB swap.
- Disk: the image is about 6.5 GB (4.3 GB of it is the PlatformIO package set with both ESP32
  toolchains). Keep at least 15 GB free for the first build (`df -h /`) and run `docker image prune -f`
  after rebuilds.
- `/etc/atech/builder.env` with `ANTHROPIC_API_KEY=...`, readable by root only (`chmod 600`).
  Template: `builder.env.example`. Compose reads the file as the user running `docker compose`, so run
  the compose commands as root or with `sudo`; `git pull` stays the repository owner's job (`atech`),
  because git refuses to work under `sudo` in a repository owned by someone else. If you would rather not
  use `sudo`, make the file group-readable by the `docker` group instead
  (`sudo chgrp docker /etc/atech/builder.env && sudo chmod 640 /etc/atech/builder.env`) and add `atech`
  to that group.
- Outbound HTTPS during the image build to `registry.platformio.org`, `dl.platformio.org`,
  `registry.npmjs.org` and `github.com` (BLEOTA), and at run time to `api.anthropic.com`.
- The repository cloned at `/home/atech/atech` (any path works; commands below assume this one).

## Environment variables

Read from `/etc/atech/builder.env`:

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | model access through the official SDK. Never logged; provider errors are redacted. |
| `ATECH_BUILDER_KEY` | no | dashboard key required on every `/api/*` request. Unset: generated once on first start and kept at `/data/builds/dashboard.key` in the builds volume. |
| `ATECH_LLM_MODEL` | no | default `claude-opus-5-5` |
| `ATECH_LLM_PROVIDER` | no | `anthropic`; the `claude` CLI is not in the image |
| `ATECH_MAX_REPAIRS` | no | compile-repair rounds, default 3 |
| `ATECH_PIO_JOBS` | no | parallel SCons jobs for `pio run`; the image sets 1 for a 2 GB server |
| `ATECH_LAN_PORT`, `ATECH_LAN_CHUNK_BYTES` | no | Wi-Fi LAN deployment settings (see limitations) |
| `ATECH_SIMULATED_DEVICE` | no | `1`, `2` or `all`: simulated boards, no hardware involved; they also register through the cloud API |
| `ATECH_PUBLIC_URL` | for cloud deployments | this server's public `https://` origin (the name in `caddy.env`). Baked into every generated image and the USB baseline as the server the board polls. See [../CLOUD_WIFI_OTA.md](../CLOUD_WIFI_OTA.md). |
| `ATECH_CLOUD_*` | no | cloud job timings (poll, expiry, stall, reboot and confirm windows, offline threshold, attempts, chunk); defaults in `builder.env.example` |

Fixed by `compose.yaml` (an env-file value does not override them): `ATECH_BUILDER_HOST=0.0.0.0`,
`ATECH_BUILDER_PORT=5173`, `ATECH_BUILDS_DIR=/data/builds`, `NODE_OPTIONS=--max-old-space-size=256`,
`PLATFORMIO_CORE_DIR=/home/atech/.platformio` and `PLATFORMIO_BIN` (they describe where the image put
PlatformIO). Image defaults that the env file may override: `ATECH_PIO_JOBS=1`, PlatformIO telemetry
off. Leave a variable commented out rather than blank: `ATECH_PIO_JOBS=` with no value removes the
one-job limit.
Compose-time only: `ATECH_ENV_FILE` (path of the env file, default `/etc/atech/builder.env`), useful on a
laptop: `ATECH_ENV_FILE=$PWD/atech-ble-ota-demos/builder/.env docker compose -f ... up -d --build`.

## Deploy

```sh
cd /home/atech/atech
git pull                                                                  # as atech, the repository owner
sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml config >/dev/null   # parse check (prints nothing)
sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml up -d --build
sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml logs -f builder
```

Run the first `up -d --build` inside `tmux` or with `nohup`: the build is driven by your SSH session and
a dropped connection would kill it. Do not paste the output of `compose config` anywhere; it inlines the
env file. The first build downloads about 4 GB of toolchain and takes 10 to 25 minutes on a small
Droplet; later builds reuse that layer unless a `platformio.ini` changes. The container restarts automatically after a
reboot (`restart: unless-stopped`) as long as Docker starts at boot (`systemctl is-enabled docker`).

## Verify the backend is running

```sh
C="sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml"
$C ps                                        # STATUS should read "healthy" within about 90 s
$C logs builder | grep -E "provider:|pio:|Demo 1:"
KEY=$($C exec -T builder cat /data/builds/dashboard.key)   # or the ATECH_BUILDER_KEY you configured
curl -s -H "x-atech-key: $KEY" http://127.0.0.1:5173/api/health
```

The health answer lists the provider and model, the PlatformIO version and both demos. The startup log
prints the dashboard links with `?key=`; the key is the only credential in the log. Every job then logs one
line per state (`job <id> demo 1 queued: "..."`, `generating`, `compiling`, `ready: <bytes>`, or
`failed: <reason>`), so `docker compose logs -f builder` is enough to watch builds. The `queued` line
includes the first 60 characters of the prompt. A startup line saying another process listens on port
5173 over IPv6 can appear inside Docker and is harmless: the backend probes `::1`, which a container
often does not have.

From your own computer, open an SSH tunnel and use the dashboards exactly as on a laptop. Web Bluetooth
works because `localhost` is a secure context:

```sh
ssh -L 5174:127.0.0.1:5173 atech@<droplet-ip>       # 5174 locally, in case a laptop builder already uses 5173
# then in desktop Chrome: http://localhost:5174/demo1/?key=<KEY>   (or /demo2/)
```

Hardware-free compile check (compiles the stock app for both demos through the real job workspace; a
few minutes the first time on one vCPU, seconds afterwards thanks to the build cache). Run it only while
no dashboard job is running, for example right after a deploy: it uses the same workspace and build
directory as live jobs, and two compiles in one workspace would corrupt each other.

```sh
$C run --rm builder node deploy/warm-cache.js          # add --base to also build the USB installer images
```

End-to-end through the API (costs one model call):

```sh
JOB=$(curl -s -H "x-atech-key: $KEY" -H 'content-type: application/json' \
  -d '{"demo":1,"prompt":"Make the onboard LED blink three times quickly, pause for two seconds, and repeat."}' \
  http://127.0.0.1:5173/api/builds | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
watch -n 5 "curl -s -H 'x-atech-key: $KEY' http://127.0.0.1:5173/api/builds/$JOB | python3 -c 'import json,sys;j=json.load(sys.stdin);print(j[\"state\"],j[\"stage\"],j.get(\"error\") or \"\")'"
curl -s -H "x-atech-key: $KEY" -o firmware.bin -D - http://127.0.0.1:5173/api/builds/$JOB/firmware.bin
```

Run the whole automated test suite inside the image (unit, pipeline, route, protocol, dashboard and
deploy tests; nothing is shipped from this stage):

```sh
docker build -f atech-ble-ota-demos/deploy/Dockerfile --target test atech-ble-ota-demos
```

## Operating it

- Logs: `$C logs -f builder` (json-file, rotated at 10 MB x 3). Job details, every attempt's
  `user_app.cpp` and `build.log` live under `/data/builds/jobs/<id>/` in the `atech_builds` volume.
- Update: `git pull` then the same `up -d --build`. Roll back with `git checkout <commit>` and rebuild.
  The volumes keep what the first start copied from the image; after a change to `lib_deps` or to the
  platform version, run `$C run --rm builder node deploy/warm-cache.js --install-only` once (while idle) so
  the workspaces match the new image instead of fetching at job time.
- Data lives in the named volumes `atech_builds`, `atech_pio-cache`, `atech_demo1-pio`, `atech_demo2-pio`.
  Backup: `docker run --rm -v atech_builds:/data -v "$PWD":/backup alpine tar czf /backup/builds.tgz -C /data .`
- Memory: 1.5 GB limit plus swap up to 3 GB total, one compile at a time, one SCons job. A job killed
  for memory ends `failed` with exit 137 in its error; keep `ATECH_PIO_JOBS=1` or use a larger Droplet.
- Resetting the dashboard key: set `ATECH_BUILDER_KEY` in the env file, or delete
  `/data/builds/dashboard.key` inside the volume and restart.

## HTTPS for the hosted dashboards

The dashboards can run on Vercel (`../vercel-frontend/README.md`) with this container as their
backend. Vercel proxies `/api/*` to the server over the public internet, so the backend needs a
public HTTPS name. It cannot reach a port bound to the server's loopback interface. The overlay
`compose.tls.yaml` adds Caddy in front of the container with automatic Let's Encrypt
certificates; the builder's own port mapping stays on `127.0.0.1`.

Manual steps, done once (none of them is performed by the repository):

1. DNS: create an A record, for example `atech-api.example.com`, pointing at the Droplet's IP.
2. Firewall: allow inbound TCP 80 and 443 (DigitalOcean Cloud Firewall or `ufw`). Port 5173 stays
   closed; only Caddy talks to it.
3. `sudo install -m 644 /dev/null /etc/atech/caddy.env` and put `ATECH_PUBLIC_HOST=atech-api.example.com`
   in it (template: `caddy.env.example`).
4. Fix the dashboard key: set `ATECH_BUILDER_KEY` in `/etc/atech/builder.env` to a long random value
   (`openssl rand -base64 24`) or read the generated one with
   `sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml exec -T builder cat /data/builds/dashboard.key`.
   The same value goes into the Vercel project as `ATECH_BUILDER_KEY`.
5. Start both:

```sh
cd /home/atech/atech
sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml -f atech-ble-ota-demos/deploy/compose.tls.yaml up -d
sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml -f atech-ble-ota-demos/deploy/compose.tls.yaml logs -f caddy
```

Caddy prints the certificate issuance in its log within a minute. Verify from any machine:

```sh
curl -si https://atech-api.example.com/api/health            # 401: the key is required (expected)
curl -si -H "x-atech-key: $KEY" https://atech-api.example.com/api/health   # 200 {"ok":true,...}
curl -si https://atech-api.example.com/demo1/                # 404: dashboards are not served here
```

Caddy forwards only `/api/*`. Everything else answers 404 so the dashboards exist in one place, on
Vercel, behind the sign-in configured there. Keep the key private: it is the only thing standing
between the internet and a firmware build on this server. Rotate it by changing
`ATECH_BUILDER_KEY` in the env file, restarting the container, and updating the Vercel variable.

Boards learn this name over Bluetooth during their one-time Wi-Fi setup (the dashboard reads `ATECH_PUBLIC_URL` from `/api/health` and provisions it), so set it before customers set up boards; see `../WIFI_BLE_ONBOARDING.md`.

The same name is what the boards talk to. `/api/device/*` is the device API: it does not take the
dashboard key (boards authenticate with their own pairing token and a bearer session, see
[../CLOUD_WIFI_OTA.md](../CLOUD_WIFI_OTA.md)), it is rate limited per address and per board id, and
it is the only way firmware leaves this server for a board. Set `ATECH_PUBLIC_URL=https://<that name>`
in `builder.env` so generated images know where to report:

```sh
curl -si https://atech-api.example.com/api/device/challenge?id=ATECH-000000000000   # 200, ok=1 ... claimed=0
```

The board validates the certificate against the Mozilla root bundle compiled into the firmware, so the
name must have a publicly trusted certificate (Let's Encrypt through Caddy qualifies); a self-signed
certificate is refused.

## Limitations of a cloud deployment

- Wi-Fi LAN deployment and mDNS discovery need the backend on the same network as the board; a cloud
  host cannot reach a board on a home LAN. Boards on a home network instead poll this server over HTTPS
  (Cloud Wi-Fi deploy, `/api/device/*`, [../CLOUD_WIFI_OTA.md](../CLOUD_WIFI_OTA.md)); the hosted
  dashboard lists claimed boards with their last contact and queues jobs for them. Bluetooth deployment
  from the browser and the firmware download for the hotspot portal work unchanged. Nothing about the
  cloud path has run on a physical board yet.
- The USB installer (`/demo1/install.html`) needs the base image; build it once with
  `$C run --rm builder node deploy/warm-cache.js --install-only --base` or the page's own button.
- This packaging was built and exercised on a laptop (Docker Desktop, arm64) and in the compose
  configuration; it has not been run on the Droplet itself until you run the commands above.
