# Rendezvous Worker

The rendezvous Worker is a Cloudflare Worker with two Durable Objects. It lets a device that has only a pairing code find the NAS server, and it carries the signalling for the WebRTC route between a device and the NAS. It can also mint TURN credentials for Cloudflare's relay, when the NAS asks. The Worker never sees disc data, resume points or device tokens.

Self-hosters can run their own Worker, or skip it and pair with links only (see [`docs/self-hosting.md`](../docs/self-hosting.md)).

## Concepts

The NAS server makes a P-256 ECDSA key pair and registers the public key once. Its NAS id is the key's RFC 7638 JWK thumbprint, so registering the same key again gives the same id. Every later call the NAS makes is signed with that key, and its record expires 90 days after the NAS last registered a code or opened its signalling socket.

When the NAS mints a pairing code it registers the SHA-256 of the normalized code, with where the code leads (its HTTPS API base, if it has one) and when it expires: 10 minutes for a plain code, 3 days for an invite. The Worker never holds a code itself. The app sends the code its user typed to the lookup and gets the NAS id and its routes back; the Worker adds the WebRTC route (the NAS id to signal) to every answer. The NAS withdraws a code it no longer needs, which frees its place at once (a NAS holds at most 20 live codes).

Each NAS has its own `Signalling` object for WebRTC signalling. The NAS keeps one WebSocket open there and proves it holds the key by signing a challenge. A device opens a short-lived socket (60 s, at most 64 messages, 32 devices per NAS at once) and sends SDP offers, ICE candidates and TURN requests; the object forwards those to the NAS with the device socket's id, and forwards the NAS's answers, candidates and TURN responses back. It forwards nothing else. The sockets are hibernatable, and the NAS's heartbeat (exactly `{"t":"ping"}` every 25 s) is answered by the runtime's WebSocket auto-response, so an idle NAS never wakes the object.

The TURN relay is paid for by whoever runs the Worker. Anyone can register a key, so a signature alone says nothing about who pays. The Worker mints TURN credentials only for NAS ids on the `TURN_NAS_IDS` allowlist, 30 times an hour per NAS and 500 times a day in all. The NAS decides first whether the device may use the relay at all.

Rate limits are per client address (an IPv6 address counts by its /64): 10 lookups and 10 signalling attempts a minute, 5 key registrations, 30 code registrations and 60 withdrawals an hour, and at most 1,000 failed lookups an hour across all clients.

## Routes

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /nas` `{ publicKeyJwk }` | the NAS | Registers the key and answers its NAS id. 403 `nas-not-allowed` for a key off `NAS_IDS`. |
| `POST /codes` | the NAS, signed | Registers a code hash with its routes and expiry. 401 for a bad signature or unknown NAS, 409 when another NAS holds that hash, 429 at 20 live codes. |
| `DELETE /codes` | the NAS, signed | Withdraws a code. |
| `POST /codes/lookup` `{ code }` | the app | Answers `{ nasId, routes }` (`CodeLookup` in `@seikou/nas`), or 404 for an unknown or expired code. |
| `GET /signal/nas?nasId=` | the NAS | WebSocket to the NAS's `Signalling` object: challenge, `auth`, then forwarding. |
| `GET /signal/device?nasId=` | the app | WebSocket to the same object; it first hears its socket id (`hello`), which a paired device signs into a TURN request. |
| `POST /turn` | the NAS, signed | Cloudflare TURN credentials for a device. 403 off the allowlist, 503 `turn-not-configured` without the key. |

Every route answers 429 past its limit. Every answer but a signalling upgrade and `/turn` carries the CORS headers of `@seikou/nas`'s `cors-policy.ts`. The message formats, signed byte layouts, close codes and limits are in `src/protocol.ts`, which the NAS server's client (`server/src/rendezvous-client.ts`) imports too.

## Where to look

[`src/`](src):

- `index.ts`: the Worker's entry point. It routes by path, bounds request bodies, applies `NAS_IDS`, counts signalling attempts and adds CORS.
- `code-registry.ts`: the `CodeRegistry` Durable Object, one instance. It stores NAS keys and code hashes, checks signatures, keeps the rate-limit logs, and runs an alarm that deletes expired codes, NAS records and stale logs.
- `signalling.ts`: the `Signalling` Durable Object, one per NAS.
- `turn.ts`: `POST /turn`, which calls Cloudflare's TURN key API.
- `protocol.ts`: the signed-message formats, hashing, signalling message types and limits shared with the NAS server, written against WebCrypto so both runtimes run the same code.
- `body.ts`: bounded request body reads.
- `memory-state.ts`, `runtime-check.ts`: an in-memory stand-in for Durable Object storage used in tests, and compile-time checks that the Worker's narrow interfaces match the real runtime.

The Worker also uses `@seikou/nas` for the API types, pairing-code rules and the CORS policy. [`wrangler.toml`](wrangler.toml) declares the Durable Object bindings and migrations.

## Secrets

Secrets are set from this folder with `wrangler secret put <NAME>`, never in the repository:

- `NAS_IDS`: the NAS ids this Worker serves. Unset or empty, the Worker is open to every NAS.
- `TURN_NAS_IDS`: the NAS ids that may mint TURN credentials. Unset or empty, `/turn` refuses everyone.
- `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`: the Cloudflare TURN key. Without them `/turn` answers 503 `turn-not-configured`.

`server/deploy/deploy.sh --nas-id` prints a NAS's id.

## Deployment

CI deploys the Worker with `wrangler deploy` in its own job (`deploy-rendezvous` in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)), so a failure there never blocks the site deploy. The Worker's `workers.dev` URL is the app's `VITE_RENDEZVOUS_URL` and the NAS server's `RENDEZVOUS_URL`.

## Documentation

- [`docs/superpowers/specs/2026-10-18-webrtc-people-design.md`](../docs/superpowers/specs/2026-10-18-webrtc-people-design.md): pairing, signalling and the relay.
- [`docs/self-hosting.md`](../docs/self-hosting.md): running your own Worker.
- The NAS side: [`server/README.md`](../server/README.md) and [`server/src/README.md`](../server/src/README.md).

External:

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
