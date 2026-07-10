# Hearthold — System Architecture Report

**For:** David (Archon architect) · **Date:** 2026-06-26 · **Archon:** v0.10.0 / `@didcid` 0.6.0
**Repo:** `~/Projects/personal/hearthold` · **Status:** witness→store loop working & tested live;
prove/disclose flow and the Sovereign control plane designed, in build.

This report summarizes purpose, use cases in both directions, the external standards we designed
against, how we use Archon's primitives, the current components, and concrete feedback from
building on v0.10.0. Detailed specs live in the `docs/` files referenced throughout.

---

## 1. Purpose

A Sovereign First Person generates a growing trove of personal history and artefacts. Hearthold
gives them:

- a **home-bound custodian agent** ("Warden") that holds and protects that private repository, and
- a **companion agent** ("Emissary") that witnesses local-only context and, when needed, requests
  **verifiable evidence** of the person's history to present to third parties —
  proving a fact *without disclosing the data behind it*.

The design principle (from prior Privacy Is Value Model work, stated plainly): **separate the
custodian of data from the agent that acts in the world**, so neither alone reconstructs the whole.
The product goal is to let a person make practical, privacy-preserving use of their own history.

---

## 2. Actors (three `did:cid` identities)

| Identity | App | Role | Runs |
|---|---|---|---|
| **Warden** | Warden service | Custodian & enforcer. Local-only AI: classifies/serves on-device. Holds the vault; issues evidence. | Always-on, home-bound |
| **Emissary** | Emissary CLI/app | Envoy. Emissaries local context, submits it home; requests + presents evidence. Holds a scoped, revocable delegation. | Mobile (CLI now; browser/phone later) |
| **Sovereign** | Signet (2nd-factor authenticator) | The principal. Signs the Warden's access-control policy; co-signs sensitive disclosures with a proof-of-human assertion. | Separate device |

Each is an independent Archon identity with its own Keymaster wallet. The **Warden enforces**, the
**Sovereign authorizes the rules** (control plane vs. data plane), and the **Emissary acts** under a
delegation the Warden issued and can revoke.

---

## 3. Use cases — both directions

### 3a. Inbound: witness → store (working, tested)
1. The Emissary captures a local-only observation (e.g. a location fix, an activity, browsing
   context) it alone can see.
2. It **seals the payload to the Warden's key** and submits it.
3. The Warden **decrypts locally**, classifies sensitivity with a local model, and **stores the
   still-sealed artefact** with a sensitivity label, returning a receipt.

The Emissary is therefore a *witness to the person's life* that contributes encrypted history to the
vault — the repository grows from the edge, but the edge keeps nothing.

### 3b. Outbound: prove → disclose (designed; `/evidence` is a stub today)
1. The Emissary asks the Warden to prove a claim ("resided in FR during 2026-H1") for some purpose.
2. If the supporting data is sensitive, the Warden requires **step-up** — up to a Sovereign
   co-signature gated by a proof-of-human check on the Signet.
3. The Warden returns a signed **evidence graph**: the derived fact plus a hash-anchored provenance
   subgraph (see §7). The Emissary presents it; a third party verifies it against issuer DIDs.

### 3c. Control plane: govern (designed — milestone S)
The Sovereign **signs the Warden's access-control configuration** (the Warden verifies it on load
and fails safe if unsigned), bounds Emissary enrollment, and gates admin operations. This makes the
Warden a *provable executor of the Sovereign's directives*, not a self-authorizing actor.

---

## 4. Security & trust model

Two independent ordinal scales plus a disclosure transform (full spec: `docs/security-model.md`).

- **Sensitivity** (per artefact): `PUBLIC < LOW < MEDIUM < HIGH < SEALED`. Anything unclassified
  defaults to `SEALED` (fail-safe quarantine); the local classifier may *relax* it, never silently
  raise-then-lower.
- **Authorization tier** (per request): `STANDING < CHALLENGE < HUMAN < MULTIFACTOR`. A request is
  satisfied only when its tier **clears** the artefact's sensitivity.
- **Disclosure mode** (what leaves): `ATTESTATION` (default) · `SELECTIVE` · `REDACTED` · `FULL` ·
  `PREDICATE` (optional).
- **Step-up** is dynamic per request: routine reads ride the baseline tier; sensitive reads escalate
  (fresh challenge / PIN / passphrase / Sovereign co-sign). PIN/passphrase exist to address
  *possession ≠ presence* — they re-bind an action to the human, not just the device.
- **Proof-of-human level** (planned, via the Signet): an assurance axis (analogous to NIST AAL) the
  Sovereign-signed policy maps onto sensitivity — e.g. `MEDIUM`→device unlock, `HIGH`→biometric,
  `SEALED`→face-liveness — run on-device, with only a hash/attestation retained.
- **Principle — never a score.** Hearthold never computes or emits a reputation/trust scalar. Output
  is always a verifiable, decomposable evidence graph the relying party evaluates itself.

### Threat model summary
| Adversary | Mitigation |
|---|---|
| Compromised Emissary device | Scoped, revocable delegation; holds no vault data; sensitive disclosures require Sovereign co-sign + proof-of-human. |
| Compromised Warden host | Cannot change policy (Sovereign-signed), enroll access, or approve `SEALED`. Honest limit: a rooted, running Warden can still read what it can currently decrypt — addressed by the planned *SEALED-to-Sovereign* encryption (Warden can't open the crown jewels) or a TEE. |
| Network / relay / registry observer | DIDComm writes nothing to the registry → no sender↔recipient edges. The relay (our own node) sees recipient DID + timing only; content is opaque. |
| Third-party verifier (honest-but-curious) | Receives issuer-attested signed evidence + selectively disclosed provenance — the fact without the underlying data. |
| Replay / token theft | Single-use `txn`, short validity, sender-constraint from DIDComm authcrypt. |

---

## 5. Standards & external designs considered

- **IETF `draft-rosomakho-oauth-txn-challenge-00` (OAuth Transaction Authorization Challenge).** Its
  thesis — *a valid credential ≠ approval of a concrete transaction* — matches our session-vs-step-up
  split. We adopted five requirements (R1–R5) from it: per-request `txn` binding + single-use;
  Warden-authored (not agent-summarized) approval description (its §7.7); sender constraint;
  explicit decline + minimization; and a Sovereign control plane that makes its "approving party"
  cryptographic. Full mapping: `docs/standards-alignment.md`.
- **W3C Verifiable Credentials 1.1.** The evidence graph is a Keymaster-issued VC; provenance rides
  the standard `evidence` field, single-use rides `termsOfUse`, revocation rides `credentialStatus`.
- **SD-JWT-VC (selective disclosure).** Field-level disclosure uses salted-digest commitments /
  Merkle membership — reveal a leaf + path against a signed root.
- **DIDComm v2 (DIF).** The Emissary↔Warden transport (§6).
- **Issuer-attested disclosure (why not ZK).** Because the Warden is the *issuer* of derived facts,
  the verifier trusts the issuer signature as with any credential; privacy comes from derivation +
  selective disclosure. ZK predicate proofs are optional and off the critical path — relevant only
  for proving facts about data the Warden does not issue.

---

## 6. Archon integration (how we use the stack)

Hearthold is a pure consumer of Archon primitives; it adds no new crypto. Notable choices:

- **Keymaster as a library, wallet-per-actor.** Each agent instantiates `Keymaster` with its own
  `WalletJson` + `CipherNode`, connected to the node via `GatekeeperClient`. We deliberately do
  **not** use the node's shared keymaster service, so each actor custodies its own wallet and the
  Emissary identity can migrate to other devices via `backupId`/`recoverId`.
- **Identities:** `createId` / `listIds` / `setCurrentId` / `resolveDID`. Registry: `hyperswarm`.
- **Delegation & attestation credentials:** `createSchema`/`getSchema` (a registered
  `HearthholdDelegation` schema), `bindCredential` → `issueCredential` → `acceptCredential`, and
  `revokeCredential`. The Warden is the issuer; the Emissary accepts; revocation de-authorizes
  instantly.
- **Challenge/response — repurposed.** Originally our auth handshake (`createChallenge` /
  `createResponse` / `verifyResponse`). Under DIDComm authcrypt, DID authentication is free, so we
  **move challenge/response up to the authorization layer**: the Warden puts the *purpose*
  (`txn`, claim, window) in an (extensible) challenge, and the Sovereign/Emissary's **signed
  response** becomes a dated, DID-attributable approval — the `approval` node of an evidence graph.
- **In-band payload sealing — zero registry footprint.** Observations are sealed with the low-level
  `CipherNode.encryptMessage(recipientPubJwk, plaintext)` (resolved via `getPublicKeyJwk`) and
  carried in the message body — *not* `encryptJSON` (which anchors an asset). The Warden unseals
  with its current-id keypair (`fetchKeyPair`). Nothing about the payload touches a registry.
- **Transport — DIDComm v2** (`publishDidComm` / `sendDidComm` / `receiveDidComm`), through
  Drawbridge `:4222`.
- **Gatekeeper/Drawbridge:** resolution + the public API + the DIDComm mount, all fronted by
  Drawbridge.

### Transport detail (DIDComm v2)
- **No registry footprint / no relationship leak.** The send path writes nothing to the registry
  (verified against the send code) — unlike dmail's notice, which is why we abandoned dmail. The
  only observer of the messaging graph is the relay, which for us is the Sovereign's own node.
- **authcrypt = who, signed = evidence.** Default authcrypt authenticates the sender DID to the
  recipient but is repudiable; anything that must travel as portable evidence is explicitly signed.
- **Async store-and-forward.** Poll `receiveDidComm`; request/response correlates via `thid`. This
  also gives **offline witnessing** for free (submit while the Warden is offline).
- **Auth simplification.** authcrypt removes the need for a challenge merely to prove DID control;
  the Warden authenticates the sender DID and checks it issued that DID an unrevoked delegation.

---

## 7. The evidence graph (the proof object)

Full spec + worked example: `docs/evidence-graph.md`. In brief, the object the Warden returns is a
**W3C VC issued by the Warden** whose:

- `credentialSubject` is the **derived claim** (about the Sovereign);
- `evidence[]` holds **provenance** — artefact groups summarized as `{kind, count, window,
  witnessedBy, commitment.merkleRoot}`, committing to a set of underlying facts without revealing
  them;
- `approval` (for sensitive claims) is the **Sovereign's signed response** to the purpose-bearing
  challenge, plus a proof-of-human assertion;
- `termsOfUse` carries single-use `txn`; `credentialStatus` carries revocation; `proof` is the
  Warden signature.

**Selective disclosure** is hash-and-signature based: default `ATTESTATION` reveals the fact + a
root-committed summary; `SELECTIVE` reveals chosen leaves as `{value, salt, merklePath}` checked
against the signed Merkle root. A verifier runs: signature/issuer → freshness/single-use →
revocation → approval (if present) → provenance → trust decision.

---

## 8. Current components & status

Monorepo (TypeScript, npm workspaces; builds clean):

| Package / path | Contents | Status |
|---|---|---|
| `packages/core` | config, security model, protocol, identity, credentials, schema, auth (challenge/response), payload (in-band seal), http + WardenClient | built |
| `packages/warden` | HTTP service, submission service, classifier seam, vault store | built |
| `packages/emissary` | Companion CLI over WardenClient | built |
| `scripts/e2e-delegation.ts` | delegation issue/accept + challenge/response | **PASS** live |
| `scripts/e2e-submission.ts` | witness→store→receipt over HTTP | **PASS** live |
| `scripts/didcomm-smoke.ts` | DIDComm v2 publish→send→poll→reply-by-`thid` | **PASS** live |

**Built & tested:** identity provisioning; delegation handshake; in-band sealed submission; classify
(quarantine stub) + store + receipt; HTTP/Tailscale transport; package upgrade to v0.10.0 (e2e
re-verified); DIDComm v2 round-trip validated.

**Designed / in build:**
- **Transport → DIDComm v2** — a `Transport` seam (HTTP retained as a LAN option); drop the
  session/challenge handshake; `submit` = send-then-poll-by-`thid`.
- **Local-model classifier** — replace the `QuarantineClassifier` stub with `qwen3:8b` +
  `nomic-embed-text` index (today everything quarantines to `SEALED`).
- **Evidence/`prove` flow** — `/evidence` is a stub returning *denied*; implement the evidence graph
  + step-up (R1–R5).
- **Sovereign / Signet control plane** — signed policy + co-signed approvals + proof-of-human.
- **Later:** NAS/filesystem ingestion; browser & mobile Emissary; multi-device fan-out.

---

## 9. Implementation feedback for Archon (v0.10.0)

Concrete rough edges we hit building on the new release — offered as a fellow implementer:

1. **`publishDidComm(undefined, …)` silently publishes key-only** (key-agreement key but **no**
   `DIDCommMessaging` service block) when the keymaster's node URL is the Drawbridge root — the
   endpoint auto-discovery mis-derives its URL. It returns `true`, so the failure is invisible until
   a later send throws *"recipient has no DIDCommMessaging endpoint."* Our workaround: fetch
   `GET <node>/api/v1/didcomm-endpoint` and pass it to `publishDidComm` explicitly. Worth either
   fixing discovery for the Drawbridge-root case or surfacing a warning.
2. **`ARCHON_DIDCOMM_ALLOW_PRIVATE_EGRESS=true` is required** for loopback/LAN delivery (relay and
   recipient on the same node), else `/deliver` returns `400`. Documented, but easy to miss for a
   single-node dev/test setup; a clearer error than bare `400` would help.
3. **Capabilities live on Drawbridge `:4222`**, not the Gatekeeper `:4224` (`404` there). Minor
   discoverability nit when wiring a client.
4. **Wallet double-init footgun.** `listIds()` auto-creates a wallet on first use; calling
   `newWallet()` *after* that (a natural-looking idempotent guard) desyncs `seed` from `enc` and
   produces a cross-process *"aes/gcm: invalid ghash tag"* that reads like a wrong passphrase. A
   note in the wallet docs (or making `newWallet` overwrite-guard idempotent) would save time.
5. **authcrypt `metadata.sender`** comes back as `<did>#key-agreement-1`; consumers must strip the
   fragment to compare DIDs. Minor, but undocumented.

These cost us debugging time but nothing is blocking — the round-trip works once they're known.

---

## 10. Open questions

- **SEALED-to-Sovereign encryption** (so the Warden cannot open its most sensitive holdings): the
  Warden classifies *after* unsealing, so it briefly sees plaintext before it could re-seal to the
  Sovereign. Options: Emissary pre-tags sensitive kinds; the Signet ingests the most sensitive sources
  directly; or accept brief Warden sight in v1.
- **Evidence-graph commitments:** committing Merkle roots over derived-claim digests vs. artefact
  ciphertext ids (we lean toward both as two anchors).
- **Transport policy:** DIDComm v2 as default with HTTP/Tailscale retained as a LAN option, vs.
  DIDComm only.
- **Sovereign recovery** if the Signet device is lost (social recovery?).

---

## Appendix — document map

| Doc | Contents |
|---|---|
| `architecture.md` | components, identities, transport, data flow, module map |
| `security-model.md` | sensitivity × authorization tiers × disclosure modes, step-up |
| `evidence-graph.md` | the proof object: exact shape, hashing, verification |
| `sovereign-signet.md` | the Sovereign DID & Signet app, proof-of-human aggregator |
| `standards-alignment.md` | mapping to the IETF OAuth transaction-challenge draft (R1–R5) |
| `manual-testing.md` | how to launch & exercise what's built |
| `PLAN.md` | phased plan & milestones |
