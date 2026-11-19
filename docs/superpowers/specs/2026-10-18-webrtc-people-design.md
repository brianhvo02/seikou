# People, Saved Data and the WebRTC Route (Step 3) — Design Spec

Date: 2026-10-18
Status: Approved by the user 2026-10-18. Release 1 (people, §4, and the BD-J store, §5) deployed 2026-10-18 (main c0be0f6). Spike done 2026-10-19 (§6.1 results below); release 2 (§6–§7, plan `docs/superpowers/plans/2026-10-19-webrtc-route.md`) deployed 2026-10-19 (main 9e9c0d9). Device run 2026-10-19 (iPhone 17 Pro, iOS 27.2, mobile data, Wi-Fi and Tailscale off): paired over WebRTC through the rendezvous, browsed the title library, pre-flight measured 18 Mbps against a 48 Mbps film and offered a 37-minute wait, played with pauses, two seeks resumed after buffering; the admin screen listed the device's route as WebRTC. BD-J over WebRTC was covered by the E2E only. Long-distance runs the same day through a VPN exit in Tokyo: a Mac on home internet (LAN candidates ignored, 222 ms round trip) measured 17 Mbps; the iPhone on mobile data through the VPN got 2 Mbps, the phone's own limit on that path (1 Mbps from Cloudflare).

Signalling was hardened on 2026-11-19: offers carry a proof, paired devices present NAS-signed tickets, and the per-NAS window is shared only by unproven connections. See `docs/superpowers/specs/2026-11-19-signalling-hardening-design.md`; where it differs from §6 here, it wins.

Parent spec: `2026-10-16-cross-browser-and-remote-design.md` §5 (step 3). Builds on `2026-10-17-nas-server-design.md` (pairing, rendezvous) and `2026-10-17-nas-library-titles-design.md` (the title library). Where this document and the parent disagree, this one wins for step 3.

## 1. Intent

The user wants a friend abroad to watch discs from the NAS on the friend's own phone or computer, in the browser, installing nothing: no Tailscale, no app. Today only the user's own Tailscale devices reach the NAS.

At the same time the NAS has to learn about *people*, not just devices. BD-J milestone 5e (another session's work) keeps what a disc saves (resume points, settings, game progress) on the NAS, per person, so one person's iPad and iPhone share it and a friend's stays separate. That needs people, a session that resolves to a person, and a small per-person store: the server's first write path for user data.

Success: the user makes an invite for a friend on the admin screen and texts the link. The friend, on another continent, opens it on a phone, sees the whole library, picks a film and watches it, with a clear, honest start-up when their connection is slower than the disc. Their saves stay theirs.

Stakes (user's words): low. It's a personal project; a rough edge isn't a disaster.

## 2. Goals, non-goals, anti-goals

Goals:
- **People** (user's request, via the BD-J session): the NAS knows people; every device belongs to one. Owners stay as they are, and an owner is also a person. Making a pairing code means picking or creating the person it's for. The admin screen shows people and their devices.
- **Per-person BD-J store** on the NAS's data volume, with the API in §5, for 5e to build against.
- **WebRTC route**: a browser-only, peer-to-peer connection from any device to the NAS, set up through the existing rendezvous Worker, carrying the same disc API as HTTPS. Pairing works over it too, since a friend can't reach the HTTPS route at all.
- **Friends see the whole library** (user's choice): the same title library and folder view the user sees. Owner-only screens (admin, Unsorted, "file differently", Hidden) stay owner-only.
- **Optional Cloudflare relay (TURN)** for networks where a direct connection fails, off until the owner turns it on, with usage shown against the free allowance (user's choice, §6.4).
- **Slow connections** (user's choice, §7): buffer first by default; when the wait would be long, say so up front and offer to wait, play with pauses, or (once step 4 exists) lower the quality.

Non-goals:
- Per-person shelves or hiding titles from a person. Everyone sees everything; the person model doesn't preclude it later.
- Lower quality (re-encoding). That's step 4, which also takes MPEG-2/VC-1 films. Step 4 must not touch the engine's playback path until 5e's MPEG-2/VC-1 change (playlists accepted without video) has merged; the BD-J session says when.
- A self-hosted relay (coturn). The user chose Cloudflare's.
- Downloading whole discs for offline viewing (parent §8: no).

Anti-goals:
- **Anything answering an unpaired device** other than "redeem a pairing code", on any route (parent §2). Over WebRTC, an unpaired peer's data channel accepts only `redeem`.
- **Surprise bills.** The relay is never used unless the owner turned it on, and it stops at the free allowance unless the owner allows paid use.
- **Writing to the drives.** The per-person store lives under `/data` only, like everything else the server writes.
- **The rendezvous Worker seeing content.** It relays signalling (SDP, ICE) and pairing lookups, never disc bytes, titles or the library. TURN relays DTLS-encrypted packets it can't read.

## 3. Order of work

My call, agreed by the user:
1. **People and the per-person store** (§4, §5): first, because 5e is waiting on them, and they work over the HTTPS route alone.
2. **Throughput spike** (§6.1): measures what a data channel actually carries before the route is built on it.
3. **WebRTC route and pairing over it** (§6).
4. **Relay and buffer-first** (§6.4, §7).

The API section (§5) goes to the BD-J session as soon as this document is approved, and from then on it is a contract: changes go through that session. People and the store ship as their own release (merge, deploy, migration) before any WebRTC work.

## 4. People

### 4.1 Data

`auth.json` gains `people: Person[]`, and each device a `personId`:

- `Person { id, name, owner: boolean, createdAt }`. Owner status moves from the device to the person: a device is an owner device when its person is an owner.
- `Device` keeps `id, name, publicKeyJwk, pairedAt, lastSeen` and gains `personId`. Its own `owner` field goes away (derived).
- `PairingCode` gains `personId` instead of `owner`.
- The session token resolves to the device, as now, and so to the person. Routes get `{ device, person }`.

**Migration** (my call), at first start of the new server: all existing owner devices go to one owner person named "Owner", and each non-owner device becomes its own person named after the device. The owner can rename people and move devices between people (both are admin actions), so a wrong guess costs a minute.

### 4.2 Pairing codes and invites

- Making a code (admin screen or `deploy.sh --owner-code`) names its person: an existing one, or a new one created with the code. `--owner-code` without a name pairs to the first owner person (made if none).
- **Lifetime** (my call): the rendezvous Worker's 15-minute cap on a code's expiry (`MAX_CODE_AHEAD_MS`) rises to 3 days for invites. A code made on the admin screen is valid 10 minutes, as now, or 3 days when it's marked as an invite to send. The QR and link are the same as in step 2 (`/?pair=<code>`). Brute force stays out of reach: about 2^60 codes against the rendezvous lookup limits (10/minute per IP, 1,000/hour overall) gives a negligible chance over 3 days even for several open invites.
- A code is still single-use. A friend who wants a second device asks for a second code.

### 4.3 Admin screen

- **People** list: name, owner badge, devices (name, last seen, which route it last used: home/Tailscale or WebRTC, relayed or not), and the person's saved-data size.
- **Actions:** new code for a person (or a new person); rename a person; make or unmake owner (refused for the last owner); move a device to another person; revoke a device; remove a person (revokes all their devices and deletes their saved data, after a confirmation naming what goes); clear a person's saved data.
- Revoking ends that device's open sessions on every route at once, including open data channels. (HTTPS tokens already fail verification once their device is gone; the builder checks that still holds per person.)

## 5. Per-person BD-J store (the API for 5e)

Designed from the BD-J session's sketch; it builds against this section.

**Keys.** BD-J saved data comes in two areas, mounted by the JVM as `/persistent/` and `/buda/`, as libbluray does. A **scope** is one whole subtree, read and written as a single snapshot:
- `persistent/<orgId>`: persistent storage, shared by the apps of one organisation (an xlet may read its sibling apps' folders).
- `buda/<orgId>/<discId>`: the binding unit data area.

`orgId` is 8 lowercase hex digits, `discId` 32. Neither is the library disc id. Anything else is a 400.

**On disk:** `/data/users/<personId>/bdj/persistent/<orgId>.tar` and `/data/users/<personId>/bdj/buda/<orgId>/<discId>.tar`, plus a sidecar `.etag`. One file per scope, replaced atomically (synced temp file, rename, directory sync), so a crash leaves the old snapshot or the new one, never half of one. (My call: one tar per scope rather than a tree of files, which keeps every replace atomic and every GET one file read.)

**Endpoints** (under `/bluray/api/`, device token required, the scope always the token's own person's):
- `GET bdj-store/<scope>` → `200`, `Content-Type: application/x-tar`, `ETag: "<etag>"`, the snapshot as a ustar archive. Each entry is one file with its path (relative to the scope), size and mtime. A scope with no snapshot answers `200` with an empty archive (two zero blocks) and no `ETag`, at once (it's on 5e's boot path, so a GET is one `stat` and one read).
- `PUT bdj-store/<scope>` with a tar body and either `If-Match: "<etag>"` or `If-None-Match: *` → `200` with the new `ETag`. A stale etag, or `If-None-Match: *` on an existing scope, is `412`; the client re-reads, merges per file (last write wins on mtime) and puts again. Neither precondition header is `428`.
- `DELETE bdj-store/<scope>` with `If-Match` → `204`. Optional for 5e; the admin "clear saved data" uses its own admin route.
- `PUT` and `DELETE` take an optional `X-Bdj-Person: <personId>` (added 2026-10-21 at 5e's request). When present and not the person the token belongs to at the moment of the write (checked again after a PUT's body has arrived), the answer is `409 {"error":"person-changed"}` and nothing is written; without it, nothing changes. It closes the window between the client's `GET me` and its write in which a device moved to another person would land one person's saves in the other's store.
- **Quotas:** 16 MB per scope, 256 MB per person. Over either, `507` with a JSON body naming which; the JVM reports it as a full disk (`IOException`). The body is rejected while streaming once it passes 16 MB.
- **Validation:** tar entries must be regular files with relative paths, no `..`, no absolute paths, no links, no device files; anything else is `400`. The server never extracts to disk.
- **Over WebRTC** the same requests travel over the data channel's request protocol (§6.3) with the same status codes, so 5e's `BdjStore` doesn't care about the route.

**Keepalive** (a constraint 5e must handle): browsers cap a `fetch(..., {keepalive: true})` body at 64 KB in total. The final flush on `pagehide` therefore succeeds only for small scopes; 5e's debounced writes (about 2 s after the last file write) are the reliable path. Over WebRTC there is no keepalive at all: a flush on `pagehide` is best-effort.

**Who sees it:** a device sees only its own person's store. Owners don't read other people's stores; they can only see sizes and clear them.

**Local-folder discs** stay browser-only (5e's IndexedDB backend). The NAS store is used for discs opened from the NAS, keyed as above, so a disc's saves follow the person across devices.

## 6. The WebRTC route

### 6.1 Throughput spike (first, throwaway)

Question: does a data channel carry a Blu-ray's rate (about 20–40 Mbps, UHD 60–100) from the NAS to a browser at high round-trip time, in Chrome, Firefox and Safari, especially iOS Safari?

- **NAS side:** a throwaway Node process on the NAS (its own container, nothing else changed), sending a 2 GB stream over a data channel. It tries the pure-JS `werift` library first, because the server has no native dependencies. If `werift` falls short and `node-datachannel` (libdatachannel bindings, native) doesn't, the server takes the native dependency: the Docker image builds it, and the "no native dependencies" constraint in CLAUDE.md is amended to say so (my call; the constraint was mine to begin with).
- **Networks:** the iPhone on cellular with Wi-Fi off (a real remote network, driven through `tools/devices/`), and a Mac browser against an emulated 150 ms and 250 ms round trip with 1% loss (`tc netem` inside the spike container only, never on the host).
- **Variables:** one channel against 2 and 4 parallel channels; message sizes of 16, 64 and 256 KB; ordered against unordered.
- **Bar:** a sustained 40 Mbps at 250 ms in Chrome and iOS Safari. Below that, parallel channels are the first remedy and the buffer-first path (§7) carries the rest; step 4's lower quality comes later. If neither library reaches the bar, the faster one is used and work continues (my call; the user called the stakes low).
- **Who runs it:** Claude deploys the spike container over ssh and drives the iPhone through `tools/devices/` over USB. The user only switches the iPhone's Wi-Fi off and plugs it in, so WebRTC transport work waits for one short session with the user.
- Results go into this document's status line and pick the library and the channel layout for §6.3.

**Spike results (2026-10-19):**
- **Library: werift.** It sustains 54–94 Mbps at an emulated 250 ms RTT with no loss (Chrome 54, Firefox 90, WebKit and Safari 94). It is CPU-bound at about 100–160 Mbps on the N150. node-datachannel collapses as RTT grows (under 1 Mbps at 250 ms; its sender idles), whatever the congestion settings.
- **Layout: one ordered channel with 64 KB messages.** More channels and 16 KB messages slow werift sharply, and 256 KB is only better outside Chrome. Every browser tested advertises a limit of at least 256 KB; the iPhone's werift session used 64 KB.
- **Loss is the risk.** With 1% random loss emulated, everything falls to 1–3 Mbps.
- **The iPhone on cellular** (a real remote network, through the router forward to UDP 47998) got 10–22 Mbps with werift, with stalls. The phone's own download from Cloudflare was 25–65 Mbps in the same minutes. Buffer-first (§7) will come up often, not rarely.
- **Not measured:** an intercontinental network. The first friend's watch is the real test.

### 6.2 Signalling

- The NAS keeps one outbound WebSocket to its Durable Object on the rendezvous Worker (hibernatable WebSockets), signed with its rendezvous key as now. It reconnects with backoff. Its heartbeat, exactly `{"t":"ping"}` every 25 s, is answered `{"t":"pong"}` by the runtime's WebSocket auto-response, so an idle NAS never wakes the object; only signalling messages and socket opens and closes do. Any socket gets that pong, authenticated or not, which is harmless because a pong carries nothing.
- A device opens a WebSocket to the Worker with the NAS id and, if paired, its device id. The Worker forwards SDP offers and answers and ICE candidates between device and NAS, and nothing else. It limits connection attempts to 10 per minute per IP and 100 per minute per NAS.
- `POST /codes/lookup` answers `routes: { https?, webrtc: { nasId } }`. An unpaired friend gets `webrtc` and redeems over it.
- STUN: Cloudflare's public STUN server. TURN: §6.4.
- **UDP on the NAS:** the server container stays on Docker's bridge network (host networking would touch the NAS's other services). It publishes one fixed UDP port (my call: 41641 is Tailscale's, so 47998), and the WebRTC library is configured to use only that port for ICE. Whether a direct path works then depends on the home connection: see §6.5.

### 6.3 The connection

- **Where it runs:** `RTCPeerConnection` exists only on the main thread, so the WebRTC transport lives in `src/player/` (or `src/ui/nas/`) and serves the engine worker's `RemoteSource` through a `MessagePort` with transferred buffers (parent §4.3). The BD-J worker's own `RemoteSource` gets a port too. The engine doesn't know which route carries the bytes.
- **Auth:** the first message on the control channel is the device's signed challenge, exactly as `POST session` over HTTPS. Until it passes, the NAS answers only `redeem` (pairing), and closes the connection after 30 s or one failed attempt. Revoking a device closes its connections.
- **Protocol:** request/response messages carrying the same routes as HTTPS: library, titles, art, manifest, ranges, probe, bdj-store and the owner's admin routes. Each request has an id. Range responses are chunked (the chunk size and channel count come from the spike; at most 64 KB per message for Safari), with flow control on `bufferedAmount`/`bufferedAmountLowThreshold`. A request is cancellable by id, so a seek aborts its reads.
- **Route choice:** the client tries the HTTPS address first with a 2 s timeout (my call), then WebRTC. The choice is remembered per NAS for the session and retried when it breaks. Telemetry and the admin screen show the route.

### 6.4 The Cloudflare relay

- **Off by default.** The owner turns it on in the admin screen, which shows Cloudflare's terms as last checked (my understanding: 1,000 GB a month free, then about $0.05/GB; the builder confirms the current terms and the copy cites the date it was checked).
- **Credentials** (my call): the rendezvous Worker holds the Cloudflare TURN key (a Worker secret, never in the repo) but knows nothing about devices, so it mints TURN credentials only at the NAS's signed request. A device asks the NAS for them over signalling, sending its device id and a fresh signature (or, when unpaired, the pairing code's hash). The NAS checks the device or the live code, checks that the relay is on and under its limit, asks the Worker for credentials (TTL 1 hour), and passes them back over signalling. A NAS id alone gets nothing. ICE tries direct candidates first and falls back to the relay.
- **Endpoint and terms (checked 2026-10-19 against developers.cloudflare.com/realtime):** the Worker mints credentials with `POST https://rtc.live.cloudflare.com/v1/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers` (`Authorization: Bearer <TURN_KEY_API_TOKEN>`, body `{"ttl": 3600}`, answer 201 `{iceServers}`), and the first 1,000 GB a month are free (shared by TURN and the SFU), then $0.05/GB of egress.
- **Who may mint:** anyone can register a key with the Worker, so a NAS signature alone would let a stranger mint credentials billed to the owner. Set `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` and `TURN_NAS_IDS` with `wrangler secret put`. `TURN_NAS_IDS` is the comma-separated list of NAS ids the Worker mints for (`server/deploy/deploy.sh --nas-id` prints the NAS's); unset or empty, `/turn` answers 503 `turn-not-configured`, and a NAS not on it gets 403. Each NAS may mint 30 times an hour, and all of them together 500 times a day (429 past either).
- **Usage** (ruling P2-R1): the NAS counts relayed bytes itself, both directions on the connections it classes as relayed, sampled from werift's counters every 10 s, and keeps the month's total in `/data/relay.json`. It is an estimate, and the copy says so. Reading Cloudflare's analytics would need another token, so the Worker reads none. A connection counts as relayed when its remote address is one of the device's relay candidates or one of the addresses of the TURN servers the NAS handed that device.
- **What viewers see:** a relayed session shows a small "Relayed" badge, and the player's info line shows "Relay this month: 412 of 1,000 GB free". The owner sees the same on the admin screen.
- **At the free limit:** new relayed sessions are refused with "The relay's free allowance for this month is used up. It resets on <date>." Open sessions finish their current title. The owner can tick "allow paid use beyond the free allowance" to lift this.
- An unpaired device redeeming a live invite may use the relay, but only for the redeem connection.
- If the relay is off and no direct path exists, the friend sees "Can't connect to the NAS from this network. Try another Wi-Fi or mobile data."

### 6.5 The home connection

Checked from the NAS on 2026-10-18 (read-only):
- **Not behind carrier-grade NAT.** The user believed it was, but the home gateway reports the same broadband IPv4 address that the NAS's outbound requests show from outside. So the gateway's port forward works.
- **Native public IPv6** on the NAS's LAN interface.

So:
- **IPv4:** the user forwards UDP 47998 on the gateway to the NAS (its LAN address), and `compose.yaml` publishes `47998:47998/udp`. The NAS advertises its public address as a host candidate learned from STUN. Most friends' networks then connect directly, and the relay is truly a fallback.
- **IPv6** (optional, my call: after the spike, and only if it helps): Docker's bridge network has IPv6 off, and the gateway's IPv6 firewall probably blocks inbound traffic. Enabling it would mean a change to the `caddy_default` network, which other services share, so it isn't part of this step unless the spike shows IPv4 falls short.
- The port forward is a manual step for the user, done once, and listed in the deploy notes. Until it exists, connections fall back to hole punching or the relay.

## 7. Slow connections: buffer first

- **Pre-flight** (exists from step 2) measures throughput with `probe` over whichever route is in use and compares it with the title's average rate (main playlist bytes ÷ duration) plus a 10% margin (my call: the average, not the `TS_recording_rate` peak, decides the wait; the peak still shows as today).
- **When the connection keeps up:** play as now.
- **When it doesn't:** the wait to play straight through is `duration × (1 − connection ÷ disc rate)`, and the bytes held ahead are that wait times the connection rate.
  - Wait under 2 minutes (my call) and storage available: buffer silently with a progress ring, then play.
  - Longer: the pre-flight says so ("About 40 minutes before it can play straight through") and offers **Wait**, **Play now with pauses**, and **Lower quality** (shown disabled with "coming later" until step 4).
- **Where the buffer lives:** an on-disk read-ahead cache in the Origin Private File System, written by the engine worker, read by `RemoteSource` before the network. It holds the main playlist's clips from the start position onward in playback order. `navigator.storage.estimate()` and `persist()` decide the room. On a phone that can't hold the whole gap, the pre-flight says how much it can hold and offers pauses (or lower quality later) instead of a wait that can't finish.
- Seeking outside the buffered range during the wait restarts buffering there. The cache is per disc and is cleared when another disc opens, or after 24 hours.
- During play, telemetry has buffer level, throughput, stall count and route; a stall shows "Buffering…".

## 8. Testing

- Server unit tests: people migration, codes per person, owner derivation, last-owner protection, revocation across routes; the BD-J store (empty scope, etag conditions, 412, quotas, tar validation, atomic replace under a crash between temp write and rename).
- Rendezvous tests: signalling forwarding, limits, TURN credential minting refused when the relay is off, usage gate.
- WebRTC: an E2E with the NAS stand-in and the Worker stand-in over a real data channel in Chromium, Firefox and WebKit (open and play `disc1`, `disc-bdj`, pair over WebRTC with HTTPS unreachable). The request protocol's chunking, cancellation and flow control get unit tests with a fake channel.
- Buffer-first: unit tests of the wait arithmetic and the cache; an E2E with a throttled transport.
- Device run: the iPhone on cellular pairs by an invite link, plays a disc over WebRTC, and a BD-J disc saves and resumes from the iPad. Recorded in the status line.

## 9. Constraints

- Everything in CLAUDE.md, especially: the public repo (made-up names only), no writes under `/mnt`, Caddy reload only, the TMDB key only in the NAS's `.env`.
- The Cloudflare TURN key lives only in the Worker's secrets (CI's existing Cloudflare token deploys it).
- `src/engine/` stays free of UI imports; the WebRTC transport is outside it and reaches it through a `MessagePort`.
- New dependencies (`werift` or `node-datachannel`) get their licences in the server's `NOTICE`.

## 10. Decisions

| Question | Decision | By |
|---|---|---|
| First remote viewer | A friend abroad, on a phone or computer, browser only | User |
| What friends see | The whole library | User |
| Stakes | Low; rough edges are fine | User |
| People and devices | Devices belong to people; an owner is a person; codes name their person | User (via the BD-J session) |
| Saved data | Per person on the NAS, scopes and API as in §5 | BD-J session's sketch; details my call |
| Slow connections | Buffer first by default; long waits shown with wait / pauses / lower quality (later) | User |
| Relay | Cloudflare TURN, optional, usage shown against the free allowance, stop at the limit unless paid use is allowed | User (option, warning); my call (stop at limit) |
| Order | People and store, spike, WebRTC, relay and buffering | My call, user agreed |
| Migration of existing devices | Owner devices → one "Owner" person; others → one person each | My call |
| Invite lifetime | 3 days (plain codes stay 10 minutes) | My call |
| WebRTC library | `werift` unless the spike says `node-datachannel` | My call |
| HTTPS timeout before WebRTC | 2 s | My call |
| Silent-buffer threshold | 2 minutes | My call |

## 11. Left to the builder

Exact screens and copy (beyond the strings above), the chunk size and channel layout (from the spike), reconnection backoff, the tar reader and writer, the OPFS cache layout, how the Worker stores relay settings, and the sidecar etag format.
