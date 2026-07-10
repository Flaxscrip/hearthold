# DRAFT — GitHub issue for the Archon repo (review before posting)

> **Status:** draft for flaxscrip's review · 2026-07-10 (rev 2: acknowledges existing HD derivation) · not yet posted
> **Suggested title:** `Keymaster: pairwise (per-relationship) DID ergonomics — counterparty-keyed creation, registry-free option, recovery-at-scale guidance`

---

## Summary

We're building on Keymaster's existing HD-wallet foundation — `createId` already derives every identity from the master seed (`m/44'/0'/{account}'/0/0`, per-account key rotation, a dedicated DIDComm branch), which is exactly the right base for **pairwise DIDs** (a fresh DID per relationship/counterparty). What we're asking for is the last mile: a counterparty-keyed convenience API, a registry-free variant for DIDs that only ever need bilateral resolution, and guidance on recovery at relationship scale.

This is mechanism only. Policy — *when* a pairwise DID is required — stays in the application layer (our Warden enforces it there). We are explicitly **not** asking Keymaster to force pairwise usage; stable public DIDs (communities, issuers, personas) remain essential.

## Motivation

1. **ToIP DTG v0.3 upgraded per-relationship DIDs from best practice to a spec requirement.** The Decentralized Trust Graph credentials draft ([trustoverip/dtgwg-cred-tf `dtg.md`](https://github.com/trustoverip/dtgwg-cred-tf/blob/main/dtg.md), §5.1) now states: *"each entity MUST generate a new, unique R-DID for every single entity they connect with."* Hearthold implements the full DTG credential set on Archon (`issueVrc` … `issueRCard`, verified live on the node), so this MUST lands on us — and by extension on Keymaster's DID-creation ergonomics and cost.
2. **Consent-gated disclosure flows (DIF H&T / A2A work) need per-audience subject DIDs.** In the A→B→C pattern we're building (a third party receives a scoped, short-lived credential about a subject), the conformance rule is "no reusable subject identifier unless the subject deliberately chooses one." Every approved grant therefore wants a fresh audience-bound DID as `credentialSubject.id`.
3. **DID-as-PII.** Under a fault-tolerant reading (and GDPR practice), a reusable DID is a correlatable identifier. The mitigation is the same one Bitcoin standardized via BIP32 HD wallets: make fresh-identifier-per-relationship the cheap, recoverable, default-friendly path.

At relationship scale this means hundreds or thousands of DIDs per wallet, which today raises three practical problems: creation ergonomics, backup/recovery, and registry cost.

## What already works (acknowledged)

Keymaster IDs are BIP44 HD-derived: `createId` assigns an incrementing account (`m/44'/0'/{account}'/0/0`), rotates keys within the account, and derives DIDComm key-agreement keys on a dedicated branch. So *keys* for any number of per-relationship IDs already descend from one mnemonic — the foundation for pairwise DIDs is in place. The remaining friction is naming/mapping, registry cost, and the recovery story at scale.

## Requested capabilities

**1. Counterparty-keyed creation (thin sugar over `createId`).**
Something like:

```
createPairwiseId(counterpartyDid | audienceTag, opts?) → did   // idempotent per counterparty
listPairwiseIds() / resolvePairwiseId(counterparty) → did
```

Today each application must invent its own name convention and keep its own counterparty→ID map. A wallet-level, idempotent, counterparty-keyed lookup would make the pattern uniform across applications and keep the pairwise→root mapping in one private place. (Possibly just a naming convention + index over the existing `wallet.ids` — we'd take that too.)

**2. Registry-free / bilateral DIDs for relationship use** *(the substantive ask)*.
An R-DID typically needs to be resolvable only by its one counterparty, yet each `createId` today anchors an operation on the public registry (hyperswarm). At relationship scale that means thousands of single-use identities on the registry and per-DID creation overhead. A `did:peer`-style variant — unregistered, exchanged and resolved bilaterally, upgradeable to registered if the relationship later needs public standing — would make the DTG MUST costless. If ephemeral DIDs already cover part of this, guidance on their suitability for *long-lived* bilateral relationships would help.

**3. Recovery-at-scale guidance (question, not feature).**
Keys re-derive from the seed, but the wallet's name→`{did, account, index}` map and the DIDs' registry operations are state. We understand `backup_wallet_did`/`recover_wallet_did` (encrypted wallet backup anchored on a DID) to be the intended recovery path — is that the recommendation at hundreds-to-thousands of pairwise IDs, or is a seed-only gap-scan recovery (à la Bitcoin's address gap limit) feasible/planned? We'll happily test either at scale.

## Current workaround

We mint ordinary IDs per grant/relationship and keep the linkage map application-side. It works — and HD derivation means key material is no burden — but every application reinvents the mapping discipline, and registry cost scales linearly with relationships.

## Non-goals

- No change to stable/public DID workflows.
- No policy enforcement in Keymaster — "when pairwise is required" is application law (Hearthold's Warden enforces it via its Ruleset system).

## We can contribute

Happy to draft the API surface, contribute e2e tests against a live node (we already run `e2e:dtg-set`, `e2e:prove`, and related suites that would exercise this), and report registry-cost measurements at relationship scale.

## References

- ToIP DTG credentials draft v0.3 — https://github.com/trustoverip/dtgwg-cred-tf/blob/main/dtg.md (R-DID rule, §5.1 "Unilateral Relationship Identification"; privacy considerations on M-DID reuse)
- BIP32 (the precedent for deterministic per-relationship identifiers) — https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
- Hearthold's DTG implementation notes (running on Archon): `docs/trust-graph-and-delegation.md` §8–9 in the hearthold repo
