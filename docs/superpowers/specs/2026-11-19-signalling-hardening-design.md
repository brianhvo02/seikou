# Signalling hardening

Status: design, 2026-11-19. Owner's choices: tickets for the lockout (approach A), and offers answered only with a proof.

## Why

Two weaknesses of the WebRTC route's signalling are recorded in `docs/known-issues.md`.

1. **Lockout.** The rendezvous Worker allows 100 device connection attempts a minute per NAS (`DEVICE_ATTEMPTS` in
   `rendezvous/src/signalling.ts`) and 10 a minute per client address (`LIMITS.signal` in `code-registry.ts`). A
   client with more than ten addresses can fill the NAS's window, so its devices get 429 for the rest of the minute,
   and it can keep doing that.
2. **Address leak.** Anyone holding a NAS's id (it travels in every code lookup and pairing) can open a device socket
   and send an offer. The NAS answers any offer with an SDP listing its public IPv4 and its LAN address
   (`RTC_LAN_ADDRESS`) as host candidates, before any pairing or session.

The owner wants both closed: a stranger who knows the id should learn nothing about where the NAS is, and shouldn't
be able to keep the owner's own devices or a friend abroad from connecting.

## Goals

- The NAS sends an answer SDP only to a device that proves it is paired, or that it holds a live pairing code.
- A paired device's connection attempts can't be used up by anyone who lacks that device's ticket.
- A device pairing with a code can't be locked out by a flood that doesn't know the code.
- No new secret leaves a device, and the Worker learns nothing it doesn't know today beyond device ids.

## Non-goals

- Hiding the NAS id itself, or the fact that a NAS is online.
- Protecting the HTTPS route (it has its own token auth and the user's Caddy in front).
- Revoking a ticket before it expires. A ticket only buys connection attempts; the NAS still checks the device's own
  proof before it answers, so a removed device's ticket gets it a socket but never an answer.

## Anti-goals

- Breaking a working pairing. A device paired before this change must keep connecting over WebRTC without being
  paired again.
- A route that stops working while the NAS is unreachable over HTTPS. A device that can reach the NAS only over
  WebRTC must still be able to get and renew its ticket.

## Approaches

- **A. Signalling tickets (chosen).** The NAS signs a ticket for each paired device. The Worker checks it with the
  NAS's registered public key, which it already fetches to authenticate the NAS's own socket, and gives each ticketed
  device its own allowance. A device pairing with a code shows the code's hash, which the Worker checks against its
  registry and gives an allowance per code. Only connections with neither proof share the per-NAS pool.
- **B. Tighter limits only.** Lower the per-address limit and keep one per-NAS pool. Simpler, but anyone with enough
  addresses still locks devices out. Not chosen.
- **C. The Worker verifies device signatures.** The NAS would register every device's public key with the Worker.
  The Worker would then hold the device list, and every pairing and removal would need a Worker round trip. Not chosen.

## Design

### 1. Offers carry a proof; the NAS answers only a checked one

A device's `offer` gains a `proof`, one of:

- `{ deviceId, signature }`: the paired device's P-256 signature over `offerProofMessage({ sid })`, a new message
  in `rendezvous/src/protocol.ts` with its own type tag (`{"type":"offer","sid":…}`), so neither a TURN proof nor an
  offer proof verifies as the other. No timestamp: the Worker picks `sid` fresh for each socket, which lives 60 s,
  so a captured signature can't be replayed on another socket. A device whose clock is off keeps the route; it already
  loses only the relay (`relay.ts`).
- `{ codeHash }`: `codeHashOf(code)` of a live pairing code, plain or invite. The app already computes it when it
  pairs (`nas-client.ts`, where it is passed as `inviteHash`).

The NAS (`server/src/rtc/signalling-client.ts`) checks the proof before calling `peers.answer`, using
`auth.signedBy` and `auth.codes()` as `turnResponder` does. An offer without a proof that checks out gets
`{ t: 'answer', sid, error: 'unauthorized' }`. That answer has no SDP, and the NAS opens no peer for that `sid`, so it
also ignores that socket's candidates. The check shares a helper with the TURN check (`auth.signedBy` over the given
message, or a live code by hash); TURN keeps its own message, its `ts` and its 10-an-hour limit.

The app (`src/ui/nas/rtc/rtc-connection.ts`) sends the proof with its offer: `deviceProof` gains the message to sign
(offer or TURN), or the code hash goes in as it does for TURN. A device given `unauthorized` stops and reports
`RtcUnreachable`, as it does for other refusals.

### 2. Signalling tickets

A ticket is `{ nasId, deviceId, exp }` (`exp` in ms since the epoch), with `signature` as the NAS's P-256 signature
over `signalTicketMessage({ nasId, deviceId, exp })`, a new message with the type tag `signal-ticket`. It is
serialized as base64url of its JSON (`encodeTicket` and `decodeTicket` in `protocol.ts`).

- **Issue.** The NAS adds `signalTicket` to two answers, when it has a rendezvous id, valid for 90 days:
  - **The pairing answer (`pair/redeem`),** so a device paired over WebRTC holds a ticket before its first real
    connection. Its code is spent and unregistered by then, so it would otherwise have no proof.
  - **The `GET me` answer,** built inline in `server/src/routes/titles.ts`, and typed in the app as `NasMe` in
    `src/ui/nas/nas-client.ts`. The ticket's type and its encode, decode and message helpers live in
    `rendezvous/src/protocol.ts` beside the other signalling messages, so no `@seikou/nas` public type changes.

  `GET me` today runs from screens, not on connect, so `NasClient` asks it right after any connection opens
  (HTTPS or WebRTC) when the pairing's ticket is missing or has under 60 days left. A device reachable only over
  WebRTC thus renews while it is used, and only a device unused for 90 days, or paired before this change, connects
  once through the shared window to get a ticket. An older NAS sends none, and the app then connects without one, as
  today.
- **Store.** The app keeps the newest ticket on the pairing (`NasPairing.signalTicket` in `NasStore`), replaced
  whenever `me` returns one with a later `exp`, and drops it when the pairing is removed.
- **Present.** The device socket is opened as `GET /signal/device?nasId=…&ticket=…`. Browsers can't add headers to
  a WebSocket upgrade, so the query carries it. A ticket only buys attempts, so its appearing in logs is acceptable.
- **Check.** In the `Signalling` Durable Object, before the shared window: decode the ticket and check its `nasId`
  (this object's) and `exp` (not past, at most 31 days ahead). Then verify the signature with the NAS key, fetched
  from the registry (`INTERNAL.nasKey`) and kept in the object's memory for 10 minutes.
  - **A ticket that checks out** is counted in `rate:ticket:<deviceId>`, 10 attempts a minute, and never in the
    shared window.
  - **One that doesn't** falls to the shared window, as if absent.
- **Per-address limits.** `index.ts` counts an upgrade carrying a `ticket` or `codeHash` parameter against a
  separate, generous per-address cap (60 a minute, `rate:signal-proof:<address>`), before the object does any
  signature check or registry fetch, and skips the usual 10-a-minute count for it. When its proof then fails, the
  object asks the registry to count it against that address's usual 10-a-minute limit as well
  (`INTERNAL.signalAttempt`, with the forwarded `CF-Connecting-IP`), and it falls to the shared window. One address
  with junk tickets thus gets no more than it would with none, and verification costs stay bounded per address.

### 3. Code proofs at the Worker

`GET /signal/device?nasId=…&codeHash=…`: the object asks the registry whether that hash is a live code of this NAS
(a new `INTERNAL.codeLive` route answering 204 or 404; the registry already keeps codes by hash with their NAS id and
expiry). A live one is counted in `rate:code:<codeHash>`, 10 a minute. Anything else falls to the shared window.

### 4. The shared window

Connections without a proof that checks out share one window per NAS, lowered from 100 to 30 a minute, and the
10-a-minute per-address limit stays for them. Once every app sends a ticket or a code hash, the only legitimate
users of this window are apps older than this change, and the NAS answers those `unauthorized` anyway (section 1).

### 5. Rollout and compatibility

- **The Worker and the site deploy together from `main`** (CI). The NAS is deployed by the owner, and by
  self-hosters from the published image.
  - The new Worker accepts tickets and code hashes and keeps the shared window.
  - The new app sends them, plus the offer proof, which an older NAS ignores.
- **Once the NAS is deployed,** it issues tickets and refuses offers without a proof.
  - An app page loaded before the site deploy keeps sending bare offers and gets `unauthorized` until it reloads.
  - The service worker's network-first navigation makes that the next page load.
- **Order:** Worker and site first (any order between them), then the NAS. Neither CLAUDE.md nor
  `docs/self-hosting.md` says this yet. Write it in `docs/known-issues.md`'s deploy-order entry and in
  `docs/self-hosting.md`'s Update section: a self-hoster with their own Worker updates it before the NAS image.
- **A self-hoster's own Worker** gets the same code. An older Worker with a newer NAS still works: it ignores the
  ticket and counts the attempt in its 100-a-minute pool.

### 6. Tests

- **Rendezvous unit tests** (`signalling.test.ts`, `worker.test.ts`):
  - A valid ticket bypasses a full shared window and the per-address limit.
  - A forged, expired or other-NAS ticket counts against the shared window.
  - A ticketed device past 10 a minute gets 429.
  - A failed proof counts against its address's 10-a-minute limit, and proof-bearing upgrades past 60 a minute from
    one address get 429 before any verification.
  - A live code hash gets its own window; an unknown one shares the pool.
- **NAS unit tests** (`signalling-client.test.ts`, `relay.test.ts` for the shared helper):
  - An offer without a proof, with a wrong signature, a proof for another `sid`, a TURN proof in place of an offer
    proof, or a dead code gets `unauthorized` and no SDP.
  - A valid device proof or a live code gets an answer.
  - `GET me` and `pair/redeem` carry a ticket that verifies with the NAS key.
- **App unit tests** (`rtc-connection.test.ts`, `nas-store` tests):
  - The offer carries the proof.
  - The ticket from pairing is stored, replaced only by a later one, sent on the upgrade, and removed with the
    pairing.
  - `GET me` is asked after connecting when the ticket is missing or has under 60 days left, and not otherwise.
- **End-to-end** (`tests/e2e/nas.spec.ts`, on the signalling stand-in `tests/e2e/signalling-standin.ts`):
  - The existing WebRTC pairing and playback tests pass with proofs and tickets.
  - A new test, in one project only (Chrome) and under a Playwright lock that the other WebRTC tests also take,
    since every project shares the stand-in's `Signalling` state: it floods the shared window from the stand-in,
    then a paired device holding a ticket still connects over WebRTC.

### 7. Docs

- **`docs/known-issues.md`:** remove the lockout and address-leak entries, and add what remains:
  - A removed device keeps attempts, never answers, until its ticket expires.
  - A device without a ticket (paired before the change, or unused for 90 days) connects once through the shared
    window, which a flood can still fill.
  - App pages from before the change get `unauthorized` until they reload.
- **Elsewhere:** CLAUDE.md's NAS server and rendezvous paragraphs, the spec of step 3 (a line pointing here),
  `docs/self-hosting.md` (deploy order), and the developer site through the `@seikou/nas` types.

## Left to the builder

- Names of the helpers and fields beyond those given here, as long as the wire names (`proof`, `ticket`,
  `codeHash`, `signalTicket`, `unauthorized`) stay.
- How the NAS key is cached in the Durable Object (its memory is lost on hibernation, which is fine).
- Whether the shared window's 30, the per-device and per-code 10 and the per-address 60 live as constants in `protocol.ts`, so the app,
  the NAS and the tests share them.
