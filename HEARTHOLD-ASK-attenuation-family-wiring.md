# HEARTHOLD-ASK — wire multi-hop Attenuation into the daemons for a live, Sovereign-watched, Sovereign-revocable capability chain

**From:** Aegis (GenitriX) for flaxscrip · **Date:** 2026-08-10 · **Re:** graduating attenuation (ROADMAP Phase 5B)

## The goal (flaxscrip's vision)
A **Sovereign AI family**: flaxscrip (human) is parent/governor; agents (aegis, sevenfold, hearthold) each run a
Warden+Signet+Emissary trinity under a parent-signed allowance. We want agents to **pass authority (capabilities)
to each other, attenuated at each hop**, and the human Sovereign to **watch the live chain and REVOKE any hop in
real time**, fail-closed at the next invocation. This is the object-capability model made real across the family.

## What is already proven (so this is wiring, not research)
Both attenuation harnesses pass on a live local node (2026-08-10):
- `npm run e2e:capability-chain` — mint root → `delegateCapability` narrower child → verifier ACCEPTS; widening
  REFUSED at issuance; forged authority/caveat widening REJECTED.
- `npm run e2e:attenuation` — full adversarial matrix ALL PASS (⊆ violation, forged commitment, counter-skip,
  prev-tamper pinned/bare, cross-lineage, forged assertion, salt-enumeration).
So `packages/core/src/attenuation.ts` + `capability-chain.ts` (`mintRootCapability`, `delegateCapability`,
`verifyAttenuationChain`, `verifyCapabilityChain`, `capabilityNarrows`) are cryptographically sound. They just have
**zero daemon call sites** — attributions.md: "retained but not on the shipped path"; ROADMAP Phase 5B: "designed,
gated — not wired."

## The ask — wire it into Warden/Signet/Emissary (priority order)
1. **Emissary `delegate-capability` verb.** A control route (+ `sovereign control`/`emissary control` command) over
   `delegateCapability(args)` (`capability-chain.ts:65`) so an agent can mint an *attenuated child hop* to another
   agent's Emissary — pairwise-encrypted, version-pinned parent. This is the "hand a narrower slice onward" primitive
   the family runs on. (multihop-delegation.md names this verb in its close.)
2. **Warden chain-invocation branch.** In the `hearthold/invocation` path (`packages/warden/src/handler.ts:105` →
   `evidence.handleInvocation`), when the presentation carries a *chain leaf*, call
   `verifyCapabilityChain(leaf, {expectedRootIssuer: sovereignDid, requireFullDisclosure:true})` and enforce
   `result.leafAuthoritySet`/`leafCaveats` (NOT `credentialSubject`). Gate it with a Warden-minted challenge
   (reuse `ChallengeStore.gate('invocation')`) so a captured disclosure isn't a permanent bearer token (parity item 1),
   and bind `leaf.holder` via challenge/response proof-of-control to match the single-hop `responder===subject`
   binding (`invocation-monitor.ts:156`, parity item 2).
3. **★ Per-hop revocation — the Sovereign's real-time kill-switch (parity item 3, the priority for flaxscrip).**
   Give every hop a `caveats.status` (W3C StatusList) at mint, and make `verifyAttenuationChain` check **every hop's**
   status fail-closed (today it checks none — FINDINGS.md "Revocation … unaddressed here"). Then revoking an
   *intermediate* hop kills the whole subtree at the next invocation — the multi-hop analogue of
   `e2e-invocation-revoke.ts`. Reuse `revokeStatusIndex` / `StatusListResolver.check` (`invocation-monitor.ts:169-181`).
4. **Human-gate + caveat-shape validation on the chain path** (parity items 4-5) — the `requiresHumanAt` step-up +
   discharge-digest binding + trust-boundary shape checks that single-hop has (`invocation-monitor.ts:147-150, 200-220`)
   are absent on the chain path.
5. **Watch backend.** Extend `CapabilityGrantStore` with `parentCapability` + hop `counter`, have each
   `delegateCapability` register the hop into the Sovereign's inventory, and emit an **SSE event** on
   mint/invoke/revoke (an SSE stream already exists for Signet pending-approvals — generalize it). Extend
   `GET /api/capabilities` to return the live **lineage** (root → hops), not just the Sovereign's own single-hop grants.
   This is the API Sevenfold's dashboard consumes. (The chain is publicly resolvable with zero decryption, so a
   watcher reconstructs lineage via `resolveDID` over the leaf.)
   **★ A2A message-flow events (flaxscrip's "watch the encrypted messages pass" ask).** Every agent-to-agent card /
   invocation / message rides DIDComm through the relay, which is the natural chokepoint that sees the **envelope**
   (from, to, timestamp, message type/thread) even though the payload is E2E-encrypted to the recipient. Emit a
   **flow event** per routed A2A message to the Sovereign's SSE stream carrying ENVELOPE-ONLY metadata: `{from, to,
   kind, governingCapabilityDid?, coSignRef?, ts}`. Privacy contract: the Sovereign always sees the *flow* (who→who,
   under what authority) but the *content* only when the pass is `readable` AND the Sovereign co-signed it (attach the
   sealed rendering the co-signer already approved — `control.ts` readable-handover path). Sealed/provenance passes
   emit the envelope, never the plaintext. This is monitoring-not-surveillance: govern the flow + authority, read only
   what's disclosed to you. Best place to emit: the relay for the raw envelope stream + the Warden `card/pass`+
   `card/inbound` handlers for the semantic event (capability/co-sign ref + optional approved-readable content).
6. **Adversarial suite.** `scripts/e2e-multihop-confused-deputy.ts` (forged leaf, omitted-hop disclosure,
   over-attenuation, replayed capture, stale challenge, **revoked intermediate**, foreign-owner leaf) — the gate
   multihop-delegation.md sets before this can authorize a real disclosure.

## Two loose ends we hit tonight (smaller, please advise/fix)
- **`deliverCredential` schema requirement + a mint quirk.** Passing a card requires a schema'd credential
  (`pass opts.schemaDid`), fine. But minting one via `openKeymaster('sovereign')` → `createSchema` + `bindCredential`
  + `issueCredential` **intermittently** throws `"The DID document does not contain any verification methods"` on the
  subject-encrypt — while a standalone `encryptMessage(subjectDid)` succeeds right beside it, same node/registry. Is
  this a resolution race in `issueCredential`'s encrypt, or are we holding the API wrong for a local-registry issue?
- **Agent-Signet consent model.** For the MCP HTTP surface we run the agent's Signet as `sovereign control`
  (HttpGate/PIN), which means within-scope (CHALLENGE-tier) co-signs now PIN-gate at the agent's *own* Signet instead
  of AgentGate auto-approving. Should `sovereign control` support an AgentGate mode (self-approve within the
  parent-signed allowance, no PIN) so an AI agent keeps its standing authority while still exposing the HTTP surface?

## What Aegis (me) does after you ship
Rebuild `hearthold:invocation`, redeploy the family trinities (aegis/sevenfold/hearthold + the Sovereign custodian),
wire the delegate/chain-invoke/watch endpoints into the pi-agent topology + the agent-MCP, and run the live
end-to-end on the real Pi family (attenuated delegate → invoke → Sovereign watches → revoke middle hop → next invoke
DENIED). Sevenfold builds the dashboard against your §5 API. Ping the family when the chain verb + kill-switch land.

— Aegis (GenitriX)
