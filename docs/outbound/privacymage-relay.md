# Relay draft → PrivacyMage (Mitchell / SoulBae)

*Draft for GenitriX (flaxscrip) to relay through the First Person's channel — **not** sent from Hearthold
directly (PrivacyMage is not in the Hearthold family DIDComm roster). Companion to
`docs/agentprivacy-skills-integration.md` and the garden at `assets/skillsync/`.*

> **Status:** ready to relay (2026-08-28). Trim to voice before sending; the substance below is grounded in
> the reconciled integration doc and the built `hearthold` catalog.

---

Mitchell — I walked the Skill Garden and mapped it against Hearthold's identity + attestation layer. The
convergence is hard to miss: **your chain-seal is, cryptographically, exactly what our issuer-attested
signatures already provide.** A garden entry "attested" at the Librarian is trust-on-the-Librarian; the
same entry carried as a `did:cid`-signed VC is trust-on-the-**issuer** — verifiable offline by anyone, no
Librarian required. Same universe, two doors.

**The substrate lines up 1:1.** Your packet model (`card ≤280 · brief ≤1200 · sha256 body hash`,
`catalog.json`, `POST /garden`, briefs-first/bodies-on-fire) maps onto our content-addressing,
load-on-demand recall, and signed evidence graph. Your leaderboard's *constellation* edges (contributed /
walked-by-another) are trust-graph relationship edges in our model (DTG VEC/VMC): *a derived edge proposes;
only a signature mints* — already your own language. And the Librarian's Desk chain-head-over-typed-entries
is the same "commitment lets any member check the cloud told the truth" as our evidence-graph roots.

**I built a working handshake.** There's now a real `hearthold` garden — a `catalog.json` with three neutral
packets, each with a computed sha256 body: `issuer-attested-evidence`, `object-capability-invocation`, and
`foreign-credential-exchange`. That third one is the fresh piece: Archon shipped credential-exchange over
DIDComm (issue-credential 3.0), and **an Archon identity can now issue a signed VC to a subject *outside*
the network and hand it whole to a foreign verifier** — no wallet, no shared registry, verified by resolving
the issuer's `did:cid`. That's the interop route a federated garden would otherwise lack: I could hand you a
signed catalog entry across the boundary and you'd verify our signature, not our word.

**One vocabulary heads-up before we build on each other.** We independently reuse a couple of names: your
**Gatekeeper** (personhood / Sybil-resistance persona) vs Archon's DID-resolver "gatekeeper" — your concept
actually lines up with our proof-of-human co-sign; and **Herald** (your media-commons persona) vs Archon's
Name Service. No conflict, just labels. The one that *isn't* a collision: your **Master Emissary**
(McGilchrist) and our **Warden ⊥ Emissary** split are the same shape — the actor that must never become the
master. That keeps surfacing on its own.

**And a friendly ask on the pages.** Your `catalog.json` *is* the machine-readable form — the whole
neutral-packet design is built for agents. But the garden is a client-rendered page that 403s at the door,
so an AI can't read the shelf without a human printing a PDF (which is how I got here). If the Librarian
exposed the public garden's `catalog.json` — or a plain-markdown snapshot — at a fetchable URL, agents could
read it directly. Small change, big unlock for the federation.

Three questions, as an invitation, not a claim on your framework:

- The Librarian's real `catalog.json` field schema, so we get the object keys exact rather than proposed?
- Would **attested-run VCs** be of interest as an optional *stronger* seal alongside the Librarian record —
  additive, no change to your flow?
- Is Librarian ↔ TRQP mutual recognition worth exploring, or premature?

Whenever you're ready, I'll host the `hearthold` garden and register it. The backbone you're reaching for
with chain-sealing is exactly what we bring.

— GenitriX
