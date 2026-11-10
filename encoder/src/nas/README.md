# nas/: the encoder and Seikou's NAS

The encoder talks to Seikou's NAS server only through its HTTP API, as a paired owner device, the way Seikou's app does: pairing redeems an owner pairing code with a new P-256 public key, and every run signs the NAS's session challenge with that key for a session token. This folder holds the pairing file, the pairing itself and the client that makes requests with a session.

## Concepts

- **The pairing file.** `<data>/nas.json`, written atomically with mode 0600: the NAS's API base, the device id and person the NAS gave, the person's name, the device's private key as a JWK (generated extractable so it can be kept) and when it was paired. It never holds a session token. A file that cannot be read as one counts as no pairing.
- **The API base.** Always ends in `/api/`. It must be `https:`; plain `http:` is allowed only on `127.0.0.1` and `localhost`, for tests. A user name, password, query or fragment is refused or dropped.
- **Pairing input.** A typed code with the address, or a pairing link as Seikou makes them: `?pair=<code>&nas=<API base>`, or `?pair=<code>&rv=<rendezvous Worker>`, in which case the Worker's `POST codes/lookup { code }` gives the NAS's HTTPS base (`routes.https`). Codes are normalised as `@seikou/nas/pairing-code` does.
- **Owner only.** A code for a person who is not an owner is refused (`not-owner`) and nothing is saved. The NAS has still paired that device, so it shows in Seikou's admin screen until an owner removes it; the same goes for a device whose pairing the encoder forgot (Unpair).
- **Sessions.** The client holds one session token in memory, signs for a new one 60 s before the NAS says it lapses, and shares one sign-in between the requests waiting on it. The sign-in runs under its own 15 s timeout, never a caller's signal: a caller whose signal aborts stops waiting alone (`unreachable`). A sign-in answer that is not JSON, or has no non-empty `token` and numeric `expiresAt`, is `http` with a fixed message. A request answered 401 signs for a new session once and is sent once more; a second 401 is the answer.
- **Closing.** `close()` drops the key and the session; every later request throws `NasError('unauthorized', null, 'This app is no longer paired with the NAS.')`. The backend closes the client it replaces on unpair and re-pair, so a long job holding the old one stops.
- **Secrets.** Nothing here logs. No error message holds the token, the key or a query string: messages name the NAS by host name only.

## API

- `nas-store.ts`: `NasPairingFile`, `readNasPairing(dataDir)`, `writeNasPairing(dataDir, p)`, `removeNasPairing(dataDir)` (also removes `<data>/fetch` and `<data>/nas-library.json`, which belong to the NAS forgotten).
- `pairing.ts`: `checkNasBase(base)`, `parsePairingInput({ code?, base?, link? })` and `pairWithNas(dataDir, input, deviceName, fetchImpl?)`, which writes the new pairing first (renamed over any earlier `nas.json`), then, when it replaced one, removes what was fetched (`removeNasFetched`), and resolves with the new file. `removeNasFetched(dataDir)` is in `nas-store.ts`.
- `client.ts`: `NasError { code, status, error }` with `code` one of `unreachable` (no answer, abort or timeout), `unauthorized` (the NAS no longer knows the device, or refused its session), `not-owner`, `bad-address` and `http` (another error answer: `status` and the body's `error`; a malformed code is `http` 400 too). `NasClient.load(dataDir, fetchImpl?)` is null when not paired; `base`, `personName`, `request(path, init?)` (a path under the base, such as `encodes/status`; pass a body that can be sent twice), `json<T>(path, init?)` (an error answer throws, 401 as `unauthorized`), `me(init?)`, `close()`.

## Where to look

- The backend holds the client in `AppContext.nas.client` (`src/server/http.ts`), loaded at `app` and `serve` start and replaced by `src/server/nas-routes.ts` (`GET /api/nas`, `POST /api/nas/pair`, `DELETE /api/nas`).
- Seikou's side: `server/src/routes/pair.ts` (redeem, challenge, session), `server/src/auth.ts` and `scripts/verify-level.ts`, whose `Device` this client follows.
- Tests: `encoder/tests/nas/`, against Seikou's NAS handlers run in-process by `nas-test-server.ts` (`startNasTestServer({ encodes?, discs? })`: a copy of `fixtures/synthetic` as library root `syn`, an encodes folder holding episode 1 of AniList 990001 with uploads, codes minted through its `Auth`, and `expireSessions()`, which moves its clock past every session it gave).
