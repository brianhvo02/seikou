# Run your own server

The player is a static web app. Your discs stay on your machine; the NAS server serves them to the player over HTTPS (or WebRTC), lists them by title and keeps each person's resume points, BD-J saved data and uploaded subtitles. This guide is for people who already run Docker Compose, a reverse proxy or Tailscale, and router port forwards.

You get the hosted player at `https://bluray.pages.dev/` for free: a pairing link from your server opens it and pairs the device straight with your server. A Cloudflare account is optional (typed codes, QR through a Worker, WebRTC for friends away from your network).

## Layers

1. **Minimum:** the server and an HTTPS address for it. A device pairs with the owner code's link. HTTPS only, no WebRTC.
2. **Optional, your own rendezvous Worker:** typed pairing codes, QR codes and the WebRTC route (also needs one UDP port forwarded).
3. **Optional, Intel Quick Sync:** quality levels (re-encoding on the GPU). Without it the server offers Original only.

## Requirements

- Docker with Compose v2 on linux/amd64.
- An HTTPS address that reaches the container's port 8080 (reverse proxy, Tailscale Serve/Funnel, or similar). Browsers refuse the player's requests to plain-HTTP servers.
- Optional: a Cloudflare account (Worker and Durable Objects, free plan is enough), a forwarded UDP port, `/dev/dri/renderD128` on an Intel GPU.

## Library layout

The server scans the folders you name up to six levels deep, slowly, and again nightly. It reads:

- decrypted disc folders (`<disc>/BDMV/...`) and `.iso` files (read through a built-in UDF reader);
- nothing it doesn't recognize; a disc whose files changed within the last hour is treated as still downloading and left out.

Mounts are read-only, and the server writes only its data volume. Roots look like `name=dir`, optionally `name=dir@Group` (roots sharing a group show as one top-level folder). Paths are inside the container, under `/library`. Unmatched discs go to Unsorted, where the owner can file them by hand; matching uses AniList, TheDiscDB (bundled) and, with a key, TMDB.

## Configure

```sh
cd server/deploy            # or copy compose.yaml, compose.gpu.yaml and .env.example anywhere
cp .env.example .env
```

Edit `.env`. Empty values mean unset.

| Setting | Meaning |
|---|---|
| `LIBRARY_MOUNT` | Host folder bound read-only at `/library` (compose default `/srv/bluray`). |
| `LIBRARY_ROOTS` | Roots as above, e.g. `movies=/library/Movies,downloads=/library/Downloads@Downloads`. A second host folder goes in `compose.override.yaml` (same read-only bind options, own target such as `/library2`) and in `LIBRARY_ROOTS`. |
| `PUBLIC_BASE` | **Required.** The HTTPS API base as devices reach it, ending in `/api/`, e.g. `https://nas.example.com/bluray/api/`. The server and every subcommand refuse to start without it. |
| `APP_URL` | The player pairing links open, with no query or fragment. Default `https://bluray.pages.dev/`. Normally left as is: the server's CORS lets only the hosted player (`bluray.pages.dev` and its preview subdomains) talk to it, so a player served from anywhere else can't reach it. |
| `RENDEZVOUS_URL` | Your Worker's base URL. Empty: pairing links only. |
| `RTC_LAN_ADDRESS` | This host's LAN IPv4 (10/8, 192.168/16 or public), advertised to WebRTC peers on your network, e.g. `192.168.1.20`. Used with `RENDEZVOUS_URL`. |
| `RTC_PORT` | The UDP port of the WebRTC route, default `47998`. Compose publishes it as given. |
| `TRUSTED_PROXY` | Hostname or IP of your reverse proxy, whose `X-Forwarded-For` is believed (for per-IP limits). Empty: no proxy is trusted. |
| `TZ`, `NIGHTLY_SCAN_AT` | Time zone and `HH:MM` of the nightly scan (default `04:00`). |
| `TITLE_LIBRARY` | Who opens the title library: `everyone` (every paired person) or `owners`. The server's own default is `owners`; `.env.example` sets `everyone`. The owner can change it in the app afterwards. |
| `TMDB_API_KEY` | Enables TMDB lookups. Never logged. |
| `DISCOGS_TOKEN` | Adds Discogs to music lookups (MusicBrainz otherwise). |
| `LOOKUP_CONTACT` | An email address or URL named in the User-Agent of music lookups, as MusicBrainz asks. Printable ASCII only. |
| `LEVELS_BACKEND` | `qsv` (Quick Sync, needs `compose.gpu.yaml`) or `off`. `x264` exists for development and CI. The server's own default, if unset, is `qsv`; `.env.example` sets `off`. A failed encoder self-test at start also leaves Original only. |
| `FANSUB_WINDOW_END` | `HH:MM` (default `08:00`), the local time the overnight fansub run stops. |
| `FANSUB_STORE_BYTES`, `FANSUB_CACHE_BYTES` | Byte budgets of the stored fansub subtitles (default 20 GB) and of the download cache (default 5 GB). |
| `FANSUB_PICKS_BYTES` | Byte budget of the subtitles viewers pick themselves from Anime Tosho (default 2 GB). When it is full, the picks used longest ago are removed first. |
| `SEADEX_URL`, `TOSHO_FEED_URL`, `TOSHO_URL` | Where SeaDex and Anime Tosho are reached; `https` only (defaults `https://seadex.moe`, `https://feed.animetosho.net`, `https://animetosho.net`). |
| `RENDER_GID` | Group id of the render node on the host, for `compose.gpu.yaml` (`stat -c %g /dev/dri/renderD128`, default 993). |
| `BLURAY_IMAGE` | Image, default `ghcr.io/brianhvo02/bluray-server:latest`. Pin a tag (a short commit hash) for a fixed version. |

The fansub search makes outbound requests to `seadex.moe` and `animetosho.net`: its `feed.` host for the listings and `storage.animetosho.net` for the subtitle track and font pack downloads, one request every 2.5 seconds to each service. Nothing else leaves the NAS for it.

Other server settings (`TRANSCODE_CACHE_BYTES`, 50 GB by default, `SCAN_PAUSE_MS`) can be added to `.env`; compose passes the whole file.

## Start

```sh
docker compose up -d
docker logs -f bluray-server
```

The container listens on plain HTTP on 8080 and publishes only the UDP `RTC_PORT`. Put your proxy in front of it (below). The first scan takes a while on a large library; the log shows progress.

## First owner

```sh
docker exec bluray-server node server.mjs owner-code
```

It prints a code, a pairing link and a terminal QR (single use, 10 minutes). Open the link on a device: the app names the server it will talk to and asks before pairing. That device is an owner and can mint invites, file discs, upload subtitles and change settings in the app. `--person <name>` mints for a named owner person.

## HTTPS and `TRUSTED_PROXY`

The server needs to be reachable at `PUBLIC_BASE`, and the proxy must pass the path after the prefix to the server's `/api/...`.

Caddy, under a prefix, with the proxy in the same Docker network (attach `bluray-server` to that network in `compose.override.yaml`, `networks:` with it as `external: true`):

```caddyfile
nas.example.com {
  handle_path /bluray/* {
    reverse_proxy bluray-server:8080
  }
}
```

`PUBLIC_BASE=https://nas.example.com/bluray/api/`, `TRUSTED_PROXY=caddy` (the proxy's container name or IP, as the server sees it). Override for that case (it replaces the service's default network, so list the default too if something else needs it):

```yaml
# compose.override.yaml
services:
  bluray-server:
    networks: [proxy]
networks:
  proxy:
    external: true
```

A proxy on the host instead: publish `127.0.0.1:8080:8080` in `compose.override.yaml` and proxy to that. A whole host name for the server works too (`PUBLIC_BASE=https://bluray.example.com/api/`, no prefix).

Tailscale: `tailscale serve` (or Funnel for friends off your tailnet) with HTTPS to the loopback port (publish 8080 on 127.0.0.1 as above) gives `https://<machine>.<tailnet>.ts.net/`. Serve it at the root, so `PUBLIC_BASE=https://<machine>.<tailnet>.ts.net/api/`; devices must be on the tailnet unless you use Funnel.

The server answers CORS for the public app's origin by itself. Set `TRUSTED_PROXY` only to your proxy; with it empty, no `X-Forwarded-For` is believed and every request counts as coming from the proxy.

## Optional: your own rendezvous Worker

Adds typed codes, QR codes and WebRTC. From `rendezvous/` of a clone of this repository (needs Node 22 or newer and a Cloudflare account; the Worker has no dependencies to install):

```sh
cd rendezvous
npx wrangler@4.148.0 login
npx wrangler@4.148.0 deploy
```

All Worker commands run from `rendezvous/`.

Note the printed `https://bluray-rendezvous.<account>.workers.dev` URL. Then:

1. Set `RENDEZVOUS_URL` to it in `.env`, and `RTC_LAN_ADDRESS` to this host's LAN address. `docker compose up -d`.
2. Forward UDP `RTC_PORT` (47998) on your router to this host. ICE uses only that port; the server advertises its public IPv4 (found by STUN) and `RTC_LAN_ADDRESS`, never Docker's address. Keep the compose port and `RTC_PORT` equal.
3. `docker exec bluray-server node server.mjs owner-code` now prints a link with `rv=` (your Worker), and registers the code with it. Typed codes work at the pair screen only through the app's built-in Worker, or yours entered under "Use another rendezvous" there. Prefer links and QR.

A pairing remembers the Worker it was made through, so WebRTC reconnects use yours. A pairing made from a `nas=` link (before you had a Worker) has none and stays HTTPS-only: after adding a Worker, pair that device again for typed codes and WebRTC.

**Allowlist (`NAS_IDS`).** By default a Worker registers any NAS, which is fine for a Worker only you know the address of. To lock it to your server, get the id and set the secret:

```sh
docker exec bluray-server node server.mjs nas-id        # exists after the first start with RENDEZVOUS_URL set
cd rendezvous && npx wrangler@4.148.0 secret put NAS_IDS     # comma-separated NAS ids
```

With `NAS_IDS` set, any other NAS gets 403 `nas-not-allowed` at registration, and lookups, signalling and `/turn` refuse it.

**Cloudflare TURN relay (optional, for peers behind strict NATs).** Create a TURN key in the Cloudflare dashboard, then, from `rendezvous/`:

```sh
npx wrangler@4.148.0 secret put TURN_KEY_ID
npx wrangler@4.148.0 secret put TURN_KEY_API_TOKEN
npx wrangler@4.148.0 secret put TURN_NAS_IDS     # your NAS id from `nas-id`
```

Without all three, `/turn` answers 503 `turn-not-configured`; a NAS not on `TURN_NAS_IDS` gets 403. The relay is off in the server until the owner switches it on in the app (it has a monthly allowance and asks before paid use).

## Optional: Quick Sync quality levels

On a host with an Intel GPU at `/dev/dri/renderD128`:

```sh
stat -c %g /dev/dri/renderD128      # set RENDER_GID to this
# .env: LEVELS_BACKEND=qsv
docker compose -f compose.yaml -f compose.gpu.yaml up -d
```

Always include `compose.gpu.yaml` in later restarts, or the container loses the device. The server self-tests each codec's encoder at start and offers only those that pass; the log says which. Encoded segments are cached under `/data/transcode` (50 GB LRU by default). The encoder is Intel-specific today; a GPU-agnostic encoder (NVENC, VAAPI on AMD) is a future milestone.

## Data and backups

Everything the server keeps is in the `bluray-data` volume (`/data`): `auth.json` and the paired devices' keys, `owner.json` (the owner's choices), per-person resume points and BD-J saved data under `users/`, uploaded subtitles in `subtitles/`, the rendezvous key, metadata and art caches, and `transcode/` (cache, safe to delete). Compose names the volume `<project>_bluray-data`, the project being the folder holding `compose.yaml` (for example `bluray-server_bluray-data` in a folder named `bluray-server`). Find the real name first:

```sh
docker volume ls | grep bluray-data
```

Then back it up with the container stopped or from a snapshot (a wrong name makes Docker create an empty volume and back that up):

```sh
docker run --rm -v <project>_bluray-data:/data -v "$PWD":/backup busybox tar czf /backup/bluray-data.tgz -C /data --exclude=transcode .
```

Restore into the same volume with the service stopped: `docker run --rm -v <project>_bluray-data:/data -v "$PWD":/backup busybox tar xzf /backup/bluray-data.tgz -C /data`.

Losing the volume unpairs every device and loses resume points and saved data (the library itself is read-only and untouched).

## Update

```sh
docker compose pull && docker compose up -d      # add -f compose.gpu.yaml where you use it
```

CI publishes `ghcr.io/brianhvo02/bluray-server` for linux/amd64 on every passing push to main, tagged `latest` and the short commit hash. To build it yourself: `npm ci && npm run server:build && docker build -f server/Dockerfile server`.

## Licences

The server is part of this project (see the repository). The image also carries Debian's ffmpeg (GPL-2.0-or-later, run only as a child process) and Intel's media driver and oneVPL runtime (MIT); sources and licence locations are in `server/deploy/IMAGE-NOTICE`, which is also the notice for anyone you give the image to. Every package in it is Debian 13's, so the GPL source is Debian's source package of the installed version (https://sources.debian.org, https://snapshot.debian.org).
