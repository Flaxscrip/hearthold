# Trusted-Knowledge Mesh v1 — Results

A constrained, one-hop, trust-gated query: it travels from node A's Emissary to a recognized friend node
B's Warden and returns a **signed, pairwise-encrypted evidence graph**. Run **live** against an Archon
Gatekeeper (`@didcid/keymaster` 0.6.0 → `flaxlap.local:4222`, `registry=local`). This proves the mesh's
core loop end-to-end — not the full network. Everything marked "later" is deferred (see
[FINDINGS.md](./FINDINGS.md)).

- Module: [`packages/core/src/mesh.ts`](../../packages/core/src/mesh.ts)
- Test matrix + fence-builder loop: [`scripts/e2e-mesh.ts`](../../scripts/e2e-mesh.ts) — `npm run e2e:mesh`

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_DATA_ROOT="$(mktemp -d)"
npm run e2e:mesh
```

---

## The loop (and what it reuses)

Two Hearthold nodes over one Gatekeeper: **A** (me) = Warden + Emissary; **B** (friend) = Sovereign +
Warden. The invariant holds throughout — **B's Warden never faces a foreign node; only the Emissary
crosses.** `MeshWarden` is B's Warden *backend*, handed a neutral request by B's edge (its Emissary, the
production relay), exactly as `CgprService` sits behind the A2A gateway. Archon stays dumb: it signs opaque
blobs (`addProof`) and stores encrypted content (`encryptJSON`); all mesh semantics live in Hearthold.

The two scopings **are** the prior models applied to new payloads — not reinvented:

| Mesh concern | Reused primitive |
|---|---|
| **Recognition credential** (B's Sovereign → A's Emissary, scoped, revocable) | **selective-disclosure** — A reveals to B only `{subject, tier, recognitionId, confidence}`; `domain`/`mode`/`maxDepth` stay hidden |
| **Query budget delegation** (A's Warden → A's Emissary) | **attenuation** — the Emissary's query must be `isSubset` of the delegated scope; it structurally cannot exceed it |
| **Signed, pairwise-encrypted answer** | `addProof` (B's Warden signs the graph) + `encryptJSON` (to A's Emissary) |

1. **Recognition** — B's Sovereign issues a scoped, revocable recognition VC naming A's Emissary.
2. **Delegation** — A's Warden mints an attenuation credential delegating a budgeted `{query on fences,
   mode:fact}` scope to A's Emissary (verified as a valid attenuation chain).
3. **The hop** — A's Emissary forms a query (gated A-side against its delegation), attaches a selective
   recognition presentation, and sends the envelope.
4. **Admission** — B's Warden checks: recognition verifies **and** is from the Sovereign B recognizes;
   names the presenter; tier; not revoked; arrival depth. Deny-by-default.
5. **Answer** — B reasons over its public partition (a seeded fence-builder note) and returns a signed
   evidence graph — reference + **provenance** (`asserted` vs `inferred`) + recognition-path confidence —
   pairwise-encrypted to A's Emissary.
6. **Return** — A's Emissary decrypts, verifies B's Warden signature against its issuer DID, renders.

---

## Test matrix — every case the expected verdict (live)

A correct REJECT is a PASS; admission and verification were never loosened.

| Case | Expected | Result (real output) |
|---|---|---|
| HAPPY | ACCEPT | evidence graph returned, decrypted, signature verified; `provenance:asserted` |
| NO-RECOGNITION | REJECT | `recognition not honored: issuer <A-warden> is not the expected <B-sovereign>` (check `recognition`) |
| REVOKED-RECOGNITION | REJECT | `recognition has been revoked by B` (check `revocation`) |
| BUDGET-EXCEEDED | REJECT (A-side) | `query {reasoning on fences} exceeds the delegated attenuation scope`; and `maxNodes 100 exceeds delegated 10` — blocked before B |
| DEPTH-VIOLATION | REJECT | `arrival depth 2 exceeds partition policy (depth 1 only)` (check `depth`) |
| PROVENANCE-INTEGRITY | REJECT tamper | altering the signed provenance breaks B's signature — `verifyProof` rejects |
| CONFIDENTIALITY | opaque wire | a third party cannot decrypt; the narrative is absent from the wire cleartext (only `cipher_*`) |

### CONFIDENTIALITY — called out

The answer crosses the wire as an Archon asset whose `didDocumentData` is `cipher_sender`/`cipher_receiver`
(pairwise-encrypted to A's Emissary). Verified directly: an outside observer's `decryptJSON` **throws** (not
the recipient), and the plaintext narrative ("8 feet on center") is **absent** from the asset's cleartext —
only `cipher_*` is present. A third party observing the hop learns neither the answer nor B's partition
contents. (Scope: this is answer confidentiality; the *query itself* is trust-gated, not confidential — B
sees it. See DEFERRED-SCOPE.)

### PROVENANCE-INTEGRITY — called out

The provenance tag distinguishing "**Sovereign B personally asserts**" from "**B's AI inferred from B's
notes**" is inside the graph that B's Warden signs with `addProof`. Verified directly: after A receives and
decrypts the graph, flipping `provenance` (`asserted → inferred`) and rewriting the narrative makes
`verifyProof` **reject** — A cannot forge or alter B's provenance claim after receipt.

---

## Happy-path transcript (the returned evidence graph, decrypted + verified)

```
▸ HAPPY: valid recognition, depth 1 → ACCEPT, evidence graph returns, A verifies + decrypts
  ✓ A-side: the query is within the delegated budget/scope
  ✓ B admits + returns an encrypted evidence graph
  ✓ A decrypts + verifies B's Warden signature
  ✓ provenance tag present + signed
    ── evidence graph (rendered) ──
      reference:  post-spacing
      provenance: asserted (fact 1, recognition-path 0.9)
      narrative:  Sovereign B asserts: set posts 8 feet on center for a cedar privacy fence, 2 feet deep in concrete.
      answeredBy: did:cid:bagaaieragvybmqbhpzdmj… (B's Warden)
```

The query ("how far apart should fence posts be?") crossed one trust-gated hop; the answer came back a
signed, pairwise-encrypted evidence graph carrying B's personal assertion and the recognition-path
confidence, and A verified it against B's Warden DID before rendering.

---

## Reproducing

`npm run e2e:mesh` → *"the fence-builder loop closes — trust-gated admission, budget attenuation, and a
signed, pairwise-encrypted evidence graph."* Two nodes are isolated under `A/` and `B/` sub-roots of
`HEARTHOLD_DATA_ROOT`; every DID is minted on `registry: local`. Assets are permanent, so each run mints a
fresh recognition, delegation, and answer.
