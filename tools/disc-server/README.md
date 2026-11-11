# disc-server: development disc server

The disc server is a development server that serves disc folders on this Mac to devices on the home network (iPhone, iPad, the iOS Simulator, other browsers), so a disc opens by URL instead of a folder pick. It also serves the built player from the same origin, so a device loads the app and the disc from one LAN URL in a secure, cross-origin-isolated context (SharedArrayBuffer needs both).

It speaks the NAS server's disc API: the same library listing, manifest (with the metadata files inlined) and files route. The player therefore opens its discs through the same `RemoteSource` and `HttpTransport` as a NAS disc. Manifests, file resolution and range parsing are the NAS server's own code (`server/src/manifest.ts`, `server/src/ranges.ts`). Pairing, sessions, folders and ISO images exist only on the NAS: the dev server has one token per run and lists folder discs flat.

It uses Node built-ins and those two NAS modules, run through `tsx` (already a devDependency).

## What's inside

- `server.ts`: the server (routes, token check, address filter, static files for `dist/`).
- `server.test.ts`: its tests (see [Tests](#tests)).

## Run it

```sh
npm run build                    # the player the server hands out (dist/)
npm run disc-server -- --root fixtures/synthetic --root fixtures/local \
  --cert ~/.disc-server/cert.pem --key ~/.disc-server/key.pem
```

Options: `--root <dir>` (repeatable; every folder up to four levels below that contains `BDMV/index.bdmv` is a disc), `--port <n>` (default 8443), `--cert`/`--key` (PEM; without them the server speaks plain HTTP on 127.0.0.1 only, which is still a secure context for a browser on this Mac), `--dist <dir>` (default `dist`).

It prints:

- `Player (lists the discs): https://<lan-ip>:8443/?token=…`: the landing screen shows "On the disc server" with a button per disc.
- One `https://<lan-ip>:8443/?disc=<…/api/discs/<id>/>&token=…` URL per disc, which offers just that disc.

Tap the disc's button to open it (the tap is what lets audio start); it is enabled once the disc's manifest has arrived. The token is new on every run; links from an earlier run answer 401, which the player reports as "no longer paired" (the dev server has no session refresh).

## Certificates (mkcert)

Devices only treat the page as a secure context over HTTPS with a certificate they trust. `mkcert` makes a local certificate authority and certificates signed by it:

```sh
brew install mkcert              # if it is not installed yet (Homebrew, user-level)
mkcert -install                  # creates the local CA and trusts it on this Mac (asks for your password)
mkdir -p ~/.disc-server
mkcert -cert-file ~/.disc-server/cert.pem -key-file ~/.disc-server/key.pem \
  "$(ipconfig getifaddr en0)" "$(hostname -s).local" localhost 127.0.0.1
```

The key stays outside the repository. Make a new certificate when the Mac's LAN address changes.

iPhone and iPad must install and trust the CA too: AirDrop `"$(mkcert -CAROOT)/rootCA.pem"` to the device, install the profile (Settings → General → VPN & Device Management), then enable full trust for it (Settings → General → About → Certificate Trust Settings). That one-time step is part of the device setup in `tools/devices/README.md`. The iOS Simulator takes it with `xcrun simctl keychain booted add-root-cert "$(mkcert -CAROOT)/rootCA.pem"`.

## What it serves

| Route | Token | Answer |
| --- | --- | --- |
| `GET /`, `GET /<file>` | no | The built player from `--dist`, with `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (as `public/_headers`) and `Cross-Origin-Resource-Policy: same-origin`. |
| `GET /api/library?path=` | yes | The NAS's `LibraryListing`: `{ folders: [], discs: [DiscEntry], scanning: false }`, every disc flat. `id` is a hash of the disc folder's real path, so it is stable across runs; `path` is `<root folder name>/<folder below it>`. |
| `GET /api/discs/<id>/manifest` | yes | The NAS's `DiscManifest`: `{ discId, name, files: [{ path, size }], inline: { path: base64 } }`, upper-case paths under `BDMV` and `CERTIFICATE` only, the files the engine reads whole inlined. |
| `GET /api/discs/<id>/files/<path>` | yes | The file, its path in any case: `Range: bytes=a-b` gives 206 with `Content-Range`, a range starting past the end 416, no range 200. Streamed from disk, so files over 4 GiB cost no memory. `HEAD` too. |
| `GET /api/discs/<id>/probe` | yes | The first 4 MiB of the largest clip (the NAS pre-flight's throughput check). |

Errors are the NAS's JSON: 401 `{ "error": "unauthorized" }`, 404 `{ "error": "disc-changed" }` for an unknown disc id (the player shows "This disc changed"), 404 `{ "error": "not found" }` for a missing file.

The token goes in `Authorization: Bearer <token>` (what the player sends for the listing and manifests) or `?t=<token>` (what `HttpTransport` sends for file reads, so they need no CORS preflight), as on the NAS. Disc responses carry `Cache-Control: no-store`, and the service worker never caches them.

## Who can connect

- The server listens only on loopback and on this Mac's private LAN addresses (10/8, 172.16/12, 192.168/16, 169.254/16), never on `0.0.0.0`, and refuses (403) any request whose source address is not loopback, private, link-local or IPv6 unique-local. Tailscale's 100.64/10 is not in that list, but the filter only sees the last hop: a local reverse proxy on this Mac (`tailscale serve`, as the device gate uses it, or any other) connects from loopback and passes it. Behind such a proxy only the per-run token protects the discs, so run one only while you need it; reaching discs from outside the home for real is the NAS server's job.
- The `Host` header is not checked (no DNS-rebinding guard). Without the token a rebound page reaches only the public player in `dist/`.
- Every disc request needs the per-run token (401 without it). The built player at `/` is public code and needs none.
- Paths with an empty, `.` or `..` segment, or with `/`, `\` or NUL once decoded, are refused (400). A file is only served if its real path (after links) is inside the disc folder.
- Read-only: only `GET`, `HEAD` and the CORS preflight `OPTIONS` are answered.

The player and the probe page follow `?disc=` links only to their own origin: open discs from the URLs the server prints, which load the player from the server itself. A `?disc=` naming another origin is ignored and nothing is fetched from it, so a link to the production player cannot point it, with a token, at a server. CORS: API requests from the Vite dev server (port 5173 on loopback or a private LAN address) still get `Access-Control-Allow-Origin` for that origin, as do the server's own origin; any other origin gets none. The token still gates every read.

## Tests

`npx vitest run tools/disc-server` (plain HTTP on loopback; the 4 GiB case uses a sparse file). It also reads discs through the player's client path (`RemoteSource` over `HttpTransport`) against the server.

## Documentation

- The command is listed in the Commands section of `CLAUDE.md`.
- Design: `docs/superpowers/specs/2026-10-17-m5d-bdj-menus-design.md` §4.5 (the dev server) and `docs/superpowers/specs/2026-10-17-nas-server-design.md` (the disc API it copies).
- Device setup that uses it: `tools/devices/README.md`.
- The NAS server it imitates: `server/` and `docs/nas.md`.
- mkcert (local certificates): https://github.com/FiloSottile/mkcert
