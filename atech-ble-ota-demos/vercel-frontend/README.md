# Atech dashboards on Vercel

Both dashboards (`/demo1/`, `/demo2/`) served from Vercel, with the existing Node and PlatformIO
backend in its Docker container on the DigitalOcean Droplet. Nothing runs on your computer.

```
Browser  --HTTPS-->  Vercel project (this directory is the Root Directory)
                       1. middleware.js: HTTP Basic sign-in on every path (fails closed)
                       2. static files from dist/: /demo1/, /demo2/, /shared/
                       3. vercel.json route: /api/(.*) -> ${ATECH_BACKEND_URL}/api/$1
                          with request header x-atech-key = $ATECH_BUILDER_KEY added by Vercel
                                                  |  HTTPS
                       Droplet: Caddy (TLS) -> builder container :5173 (requires the key on /api/*)
```

The browser only ever talks to the Vercel origin. The backend key is a Vercel environment
variable expanded at request time; it is not in this repository, not in the build output (the
build fails if it is) and never in the browser. The sign-in header is removed before the request
leaves Vercel, so the Droplet sees the key and nothing else. The Anthropic key stays on the Droplet.

Builds are asynchronous on the Droplet: the dashboard sends one short `POST /api/builds`, gets a
job id back at once, and then polls `GET /api/builds/<id>` every three seconds until the job is
`ready` or `failed`. No browser request outlives Vercel's 120 s limit for proxied requests.

## What is in this directory

| File | Role |
| --- | --- |
| `vercel.json` | build settings, the redirects (`/` to `/demo1/`, `/demo1` and `/demo2` to their slashed form), the `/api` route that sets the key and removes the sign-in header |
| `middleware.js` | Vercel Routing Middleware: Basic sign-in from `ATECH_DASHBOARD_USER` / `ATECH_DASHBOARD_PASSWORD` |
| `build.js` | `npm run build`: copies `../demo1-custom-gatt/web`, `../demo2-bleota-library/web` and `../web-shared` into `dist/`, writes the hosted `shared/atech-config.js`, checks the environment and scans the output for secrets |
| `dev-server.js` | `npm run dev`: local emulation of the Vercel behaviour against any backend |
| `lib/basic-auth.js` | header parsing and constant-time comparison shared by the middleware and the dev server |
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
| `ATECH_DASHBOARD_USER` | no | a user name for the sign-in prompt | your choice |
| `ATECH_DASHBOARD_PASSWORD` | **yes** | a long password for the sign-in prompt | `openssl rand -base64 18` |

The build refuses to run when any of the four is missing or when `ATECH_BACKEND_URL` is not an
`https://host[:port]` origin, and it fails if the key or the password value shows up in `dist/`.
With the sign-in variables missing at run time, every page answers 503 rather than opening up.

## Before the first deploy

1. Put the Droplet behind HTTPS: `deploy/README.md`, section "HTTPS for the hosted dashboards"
   (DNS record, firewall ports 80 and 443, `/etc/atech/caddy.env`, the two-file `docker compose up`).
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
4. Environment Variables: the four from the table above. Mark the key and the password as sensitive.
5. Deploy. The build log ends with `vercel-frontend: wrote 14 files to .../dist`.

With the CLI instead, from the repository root:

```sh
npm i -g vercel
cd atech-ble-ota-demos/vercel-frontend
vercel link                                   # creates the project; root directory = this folder
vercel env add ATECH_BACKEND_URL production
vercel env add ATECH_BUILDER_KEY production   # choose "sensitive" when asked
vercel env add ATECH_DASHBOARD_USER production
vercel env add ATECH_DASHBOARD_PASSWORD production
vercel --prod
```

Later deploys happen on every push to `main` (Git integration) or with `vercel --prod`.

## Verify

```sh
APP=https://<project>.vercel.app
curl -si $APP/demo1/                                   # 401 with WWW-Authenticate: Basic
curl -si -u "$USER_NAME:$PASSWORD" $APP/demo1          # 308 to /demo1/
curl -si -u "$USER_NAME:$PASSWORD" $APP/api/health     # 200, {"ok":true,"provider":"anthropic",...}
curl -si -u "$USER_NAME:$PASSWORD" -H "x-atech-key: wrong" $APP/api/health   # still 200: Vercel replaces the header
```

In a browser: open `$APP/demo1/`, sign in, and check that the top bar says `Backend online`. Type a
prompt, click Generate firmware, and watch the status move through Generating, Compiling and
Validating by polling (one short request every three seconds). The generated `user_app.cpp` shows
under the status, and Download firmware fetches the validated image through the same origin.
`$APP/demo1/install.html` shows whether the base image parts exist on the server.

## What works where

| Browser | Generate, status, source preview, download | Bluetooth deployment | Wi-Fi deployment to a board on your network |
| --- | --- | --- | --- |
| Chrome, Edge (desktop, Android) | yes | yes (HTTPS origin) | not yet |
| Safari (macOS, iPhone, iPad) | yes | no Web Bluetooth | not yet |
| Firefox | yes | no Web Bluetooth | not yet |

Wi-Fi deployment goes through the backend, and the backend now runs in the cloud, not on your
Wi-Fi, so it cannot reach a board at home. The hosted dashboard says so, hides Find devices, and
offers Bluetooth and the hotspot download instead. Simulated boards (`ATECH_SIMULATED_DEVICE` on
the server) still appear and accept deployments, which exercises the cloud path end to end
without hardware. A future board-to-cloud connection would slot into the same panel.

The USB installer page works on Vercel (Web Serial needs HTTPS, which Vercel provides). Its
"Build the base image now" button is hidden on the hosted site because that is a multi-minute
job; the operator builds the parts once on the server with
`sudo docker compose -f atech-ble-ota-demos/deploy/compose.yaml run --rm builder node deploy/warm-cache.js --install-only --base`.

## Local emulation

Run the backend as the Droplet runs it (non-loopback listener, fixed key, simulated boards) and the
emulation in front of it:

```sh
cd atech-ble-ota-demos/builder
ATECH_BUILDER_HOST=0.0.0.0 ATECH_BUILDER_PORT=5199 ATECH_BUILDER_KEY=devkey ATECH_SIMULATED_DEVICE=all npm start

cd ../vercel-frontend
PORT=3100 ATECH_BACKEND_URL=http://127.0.0.1:5199 ATECH_BUILDER_KEY=devkey \
ATECH_DASHBOARD_USER=atech ATECH_DASHBOARD_PASSWORD=local-only npm run dev
```

Open http://127.0.0.1:3100/demo1/ and sign in with `atech` / `local-only`. The emulation rebuilds
`dist/` at start, so it always serves the current dashboards with the hosted configuration. It is
not Vercel: it mirrors `vercel.json` and `middleware.js` closely enough to test the dashboards,
the sign-in and the proxying, nothing more.

Local development without any of this is unchanged: `cd builder && npm start` serves the
dashboards itself with the default configuration in `web-shared/atech-config.js` (live progress
over SSE, no sign-in on loopback).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every page answers 503 | sign-in variables missing | set `ATECH_DASHBOARD_USER` and `ATECH_DASHBOARD_PASSWORD`, redeploy |
| Build fails with "The Vercel environment is incomplete" | one of the four variables missing or `ATECH_BACKEND_URL` has a path | set them for the environment you deploy (Production and Preview are separate) |
| Top bar says "Build service refused the hosted dashboard key" | `ATECH_BUILDER_KEY` on Vercel differs from the key the container uses | copy the key from the server, update the variable, redeploy (variables are read at request time for the route, but a redeploy is the safe way) |
| Top bar says "Build service unreachable" | Vercel cannot reach `ATECH_BACKEND_URL` | check DNS, the firewall (443), `docker compose logs caddy`, and `curl -si https://<host>/api/health` from outside |
| Bluetooth button disabled | browser without Web Bluetooth | use Chrome or Edge; generation and download work everywhere |
| Step 1 shows "No board yet" for a minute after loading | the server still lists a paired board it cannot reach; each unreachable board adds well over a minute to the first device refresh (mDNS and probe timeouts), and Vercel drops proxied requests after 120 s | forget stale boards on the server (`curl -X DELETE -H "x-atech-key: $KEY" http://127.0.0.1:5173/api/devices/<id>` over SSH) or clear `devices.json` in the builds volume; simulated boards answer at once |

## Rotating secrets

- Backend key: change `ATECH_BUILDER_KEY` in `/etc/atech/builder.env`, restart the container, update
  the Vercel variable, redeploy.
- Sign-in: change the two Vercel variables and redeploy; browsers will prompt again.
