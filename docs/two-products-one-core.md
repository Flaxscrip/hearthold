# Hearthold & Spaces — Two Products, One Core

_Design & direction · 2026-08-18_

## Why this document

We kept hitting friction integrating what felt like one system, and it turned out to be
**two** — with different centres of gravity — sharing a single substrate. This note names the
split, so each product gets a clean story and consumers stop asking "which half do I use?", while
we keep the thing that made it beautiful in the first place: **a person uses both from one Archon
wallet, one identity.**

The short version:

> It is not one system, and it is not two disconnected projects. It is **two products on one core.**

## The core insight

```
┌──────────────────────────────────┬─────────────────────────────┐
│   HEARTHOLD  (Sovereign Capsule)  │   SPACES  (Commons + Blazon)│
│  "prove a fact, disclose nothing" │  "publish a queryable self, │
│                                   │   gated by membership"      │
│  · object-capabilities            │  · KB spaces + recall       │
│    (mint→attenuate→invoke→revoke) │  · membership groups        │
│  · Trinity: Warden/Sovereign/     │    (flat → graded)          │
│    Signet                         │  · shared + private         │
│  · issuer-attested evidence       │    partitions               │
│  · Emissary + Verifier            │  · lightweight members      │
│  · heavyweight per principal      │  · promote-to-shared        │
│                                   │                             │
│  ref impl: prove/emissary demos   │  ref impl: HATPro, kb-portal│
├───────────────────────────────────┴─────────────────────────────┤
│                  ── BRIDGE · Guardianship ──                     │
│     a governed edge spanning a member ⇄ a custodian              │
│     (Ruleset chains + the amendment rule) — stays in core        │
├──────────────────────────────────────────────────────────────────┤
│                     SHARED CORE  (@hearthold/core)               │
│  Archon did:cid · ONE wallet · Warden-as-custodian ·             │
│  partitions + sealing · sensitivity / decideRelease ·            │
│  DIDComm transport · Rulesets · pairwise DIDs · trust registry   │
└──────────────────────────────────────────────────────────────────┘
              ONE ARCHON WALLET · ONE IDENTITY SUBSTRATE
```

The bottom layer is genuinely shared, and it is where the "same wallet" beauty lives. On top of it
sit two clearly-named product surfaces. **The Warden is core** — it is the custodian in both
products, wearing two role-profiles (evidence-minter for Hearthold, KB-host for Spaces). That is
*why* one wallet works.

## The shared core (`@hearthold/core`)

The substrate both surfaces stand on:

`identity`, `keymaster`, `transport` (DIDComm), `protocol`, `payload`, `config`, `security`
(sensitivity × authorization tiers × `decideRelease`), `pairwise`, `ruleset`, `trust-registry`/`dtg`,
`mailbox-pointer`, the partition + sealing + `session-keys`/`rewrap` plumbing, and the
**Warden-as-custodian** shell.

## Product 1 — Hearthold (the Sovereign Capsule)

> **"Your home keeps your data; a companion proves facts about you to the world without handing the
> data over. Authority to disclose is a signed, scoped, revocable capability — verified at the point
> of use, killable in one hop."**

The unit is a **single person's vault** and controlled emission to the world. The heart is the
**object-capability**: mint → attenuate (monotonic narrowing) → invoke (verified at the point of use)
→ revoke (per-hop, fail-closed). Disclosure is **issuer-attested** — the Warden derives and signs a
fact; verifiers trust the issuer's signature, never a presenter's word. Heavyweight per principal
(the Trinity: Warden / Sovereign / Signet). This is the *sovereign individual, high-assurance
selective disclosure* story.

Modules: `capability*`, `attenuation`, `lineage`, `invocation-monitor`, `evidence`, `prove`,
`selective-disclosure`, `status-list`, `single-use`, `escalation`. Agents: Sovereign + Signet,
Emissary, Verifier (+ the Warden in its issuer-attested-evidence role). Reference impl: the e2e
`prove` flows, the Emissary and Signet-approver apps.

## Product 2 — Spaces (the Commons and the Blazon)

> **"A self-owned, queryable knowledge surface — a community's shared commons, or a Sovereign's
> public face — gated by membership. Keep private notes; promote what you choose into the shared
> pool; trusted readers (human or AI) get only what's shared."**

The unit is **membership-gated shared knowledge**. The heart is the **group** (in/out, or graded).
Lightweight members, shared + private partitions, open-enrollment, `promote-to-shared`. This is the
*collaboration / marketplace / publishing* story.

Spaces has **two shapes on the same primitive** (a Space = a KB with scope + membership):

- **Commons** — a Space with *many* members: a household, a community, a marketplace. `N = many`.
- **Blazon** — a Space with *one* Sovereign publishing their queryable public face. `N = 1`. (See
  below.)

Modules: `kb`, `kb-config`, `recall`, `household`, `household-vault`, GroupTrustRegistry usage
(flat → graded), open-enrollment, promote-to-shared. Agents: the Warden in its KB-custodian role +
lightweight members. Reference impl: **HATPro** (travelers + trusted-partner companies), `kb-portal`.

### The Blazon — a Sovereign's queryable public face

A **Blazon** is the AI-native evolution of the personal homepage: not a page you *read*, but a
self-owned identity surface you *ask questions of*.

Why it is genuinely new, not "a website with extra steps":

- **Self-owned** — published from the Sovereign's own wallet, `did:cid`-anchored. No platform holds
  it. There is no account to delete — there is a key.
- **Machine-queryable, not just readable** — the interface is KB *recall*. Any AI (yours, a vendor's,
  anyone's) asks *"what are their dietary preferences? do they have status with us?"* and gets an
  answer. Your homepage **answers questions** instead of making the reader hunt.
- **Signed answers** — a Blazon's recall results can come back **Warden-signed / issuer-attested**, so
  the querying AI knows the answer is authentically that Sovereign's published fact, untampered. A
  website can be spoofed; a signed Blazon answer cannot. This is where the core's signing carries
  straight into public publishing.
- **Layered by default** — public bio → trusted-partner details → private notes are just scope /
  read-group settings. One surface, graded visibility, nothing to keep in sync.
- **Authoritative + revocable** — one source the Sovereign controls; update once, every querier sees
  current. The end of scattered, stale profiles.

The name: a **blazon** is the formal, precise, public description of a coat of arms — literally "the
structured spec of an identity, declared in public" — and a real blazon is written in a strict
formal grammar. A Sovereign's Blazon is a **structured, machine-queryable public identity
declaration**; the word already means exactly that. (We considered "Herald", but Archon's name
service is already Herald — historically a herald was both *proclaimer* and *registrar of arms*;
Archon took the registrar sense, so we take the artefact the herald proclaims: the Blazon.)

Narrative: homepage (you owned it) → social platform (they owned your profile) → **Blazon (you own
it, and it answers for you)**. *Reclaim your homepage — and make it talk.*

## Publish vs. Prove — how the two products compose

The two products are two faces of one wallet:

> **Publish** what you want the world to query → your **Blazon / Space** (open or graded recall).
> **Prove** what you keep private, on demand → your **Hearthold capsule** (capability-gated,
> disclose-nothing).
> `promote-to-shared` is literally *"move this fact from my private capsule out onto my public
> Space."*

The hearth (private vault) and the front door (queryable Blazon), one identity. HATPro's travelers
are already this: a traveler publishing a queryable profile is a Sovereign with a Blazon; the
companies are early queriers.

## The bridge: Guardianship

`guardianship` (+ the ruleset amendment rule) is the one place a Spaces member and a Hearthold
custodian meet under a governed relationship — a governor gets scoped, ceiling-gated read over a
member, and *access-widening needs the affected member's own signature*. It belongs in core, used by
both products.

## The seam rule (kills "which half do I use?")

- Building a **single principal disclosing to the world**? → **Hearthold** (capabilities, invoke,
  evidence).
- Building a **community sharing knowledge, a marketplace, or a public profile**? → **Spaces**
  (groups, partitions, promote-to-shared; Commons for N-many, Blazon for N=1).
- They **compose**: a household on Spaces where each member also runs a Hearthold capsule — the
  shared core makes that one wallet, one identity. That composition is the thing worth protecting,
  and it is exactly what a full fork would break.

## The staged path — earn each step, don't front-load the cost

1. **Now:** one repo, two named surfaces. A `docs/` split + package-README reframe — *no code move*;
   it is naming over structure that already exists. Two docs tracks, two reference impls (prove-demo =
   Hearthold, HATPro = Spaces/Blazon).
2. **When they diverge:** factor the surfaces into their own namespaces on the shared core
   (`@hearthold/core` stays; add e.g. `@hearthold/spaces` vs `@hearthold/capsule` agent sets). Still
   one repo.
3. **Only if a product hardens with its own cadence + consumers:** split the repo.

Honest caveat: a chunk of recent integration pain was *infra* (gatekeeper anchoring, separate KB
wallet, readGroup nesting), not concept. A conceptual split does not erase that plumbing — that is
deployment topology. Split for *narrative clarity and clean pitches*, not to make the wiring
disappear.

## What this means for the dev team now

- **HATPro** is the **Spaces / Blazon** reference implementation. Its travelers are Sovereigns with
  Blazons; its trusted-partner companies are queriers. Build against the Spaces surface (flat trusted
  group + promote-to-shared + shared-pool recall), not the Hearthold capability surface.
- The **prove / Emissary / Signet** demos are the **Hearthold** reference implementation.
- **`promote-to-shared` is the load-bearing action** that turns private data into a public/queryable
  Blazon; the trust group gates *who may read the shared pool*. Two independent knobs.
- **Coming Hearthold-side primitive:** a clean structured-profile *read/overwrite* (today's recall is
  append-log), so a Blazon returns one current profile, not accumulated append versions. This is what
  makes the query side genuinely usable.
