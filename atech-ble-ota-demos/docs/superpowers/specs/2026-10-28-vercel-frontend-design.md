# Vercel-hosted dashboards for the Atech builder (design, 2026-10-28)

## Intent

Open the Demo 1 and Demo 2 dashboards from any browser at a Vercel URL, with no local
frontend or backend. The Node backend and the PlatformIO compiler keep running in the existing
Docker container on the DigitalOcean Droplet. Vercel serves the static dashboards and proxies
`/api/*` to the Droplet so the browser keeps talking to one origin.

The request this answers is the owner's 14-point brief of 2026-10-28 (Vercel frontend directory,
reuse the dashboards, same-origin API, secure routing, HTTPS backend, no secrets in the frontend,
authentication, async jobs with polling, preserved functionality, Web Bluetooth kept optional,
cloud OTA prepared but not claimed, local development unchanged, tests, documented settings).

## Goals

- `https://<project>.vercel.app/demo1/` and `/demo2/` serve the unchanged dashboards.
- Every backend call stays a same-origin `/api/...` request from the browser's point of view.
- The Anthropic key and the backend dashboard key never appear in frontend code, build output
  or the browser.
- Pages and API are behind authentication before anyone can start a firmware generation.
- Builds are started with one short request and followed by polling; no browser request lives
  longer than a few seconds.
- Source preview, build status, downloads, identity checks, Bluetooth deployment and both
  demos' existing behaviour keep working.
- `cd builder && npm start` and every existing test keep working exactly as before.
- The Droplet can be put behind HTTPS with files in the repository; nothing is deployed here.

## Non-goals

- Deploying to Vercel or to the Droplet, or changing the DigitalOcean firewall.
- Wi-Fi deployment from the cloud backend to a board on someone's home network. The hosted
  dashboard says plainly that this is not available yet.
- A visual redesign, a framework migration, or bundling the dashboards.
- Keeping SSE on the hosted path. Locally it stays.

## Anti-goals

- A build that succeeds while a secret is in the output, or a page that works without sign-in.
- Copy that claims remote deployment works.
- A hidden default: every setting Vercel needs is listed in one README table.

## Architecture (decided)

```
Browser  --HTTPS-->  Vercel project (root: atech-ble-ota-demos/vercel-frontend)
                       1. Routing Middleware: HTTP Basic auth on every path (fail closed)
                       2. static files from dist/: /demo1/, /demo2/, /shared/
                       3. route /api/(.*)  -->  ${ATECH_BACKEND_URL}/api/$1
                          with request header x-atech-key = $ATECH_BUILDER_KEY (route transform)
                                                  |
                                                  v  HTTPS
                       DigitalOcean Droplet: Caddy (TLS) --> builder container :5173
                                                  (/api/* only; backend still requires the key)
```

Two independent checks guard generation: the Vercel sign-in (user and password, Vercel env
vars) and the backend dashboard key, which Vercel adds at request time and the browser never
sees. Vercel documents both mechanisms: Routing Middleware is available on all plans; route
`dest` values and transform `args` expand `$VAR` from project environment variables listed in
the route's `env` array.

The browser never addresses the Droplet. Web Bluetooth works because the Vercel origin is
HTTPS. Nothing about the firmware, the BLE protocols or the LAN OTA protocol changes.

## Components

### 1. `atech-ble-ota-demos/vercel-frontend/` (new, the Vercel Root Directory)

| File | Role |
| --- | --- |
| `package.json` | `"type": "module"`, scripts `build`, `dev`, `test`; dependency `@vercel/functions` |
| `vercel.json` | `framework: null`, `buildCommand`, `outputDirectory: dist`, `redirects` (`/` to `/demo1/`, `/demo1` to `/demo1/`, `/demo2` to `/demo2/`), `routes` (API proxy with `env`, the key transform and a transform that deletes the `authorization` header). No `trailingSlash`: see the decisions below |
| `middleware.js` | Basic auth for all paths using `ATECH_DASHBOARD_USER` / `ATECH_DASHBOARD_PASSWORD`; 503 with a plain message when either is unset; 401 with `WWW-Authenticate` otherwise; `next()` when valid |
| `lib/basic-auth.js` | runtime-agnostic header parsing and constant-time comparison, shared by the middleware, the dev server and the tests |
| `build.js` | assembles `dist/` from `../demo1-custom-gatt/web`, `../demo2-bleota-library/web` and `../web-shared` (no test files, no dotfiles), writes `dist/shared/atech-config.js` for the hosted mode, validates the environment, and fails if any configured secret value appears in the output |
| `dev-server.js` | local emulation of the Vercel behaviour (auth, static, trailing slash, `/api` proxy with the injected key) against a local or remote backend |
| `test/*.test.js` | `node --test` suites, see Testing |
| `README.md` | exact Vercel settings, environment variables, Droplet HTTPS steps, deploy and verify steps |

`build.js` fails the Vercel build with a clear message when `ATECH_BACKEND_URL` is missing or
is not an `https://host[:port]` URL without a path, or when `ATECH_BUILDER_KEY`,
`ATECH_DASHBOARD_USER` or `ATECH_DASHBOARD_PASSWORD` is empty. Vercel leaves an unset `$VAR`
as a literal string in the route destination, so this check is what turns a misconfiguration
into a failed build instead of a broken site. `ATECH_ALLOW_MISSING_ENV=1` skips the check for
local builds.

### 2. Runtime configuration file (new): `web-shared/atech-config.js`

A tiny classic script that sets `window.ATECH_CONFIG`. The checked-in default is
`{apiBase: '', transport: 'auto', hosted: false, pollMs: 2000}`; the backend serves it unchanged
at `/shared/atech-config.js`. The Vercel build overwrites `dist/shared/atech-config.js` with
`{apiBase: '', transport: 'poll', hosted: true, pollMs: 3000}`. Both `index.html` files and both
`install.html` files load it before any other shared script. `apiBase` is a same-origin path
prefix (normally empty); a cross-origin base is not supported because the backend has no CORS.

### 3. `web-shared/atech-builder.js` changes

- All backend URLs go through one `apiUrl(path)` helper that prefixes `apiBase`. The literal
  `/api/...` strings stay where they are so the existing structure tests keep matching.
- `transport: 'poll'` makes `follow()` and `followDeployment()` poll `GET /api/builds/:id` and
  `GET /api/deployments/:id` every `pollMs` and never open an `EventSource`. `auto` keeps the
  current SSE-then-poll behaviour.
- `hosted: true` changes copy only where the local copy would be wrong:
  backend offline, dashboard key missing (now a Vercel configuration problem), the Wi-Fi method
  note ("Not available from the hosted dashboard yet: the build service runs in the cloud, not
  on your Wi-Fi"), the no-Bluetooth note, and the empty device panel. `Find devices` is hidden
  because mDNS discovery would run on the Droplet. Devices the backend already knows (simulated
  boards, future cloud-reachable boards) are still listed and refreshed every 15 s instead of
  8 s. Nothing else in the deployment panel changes, so Bluetooth and the hotspot download work
  as today.

### 4. `install.html` (both demos)

Loads the config script, builds the manifest and status URLs from `apiBase`, hides "Build the
base image now" when hosted (a multi-minute request has no place behind a proxy; the operator
runs `deploy/warm-cache.js --base` on the Droplet) and says so, and replaces the
`http://localhost:5173` wording with "HTTPS or http://localhost".

### 5. Droplet HTTPS (files only): `deploy/compose.tls.yaml` and `deploy/Caddyfile`

An optional Compose overlay adds a `caddy` service (ports 80 and 443, automatic Let's Encrypt
certificates, named volumes for certificates) that reverse-proxies only `/api/*` to
`builder:5173` over the Compose network and answers 404 for everything else. The builder's
host port stays on loopback. `ATECH_PUBLIC_HOST` (the DNS name) is the only new setting. The
README spells out the manual steps: DNS A record, opening 80 and 443 in the Droplet firewall,
starting with both compose files, and verifying with curl.

### 6. Documentation and housekeeping

- `vercel-frontend/README.md`: settings table, environment variables, step-by-step deploy,
  verification checklist, what the hosted dashboard can and cannot do.
- `deploy/README.md`: HTTPS section pointing at the overlay; the key must equal
  `ATECH_BUILDER_KEY` on Vercel.
- Main README: one "Hosted dashboards" line.
- Root `.gitignore`: `node_modules/`, `.vercel/`, `vercel-frontend/dist/`.
  `atech-ble-ota-demos/.dockerignore`: `vercel-frontend` (keeps it out of the 6.5 GB image).
- Existing structure tests updated only where the new script tag or copy requires it.

## Security review

- Secrets: `ATECH_BUILDER_KEY` is a Vercel environment variable expanded by Vercel at request
  time; it is never read by the build, never written to `dist/`, and the build scans the output
  for its value. `ANTHROPIC_API_KEY` stays in `/etc/atech/builder.env` on the Droplet.
- Sign-in: Basic auth over HTTPS with a constant-time comparison. Unset credentials mean a 503
  for every path, never an open site.
- Direct access to the Droplet: Caddy forwards only `/api/*`; the backend answers 401 without
  the key; the dashboards are not served publicly from the Droplet.
- Not covered: rate limiting, per-user accounts, audit of who started which build. The job
  log on the Droplet records prompts; the Vercel user name is not forwarded.
- Vercel caches external rewrites that send cache headers; the backend sends `no-store` on
  every API response, so nothing is cached.

## Vercel project settings (what the README must state)

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Root directory | `atech-ble-ota-demos/vercel-frontend` |
| Include source files outside of the Root Directory | enabled (default for new projects) |
| Build command | `npm run build` |
| Output directory | `dist` |
| Install command | default (`npm install`) |
| Node.js version | 22.x (default) |
| Environment variables | `ATECH_BACKEND_URL` (plain), `ATECH_BUILDER_KEY` (sensitive), `ATECH_DASHBOARD_USER` (plain), `ATECH_DASHBOARD_PASSWORD` (sensitive) |

## Testing

- `vercel-frontend`: `node --test` covers the Basic auth helper, the middleware responses
  (503 unset, 401 wrong or missing, pass-through right), the build (files present, config
  rewritten, no test files, no secret values, env validation), the shape of `vercel.json`
  (env-expanded destination, key transform, trailing slash, redirect), and the dev server
  (auth, static, trailing-slash redirect, `/api` proxying with the injected key overriding a
  client-supplied one, POST bodies forwarded, binary downloads streamed).
- `builder/test`: a new jsdom suite boots both dashboards with the hosted config and proves
  no `EventSource` is created, jobs progress through polling to `ready`, the download link is
  a same-origin `/api` URL, `Find devices` is hidden, the Wi-Fi note carries the hosted text,
  and Bluetooth deployment is still offered when a board is connected.
- Every existing suite runs unchanged.
- Browser: the dev server with Basic auth in front of a local backend with simulated boards,
  opened in Chrome: sign-in, both dashboards, build status by polling, source preview,
  download, installer page, and the hosted copy.

## Decisions after the builder check (2026-10-28)

A reviewer read this document against Vercel's routing source (`@vercel/routing-utils`) and raised
one blocking point; the answers below are part of the design.

- **No `trailingSlash: true`.** Vercel compiles it into a 308 route that runs before user
  `routes`, matching every extension-less path (`^/((?:[^/]+/)*[^/\\.]+)$`). `/api/health`,
  `/api/builds` and every other API path would be redirected to a slashed form the backend
  answers 404 to. Instead, `redirects` send `/demo1` and `/demo2` to their slashed form (308)
  and `/` to `/demo1/` (307). Redirects run after user routes, so `/api` is never touched.
- **The sign-in never reaches the backend.** A second transform deletes the `authorization`
  header on the `/api` route; the dev server does the same. The Droplet sees only the key.
- **Hosted mode ignores a browser-held key.** `adoptKey` is skipped when `hosted` is true, so a
  key left by an old `?key=` link is neither stored nor sent, and the download link has no
  `?key=`.
- **The hosted device timer keeps probing, every 15 s.** The reviewer suggested a non-probing
  timer; the backend, however, reports a board as online only when a probe answered within the
  last 20 s (`describe()` in `builder/lib/devices.js`), so a non-probing timer would show every
  board offline. 15 s keeps the state accurate with about half the requests of the local 8 s.
  A backend that still lists an unreachable paired board takes over a minute per refresh (mDNS
  and probe timeouts, measured 78 s locally); the README tells the operator to forget such boards.
- Vercel allows a proxied request 120 s. Builds are started with one short request and polled,
  so only the installer's base-image build could approach that, and it is hidden when hosted.

## Left to the builder

Exact wording of the hosted copy, test file layout, Caddyfile details beyond the behaviour
above, README structure, and the dev server's CLI flags.
