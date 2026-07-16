# DRAFT rev 3 — GitHub issue for the Archon repo (review before posting)

> **Status:** draft for flaxscrip's review · 2026-07-13 · rev 3: softened per flaxscrip — introduces pairwise from scratch (David hasn't encountered the pattern yet), recasts asks as discussion questions, folds in the deterministic-derivation consideration, keeps the ephemeral-agents item (incident-motivated).
> **Suggested title:** `Discussion: per-relationship ("pairwise") DIDs — derivation, recovery, and lifecycle questions from Hearthold`

---

## Summary

Hearthold has started creating **a fresh DID per relationship/counterparty** in some flows, and we'd like to discuss what wallet- and registry-level support for that pattern could look like — nothing here is urgent, and `registry: 'local'` (thank you) already solved our testing problem. This is us describing where we're heading and asking how you'd want it done, plus one concrete proposal (ephemeral agents) motivated by the traffic incident we already discussed.

## What "pairwise" means and why we're doing it

A pairwise (or per-relationship) DID is a DID used with exactly **one counterparty**: Alice shows the bookshop one DID and the hotel a different one, so the two can't correlate her by identifier if they compare databases. Both DIDs are hers — same wallet, same seed — the *mapping* is private to her. The pattern is old practice in Bitcoin (fresh address per payment, standardized by HD wallets) and is now becoming normative in credential circles: the ToIP Decentralized Trust Graph draft we implement ([dtgwg-cred-tf `dtg.md`](https://github.com/trustoverip/dtgwg-cred-tf/blob/main/dtg.md), §5.1) requires *"a new, unique R-DID for every single entity they connect with,"* and the consent-gated disclosure work we're doing with the DIF H&T group wants grant subjects that aren't reusable identifiers. Under a DID-as-PII reading, this is just data minimization applied to identifiers.

Practical consequence: a busy wallet ends up with hundreds of agent DIDs — one per relationship — which raises the derivation, recovery, and lifecycle questions below.

## What already works (acknowledged)

Keymaster keys are already **deterministically derived**: `createId` walks an incrementing account index (`m/44'/0'/{account}'/0/0`), so key material for any number of per-relationship IDs descends from one mnemonic. And — a property we'd want to *preserve* — the **DID itself is unpredictable by construction**: it's the CID of the signed create operation, which embeds the creation time and the registry's current `blockid`, so nobody (including the wallet owner) can precompute the "next" DID. Keys deterministic, identifiers unpredictable. That split looks right to us.

## Discussion questions

**Q1 — Counterparty-keyed convenience.** Today each application invents its own naming convention (we mint per-relationship IDs and keep a private counterparty→ID map application-side). Would a wallet-level idempotent helper make sense — `createPairwiseId(counterpartyTag)` returning the existing ID for a known counterparty, minting on first contact — or would you rather keep this above Keymaster (a naming convention over `wallet.ids`)? Either works for us; a shared convention would keep applications from diverging.

**Q2 — Deterministic derivation for pairwise keys, and what recovery means.** flaxscrip's framing: some wallets offer deterministic "next" IDs via an incrementing index, which simplifies backup and recovery. Could pairwise keys ride the existing account counter (or a counterparty-tagged derivation), so that **seed-only recovery of keys** is possible — with DIDs staying unpredictable as they are now? Recovery would then mean: re-derive keys by walking indices, then rediscover which DIDs each key controls (registry scan by pubkey for registered DIDs; the counterparty's copy or the encrypted wallet backup for unregistered ones). Is `backup_wallet_did`/`recover_wallet_did` the recommended story at hundreds of IDs, or is a gap-scan-style recovery something you'd consider? Honest framing: **we don't expect answers here — we'd like to explore this together**, and we'll happily prototype and measure whatever direction you prefer.

**Q3 — The space between `local` and `hyperswarm`.** `local` resolves for nobody else; `hyperswarm` resolves for everybody. A relationship DID wants to resolve for exactly **one remote counterparty**. Is there appetite for a bilateral mode (à la `did:peer` — DID docs exchanged directly, upgradeable to a public registry if the relationship later needs standing)? This would also keep relationship-scale DID creation off the public mediator entirely — relevant to the traffic patterns you analyzed.

## One concrete proposal — ephemeral agents (`validUntil` on `type: 'agent'`)

Assets can carry `registration.validUntil` and get garbage-collected; agents can't — `createIdOperation` has no expiry path, so every agent is permanent and revocation only appends a tombstone. The traffic analysis you did is what that asymmetry costs in practice: ~800 permanent agents in two weeks, ~99% our test and KB-provisioning fixtures (created before we adopted `registry:'local'` for tests). Extending `validUntil` + GC to agents would serve expiring test fixtures, relationship DIDs born expiring-and-renewable, and consent-grant subjects that die with the grant they anchor. Related: should the mediator be able to prune *revoked* agents' operations, so incidents like ours have a disposal path?

## Non-goals

- No change to stable/public DID workflows — communities, issuers, and personas keep their permanent DIDs.
- No policy enforcement in Keymaster — *when* pairwise is required is application law (Hearthold's Warden enforces it there).
- No urgency — `local` unblocked us; this is direction-setting.

## We can contribute

Prototype whichever direction you prefer, e2e tests against a live node (we already run `e2e:dtg-set`, `e2e:prove`, `e2e:pairwise-grant` and friends), and registry-cost measurements at relationship scale.

## References & evidence

- ToIP DTG credentials draft v0.3 — R-DID rule §5.1 + privacy considerations on identifier reuse
- BIP32 (the deterministic-derivation precedent) — https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
- `did-creation-source.md` — the mediator-log traffic analysis (2026-07-06→13), attached
- Hearthold's DTG implementation notes: `docs/trust-graph-and-delegation.md` §8–9
