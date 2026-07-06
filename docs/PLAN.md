# Hearthold — Plan

## Concept

A Sovereign First Person's **7th Capital** (accumulated personal history) made safely *liquid*.
**Three** separated Archon identities completing the PVM triad (First Person / Swordsman / Mage):

- **Warden** (home Keeper / Swordsman / Soulbis lineage) — always-on, home-bound custodian.
  A **local-only AI**: reasons over your history on hardware you control, nothing transmittable.
  Holds the vault; ingests structured + unstructured data (incl. NAS); enforces the security
  model; mints proofs.
- **Witness** (Companion / Mage / Soulbae lineage) — mobile envoy. Two jobs: **witnessing**
  (captures local-only context → encrypted submissions home) and **acting in the world**
  (requests evidence from the Warden, presents proofs to third parties). Holds minimal data;
  authorized by a revocable delegated credential.
- **Sovereign** (First Person), held by the **Signet** app — the principal made cryptographic.
  Signs the Warden's access-control configuration (control plane vs. data plane) and co-signs
  HIGH/SEALED disclosures with a graded **proof-of-human** assertion. See
  [sovereign-signet.md](sovereign-signet.md).

## Identities & the separate Keymaster

Hearthold instantiates Keymaster **as a library against the Archon Gatekeeper**, with its own
file-backed wallet per agent — independent of the dev node's keymaster service (`:4226`).

- **Warden** — a `did:cid` identity, wallet at `~/.hearthold/warden/`.
- **Witness** — a separate `did:cid` identity, wallet at `~/.hearthold/witness/` (so
  `backupId`/`recoverId` can later move it to phone/browser).
- **Delegation** — Warden issues Witness a revocable `HearthholdDelegation` credential granting
  scoped query rights. Witness presents it (with a fresh challenge/response) to get answers.

## Security model

See [security-model.md](security-model.md). In brief:

- Every artefact carries a **sensitivity label**; uncategorized data defaults to **quarantine
  (max)** until the local model classifies it. Relaxation below a threshold needs human confirm.
- Every request carries an **authorization tier** (standing → fresh-challenge → human-in-the-loop
  → multi-factor). Warden releases only when `authz clears sensitivity`.
- Disclosure is a **derived VC** (selective-disclosure attestation), not the raw artefact.
  ZK predicate proofs are a later phase.

## Tech stack

- **TypeScript / Node**, npm workspaces monorepo. Shared `core` reused by every front-end.
  CLI is the v1 surface; browser (Vite) and mobile reuse the same `core`.
- **Archon**: `@didcid/keymaster`, `@didcid/gatekeeper`, `@didcid/cipher` (the PVM/spellweb
  stack). Gatekeeper at `flaxlap.local:4224`.
- **Transport**: direct HTTP over **Tailscale** — *not* dmail (dmail notices would leak the
  Witness↔Warden relationship on the registry). Archon for trust; private socket for bytes.
  Payloads sealed in-band (no anchoring), so zero registry footprint.
- **Local AI (Warden)**: local model via **Ollama** behind a swappable abstraction; used for
  classification + retrieval-augmented evidence assembly.
- **Index**: local vector store + structured metadata (start file/SQLite-backed; keep embeddable).

## Milestones

The back-end is now broad — identities, DIDComm transport, the on-device classifier, the full prove
flow, the **DTG credential set**, the **TRQP trust registry**, the **Witness projector**, the **Signet**
gate, and the **Game-of-42 bridge** all run and are tested live. The next focus returns to **Hearthold
itself**: graphical front-ends that make the system demonstrable.

### v1 — the witness→store→prove loop  ✅
1. **Identities** ✅ — Hearthold Keymaster wiring; `Warden` + `Witness` DIDs (`init`).
2. **Delegation handshake** ✅ — `HearthholdDelegation` VC issue/accept + challenge/response;
   tested live (`e2e:delegation`). CLI: `warden delegate` / `witness accept`.
3. **Transport + Witness → store** ✅ — **DIDComm v2** transport (`Transport` seam); authcrypt
   authenticates the sender (no session handshake); Warden authorizes via the recorded delegation,
   unseals → classifies → stores → replies with a receipt correlated by `thid`. Tested live
   (`e2e:submission` + two-process CLI). CLI: `warden serve` / `witness submit`.
4. **Classifier** ✅ — Warden classifies sensitivity on-device via a local model (Ollama
   `qwen3:8b`, structured output), fail-safe to `SEALED`. CLI: `warden classify`. **Index** (vector
   retrieval via `nomic-embed-text`) follows when the evidence flow needs retrieval.
5. **Prove** — for an `issued` claim ("I hold a valid credential of type X from issuer Y") the proof
   is an Archon challenge/response presentation: the verifier challenges (naming the schema + trusted
   issuers = audience binding), the Sovereign presents (which *is* the disclosure approval), and the
   verifier reads the disclosed claims + confirms the original issuer's signature. **Built & tested**
   (`core/prove.ts`, `e2e:prove`). Foundation done: Sovereign DID + `accept-credential` → `issued`
   leaf. Derived/`witnessed` claims + the full evidence graph are the **E** milestone below (built).

### E — Evidence graph: the prove side  ✅ (A3 selective disclosure = last piece)
The Warden turns witnessed vault data into a signed, presentable, disclosure-controlled proof
(design in [evidence-graph.md](evidence-graph.md)).
- **A1 — witnessed graph** ✅ (`core/evidence.ts`): assemble matching artefacts → a Merkle-committed
  provenance group → a Warden-issued VC (trust class `witnessed`); presented + verified via the prove
  flow, verifier trusting the Warden. `e2e:evidence`.
- **A2 — Sovereign co-sign** ✅: sensitive claims route through a **direct Warden↔Sovereign channel**
  (the Witness is never in the authorization path, §7.7); the Sovereign **signs** the approval
  statement (`keymaster.addProof`) — a detached signature embedded in the graph and **independently
  verifiable by any third party** (`verifyProof`), tamper-evident. `e2e:evidence-stepup` / `-direct`.
- **Composite — `issued` leaves** ✅ (closes F6): third-party credentials composed alongside the
  witnessed provenance; a verifier checks **each issuer** in one presentation (`requestCompositeProof`),
  so a skeptical relying party trusts an external party's signature, not just the Warden.
  `e2e:evidence-composite`.
- **Ephemerality + structured** ✅: configurable `validUntil`, single-use `txn`, structured predicate.
- **A3 — selective disclosure** ◀ last piece: reveal chosen per-observation leaves against the signed
  Merkle root (SD-JWT-VC-style), so a verifier can spot-check one supporting fact without seeing the rest.

The whole prove side is clickable in the Witness app (*Prove a claim* → Signet approval → inspector).

### R — Recall / Index: the private archive (RAG)  ◐ R1 built
Hearthold's *other* mode: not proving to a third party, but **answering the Sovereign's own questions
from the vault** — a sovereign, local-AI personal knowledge base ("when is America's anniversary?" →
recalled from a witnessed document). Local-only AI = **private RAG**: query + answer never leave the device.
- **R1 — Index + recall flow** ✅ (`core/recall.ts`, `warden/index-store.ts`, `warden/recall.ts`):
  the Warden embeds each submission at store time (Ollama `nomic-embed-text`) into a local index that
  holds **embeddings + metadata only, no plaintext** — content is re-unsealed transiently at recall
  time, so the vault stays sealed at rest. `recall(query)` = embed → cosine-rank (with an optional
  sensitivity ceiling) → re-unseal top-k → a local model answers with citations. CLI `warden recall`;
  answers are flagged `machine-derived`. Fail-open (no embed model → submission still stores).
  `e2e:recall` (hermetic). **To run live:** `ollama pull nomic-embed-text`.
- **Next:** structured extraction (extend the classifier seam to pull facts / entities / dates);
  a recall control endpoint + a GUI surface (Witness/Warden "ask your vault"); better vector store
  (flat JSON → sqlite-vec). Composes with prove: recall an answer, then wrap it in an evidence graph
  (honest `machine-derived` flag / a future `sovereign-confirmed` override).

This is what turns Hearthold from a proof system into a general **archive + retrieval + disclosure** layer.

### T — Trust graph & registry  ✅
The **DTG credential set** (VRC / VMC / VIC / VPC / VEC / VWC + RCard) issued and verified natively on
Archon (`core/dtg.ts`, `e2e:dtg-set`), and a **ToIP TRQP v2.0 trust registry** (`core/trust-registry.ts`,
`packages/registry`) — `HttpTrustRegistry` (consume any registry) + `GroupTrustRegistry` (over Archon
groups), authorizing per `(action, resource)`: *outward* (which issuers a verifier trusts) and *inward*
(a Witness's autonomy ceiling). Interop with an independent TRQP deployment verified. See
[trust-graph-and-delegation.md](trust-graph-and-delegation.md).

### W — Witness as projector  ✅ (per-device pending)
The **Witness** is the world-facing projector (PVM Mage): a verifier contacts `witness serve`, which
either presents on its own (below its cleared ceiling, under standing delegation) or **relays the
proof-request to the Signet** for proof-of-human approval, then carries the proof out — never approving
itself (§7.7). The autonomy ceiling is read from the inward trust registry. Built & tested
(`witness/handler.ts`, `e2e:projector`, `e2e:inward-registry`). **Still to do:** **per-device Witnesses**
(one Sovereign, many Witnesses) with **kind-scope enforcement**. See the actors table in
[architecture.md](architecture.md).

### S — Sovereign control plane (Signet)  ◐ partial
The **Sovereign** identity and the **Signet** proof-of-human gate are built (`packages/sovereign`, the
`ApprovalGate` seam — PIN today; the gate scales to biometric / face-liveness). **Still to do:** lift
policy out of `security.ts` into a **Sovereign-signed configuration** the Warden verifies / fails-safe,
and co-sign HIGH/SEALED disclosures carrying a graded proof-of-human assertion. SEALED-to-Sovereign
encryption deferred. Full design in [sovereign-signet.md](sovereign-signet.md).

### G42 — Game-of-42 / agentprivacy bridge  ✅
A **byte-exact** implementation of the agentprivacy Game-of-42 canon (`VRC → κ → seal`, verified against
the reference code) plus the City-Key projection (`core/game42.ts`). A sealed governance board (the Drake
Gamers Guild) becomes a constellation node and a soulbis City Key — the constellation *is* the trust
registry, rendered visually. See [for the City of Mages](../demos/game-of-42/for-the-city-of-mages.md).

### GUIs — graphical front-ends for demos  ◀ current focus
Thin **Vite / React** apps over the same `@hearthold/core` the CLIs already use (Buffer shim per house
rules), to make the system demonstrable without a terminal:

- **Signet** — the Sovereign's proof-of-human approval screen: the disclosure context (who is asking,
  what, at what sensitivity) with approve / deny and the chosen PoH method. Replaces the terminal PIN —
  the human-in-the-loop moment, made visible.
- **Warden console** — the vault (classified artefacts), delegations, and the trust registry (groups,
  bindings, the trust graph): the back-end made visible.
- **Verifier** — request a proof and watch it verify (✓ + disclosed claims, issuer / registry trust):
  the *prove-it-to-a-stranger* moment.
- **Board / constellation viewer** — a live Game-of-42 board + constellation fed by `core` (building on
  the static SVG viewer in `demos/game-of-42/`).

Demo-first steps toward the layered Hearthold GUI (admin base → DID cards → themes).

### KB — Knowledge Base via a public Mage portal + a private Warden  ◐ first increment built
A shared, authorized **Knowledge Base** that authorized Sovereign(s) can **query and update** — WITHOUT
touching the home Warden's invariant. The public surface is a **public Mage** (Witness): the community's
world-facing portal that authenticates who is asking and **carries** the query; the **Warden stays
private** (home-bound, local-only AI, holds the KB, authorizes, recalls) and never faces the public.
This is the projector pattern *inverted* — where prove is `verifier → Mage relays → Sovereign approves →
Mage carries out`, a KB query is `authorized Sovereign → Mage relays → Warden authorizes + recalls →
Mage carries out`. Multi-tenancy lives in the Mage (holds no secret = safe to share), not the Warden.

**Authenticate → authorize:** a visiting Sovereign first proves control of their DID via an **Archon
challenge/response** (the portal issues a challenge; the Sovereign signs; control is verified — as
archon.social / archon-ssh do); *then* the Warden authorizes that authenticated DID against a KB
**`GroupTrustRegistry`** membership (`read`/`write` on the KB resource). Over an established DIDComm
session, authcrypt already authenticates the sender DID, so the explicit challenge is for the
web-portal entry point.

Reuses almost everything: **query = recall** (in the Warden), **update = submit** (registry-gated,
provenance-stamped), the Mage relay = the built **projector** pattern, and facts can be **proven** from
the KB (evidence graph over KB entries, composited with the contributor's credential). Sensitivity is
repurposed as **visibility** (public / member-only / role-gated). Content discipline: shared knowledge
only — **never** private 7th Capital (that stays in a personal Warden).

- **First increment** ✅ (`core/kb.ts`, `warden/kb.ts`, `witness/kb-relay.ts`, `e2e:kb`): a KB Warden
  serves a shared KB; a member **authenticates** by signing the request over a Warden-issued nonce
  (`signKbRequest`/`verifyKbRequestSignature` — DID control proven end-to-end, so the relaying Mage can't
  forge identity; the nonce gives anti-replay), is **authorized** by a KB `read`/`write`
  `GroupTrustRegistry` group, then **queries** (recall) or **updates** (seal+classify+index, contributor-
  stamped). The public Mage (`makeKbRelayHandler`) forwards and holds nothing. Verified live: member
  update+query, non-member refused, forged requester rejected, replayed nonce rejected.
- **Deployable CLI + daemon** ✅: `warden kb-init <kbId>` (creates read/write groups) · `kb-grant` /
  `kb-revoke` / `kb-status`; `warden serve` (and `control`) load the `KbService` and serve the KB over
  DIDComm; `witness kb-portal` runs the public Mage; `sovereign kb-query` / `kb-update` are the member
  client (challenge → sign → request). Verified live over DIDComm end-to-end: a member contributes and
  queries the guild KB through the Mage portal, three real processes. **Still to do:** a hosted **web
  portal** over the Mage (browser member login via Archon challenge/response); multi-KB per Warden.
- **Grows to:** multi-Sovereign (add members to the group), a guild/public GUI, and a **prove→contribute
  bridge** (publish a consented, derived fact from a personal vault into the shared KB).
- **Demo vehicle:** the Drake Gamers Guild Knowledge Base — members query/update via the guild's public
  Mage, authorization = guild membership (VMC / group), facts provable. Drives the guild-manager GUI.

PVM-preserving by design: the public-facing role (Mage) holds no secret; the secret-holder (Warden)
never faces the public. Honest boundary: the guild's host still runs the Warden and sees queries at it —
a coherent *librarian* posture (the guild's brain, reached through its portal), not a personal
privacy-vault claim; the AI stays local (no cloud leak); query privacy over DIDComm is preserved.

### P2 — NAS / filesystem ingestion
Filesystem connector, bulk classification, fail-safe quarantine, human-confirm triage.

### P3 — Browser Witness
Real browsing-history witnessing on the shared `core` (Vite app; Buffer shim per house rules).

### P4 — Mobile Witness
Location-history witnessing on a phone.

### P5 — Richer disclosure & multi-device
Field-level selective disclosure (SD-JWT-VC salted digests / Merkle membership); multi-device
Witness fan-out via an Archon group. Optional predicate proofs for facts about data the Warden does
not issue.

## Open questions

- Local-model default (e.g. `llama3.1` vs a smaller classifier) and the embedding model.
- Index backend: flat file → SQLite + `sqlite-vec` → dedicated vector store.
- Whether the agents run as long-lived services or CLI-invoked processes — **resolved** for v1:
  CLI-invoked, each with a DIDComm `serve` loop; a service / GUI wrapper arrives with the GUIs milestone.
- Human-in-the-loop approval channel (terminal prompt now; the **Signet GUI** is the next step,
  push-to-device later).
