# Phase 2 — Partition-Key Rewrap Handshake (spec)

**Date:** 2026-07-16 · GenitriX + flaxscrip · **Status:** joint spec (Hearthold ⇄ Sevenfold Signet) ·
**Reviewers' bar:** Fable's three acceptance criteria (§4) are the acceptance criteria.

The rewrap handshake is how a Warden — which by construction **cannot read a member's private partition at
rest** (Phase 1, `payload.ts`) — transiently regains the ability to run local RAG over that member's OWN
content during that member's authenticated session. It is the "read-guest" half of write-host/read-guest.

**It is the new trust boundary.** For the duration of a session the Warden holds a key that opens the
session member's private content. That is necessary (the local model must see plaintext to answer the
member's own query) and is exactly the residual the threat model (§4a) names. So this spec pins its
*authorization*, not just its mechanics.

---

## 1. The primitives it builds on (already shipped, Phase 1)

`packages/core/src/payload.ts` (ECDH-ES, bare ciphertext, zero registry footprint):
- `generatePartitionKeypair(cipher) → {publicJwk, privateJwk}`
- `sealToKey(cipher, pub, plaintext) → ciphertext` — the Warden seals private content to `partitionPub`.
- `openWithKey(cipher, priv, ciphertext) → plaintext` — decrypt with a held partition key.
- `wrapKeyForDid(handle, did, priv) → wrapped` — wrap the partition private key to a DID's key.
- `unwrapKey(handle, wrapped) → priv` — unwrap with the CURRENT id's key (i.e. only at the member's Signet).

`PartitionRecord` (`partition-store.ts`) already carries `partitionPub` (Warden seals with it) and
`wrappedKey` (the partition private key wrapped to the member — the Warden holds it but cannot open it).

Login/session reuse `KbService`'s model (`kb.ts`: `startLogin`/`completeLogin`/`serveWithSession`,
`keymaster.createChallenge`/`verifyResponse`) and DIDComm (`packages/core/src/transport.ts`,
`transport.request`), routed per-member exactly as the KB action-approver already is (`makeDidcommActionApprover`).

---

## 2. The two DIDComm messages (new)

**`hearthold/partition-rewrap-request`** — Warden → the **session member's** Signet:
```ts
{
  type: 'hearthold/partition-rewrap-request',
  version: PROTOCOL_VERSION,
  sessionId: string,          // binds the rewrapped keys to this one session (§4.3)
  wardenSessionPub: CipherPublicJwk,  // the Warden's EPHEMERAL, per-session public key
  partitions: { partitionId: string; wrapped: string }[],  // ONLY partitions this member owns (§4.1)
  nonce: string,              // Warden-issued, single-use (replay-guard, mirrors KbService.challenge)
}
```

**`hearthold/partition-rewrap-response`** — the member's Signet → Warden:
```ts
{
  type: 'hearthold/partition-rewrap-response',
  version: PROTOCOL_VERSION,
  sessionId: string,
  approved: boolean,          // false = member declined / proof-of-human failed
  rewrapped?: { partitionId: string; rewrapped: string }[],  // present iff approved
  reason?: string,
}
```

---

## 3. The flow

1. **Login** (existing): member proves DID control (challenge/response) → Warden mints a session
   (`ControlSessionStore`, token, absolute expiry). `sessionDid = the member`.
2. **Warden prepares** the rewrap: resolve the session member's partitions (`PartitionStore` by owner ==
   sessionDid) → collect `{partitionId, wrapped}`. Generate an **ephemeral** session keypair
   (`generatePartitionKeypair`) — held in memory, never written to disk.
3. **Warden → Signet**: send `partition-rewrap-request` to `sessionDid`'s Signet (per-member routing, §4.2),
   carrying `wardenSessionPub` + the wrapped keys + `sessionId` + `nonce`.
4. **Signet (member's device — Sevenfold implements)**:
   - **Require the member's proof-of-human** (Signet PIN / approval) — the member authorizes the rewrap,
     never the governor (§4.1).
   - For each `{partitionId, wrapped}`: `priv = unwrapKey(memberHandle, wrapped)` (member's own key);
     `rewrapped = sealToKey(cipher, wardenSessionPub, JSON.stringify(priv))`.
   - Respond `{approved:true, rewrapped}` — or `{approved:false, reason}` on decline/PIN-fail.
5. **Warden ingests**: for each `rewrapped`: `priv = JSON.parse(openWithKey(cipher, wardenSessionPriv, rewrapped))`;
   store in the in-memory **SessionKeyStore** under `(sessionId → partitionId → priv)`. Discard
   `wardenSessionPriv` after ingest (it has done its one job).
6. **Recall during the session**: when the member queries, for each private partition in their visible set
   the Warden unseals item ciphertext with the session key: `openWithKey(cipher, sessionPriv, item.ciphertext)`.
   No session key (rewrap not done / expired / zeroized) → private items are skipped as ciphertext — a
   graceful "log in again to search your private notes," never a leak.
7. **Session end** (logout / absolute expiry / member removal): `SessionKeyStore.zeroize(sessionId)` —
   overwrite + drop the keys **immediately** (§4.3).

---

## 4. Acceptance criteria (Fable, 2026-07-16 — these gate Phase 2)

**4.1 — The rewrap is authorized, ephemeral, and scoped.** Three invariants, each e2e'd:
- **Ephemeral:** the Warden session keypair and every rewrapped `partitionPriv` live in memory only, are
  never persisted (assert: no session-key file appears on disk), and are zeroized at session end.
- **Member-authorized:** the Signet rewraps only after the **member's own proof-of-human**. A rewrap
  request that arrives without a member approval is refused — the governor cannot obtain the key.
- **Scoped:** the request carries wrapped keys **only for partitions the session member owns**; the Signet
  rewraps only its own; the Warden holds session keys only for that member's partitions. A partition owned
  by another member is never in the request and never rewrapped.

**4.2 — Per-member Signet routing.** The `partition-rewrap-request` transport target is the **session
member's DID**, resolved from the session — **never `config.sovereignDid`**. This reuses the Phase-2
per-member approver refactor (the same one the face/forge fix needs); the rewrap must not default to the
configured Sovereign any more than the face fix may.

**4.3 — Session lifecycle binds the key.** `logout`, absolute-expiry, and revoke-on-removal
(Addition 1) must **zeroize the rewrapped session key**. A removed member's live session loses its token
**and** its ability to decrypt **at the same instant — not at TTL**. Removal → `sessions.revokeAllFor(did)`
→ `SessionKeyStore.zeroize(sessionId)` in the same step.

---

## 5. New Warden-side surface (Hearthold implements)

- `SessionKeyStore` (in-memory only): `put(sessionId, partitionId, priv)`, `get(sessionId, partitionId)`,
  `zeroize(sessionId)`. No file backing, ever. Bound 1:1 to `ControlSessionStore` lifetime.
- Rewrap orchestration in `runWardenControl` (post-login): prepare → send → ingest. Uses the per-member
  approver target (§4.2) and the `stepUpTimeoutMs` config (Phase 0) for the round-trip.
- Recall unseal path (`RecallService` content resolver): try the session key for a private partition;
  fall back to skip-as-ciphertext.
- Wire `SessionKeyStore.zeroize` into logout / expiry / `revokeAllFor` (§4.3).

## 6. Signet-side surface (Sevenfold implements)

- A responder for `hearthold/partition-rewrap-request` in the Signet app: proof-of-human gate → `unwrapKey`
  per partition → `sealToKey(wardenSessionPub, priv)` → `partition-rewrap-response`. Reuses the member
  wallet's own key (`fetchKeyPair`) exactly as `unwrapKey` already does. Decline path returns
  `{approved:false}`.

## 7. e2e — `scripts/e2e-partition-rewrap.ts` (the §4 criteria as tests)

- member logs in → rewrap approved (PIN) → Warden RAGs the member's OWN private content → **PASS**.
- rewrap request contains only the session member's partitions; another member's partition is absent → scoped.
- a rewrap attempt without the member's proof-of-human (governor-initiated) → refused; no key obtained.
- routing: the request targets the session member's Signet, not `config.sovereignDid`.
- logout → `zeroize` → subsequent private recall returns ciphertext-only (no plaintext).
- member removal on a LIVE session → key zeroized immediately; private recall fails at once, not at TTL.
- no session-key file is ever written (at-rest invariant).

---

**Open for the joint session:** message field names (above are proposed), whether to batch all partitions
in one request vs one per partition, and the Signet UX for the proof-of-human prompt ("unlock your private
notes for this session"). None affect the §4 invariants — those are fixed.
