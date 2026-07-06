# Hearthold — the Knowledge Portal

*A shared, authorized Knowledge Base that members can query and update — built without bending the PVM
model. The public surface is a Mage (Witness); the brain behind it is an ordinary private Warden.*

## The idea, and the fork we didn't take

We want a **hosted Knowledge Base** an authorized community (say a guild) can query — and update —
over the web, as a live demonstration of the tech and a seed for multi-party participation.

The tempting-but-wrong design is a *"Public Warden"*: expose the Warden itself as a public service. That
breaks the Warden's defining invariant — private, home-bound, local-only AI, **cannot exfiltrate** — and
muddies what content is safe to host.

The right design moves the public surface to **the role that is already meant to be public: the Mage**
(Witness). The Witness is defined as the world-facing emissary that *sees in, projects out, carries
delegated authority, and holds no secret.* A public Mage serving a query portal is textbook Witness. The
Warden never faces the public.

> **This is the projector pattern, inverted.** Where *prove* is
> `verifier → Mage relays → Sovereign/Signet approves → Mage carries the proof out`, a *KB query* is
> `authorized Sovereign → Mage relays → Warden authorizes + recalls → Mage carries the answer out`.
> The Mage is the world-facing carrier in both directions; the same seam does both.

## Architecture

```
 authorized Sovereign ──(web portal / DIDComm)──▶  public Mage  ──DIDComm──▶  private Warden
   (a guild member)                                (carries; no secret)       (authorizes; recalls;
   ◀──────── answer + citations ─────────────────────────────────────────      holds the KB; local AI)
```

- **The Warden stays private** — home/guild-bound, holds the Knowledge Base, runs a **local-only** model
  for recall, authorizes requests, and never accepts a public connection. Invariant preserved.
- **The public Mage is a portal and a carrier** — it terminates the web/DIDComm connection, forwards the
  request to the Warden, and returns the answer. It decides nothing and holds no secret (§7.7). One
  **community Mage** acts as the guild's public emissary.
- **Multi-tenancy lives in the Mage** — a *shared Mage* is safe precisely because it holds nothing; a
  shared Warden would not be. This is the PVM separation working in our favour.

## Authenticate, then authorize

Two distinct steps, kept separate:

1. **Authenticate — who are you?** A visiting Sovereign proves control of their `did:cid` via an **Archon
   challenge/response**: the portal issues a challenge, the Sovereign signs it, control is verified — the
   same pattern archon.social and archon-ssh use. (Over an already-established DIDComm session, authcrypt
   authenticates the sender DID for free, so the explicit challenge is the web-portal entry point.)
2. **Authorize — what may you do?** The **Warden** checks that authenticated DID against a KB access group
   via the **trust registry** (`GroupTrustRegistry`, TRQP `read` / `write` on the KB resource). Read and
   write are separate authorizations. **Multi-Sovereign is just "add members to the group."**

Authorization lives in the *private* Warden, not the public Mage — the Mage only proves *who* is asking
and carries.

## What it reuses

Almost everything already exists:

| KB operation | Built on |
|---|---|
| **Query** | **recall** — embed → cosine-rank → re-unseal top-k → local model answers with citations |
| **Update** | **submit** — classify + index + store, now provenance-stamped with the contributor's DID |
| **Authorize** | **`GroupTrustRegistry`** (TRQP over Archon groups) |
| **Public relay** | the **projector** pattern (`witness/handler.ts`) |
| **Prove a KB fact** | the **evidence graph** — composited with the contributor's credential (`issued` leaf) |

New surface is small: a registry-gated read/write authorization reframe, a KB visibility model, and a
hosted portal over the Mage.

## Visibility (sensitivity, repurposed)

For a shared KB, an artefact's sensitivity becomes **who may see it**: `public` (any authenticated
member), `member-only`, or `role-gated` (e.g. officers). The same sensitivity × authorization machinery
applies — the release decision just answers "may *this* member read *this* entry?"

## Provenance and the prove→contribute bridge

Every KB entry carries **who contributed it** (a `did:cid`) and how it was witnessed — so the KB is not
an anonymous blob but a graph of attributed knowledge. A member can also take a **consented, derived
fact** from their *private* vault, prove it (an evidence graph), and **contribute** that proof into the
shared KB. Recall over the KB can then cite attributed, even independently-verifiable, entries.

## Invariants & honest boundary

Two invariants keep the Knowledge Portal from drifting into a surveillance surface as the KB grows.
They are **rules, not notes**:

- **Invariant I — guild brain ≠ personal vault.** The KB holds *shared* knowledge; it **never** holds a
  member's **7th Capital**. The personal Warden holds the 7th Capital. **These must never merge.** A
  member may *contribute* a consented, derived fact (via prove→contribute), but the KB is not, and must
  not become, a store of members' private histories. This is the line between a guild *brain* and a
  *surveillance surface*.
- **Invariant II — no query attribution retained.** The Warden reads a query **in memory only** to answer
  it; it does **not** persist the query text or *who asked what, when*. **Query logging is off by
  default.** Retaining per-DID query attribution would let the guild host reconstruct a member's interest
  graph — putting the PVM **Reconstruction Ceiling (R < 1)** at risk *even for a shared KB*. So the
  default is structural forgetting: a query leaves no trace at the Warden. (Enforced in code: the KB
  service's query path recalls and replies without writing the query or requester anywhere — the code
  comment marks it as a deliberate invariant. Any future ops metrics must be aggregate and
  non-attributable.)

**The honest part.** The guild's host still runs the Warden and, at request time, sees the query *in
memory* to answer it (unavoidable — it must read the question). That is a coherent **librarian** posture:
the guild's brain, reached through the guild's portal — **not** a personal privacy-vault claim. What the
invariants guarantee is that the librarian *keeps no record of who read what* and *never becomes a store
of members' private lives*. The recall AI stays **local** (no cloud leak), and DIDComm writes nothing to
the registry, so no outside observer learns the member↔KB relationship either.

## First increment → growth

- **First (single Sovereign):** a KB access group; the Warden does registry-gated recall + authorized
  update; a Witness relays KB queries; a thin public web portal over the Mage. Hosted on flaxlap.
- **Grows to:** multi-Sovereign (add members), a guild/public GUI, portable **VMC** membership (present a
  guild-membership credential to be admitted to the group), and the prove→contribute bridge.

## Demo vehicle — the Drake Gamers Guild Knowledge Base

Guild members reach the guild's public Mage, authenticate with their `did:cid`, and query the KB
(*"what's the raid schedule?"*, *"who's the current champion?"*); authorized officers update it;
authorization is guild membership; and facts can be **proven** out of it. It's a tangible, multi-party,
reachable demonstration — and the natural driver for the guild-manager GUI and the multi-Sovereign
future.
