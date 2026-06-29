# Hearthold — The Sovereign DID & the Signet App

Hearthold introduces a **third Archon identity**: the **Sovereign** — the human principal, made
cryptographic. It is held by a dedicated **Signet** app (a 2nd-factor authenticator). This splits a
**control plane** (the Sovereign authorizes the *rules*) from the **data/enforcement plane** (the
Warden *executes signed directives*), and completes the PVM triad:

| PVM role | Hearthold identity | App | Posture |
|---|---|---|---|
| First Person | **Sovereign** | **Signet** | the principal; signs directives & approves the sensitive |
| Swordsman (protect) | **Warden** | Warden | always-on custodian; enforces signed policy |
| Mage (project) | **Witness** | Witness | mobile envoy; witnesses + requests evidence |

> "The Signet seals the Warden's directives." A signet ring is the historical instrument by which a
> sovereign authorizes a document — here, the Warden's access-control configuration and its most
> sensitive disclosures.

## Why: the Warden stops being its own authority

Today the Warden is both the source and the enforcer of authority — policy lives in its code, it
issues delegations, it decides disclosures, all rooted in its own wallet. A compromise of the
Warden host is therefore total. The Sovereign DID makes the Warden an **executor of signed
directives**: it enforces, but it does not author authority.

## What the Sovereign signs / governs

1. **The access-control configuration.** The clearance map, tier ladder, and step-up rules become a
   **document the Sovereign signs**. The Warden verifies the signature on startup and on every
   change; an unsigned or wrong-key config is refused, failing safe to "everything `SEALED`, no
   disclosures." The Warden thus *provably runs the Sovereign's directives* — tamper-evident.
2. **Witness enrollment bounds.** The Warden may issue `HearthholdDelegation` VCs only within
   Sovereign-signed limits, so a compromised Warden cannot enroll an attacker's Witness.
3. **Admin operations.** NAS/connector registration, classifier-model changes, key rotation, vault
   export/backup, and Warden revocation each require a Sovereign signature.
4. **Approving party for HIGH/SEALED.** Sensitive disclosures require a **Sovereign co-signature**
   from the Signet over `(txn, reason, attestationPreview)` — this *is* the `MULTIFACTOR` tier and
   the realization of the IETF draft's "approving party" (see [standards-alignment.md](standards-alignment.md), R2/R5).

## The Signet as a proof-of-human aggregator

The Signet gates *use* of the Sovereign key behind pluggable **proof-of-human (PoH)** checks and
attests the method used into its signature — turning a co-signature from binary into graded.

- **Adaptor pattern.** `HumanProofProvider`s: device PIN/passphrase, platform biometric
  (FaceID / TouchID / Android BiometricPrompt), camera **face-liveness recording**, FIDO2
  user-presence, and (future) proof-of-personhood protocols. Each yields a
  `HumanPresenceAssertion { method, level, timestamp, evidenceRef? }`.
- **Bound into the approval.** The Signet runs the required provider(s), then signs the PoH
  assertion alongside `(txn, reason, attestationPreview)`. The Warden verifies the Sovereign
  signature *and* that the asserted PoH **meets policy**.
- **A new orthogonal axis: PoH assurance level** (cf. NIST AAL). The Sovereign-signed policy maps
  it onto the sensitivity ladder — e.g. `MEDIUM`→device-unlock, `HIGH`→biometric,
  `SEALED`→face-liveness. The authz *tier* answers "who/what is authorized"; the PoH *level*
  answers "how sure are we the right human is present **now**."
- **Privacy guardrail.** PoH runs **on-device in the Signet**; biometric templates and raw
  recordings never leave it. By default only a **hash/attestation** is bound into the signature;
  raw evidence (e.g. a face video) is retained only if the Sovereign explicitly wants it — in which
  case it is just another `SEALED` artefact in their 7th Capital. Local-first applies to PoH too.

This is the deepest answer to **presence ≠ person**: a PIN proves a secret; graded on-device
liveness proves *a live, verified human now*, with the strength explicit and policy-governed.

## Placement (decided)

- **Dev:** a third wallet on the same machine to build the signing/verification mechanics.
- **End-state:** a separate **Signet** app on a distinct device — a true possession factor.
  Migration reuses Archon `backupId`/`recoverId` and the shared `core`, exactly like the Witness's
  path to phone/browser.
- **Future:** cold/offline Sovereign root for config signing + a warm key on the Signet for routine
  approvals.

## Scope for v1 (decided)

- ✅ **Sovereign-signed policy** (Warden verifies, fails safe) + **co-signed HIGH/SEALED approvals**
  (= `MULTIFACTOR`).
- ⏸ **SEALED-to-Sovereign encryption** deferred (encrypt SEALED artefacts to the Sovereign so the
  Warden literally cannot open them). Strongest guarantee; raises an ingestion question — who
  classifies before sealing — see *Open questions*.

## Threat-model delta (and honest limits)

- **Gains:** a compromised Warden host can no longer change the rules, weaken policy silently,
  enroll new access, or approve HIGH/SEALED disclosures (those need the Sovereign key + PoH on a
  separate device). Policy tampering is evident.
- **Limit:** a *rooted, running* Warden with its data keys can still exfiltrate what it can
  currently decrypt. Signed config does not stop that — it stops *authority expansion* and *policy
  weakening*. Removing crown-jewel data from the Warden's reach needs **SEALED-to-Sovereign**
  (deferred) or a TEE (later).

## Protocol / code deltas (for when we build it)

- **Policy doc + signature.** Lift the clearance map / tier ladder out of `security.ts` into a
  `SovereignPolicy` document; add `verifyPolicy(policy, sovereignDid)` the Warden runs on load.
- **Co-sign in the evidence flow.** `EvidenceResponse{step-up-required}` for HIGH/SEALED demands a
  Sovereign co-signature; add a Signet endpoint/flow that produces `{ sovereignSig, humanProof }`
  bound to the `txn`.
- **PoH types.** `HumanPresenceAssertion { method, level, timestamp, evidenceRef? }`; `PoHLevel`
  enum; `HumanProofProvider` interface in a new `signet` package.
- **Signet app.** New front-end on `core`, holding the Sovereign wallet; admin signing + approval
  co-signing surfaces.

## Status — the first Signet (built)

The proof-of-human **approval gate** is built and tested. Presenting a proof is the external
disclosure, so the Sovereign's serve handler no longer auto-presents: an `ApprovalGate`
(`packages/sovereign/src/signet.ts`) must return a `HumanPresenceAssertion` first. The first
provider is a **PIN** (assurance level 1) — `PromptGate` reads it interactively on `sovereign
serve`; `PinGate` is the headless/test variant. The assertion (`{ method, level, timestamp }`)
rides the `proof-presentation` back to the verifier. Tested live (`e2e:prove-didcomm`): a correct
PIN presents + carries the proof-of-human; a wrong PIN declines and presents nothing.

Next on the Signet: stronger providers behind the same gate (biometric, camera face-liveness),
binding the assertion cryptographically, scaling the required level with sensitivity, and moving
the Signet to a separate device.

## Open questions

- **Classification before sealing (for SEALED-to-Sovereign).** The Warden classifies *after*
  unsealing, so it briefly sees plaintext before it could re-seal to the Sovereign. Options:
  Witness pre-tags sensitive kinds; the Signet/Sovereign app ingests the most sensitive sources
  (e.g. the NAS tax docs) directly; or accept brief Warden sight in v1.
- **PoH evidence retention** default (hash-only vs retained recording) and per-sensitivity policy.
- **Recovery / social recovery** of the Sovereign root if the Signet device is lost.
