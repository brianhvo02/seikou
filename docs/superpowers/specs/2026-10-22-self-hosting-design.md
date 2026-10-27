# Self-hosting the NAS server: design

Status: done; on main and deployed 2026-10-22 at 2b975fb (site, Worker, first GHCR image). The owner's NAS cutover to the generic compose is done (checked 2026-10-23).

## 1. Why

The NAS server (`server/`) works with any library, but its deployment is written for one NAS: `server/deploy/deploy.sh`
builds on the owner's Mac and ships over ssh to the owner's host, `server/deploy/compose.yaml` names that NAS's drives,
Tailscale address, LAN address, Caddy and timezone, the server prints pairing links to the owner's site, and the public
web app (`bluray-web.pages.dev`) pairs only through the owner's rendezvous Worker. Nobody else can run a server without
reading the code. The goal is that an experienced self-hoster can run their own server from the repo, play from it on
the public web app, and never depend on the owner's Cloudflare account.

## 2. Goals, non-goals, anti-goals

Goals:
- A published server image and a generic compose file with `.env.example`, so a self-hoster sets values, not code.
- A setup guide in the repo for people who already run Docker Compose and a reverse proxy.
- A server works with no rendezvous Worker at all (pairing by a link that carries its address).
- A self-hoster can run their own rendezvous Worker for typed codes, QR codes and the WebRTC route, and the public web
  app uses it for their pairings.
- The owner's Worker serves only the owner's NAS.
- The owner's own deployment keeps working, with the owner's values moved out of the repo's compose file.

Non-goals (this project):
- A GPU-agnostic encoder (NVIDIA NVENC, AMD VAAPI as well as Intel Quick Sync). **Future milestone, after everything
  else is done** (owner's call). This project documents Quick Sync as it is, and Original only without it.
- Images for other CPU architectures (the image stays linux/amd64; jellyfin-ffmpeg and Quick Sync are amd64).
- A hosted service, an installer, or a setup wizard in the app.
- Self-hosters deploying their own copy of the web app (possible, but not documented as a path).

Anti-goals:
- Another person's NAS registering on the owner's Worker, or costing the owner anything.
- The public web app silently talking to a server or Worker the person didn't choose: a link's addresses are shown
  before pairing.
- The owner's private values (addresses, drive layout, keys) left in the repo.
- Breaking existing pairings or the owner's deploy.

## 3. Decided

**Who it is for (owner's call).** People with self-hosting experience: Docker Compose, a reverse proxy or Tailscale,
router port forwards. The guide is concise and skips basics.

**Layers.**
1. *Minimum:* the server and an HTTPS address for it (their reverse proxy, Tailscale, or similar). The owner code's
   link carries the server's address, so a device pairs straight with the server; no Worker and no Cloudflare
   account. Devices reach the server over HTTPS only (no WebRTC route).
2. *Optional, their own rendezvous Worker:* deployed from `rendezvous/` with Wrangler under their Cloudflare account.
   It gives typed pairing codes, QR codes through the Worker, and the WebRTC route (which also needs a UDP port
   forwarded on their router). The Cloudflare TURN relay is a further option, as for the owner.
3. *Optional GPU:* an Intel Quick Sync render node passed into the container, for quality levels; without one the
   server offers Original only.

**Pairing links (owner's choice 2: the public app accepts any Worker).** A pairing link today is
`<app>/?pair=<code>` and resolves through the app's built-in Worker (`VITE_RENDEZVOUS_URL`). It gains two optional
parameters:
- `nas=<the server's HTTPS API base>`: the device redeems the code directly at that server, without a lookup.
- `rv=<a rendezvous Worker's base URL>`: the device looks the code up at that Worker instead of the built-in one, and
  uses it for this pairing's signalling (WebRTC) from then on.
A pairing remembers the Worker it was made through, so a WebRTC reconnect uses the same Worker. Before pairing from a
link that names a server or Worker other than the app's own, the pair screen shows the host names it will talk to and
asks to continue. Both addresses must be `https:` URLs (`http://localhost` allowed only on a dev build).

**Typed codes.** A typed code goes to the app's built-in Worker, unless the person opens "Use another rendezvous" on
the pair screen and enters a Worker address (my call: an advanced field, folded away by default).

**The server's printed link.** The owner code's link (`pairingLink`, `server/src/codes.ts`), and the links minted in
the app's owner screens, use `APP_URL` (default `https://bluray-web.pages.dev/`) and add `nas=` (from `PUBLIC_BASE`)
when no `RENDEZVOUS_URL` is set, or `rv=` (from `RENDEZVOUS_URL`) when one is set (my call: always, so the server needn't
know which Worker the app has built in; the app asks nothing when `rv` is its own Worker).

**The owner's Worker, locked.** `POST /nas` (registration, `rendezvous/src/code-registry.ts`) accepts only NAS ids
on an allowlist, `NAS_IDS` (a Worker secret, comma-separated, the same pattern as `TURN_NAS_IDS` in `turn.ts`). An
empty or unset `NAS_IDS` keeps registration open, so a self-hoster's own Worker works without setting it. The owner
sets it to the owner's NAS id (`server/deploy/deploy.sh --nas-id`). A refused registration answers 403
`nas-not-allowed`, and the server logs one plain line saying its Worker refused it. With `NAS_IDS` set, code lookups,
signalling and `/turn` also refuse a NAS id not on it, so a NAS registered before the lock is shut out at once (my call).

**CORS.** The shared origin rule (`src/engine/disc/cors-policy.ts`) already allows the public app's origin on every
server and Worker built from this repo. A self-hoster's server and Worker therefore accept the public app as they are.

**Server image.** The image carries a notice for its GPL parts (jellyfin-ffmpeg, Intel's media driver) with where
their sources are, and the guide repeats it (my call). GitHub makes a new package private: the owner makes it public once
in the package settings. CI builds `server/Dockerfile` for linux/amd64 and publishes it to GitHub's container registry
(`ghcr.io/<owner>/bluray-server`), tagged with the commit and `latest`, on every push to main that passes CI.

**Generic compose and settings.** `server/deploy/compose.yaml` becomes generic: every value of the owner's moves into
`.env`, documented in a committed `server/deploy/.env.example`:
- `LIBRARY_ROOTS` and the library mounts (one documented example root, read-only, `create_host_path: false`),
- `PUBLIC_BASE` (no default of the owner's: the server refuses to start without it, with a message),
- `APP_URL`, `RENDEZVOUS_URL` (optional), `RTC_LAN_ADDRESS` and `RTC_PORT` (optional, with the Worker),
- `TRUSTED_PROXY` (optional), `TZ`, `NIGHTLY_SCAN_AT`, `TITLE_LIBRARY`,
- `TMDB_API_KEY`, `DISCOGS_TOKEN` (optional), `LEVELS_BACKEND` (`qsv` or `off`),
- the GPU override stays a separate `compose.gpu.yaml`.
The owner's own drives, addresses and keys live only in the owner's NAS's `.env` (and, for the drive mounts, a
`compose.override.yaml` on the owner's NAS, not in the repo). `DEFAULT_PUBLIC_BASE` (`server/src/config.ts`) goes.

**The owner's deploy.** `deploy.sh` keeps building on the Mac and shipping over ssh by default (the host stays in
`BLURAY_NAS_HOST`), now writing the generic compose file and leaving the owner's `.env` and `compose.override.yaml`
alone. A one-time step (`deploy.sh --migrate`) writes the owner's current values from today's compose into the NAS's
`.env` and override before the first generic deploy, and `deploy.sh` refuses to deploy while the NAS's `.env` lacks
`PUBLIC_BASE`, so a missed value can't take the NAS down (my call). The Caddy route step stays, its site name from
`BLURAY_CADDY_SITE` on the Mac (a gitignored `.env.local` there), not the repo.

**The owner's values in the repo (owner's call: current files only).** The owner's Tailscale host name, LAN address,
drive layout, Worker address and ssh host name leave every current file (scripts such as `caddy-route.sh`,
`tools/devices/live-check.ts` and `tools/bdj-library/sync.ts`, tests, CLAUDE.md, `docs/known-issues.md`, and the older
specs and plans), replaced by settings or made-up examples. Git history is not rewritten.

**Lookup identity.** The MusicBrainz and Discogs `User-Agent` keeps the project's name and repository, and a
self-hoster may add a contact address with `LOOKUP_CONTACT` (my call), as MusicBrainz asks.

**The guide.** `docs/self-hosting.md`, linked from the README:
requirements (Docker Compose, an HTTPS address, amd64); the library layout the scanner expects; `.env` settings;
starting it; the first owner pairing code (`docker exec … owner-code`, its link and QR); HTTPS options (reverse proxy,
Tailscale) and `TRUSTED_PROXY`; optional Worker (Wrangler deploy, `NAS_IDS` for their own allowlist, `RENDEZVOUS_URL`,
the UDP port forward and `RTC_LAN_ADDRESS`, the TURN relay's secrets); optional Quick Sync; what the data volume holds
and how to back it up; updating; and that the GPU-agnostic encoder is a future milestone.

## 4. Constraints

- The public repo rule: none of the owner's addresses, drive names, NAS id or keys in the repo, the guide or examples.
- The server keeps no native dependencies and writes only under `/data`; library mounts read-only.
- Existing pairings keep working: a pairing stored before this change has no Worker of its own and uses the built-in
  one, as today.
- The owner's Worker allowlist must be set before or together with the deploy that locks it, so the owner's NAS never loses
  registration.
- No user-agent sniffing; supported browsers as today.

## 5. Left to the builder

- The exact pair-screen wording and layout for the confirmation and the advanced Worker field.
- How a pairing stores its Worker (a field in `NasStore`'s pairing record, migrated with a default).
- The CI job's details (buildx, registry login with `GITHUB_TOKEN`, tags).
- The guide's structure and examples (made-up hostnames such as `nas.example.com`).
- The server's start-up message wording when `PUBLIC_BASE` is missing.

## 6. Calls made without the owner (check these)

- C1. Without a Worker, a server is reachable over HTTPS only; WebRTC needs a Worker for signalling.
- C2. A typed code uses another Worker only through a folded-away "Use another rendezvous" field.
- C3. Before pairing from a link that names another server or Worker, the app shows the host names and asks.
- C4. An unset `NAS_IDS` leaves registration open (so self-hosters' Workers work as deployed); only the owner sets it.
- C5. `PUBLIC_BASE` has no default; the server refuses to start without it.
- C6. The image is published to GitHub's container registry, linux/amd64 only.
- C7. The owner's drive mounts move to a `compose.override.yaml` on the owner's NAS.
- C8. Printed links always carry `rv=` when a Worker is set; the app asks nothing when it is its own Worker.
- C9. With `NAS_IDS` set, lookups, signalling and TURN also refuse NASes off the list.
- C10. `deploy.sh --migrate` moves the owner's values to the NAS once; deploys refuse without `PUBLIC_BASE` there.
- C11. The image and guide carry a GPL notice with source locations; the owner makes the package public once.
- C12. `LOOKUP_CONTACT` lets a self-hoster add a contact to the lookup `User-Agent`.
