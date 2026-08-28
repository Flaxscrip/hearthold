# Blazon disclosure over DIDComm — reaching a foreign verifier

*How a Sovereign's Blazon fact reaches a party **outside Archon** as a verifiable credential, once
Archon's credential-exchange-over-DIDComm verbs publish — preserving every Hearthold invariant.*

> **Status:** IMPLEMENTED (2026-08). The delivery verbs (`sendCredentialDidComm` / `acceptCredentialDidComm`,
> issue-credential 3.0) shipped in **`@didcid/keymaster` 0.6.3**. The core primitive is
> `discloseToForeignVerifier` (`core/credential-delivery.ts`) — a gated mint-and-push — proven end-to-end by
> `npm run e2e:foreign-credential` against the live node. Still a *publish* transport only: the interactive
> *prove* path stays Hearthold's own challenge/response (present-proof 3.0 remains deferred).

## The problem

The **Blazon** (`docs/two-products-one-core.md`) is a Sovereign's self-owned, AI-queryable public
profile — two verbs, **publish** (the Blazon) and **prove** (the capsule). Today a Blazon field is
readable by **KB members** via `get-doc` (`warden/kb.ts`). A party **outside the KB — or outside Archon
entirely** — has no way to read it: a `did:cid` credential *reference* is useless to someone who can't
resolve-and-decrypt it.

Archon's #919 closes exactly that gap. `sendCredentialDidComm` carries the **signed credential itself**
(not a DID reference) inside an `issue-credential/3.0` DIDComm message — David's own note: *"the only way
to reach a subject outside the network."* #936 makes the receiving inbox **recognize** it (labels it
"Credential", offers Accept). That is the transport a Blazon *publish* has been missing.

## The mapping — publish rides the push, prove stays ours

The Blazon's two verbs map onto two mechanisms, and the split is clean:

| Blazon verb | What it is | Delivery |
|---|---|---|
| **publish** | hand out a signed, self-owned fact | **`sendCredentialDidComm`** — a *push* of a signed VC that reaches a foreign DID |
| **prove** | interactive, capability-gated, single-use disclosure | **Hearthold challenge/response** — unchanged (present-proof 3.0 is deferred; our flow carries freshness + holder-binding + step-up a push does not) |

`sendCredentialDidComm` is the *publish* transport — **not** a replacement for *prove*.

## The flow — a Blazon fact → a foreign verifier (Bob, non-Archon)

```
Alice's Warden                                             Bob (foreign / non-Archon)
──────────────                                            ──────────────────────────
1. Blazon fact  (KB shared doc / put-doc'd profile field)
      │
2. decideRelease()  ── crosses the release ladder even to publish
      │                 (PUBLIC/LOW → no step-up; sensitive → Sovereign co-sign)
      ▼
3. mint issuer-attested VC
      claims  = the disclosed Blazon field(s)
      issuer  = Warden (Warden-signed answer)   [+ Sovereign co-sign if sensitive]
      subject = Blazon DID (public) OR pairwise DID (scoped)
      + validUntil (ephemeral)  + credentialStatus (StatusList → revocable)
      │
4. sendCredentialDidComm(credentialDid, bobDid)
      → packs the SIGNED CREDENTIAL ITSELF into an issue-credential/3.0
        DIDComm message  ───────────────────────────────────────────────►  5. inbox recognizes it as
                                                                                "Credential" (#936)
                                                                             6. reads the signed VC,
                                                                                verifies the ISSUER's
                                                                                signature (the Warden's)
                                                                             7. checks validUntil + status
```

Bob never has to be on Archon to **receive and read** it (the credential travels in full). The one thing
he still needs is to **resolve the issuer's DID** for the Warden's verification key — via a universal
resolver / public gatekeeper (that's what `uni-resolver-driver-did-cid` exists for).

## Invariants preserved

- **Issuer-attested, never our word.** Bob trusts the Warden's signature (and the Sovereign's co-sign on
  sensitive fields), never a gateway or Alice's assertion — the core rule, unchanged.
- **`decideRelease()` still gates it.** A publish crosses the same release path; no surface can emit a
  Blazon VC without passing it. Sensitive Blazon fields force a Sovereign co-sign even on the publish path.
- **No confused deputy — the subtle bit.** Choosing Bob as recipient is fine *here* because it is the
  Sovereign disclosing **her own public data by her own act**, not a delegated agent forging-for-a-peer.
  The "audience is designated by the capability, never chosen at invoke time" guard applies to the
  **capsule/prove** path (capability invocation), not to the owner publishing her own Blazon.
- **Pairwise vs stable is the one real policy choice.** A truly *public* Blazon wants a **stable**
  identity (the point is to be found + queried) — a deliberate **Ruleset-signed stable-DID exception** to
  the pairwise default. A **scoped** disclosure (prove a fact without exposing your public face) stays
  **pairwise** (`core/pairwise.ts`, Alice-for-Bob). The Warden picks per the active Ruleset.

## Honest caveats

- **It's a push/snapshot, not an interactive proof.** No challenge, no freshness ceremony over DIDComm
  (present-proof is deferred). Currency comes from a short `validUntil` + a `credentialStatus` Bob
  re-checks — not from a live handshake.
- **Verification needs the issuer resolvable by Bob.** Delivery to a foreign DID is solved; *verification*
  still requires Bob to resolve the Warden's `did:cid`. If he can't, he can **read** the credential but
  not **verify** it — state that plainly to a relying party.

## Where it plugs in (and the gate)

- **Mint:** the Warden already mints issuer-attested VCs (`core/evidence.ts` / Archon `issueCredential`);
  the Blazon publish surface (`put-doc`/`get-doc`, `warden/kb.ts`) gains a **disclose-to-foreign-DID**
  verb that mints the pairwise-or-stable VC with `validUntil` + a StatusList `credentialStatus`.
- **Deliver:** `core/credential-delivery.ts` (alongside the `did:cid` card-pass) now carries the **foreign
  path** — `discloseToForeignVerifier`, which calls `keymaster.sendCredentialDidComm`.
- **Gate:** the release ladder is enforced INSIDE `discloseToForeignVerifier` — it calls `decideRelease`
  first and mints/sends nothing on a deny, so no surface can emit a foreign VC without crossing the ladder
  (verified by `e2e:foreign-credential`, the deny-by-default case).

## Why it fits

The Blazon's *publish* verb was always "hand someone a signed fact"; `sendCredentialDidComm` is exactly
"hand a foreign party a signed VC." It is the **interop route for the Blazon** (and any Hearthold-issued
evidence) to reach a **non-Archon verifier** — the piece our own wire protocol doesn't provide — and it
strengthens the two-products-one-core case without touching the *prove* path, which stays Hearthold's own
challenge/response until present-proof 3.0 exists.
