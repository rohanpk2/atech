# Atech dashboards on Vercel

Both dashboards (`/demo1/`, `/demo2/`) served from Vercel, with the existing Node and PlatformIO
backend in its Docker container on the DigitalOcean Droplet. Nothing runs on your computer.

```
Browser  --HTTPS-->  Vercel project (this directory is the Root Directory)
                       1. static files from dist/: /demo1/, /demo2/, /shared/  (no sign-in)
                       2. vercel.json route: /api/(.*) -> ${ATECH_BACKEND_URL}/api/$1
                          with request headers x-atech-key = $ATECH_BUILDER_KEY and
                          x-atech-user = $ATECH_DASHBOARD_USER added by Vercel
                                                  |  HTTPS
                       Droplet: Caddy (TLS) -> builder container :5173 (requires the key on /api/*)
                                                  ^  HTTPS, outbound from the board, /api/device/*
ESP32-S3 on its home Wi-Fi ───────────────────────┘  (own pairing token, no dashboard key)
```

The dashboards are public. `ATECH_DASHBOARD_USER` is not a login: Vercel forwards it as
`x-atech-user`, and the backend uses that name as the owner of claimed boards and their
deployments. A second deployment with a different value never sees the first one's boards.

The browser only ever talks to the Vercel origin. The backend key is a Vercel environment
variable expanded at request time; it is not in this repository, not in the build output (the
build fails if it is) and never in the browser. Any `Authorization` header is removed before the
request leaves Vercel, so the Droplet sees the key and the owner name. The Anthropic key stays
on the Droplet.

Builds are asynchronous on the Droplet: the dashboard sends one short `POST /api/builds`, gets a
job id back at once, and then polls `GET /api/builds/<id>` every three seconds until the job is
`ready` or `failed`. No browser request outlives Vercel's 120 s limit for proxied requests.

## What is in this directory

| File | Role |
| --- | --- |
| `vercel.json` | build settings, the redirects (`/` to `/demo1/`, `/demo1` and `/demo2` to their slashed form), the `/api` route that sets the key and the owner header and removes any `Authorization` header |
| `build.js` | `npm run build`: copies `../demo1-custom-gatt/web`, `../demo2-bleota-library/web` and `../web-shared` into `dist/`, writes the hosted `shared/atech-config.js`, checks the environment and scans the output for secrets |
| `dev-server.js` | `npm run dev`: local emulation of the Vercel behaviour against any backend |
| `test/` | `npm test` |

The dashboards themselves are not copied or forked: the build reads them from the sibling
directories at deploy time, so a change to a dashboard is live on Vercel after the next push.

## Vercel project settings

| Setting | Value |
| --- | --- |
| Framework Preset | **Other** |
| Root Directory | `atech-ble-ota-demos/vercel-frontend` |
| Include source files outside of the Root Directory in the Build Step | **Enabled** (Settings, General, Root Directory; it is the default for new projects) |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | default (`npm install`) |
| Node.js Version | 22.x (default) |

`vercel.json` repeats the framework, build command and output directory, so the dashboard values
only need to match it. It deliberately does not use `trailingSlash`: Vercel would then redirect
extension-less API paths such as `/api/health` before the proxy route runs.

## Environment variables

Add these in Settings, Environment Variables, for Production (and Preview if you deploy branches).

| Name | Sensitive | Value | Where it comes from |
| --- | --- | --- | --- |
| `ATECH_BACKEND_URL` | no | `https://atech-api.example.com` (scheme and host only, no path, no trailing slash) | the DNS name you gave the Droplet in `deploy/README.md`, section "HTTPS for the hosted dashboards" |
| `ATECH_BUILDER_KEY` | **yes** | the backend's dashboard key | `ATECH_BUILDER_KEY` in `/etc/atech/builder.env`, or `sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml exec -T builder cat /data/builds/dashboard.key` |
| `ATECH_DASHBOARD_USER` | no | the owner name claimed boards and builds are bound to (not a login) | your choice, for example `atech` |

The build refuses to run when any of the three is missing or when `ATECH_BACKEND_URL` is not an
`https://host[:port]` origin, and it fails if the key shows up in `dist/`. There is no dashboard
password: `/demo1/` and `/demo2/` answer without a sign-in.

## Before the first deploy

1. Put the Droplet behind HTTPS: `deploy/README.md`, section "HTTPS for the hosted dashboards"
   (DNS record, firewall ports 80 and 443, `/etc/atech/caddy.env`, the two-file `docker compose up`).
   Set `ATECH_PUBLIC_URL=https://<that name>` in `/etc/atech/builder.env` so generated firmware knows
   which server to poll.
   Check from your laptop: `curl -si https://atech-api.example.com/api/health` answers `401` (the
   key is required), and the same request with `-H "x-atech-key: <key>"` answers `200` with
   `{"ok":true,...}`.
2. Fix the backend key (`ATECH_BUILDER_KEY` in `/etc/atech/builder.env`, then restart the container)
   so it does not change when the builds volume is recreated.

## Deploy

Through the Vercel dashboard:

1. Add New Project, import `rohanpk2/atech`.
2. Framework Preset: Other. Root Directory: `atech-ble-ota-demos/vercel-frontend` (use Edit next to
   the root directory and pick the folder). Leave "Include source files outside of the Root
   Directory" enabled.
3. Build and Output Settings: Build Command `npm run build`, Output Directory `dist` (both already in
   `vercel.json`).
4. Environment Variables: the three from the table above. Mark the key as sensitive.
5. Deploy. The build log ends with `vercel-frontend: wrote 14 files to .../dist`.

With the CLI instead, from the repository root:

```sh
npm i -g vercel
cd atech-ble-ota-demos/vercel-frontend
vercel link                                   # creates the project; root directory = this folder
vercel env add ATECH_BACKEND_URL production
vercel env add ATECH_BUILDER_KEY production   # choose "sensitive" when asked
vercel env add ATECH_DASHBOARD_USER production
vercel --prod
```

Later deploys happen on every push to `main` (Git integration) or with `vercel --prod`.

## Verify

```sh
APP=https://<project>.vercel.app
curl -si $APP/demo1/                                   # 200, the dashboard HTML, no WWW-Authenticate
curl -si $APP/demo1                                    # 308 to /demo1/
curl -si $APP/api/health                               # 200, {"ok":true,"provider":"anthropic",...}
curl -si -H "x-atech-key: wrong" $APP/api/health       # still 200: Vercel replaces the header
```

In a browser: open `$APP/demo1/` (no sign-in) and check that the top bar says `Backend online`. Type a
prompt, click Generate firmware, and watch the status move through Generating, Compiling and
Validating by polling (one short request every three seconds). The generated `user_app.cpp` shows
under the status, and Download firmware fetches the validated image through the same origin.
`$APP/demo1/install.html` shows whether the base image parts exist on the server and, when they are
missing or stale, starts the base build there and follows it to Ready.

## What works where

| Browser | Generate, status, download | Cloud Wi-Fi deploy (board on its own Wi-Fi) | Bluetooth: one-time Wi-Fi setup and deployment backup |
| --- | --- | --- | --- |
| Chrome, Edge (desktop, Android) | yes | yes | yes (HTTPS origin) |
| Safari (macOS, iPhone, iPad) | yes | yes | no Web Bluetooth |
| Firefox | yes | yes | no Web Bluetooth |

Cloud Wi-Fi deploy queues a job on the backend; the board polls the backend over HTTPS, downloads
the image, installs it, reboots and reports back. The dashboard shows pending, offline, downloading,
installing, rebooting, succeeded or failed. Step 1 lists the boards claimed by `ATECH_DASHBOARD_USER`
with their last contact, and boards that have contacted the backend but are not claimed yet; mDNS
discovery is not offered on the hosted dashboard. Claiming needs the board id and its pairing token
(the OTA authorization code printed on the board's serial console). Full description, protocol and
the physical checklist: [../CLOUD_WIFI_OTA.md](../CLOUD_WIFI_OTA.md). Simulated boards
(`ATECH_SIMULATED_DEVICE` on the server) register through the cloud API too, so the hosted flow can be
exercised end to end without hardware. **Nothing about the cloud path has run on a physical board.**

The USB installer page works on Vercel (Web Serial needs HTTPS, which Vercel provides). The base
build runs in the background on the backend (`POST /api/installer/<demo>/build` answers 202 at once
and `GET /api/installer/<demo>/status` reports `building`, `built` and `error`), so the page starts
it by itself when the parts are missing or stale and polls until they are ready; a multi-minute
compile never holds a proxied request open. The operator can still pre-build the parts with
`sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml run --rm builder node deploy/warm-cache.js --install-only --base`.

## Local emulation

Run the backend as the Droplet runs it (non-loopback listener, fixed key, simulated boards) and the
emulation in front of it:

```sh
cd atech-ble-ota-demos/builder
ATECH_BUILDER_HOST=0.0.0.0 ATECH_BUILDER_PORT=5199 ATECH_BUILDER_KEY=devkey ATECH_SIMULATED_DEVICE=all npm start

cd ../vercel-frontend
PORT=3100 ATECH_BACKEND_URL=http://127.0.0.1:5199 ATECH_BUILDER_KEY=devkey npm run dev
```

Open http://127.0.0.1:3100/demo1/. The emulation rebuilds `dist/` at start, so it always serves
the current dashboards with the hosted configuration. It is not Vercel: it mirrors `vercel.json`
closely enough to test the dashboards and the proxying, nothing more.

Local development without any of this is unchanged: `cd builder && npm start` serves the
dashboards itself with the default configuration in `web-shared/atech-config.js` (live progress
over SSE, open on loopback).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build fails with "The Vercel environment is incomplete" | one of the three variables missing or `ATECH_BACKEND_URL` has a path | set them for the environment you deploy (Production and Preview are separate) |
| Top bar says "Build service refused the hosted dashboard key" | `ATECH_BUILDER_KEY` on Vercel differs from the key the container uses | copy the key from the server, update the variable, redeploy (variables are read at request time for the route, but a redeploy is the safe way) |
| Top bar says "Build service unreachable" | Vercel cannot reach `ATECH_BACKEND_URL` | check DNS, the firewall (443), `docker compose logs caddy`, and `curl -si https://<host>/api/health` from outside |
| Bluetooth button disabled | browser without Web Bluetooth | use Chrome or Edge; generation and download work everywhere |
| Step 1 shows "No board yet" for a minute after loading | the server still lists a paired board it cannot reach; each unreachable board adds well over a minute to the first device refresh (mDNS and probe timeouts), and Vercel drops proxied requests after 120 s | forget stale boards on the server (`curl -X DELETE -H "x-atech-key: $KEY" http://127.0.0.1:5173/api/devices/<id>` over SSH) or clear `devices.json` in the builds volume; simulated boards answer at once |

## Rotating secrets

- Backend key: change `ATECH_BUILDER_KEY` in `/etc/atech/builder.env`, restart the container, update
  the Vercel variable, redeploy.
- Owner name: change `ATECH_DASHBOARD_USER` and redeploy. Boards claimed under the previous name
  stay bound to it and will not appear under the new one.
