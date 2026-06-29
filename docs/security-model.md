# Hearthold — Security Model

The differentiator from an ordinary authorized-client/privileged-server system is that release
is governed by **two independent scales** plus a **disclosure transform**, and that the reasoning
agent (the Warden) is **local-only by construction**. A request is satisfied only when an
authorization tier *clears* an artefact's sensitivity, and even then what leaves the house is a
*derived* credential, not the raw artefact.

## 1. Sensitivity labels (per artefact)

Ordinal. Every stored artefact carries one.

| Label | Ord | Meaning |
|---|---|---|
| `PUBLIC` | 0 | Already public / freely shareable |
| `LOW` | 1 | Low-sensitivity personal data |
| `MEDIUM` | 2 | Ordinary private data |
| `HIGH` | 3 | Sensitive (financial, health, legal) |
| `SEALED` | 4 | Requires explicit fresh human approval to ever disclose |

**Fail-safe default.** Anything ingested but not yet classified is treated as `SEALED`
(quarantined). The local classifier may *relax* the label; relaxing to `MEDIUM` or below requires
human confirmation. Sensitivity is never silently raised-then-lowered without an audit entry.

## 2. Authorization tiers (per request)

What the Witness must satisfy to obtain a release. Each tier *clears* up to a maximum sensitivity.

| Tier | Ord | What it requires | Clears up to |
|---|---|---|---|
| `STANDING` | 1 | Valid, unrevoked delegation credential | `LOW` |
| `CHALLENGE` | 2 | Standing + fresh Archon challenge/response | `MEDIUM` |
| `HUMAN` | 3 | Challenge + human-in-the-loop approval | `HIGH` |
| `MULTIFACTOR` | 4 | Human approval co-signed by a second device | `SEALED` |

`PUBLIC` artefacts are always releasable. The clearance map is policy, not hard-coded ordinals —
see `core/src/security.ts` (`clearsSensitivity`).

## 3. Disclosure modes (what actually leaves)

What crosses the boundary is an **evidence graph** (see [evidence-graph.md](evidence-graph.md)) —
a signed, decomposable object — never a raw dump and never a reputation score. Disclosure is
**issuer-attested, not self-proven**: the Warden holds the evidence, derives the fact, and signs
it; the verifier trusts that signature the way it trusts any credential issuer. Privacy comes from
*derivation + selective disclosure*, built on plain signatures and hashes.

| Mode | Meaning | Phase |
|---|---|---|
| `ATTESTATION` | A derived VC asserting a fact ("resided in FR, 2026-H1") **without** the source; provenance carried as content hashes | v1 (default) |
| `SELECTIVE` | Reveal chosen underlying claims against signed salted digests (SD-JWT-VC style) or a Merkle membership proof | v1+ |
| `REDACTED` | The artefact with fields removed | v1 |
| `FULL` | The raw artefact (rare; high tiers only) | v1 |
| `PREDICATE` | A predicate proof over data the Warden did **not** issue (e.g. ZK) | optional |

The default and most valuable mode is `ATTESTATION`. `SELECTIVE` adds field-level disclosure using
**salted-digest commitments (SD-JWT-VC) or Merkle membership**. `PREDICATE` covers proving facts
about data the Warden is not the issuer of.

## 4. Release decision

```
release(request, artefact):
  if artefact.sensitivity == PUBLIC: allow
  if not delegationValid(request): deny "no/expired delegation"
  if not tierSatisfied(request.tier, request): deny "tier not satisfied"
  if not clearsSensitivity(request.tier, artefact.sensitivity): deny "insufficient authorization"
  if not disclosureSatisfiable(request.mode, artefact): deny "cannot satisfy disclosure mode"
  emit auditEntry
  allow with disclosureTransform(request.mode, artefact)
```

Mental model: every artefact has a **sensitivity**, every request an **authorization**, and the
Warden releases — as a signed **evidence graph** — only when `authorization clears sensitivity`
and the disclosure mode is satisfiable. The 7th Capital becomes spendable without being spilled.

**Principle (never a score).** Hearthold never computes or emits a sovereignty score, trust tier,
or reputation number — only a verifiable, decomposable evidence graph the relying party evaluates
for itself.

## 5. Step-up over the wire (presence ≠ person)

Authorization is **dynamic per request**, carried over the private HTTP channel:

- Opening a session (a verified delegation challenge/response) establishes the baseline
  `STANDING` tier — enough to release `LOW` content and to submit observations.
- When a request touches `MEDIUM+` content, the Warden replies `step-up-required` with the
  `requiredTier` and the methods it will accept (`challenge`, `pin`, `passphrase`). The Witness
  satisfies one and retries; the Warden re-runs the release decision at the elevated tier.

**External disclosure always requires the Sovereign's approval.** Internal-access sensitivity is
*not* the right trigger for proofs that leave to a third party: the operation that matters is *data
crossing the boundary to a named verifier*. So **any evidence disclosed externally requires a fresh
Sovereign approval** (the purpose-bearing challenge co-signed via the Signet), independent of how
sensitive the source artefacts are. The **proof-of-human level** then scales *with* source
sensitivity — device-unlock for a low-stakes claim, face-liveness for `SEALED`-backed ones. This
decouples "who/what may read the vault internally" (the tier ladder) from "the Sovereign approves
what leaves, to whom" (external disclosure).

The `pin` / `passphrase` methods exist to address a problem the delegation alone cannot: a valid
session proves the *Witness device* is authorized, but **not that the Sovereign is the one holding
it**. Possession of the device ≠ presence of the person. A per-request secret the Sovereign must
supply re-binds the action to the human for sensitive disclosures. This never fully solves the
problem (a coerced or shoulder-surfed secret still leaks), but it raises the bar from "whoever
holds the phone" to "whoever holds the phone *and* knows the secret" — a sound first line, with
stronger factors (second device = `MULTIFACTOR`) reserved for `SEALED`.

## 6. The local-only invariant

The Warden's classification and evidence-assembly reasoning runs on a **local model** (Ollama or
equivalent). No artefact content is sent to any cloud model. This invariant is what makes a
third-party verifier willing to trust a Warden-minted credential: the data that backs it never
left hardware the Sovereign controls.
