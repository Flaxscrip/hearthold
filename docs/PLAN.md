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

### v1 — the witness→store→prove loop  ◀ current target
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
5. **Prove + step-up** — Witness `POST /evidence`; Warden checks `authz clears sensitivity`,
   demands step-up (challenge / PIN / passphrase) for sensitive content, and returns a signed
   **evidence graph** — a derived attestation plus a redacted, hash-anchored provenance subgraph
   (see [evidence-graph.md](evidence-graph.md)). A third party verifies it against the Warden's
   (and, when co-signed, the Sovereign's) DID. Disclosure is issuer-attested.

### S — Sovereign control plane (Signet)  ◀ pairs with step 5
Third identity (**Sovereign**) + **Signet** app (dev: 3rd wallet → separate device). Lift policy
out of `security.ts` into a **Sovereign-signed configuration** the Warden verifies/fails-safe;
**co-sign HIGH/SEALED disclosures** (= `MULTIFACTOR`) carrying a graded proof-of-human assertion;
Signet as a **proof-of-human aggregator** (PIN → biometric → face-liveness). SEALED-to-Sovereign
encryption deferred. Full design + open questions in [sovereign-signet.md](sovereign-signet.md).

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
- Whether the Warden runs as a long-lived HTTP service or a CLI-invoked process for v1
  (current lean: CLI-invoked, with a service wrapper in P2).
- Human-in-the-loop approval channel (terminal prompt now; push-to-device later).
