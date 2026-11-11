# Rendezvous Worker

The rendezvous Worker is a Cloudflare Worker with two Durable Objects. It lets a device that has only a pairing code find the NAS server, and it carries the signalling for the WebRTC route between a device and the NAS. It can also mint TURN credentials for Cloudflare's relay, when the NAS asks. The Worker never sees disc data, resume points or device tokens.

The NAS server registers its public key and signed hashes of its pairing codes. The app looks a typed code up and gets the NAS's address back. Self-hosters can run their own Worker, or skip it and use pairing links only (see [`docs/self-hosting.md`](../docs/self-hosting.md)).

## Modules

[`src/`](src):

- `index.ts`: the Worker's routes. `POST /nas` and `POST /codes` (the NAS registers), `DELETE /codes` (the NAS withdraws a code), `POST /codes/lookup` (the app looks a code up), the `/signal/nas` and `/signal/device` WebSockets, and `POST /turn`.
- `code-registry.ts`: the `CodeRegistry` Durable Object. It stores NAS keys and code hashes, checks signatures, and keeps the per-NAS and per-client limits.
- `signalling.ts`: the `Signalling` Durable Object, one per NAS. It forwards offers, answers, candidates and TURN requests between the NAS and a device over hibernatable WebSockets, and answers the NAS's heartbeat without waking.
- `turn.ts`: `POST /turn`, which mints Cloudflare TURN credentials only for the NAS ids on an allowlist, with hourly and daily limits.
- `protocol.ts`: the signed-message formats and hashing shared with the NAS server (`server/src/rendezvous-client.ts`), written against WebCrypto.
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
- The NAS side: [`server/README.md`](../server/README.md).

External:

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
