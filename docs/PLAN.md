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
   leaf. **Next:** derived/`witnessed` claims via a Warden-minted evidence graph + Sovereign
   co-sign (see [evidence-graph.md](evidence-graph.md)).

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
