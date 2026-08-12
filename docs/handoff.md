# Handoff — a task-with-authority, composed (no new core surface)

**Status:** design (2026-08-11, revised). Answers Q1 of `HEARTHOLD-ASK-family-collaboration-mcp.md`.
Companion to `invocation.md`, `security-model.md`, `agent-family.md`.

> **Revision note.** An earlier draft proposed a `hearthold/task` protocol message. flaxscrip challenged it:
> *we already have the primitives — what's the gap?* There isn't one. A handoff is a **composition of shipped
> verbs**, not a new subsystem. The invariant *"authority is not a message"* is satisfied by using **two
> primitives** (a signed delegation + a message), not by inventing a type that re-fuses them. This doc records
> the composed form and defers the only thing that would justify new surface.

## The rule

A handoff is one agent asking another to *do* something.
- **Prompt-only** ("summarise this") grants nothing — the recipient acts under their own authority. It is a
  **`send`**.
- **Authority-bearing** (the recipient may exercise a capability over someone else's resources) is a
  **`delegate` + a `send`**: the authority travels as a signed `ChainCapabilityGrant`; the instruction travels
  as a message that *names* the grant by DID. Two objects, never fused.

## The composed handoff — existing verbs only

```
1. hearthold_delegate_capability { toDid, parent, caveats }
     → attenuate + issue a child grant to the recipient (transfers over hearthold/chain-grant;
       delegateCapability already refuses a widening child + non-holder delegator)
2. hearthold_send { toDid, card against a `familyTask` schema:
       { description, action?, target?, args?, deadline?, capabilityRef: <childVcDid>, txn } }
     → the instruction; correlation (capabilityRef + txn) rides in the card's own claims
3. recipient: hearthold_messages (read) → hearthold_held (has the grant) → hearthold_chain_invoke
     → the OWNER's Warden verifies the whole chain at point of use (attenuation, delegator-binding,
       per-hop status/revocation, discharges, human gate) → GRANTED evidence or leak-safe denial
4. cancel: hearthold_revoke_hop <childVcDid>  → the recipient's next invoke fails closed; the task goes inert
```

Every step is a verb already in `feat/invocation` / the agent-MCP. **Nothing in `core/protocol.ts` changes.**

## What is (and isn't) new

- **`familyTask` schema** — an Archon schema (register-once, reuse sphere-wide), so agents agree on task field
  names. This is a schema DID, **not** a core protocol message — the same move as Aegis's `familyMessage`.
- **`hearthold_handoff` façade (OPTIONAL, ergonomics)** — a strict composition of
  `delegate_capability` + `send`-against-`familyTask`. Zero new authority, no new gate, no new wire type —
  exactly the façade pattern of the other four MCP verbs. Skip it and the raw two-verb composition works
  identically.
- **Nothing else.** No `hearthold/task` message type. Retracted.

## Consent, revocation, watch — all unchanged

- **Consent** routes through the existing escalation ladder (`warden/escalate.ts` + AgentGate): attenuating
  within the agent's parent-signed allowance → AgentGate self-approves (P3 standing); widening / granting over
  the Sovereign's owner-scope to a sibling → escalates to the Sovereign Signet. The handoff invents no gate.
- **Revocation cancels the task.** Because the authority is a separate revocable object, `revoke_hop` makes
  the recipient's next `chain_invoke` fail closed — the instruction lingers but is inert without a live
  capability. Cancelling work = revoking the capability.
- **The watch already lights up.** The delegation fires `reportHopRegistered` (a lineage-forest edge) and
  `reportFlow` (a flow event: who→whom, capability ref, caveats). Envelope + authority only, never the task
  text — monitoring, not surveillance.

## The one thing that WOULD justify new surface — deferred

A typed, machine-executable task envelope earns its place **only** for **rote automation with no interpreter**
— a daemon mechanically mapping a task to an `InvocationAct` and invoking without an AI reading it. Our family
has an **AI in the loop** that reads the message and decides to invoke, so the structured card + a held
capability is sufficient. Build the typed envelope **when a real no-interpreter workflow needs it**, not
speculatively.

## Invariants preserved (by composition, not by addition)

- **Authority is a signed object** — it travels as a `ChainCapabilityGrant`; the message names a DID.
- **Attenuation monotonic** · **revocable per-hop** · **deny-by-default at use** — all inherited from the
  capability layer unchanged.
- **The task text is input evidence, never consent** — the Warden still authors any human-facing consent.
- **A2A only at the edge** — the handoff is internal DIDComm + a schema; no A2A types, no new core types.

## Net-new surface

**A `familyTask` schema DID + (optionally) one façade verb. Nothing in `core`.** The handoff is
`delegate` + `send`.
