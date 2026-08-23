# Hearthold terminology — KB *members* vs the Sovereign *trinity*

Two models in Hearthold share vocabulary and get conflated. This doc pins the words so Hearthold, Aegis, and
Sevenfold align. **One sentence:** the *Knowledge Base* is about **shared, collaborative knowledge — many
members around one custodian**; the *trinity* is about **personal, sovereign custody — each Sovereign running
its own three services over its own vault.** They compose; they are not the same axis.

---

## Model A — the shared Knowledge Base (multi-user)

Collaborative knowledge that several people read and write, hosted by **one** custodian.

| term | meaning |
|---|---|
| **KB Warden** | The **one** custodian that hosts a shared Knowledge Base — holds the store, enforces access, runs the assurance policy. One KB Warden can host **many** KBs (`e2e:kb-multi`). |
| **shared Knowledge Base (KB)** | The collaborative pool. Identified by a `kbId`. |
| **KB member** | A DID **authorized to a KB** — a *user* of the shared custodian, **not** a full stack. A member brings only their **Signet** (their key) to log in and to step up a sensitive write. |
| **group / trust registry** | Membership + authorization live in a `GroupTrustRegistry` group (`readGroup` / `writeGroup`). Reader vs writer is a grant, re-counted server-side. |
| **assurance policy** | A **Sovereign-signed Ruleset chain** naming the per-verb step-up required (`read`/`write` → `factor1` \| `factor2`). Governed by a DID readers pin. |
| **session** | A short-lived login token from challenge → response → `verifyResponse` (keys never leave the member's wallet/Signet). Machine clients use a per-request signature instead. |
| **KB Space** | A KB with **per-member private partitions** turned on (`memberPartitions`). |
| **private partition** | A private DB **inside the KB Warden**, one per member. Member-key sealed: the Warden is **write-host** (seals in, cannot open at rest) and the member is **read-guest** (their session key opens it). A scope-less contribute lands here; `scope:'shared'` lands in the shared pool. |

*Reference:* `docs/kb-spaces.md`. *Code:* `warden/kb.ts`, `warden/kb-config.ts`, `core/trust-registry.ts`.

---

## Model B — the Sovereign trinity (personal custody / the "7th Capital")

One principal's own private data history and the three services that keep it.

| term | meaning |
|---|---|
| **Sovereign** | The **principal** — a `did:cid` identity + wallet. A person **or** an AI agent. This is *who*, not a service. |
| **trinity** | The **three services** that constitute a Sovereign's custody stack: **Warden · Emissary · Signet**. |
| **Warden** | The Sovereign's **own** custodian — holds *its* vault, classifies on-device, serves evidence, enforces release. Each Sovereign has its **own** Warden. |
| **Emissary** | The Sovereign's world-facing **companion** — observes context, contributes it home, later presents evidence. The *voice*. |
| **Signet** | The Sovereign's **authorizer / 2nd factor** — holds the key, approves disclosures. A **human** Signet gates on a PIN (proof-of-human); an **AI agent's** Signet runs an `AgentGate` (self-approves within its parent-signed allowance, escalates above it — proof-of-agent). The *conscience*. |
| **vault** | The Sovereign's own private data history (its 7th Capital). |
| **parent / governor / Master-Sovereign** | In the **agent family**: the human Sovereign over AI-agent Sovereigns (`governorDid` / `parentDid`). Signs allowances; sensitive agent acts escalate to *its* Signet. |
| **Verifier** | A **third party** that requests and checks proofs. Not part of a Sovereign's trinity. |

*Reference:* `docs/agent-family.md`, `README.md`. *Code:* `packages/{warden,emissary,sovereign,verifier}`.

---

## How they compose

You are a **Sovereign** (your own trinity + vault) who can **also** be a **KB member** of one or more shared KBs.

- Acting on a **shared KB** → you are a **KB member**: group-authorized on **someone else's** KB Warden.
- Acting on your **own** history → you are a **Sovereign**: your **own** Warden custodies it.
- A **KB member does not need their own Warden or Emissary.** The only trinity service a KB member touches is
  their **Signet** — to sign the login challenge and to co-sign a factor-2 write.
- A KB **private partition** is a middle ground: private data hosted **inside the shared KB Warden** (sealed to
  the member), *distinct* from the member's **own personal vault** on their **own** Warden.

---

## The overlapping words (where confusion comes from)

| word | in the KB model | in the trinity / family model | rule |
|---|---|---|---|
| **member** | a *user* of a shared KB (group-authorized DID) | a *Sovereign under a parent* (a full agent, with its own trinity) | **never say bare "member"** — say **"KB member"** or **"family member"** |
| **Warden** | **one** shared Warden hosts the KB | **each** Sovereign has its **own** Warden | qualify: "the KB Warden" vs "Alice's Warden" |
| **Signet** | the member's key for login + write step-up | the Sovereign's 2nd factor / conscience | **same concept** — a member's Signet *is* part of their own trinity. No conflict. |
| **governor** | the DID signing the KB **assurance policy** | the **parent / Master-Sovereign** over agents | analogous ("the DID that signs policy"), different scope — qualify it |
| **partition / space** | shared vs private DB **within a KB** | — (use **vault** for a Sovereign's own custody) | don't call a personal vault a "partition" |
| **assurance / tier** | KB per-verb step-up (`factor1`/`factor2`) | the release ladder's `AuthzTier` (STANDING…MULTIFACTOR) + spend/cost bands | related ladders; name which one |

---

## Conventions (say this, not that)

- ✅ **"KB member"** for a user of a shared KB. ❌ bare "member" (ambiguous).
- ✅ **"Sovereign"**, **"trinity"**, **"vault"** for personal custody. ❌ "the KB's Sovereign" (a KB has a
  *governor* that signs its policy and *members* that use it — no "Sovereign of the KB").
- ✅ **"the KB Warden"** (one, shared) vs **"Alice's Warden"** (her own). ❌ unqualified "the Warden" when both
  are in play.
- ✅ **"family member" / "agent Sovereign"** for a Sovereign under a parent. ❌ "member" for an agent.
- The **Signet** is the one word that means the same thing in both models — a Sovereign's proof-of-human (or
  proof-of-agent) authorizer. A KB member logging in or stepping up a write *is* using their own Signet.

---

## Glossary (quick reference)

- **AgentGate** — an AI agent's Signet gate: self-approves within the parent-signed allowance, escalates above.
- **assurance policy** — a KB's Sovereign-signed per-verb step-up requirement (`factor1`/`factor2`).
- **community** — a group of members under a shared issuer/registry (a **C-DID** issuing **VMC** membership; the
  PVM "G" factor). **Formerly called a "sphere"** in some docs — that usage is **retired** (see *Sphere* below).
- **Emissary** — a Sovereign's world-facing companion (contribute/present). One-third of the trinity.
- **governor** — the DID that signs a policy: a KB's assurance-policy signer, or the family parent.
- **KB member** — a DID authorized (via a group) to read/write a shared KB.
- **KB Warden** — the one custodian hosting a shared KB (may host many).
- **private partition** — a member's private DB inside a KB Warden (member-key sealed; write-host/read-guest).
- **Signet** — a Sovereign's 2nd-factor authorizer (PIN for humans, AgentGate for agents).
- **Sovereign** — the principal: a `did:cid` identity (person or AI agent).
- **Sphere** — a named **publication target**: the `(Gatekeeper URL, registry)` operations publish onto
  (`core/sphere.ts`; `publishToSphere` fails closed on a mismatch). It is **the anchoring layer, not the
  application layer** — a Sphere is **never** a KB, a partition, a space, or a community. "A shared Sphere
  between Sovereigns" = one Gatekeeper+registry two Sovereigns both anchor on. A shared KB *rides on* a
  Sphere but is not one. (The app-layer "sphere" meanings are retired: **community** for a membership body,
  **space/partition** for a KB compartment.)
- **trinity** — a Sovereign's three services: Warden · Emissary · Signet.
- **vault** — a Sovereign's own private data history (its 7th Capital).
- **Verifier** — a third party that requests + checks proofs (not part of a trinity).
- **Warden** — a custodian (the KB's, shared; or a Sovereign's own).
