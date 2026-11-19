# Signalling Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The NAS answers WebRTC offers only from paired devices or holders of a live code, and the rendezvous
Worker gives ticketed devices and live codes their own connection allowances, so a flood can't lock them out.

**Architecture:**
- **New wire pieces** (offer proof, signal ticket, limits) live in `rendezvous/src/protocol.ts`. The Worker, the NAS
  and the app all import them.
- **The Worker** checks proofs at the `Signalling` Durable Object, with two new internal registry routes.
- **The NAS** gates offers and issues tickets in `GET me` and `pair/redeem`.
- **The app** sends the proofs, stores the ticket on the pairing and renews it after connecting.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects (run in Node for tests), werift on the NAS,
Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-signalling-hardening-design.md`

## Global Constraints

- **Wire names:** `proof`, `ticket`, `codeHash`, `signalTicket`, `unauthorized`. They are fixed by the spec.
- **Ticket lifetime:** valid for 90 days. Renew when under 60 days are left. The Worker refuses an `exp` more than
  31 days past the 90.
- **Limits per minute:**

  | Who | Allowance |
  |---|---|
  | Shared window per NAS | 30 |
  | Per ticketed device | 10 |
  | Per live code | 10 |
  | Proof-bearing upgrades per address | 60 |
  | Unproven upgrades per address | 10, as today |

- **Offer proof:** `{ deviceId, signature }` over `offerProofMessage({ sid })`, with no timestamp, or `{ codeHash }`
  of a live code, plain or invite.
- **TURN is unchanged:** its message, its `ts` and its 10 an hour stay as they are.
- **Ticket format:** `{ nasId, deviceId, exp, signature }`, base64url of its JSON. The signature is over
  `signalTicketMessage({ nasId, deviceId, exp })`, whose JSON starts with type tag `signal-ticket`.
- **Every new file's header** is `// SPDX-License-Identifier: LGPL-3.0-or-later`. Every export gets a doc comment
  (`tests/documentation.test.ts`).
- **Commit trailers:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01GBZfoxxVBoLAHWBt3hr873`.
- **Tests:**
  - `npm test`, `npm run typecheck` and `npm run licence-check` pass after every task.
  - Run `npx vitest run tests/documentation.test.ts` after touching exports.
  - Run `npm run devsite:model` first if `npm test` reports a stale model.

## Review Focus

1. **A device paired before this change** connects without a ticket. It must still get one: through the shared
   window, then `me` after connecting. Task 5 tests it.
2. **A ticket for another NAS id, or one whose `exp` lies far in the future,** must not buy an allowance, and must
   count like no proof. Task 3 tests it.
3. **Candidates sent after a refused offer** must not open or touch a peer on the NAS. Task 4 tests it.
4. **An HTTPS-paired device whose NAS has no rendezvous** gets `signalTicket: null` and keeps working. Tasks 4 and 5
   test it.
5. **The upgrade URL with both `ticket` and `codeHash`:** the ticket is checked first, and on failure the code; only
   one allowance is ever counted. Task 3 tests it.

---

### Task 1: Wire pieces in the protocol

**Files:**
- Modify: `rendezvous/src/protocol.ts`
- Test: `rendezvous/src/protocol.test.ts` (create)

**Interfaces:**
- **Produces:**
  - `offerProofMessage(fields: { sid: string }): Uint8Array<ArrayBuffer>`, with the JSON
    `{"type":"offer","sid":…}`.
  - `interface SignalTicket { readonly nasId: string; readonly deviceId: string; readonly exp: number; readonly signature: string }`
  - `signalTicketMessage(fields: { nasId: string; deviceId: string; exp: number }): Uint8Array<ArrayBuffer>`, with
    the JSON `{"type":"signal-ticket","nasId":…,"deviceId":…,"exp":…}`.
  - `encodeTicket(t: SignalTicket): string` (base64url of the JSON)
  - `decodeTicket(s: string): SignalTicket | null`: null for bad base64, bad JSON, wrong field types, or a string
    over 1024 chars.
  - `type OfferProof = { readonly deviceId: string; readonly signature: string } | { readonly codeHash: string }`
  - Constants: `SIGNAL_TICKET_TTL_MS = 90 * DAY`, `SIGNAL_TICKET_RENEW_MS = 60 * DAY`,
    `SIGNAL_TICKET_MAX_AHEAD_MS = 121 * DAY`, `SIGNAL_SHARED_PER_MINUTE = 30`, `SIGNAL_TICKET_PER_MINUTE = 10`,
    `SIGNAL_CODE_PER_MINUTE = 10`, `SIGNAL_PROOF_PER_ADDRESS = 60`.

- [ ] **Step 1: Write the failing tests** in `protocol.test.ts`:
  - `offer and TURN proof messages differ for the same sid`: their bytes are not equal.
  - `a ticket survives encode and decode`: round trip equals the input.
  - `decodeTicket refuses junk`: null for `'%%%'`, `base64url('[]')`, a ticket with `exp: 'x'`, and `'a'.repeat(1025)`.
- [ ] **Step 2: Run** `npx vitest run rendezvous/src/protocol.test.ts`. Expected: FAIL, the exports are missing.
- [ ] **Step 3: Implement the exports above in `protocol.ts`,** next to `turnProofMessage`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rendezvous): offer proof and signal ticket messages`.

### Task 2: Registry routes for code checks and proof attempts

**Files:**
- Modify: `rendezvous/src/code-registry.ts`
- Test: `rendezvous/src/worker.test.ts`

**Interfaces:**
- **Consumes:** `SIGNAL_PROOF_PER_ADDRESS` (Task 1).
- **Produces:**
  - `INTERNAL.codeLive = '/internal/code-live'`: `GET ?nasId=&codeHash=` answers 204 when a code record with that
    hash, this `nasId` and an `expiresAt` in the future exists, else 404.
  - `INTERNAL.signalProofAttempt = '/internal/signal-proof-attempt'`: `POST` with `CF-Connecting-IP`, counted in
    `rate:signalProof:<bucket>` at `{ max: 60, windowMs: MINUTE }` (a new `LIMITS.signalProof`). Answers 204, or
    429 when full.
  - `INTERNAL.signalAttempt` is unchanged (10 a minute per address).

- [ ] **Step 1: Write the failing tests** in `worker.test.ts`, calling the registry object as its existing tests do:
  - `code-live answers 204 only for a live code of that NAS`: register a code for NAS A. Then A plus its hash gives
    204, NAS B plus its hash gives 404, and after the clock passes `expiresAt` it gives 404.
  - `signal-proof-attempt allows 60 a minute per address`: 60 calls give 204, the 61st gives 429, and another address
    still gets 204.
- [ ] **Step 2: Run** `npx vitest run rendezvous/src/worker.test.ts -t "code-live|signal-proof"`. Expected: FAIL.
- [ ] **Step 3: Implement both routes** in the registry's internal dispatch, beside `INTERNAL.signalAttempt`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(rendezvous): registry checks for live codes and proof attempts`.

### Task 3: The Worker's allowances for tickets and codes

**Files:**
- Modify: `rendezvous/src/index.ts` (`signal()`), `rendezvous/src/signalling.ts` (`fetch`, `allowDevice`)
- Test: `rendezvous/src/signalling.test.ts`, `rendezvous/src/worker.test.ts`

**Interfaces:**
- **Consumes:** Task 1 (`decodeTicket`, `signalTicketMessage`, the limits) and Task 2 (`INTERNAL.codeLive`,
  `INTERNAL.signalProofAttempt`, `INTERNAL.signalAttempt`).
- **Produces:**
  - The device upgrade accepts the query parameters `ticket` and `codeHash`.
  - Its 429 body stays `{ error: 'too many requests' }`.
  - `Signalling` keeps the NAS key in memory for 10 minutes (`keyCache: { jwk, at } | null`).

**Rules (in `index.ts` `signal()`):** when the URL carries `ticket` or `codeHash`, call
`INTERNAL.signalProofAttempt` in place of `INTERNAL.signalAttempt`, passing `CF-Connecting-IP` on to the object's
request.

**Rules (in `Signalling.fetch`, device role):**
1. **The ticket comes first,** if present. It checks out when it decodes, its `nasId` equals this object's, `now < exp`,
   `exp <= now + SIGNAL_TICKET_MAX_AHEAD_MS`, and its signature verifies with the NAS key over
   `signalTicketMessage`. Then count it in `rate:ticket:<deviceId>` (10 a minute) and go on, 429 when full.
2. **Else the code hash,** if present. When `INTERNAL.codeLive` answers 204, count it in `rate:code:<codeHash>` (10 a
   minute), 429 when full.
3. **Else, or when a proof failed:**
   - When a proof was present but failed, call `INTERNAL.signalAttempt` with the forwarded address; 429 if it refuses.
   - Then count in the shared `rate:device` window, now at 30.
4. **Only one allowance** is ever counted per upgrade.

The alarm's cleanup covers the new keys. Store each window as the existing `ATTEMPTS_KEY` log is stored, one key
per device or code.

- [ ] **Step 1: Write the failing tests** in `signalling.test.ts`, using its fake state, a registry stand-in and a
  real P-256 key for the NAS:
  - `a valid ticket connects while the shared window is full`: fill 30 bare attempts, then a ticketed upgrade gets
    101.
  - `a ticketed device gets 10 a minute`: the 11th gets 429, and another device's ticket still gets 101.
  - `a ticket for another NAS, an expired one, one too far ahead, or a forged one counts as shared and per address`:
    each makes the registry see a `signal-attempt` call and takes a shared slot.
  - `a live code hash gets its own window; an unknown one shares the pool`.
  - `ticket and codeHash together: only the ticket's window is counted when it checks out, only the code's when the
    ticket fails`.
- [ ] **Step 2: Write the failing test** in `worker.test.ts`: `an upgrade carrying a ticket is counted as a proof
  attempt, not a plain signal attempt`.
- [ ] **Step 3: Run** `npx vitest run rendezvous/src`. Expected: the new tests FAIL.
- [ ] **Step 4: Implement the rules above.**
- [ ] **Step 5: Run** `npx vitest run rendezvous/src`. Expected: PASS, the existing tests included. Update the old
  100-a-minute test to 30.
- [ ] **Step 6: Commit** `feat(rendezvous): per-device and per-code signalling allowances`.

### Task 4: The NAS checks offers and issues tickets

**Files:**
- Create: `server/src/rtc/signal-proof.ts`
- Modify: `server/src/rtc/relay.ts` (use the shared check), `server/src/rtc/signalling-client.ts` (gate offers),
  `server/src/routes/titles.ts` (`me`), `server/src/routes/pair.ts` (`redeem`), `server/src/main.ts` (wiring),
  `server/src/rendezvous-client.ts` (only if a sign helper is missing)
- Test: `server/src/rtc/signal-proof.test.ts` (create), `server/src/rtc/signalling-client.test.ts`,
  `server/src/routes/titles.test.ts`, `server/src/routes/pair.test.ts` (use the existing test files' names where
  they differ)

**Interfaces:**
- **Consumes:** Task 1 (`offerProofMessage`, `signalTicketMessage`, `encodeTicket`, `SIGNAL_TICKET_TTL_MS`).
- **Produces:**
  - `checkOfferProof(auth: Pick<Auth, 'signedBy' | 'codes'>, sid: string, proof: unknown): string | null`: the key
    `device:<id>` or `code:<hash>`, or null. Any live code counts here, not only invites.
  - `ticketIssuer(opts: { sign(m: Uint8Array<ArrayBuffer>): Promise<string>; nasId: string | null; now(): number }): (deviceId: string) => Promise<string | null>`:
    null when `nasId` is null.
  - `SignallingClient` options gain `checkOffer?: (sid: string, proof: unknown) => boolean`. An offer that fails it
    gets `{ t: 'answer', sid, error: 'unauthorized' }`, and `peers.answer` is never called.
  - `titleRoutes` and `pairRoutes` take an optional `issueTicket?: (deviceId: string) => Promise<string | null>`.
    `me` and `redeem` add `signalTicket` (string or null) to their 200 JSON.

- [ ] **Step 1: Write the failing tests:**
  - `signal-proof.test.ts`:
    - A device signature over `offerProofMessage({ sid })` gives `device:<id>`.
    - The same signature for another `sid`, a TURN proof, or no proof gives null.
    - A live plain code's hash gives `code:<hash>`; a dead code gives null.
    - `ticketIssuer` makes a ticket that `decodeTicket` reads, whose signature verifies with the NAS public key,
      and whose `exp` is `now + SIGNAL_TICKET_TTL_MS`. With `nasId` null it gives null.
  - `signalling-client.test.ts`:
    - An offer refused by `checkOffer` is answered `unauthorized` with no `sdp`, and the fake `peers.answer` is not
      called.
    - A following `candidate` for that `sid` doesn't reach `peers.candidate`.
    - An accepted offer is answered as before.
  - `titles` and `pair` route tests: `me` and `redeem` carry `signalTicket` when an issuer is given, and `null` when
    it gives null.
- [ ] **Step 2: Run** `npx vitest run server/src/rtc server/src/routes`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the interfaces above:**
  - Have `turnResponder`'s device and invite check reuse the signature check from `signal-proof.ts`. Its `ts` and its
    invite-only rule stay.
  - Remember refused sids in `SignallingClient` (a `Set`, cleared after 60 s), so their candidates are dropped.
  - In `main.ts`, build the issuer from the `rendezvous` client's `sign` and the `nasId` it already reads, and pass
    `checkOffer` (`checkOfferProof(auth, …) !== null`) to `SignallingClient`.
- [ ] **Step 4: Run** `npx vitest run server/src`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): offers need a proof; me and redeem issue signal tickets`.

### Task 5: The app sends proofs and keeps its ticket

**Files:**
- Modify: `src/ui/nas/rtc/rtc-connection.ts`, `src/ui/nas/rtc/signalling-client.ts` (the URL), `src/ui/nas/nas-client.ts`,
  `src/ui/nas/nas-store.ts`
- Test: `src/ui/nas/rtc/rtc-connection.test.ts`, `src/ui/nas/nas-client.test.ts`, the `nas-store` test file

**Interfaces:**
- **Consumes:** Task 1 (`offerProofMessage`, `decodeTicket`, `SIGNAL_TICKET_RENEW_MS`, `OfferProof`) and Task 4
  (`signalTicket` in `me` and `redeem`).
- **Produces:**
  - `NasPairing.signalTicket?: string`.
  - `RtcOpenOptions` gains `offerProof?: (sid: string) => Promise<OfferProof>` and `ticket?: string`. The offer is
    sent as `{ t: 'offer', sdp, proof }`.
  - The socket URL adds `&ticket=` when given, else `&codeHash=` when `inviteHash` is given.
  - `NasMe.signalTicket?: string | null`.

**Rules in `NasClient`:**
- **`pair`:** stores `signalTicket` from the redeem answer on the new pairing, and passes the code's hash as the
  offer proof (`{ codeHash }`) and in the URL.
- **`routeDeps`:** passes `offerProof` (the device signature over `offerProofMessage({ sid })`) and the pairing's
  ticket.
- **After any connection opens** (HTTPS or WebRTC; `startSession` succeeding is the hook): when the pairing's ticket
  is missing, or its decoded `exp - now < SIGNAL_TICKET_RENEW_MS`, ask `GET me` once.
  - If `me` returns a ticket with a later `exp`, store it with `store.put`.
  - Ask at most once per client lifetime per pairing, so a failing `me` doesn't loop.
- **Unpairing** removes the ticket with the pairing, which the existing store delete covers.

- [ ] **Step 1: Write the failing tests:**
  - `rtc-connection.test.ts`:
    - The offer message carries `proof` from `offerProof(sid)`, or `{ codeHash }` when `inviteHash` is given.
    - The URL carries `ticket` when given.
  - `nas-client.test.ts`:
    - `pair` stores the redeem's `signalTicket`.
    - After a session, a pairing without a ticket asks `me` once and stores its ticket.
    - A pairing whose ticket has more than 60 days left doesn't ask.
    - A `me` returning an older `exp` doesn't replace a stored ticket.
    - A NAS answering `signalTicket: null` leaves the pairing as it was.
- [ ] **Step 2: Run** `npx vitest run src/ui/nas`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the interfaces and rules above.**
- [ ] **Step 4: Run** `npx vitest run src/ui/nas`, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): offers carry a proof and the pairing keeps its signal ticket`.

### Task 6: End to end, and the docs

**Files:**
- Modify: `tests/e2e/nas.spec.ts`, and `tests/e2e/nas-server.ts` if the stand-in needs a hook to flood
- Modify: `docs/known-issues.md`, `docs/self-hosting.md` (Update section), `CLAUDE.md` (rendezvous and NAS
  paragraphs), `docs/superpowers/specs/2026-10-18-webrtc-people-design.md` (one line pointing to the new spec)

- [ ] **Step 1: Write the E2E test** `a flood of unproven signalling can't keep a ticketed device off WebRTC` in
  `nas.spec.ts`:
  - Chrome only.
  - Wrap it in a new `exclusively('signalling-flood', …)` lock, as `encodes.spec.ts` does, and take that lock in the
    existing WebRTC tests too.
  - The test pairs over WebRTC, which now gets a ticket from the redeem.
  - It then sends 30 bare upgrades to the stand-in's `/signal/device?nasId=`, through Node `fetch` or `ws`, from the
    test process.
  - Then it reloads, plays disc1 over WebRTC, and asserts the WebRTC data channel received bytes (`window.__rtcBytes`).
- [ ] **Step 2: Run** `npx playwright test tests/e2e/nas.spec.ts --project=chromium`. Expected: every test passes,
  the new one included.
- [ ] **Step 3: Run** `npx playwright test tests/e2e/nas.spec.ts` (all projects). Expected: PASS.
- [ ] **Step 4: Update the docs:**
  - **Remove** the known-issues entries "A hostile client can lock a NAS's devices out…" and "The answer SDP shows
    the NAS's addresses…".
  - **Add** the two entries the spec's section 7 lists.
  - **Write** the deploy order (Worker and site, then NAS) in the known-issues deploy-order entry and in
    `docs/self-hosting.md`'s Update section.
  - **CLAUDE.md:** describe tickets and offer proofs in one or two sentences each, where the rendezvous Worker and
    the NAS's `dispatch.ts`/`signalling-client.ts` are described.
- [ ] **Step 5: Run** `npx vitest run tests/documentation.test.ts` and `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `test(e2e): a signalling flood can't lock out a ticketed device; docs`.
