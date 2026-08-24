# Trusted-Knowledge Mesh v1 — Findings

What Archon made easy or awkward, and — importantly — an explicit **DEFERRED-SCOPE** section naming what
v1 does NOT do. Grounded on real calls against a live node (`@didcid/keymaster` 0.6.0 →
`flaxlap.local:4222`, `registry=local`); the harness is [`scripts/e2e-mesh.ts`](../../scripts/e2e-mesh.ts)
(`npm run e2e:mesh`).

## Verdict

The core loop closes end-to-end and every negative test rejects at the intended check. The mesh is built
**entirely** from the two prior modules plus Archon's `addProof`/`encryptJSON` primitives — no new crypto,
no new trust assumption. The architecture invariant held: B's Warden is a backend handed a neutral request,
never a foreign socket.

## What Archon made easy

- **Cross-node addressing "just works."** Both nodes register their DIDs on the same Gatekeeper, so B's
  Warden resolves A's Emissary DID to encrypt the answer to it, and A verifies B's Warden signature by
  resolving B's Warden DID — no key exchange, no out-of-band trust bootstrap beyond the recognition itself.
- **Pairwise answer confidentiality is one call.** `encryptJSON(signedAnswer, aEmissaryDid)` yields an
  asset whose cleartext is only `cipher_*`; the outside-observer test confirmed a non-recipient's
  `decryptJSON` throws and the narrative never appears in the clear. Answer confidentiality came free from
  the same primitive selective-disclosure and CGPR already use.
- **Provenance integrity is free from the signature.** `addProof` signs the whole graph, so the
  `asserted`/`inferred` tag is unforgeable after receipt — no separate integrity mechanism.
- **The two reuses were genuinely drop-in.** The recognition is a selective-disclosure VC (A reveals only
  what B admits on); the budget delegation is an attenuation credential (`isSubset` blocks an over-scope
  query A-side). Neither needed changes to the underlying modules.

## What Archon made awkward (and the workaround)

- **Numeric budget isn't set-⊆.** Attenuation's `isSubset` is categorical (operations/resources as sets),
  which cleanly enforces `{query on domain:fences, mode:fact}` — an over-scope query (`mode:reasoning`) is
  blocked structurally. But `budget:{maxNodes, rate}` needs `≤`, not `⊆`; strings like `maxNodes:10` don't
  compare numerically as a set. So the mesh keeps the **categorical scope on attenuation `isSubset`** and
  adds a small **numeric `≤` check** for `maxNodes`/`rate` — the natural numeric analogue, enforced at the
  same A-side gate. Both were exercised (over-scope and over-budget both blocked before B).
- **Revocation is mesh-side, not credential-native here.** The recognition is an `addProof`-signed
  selective-disclosure credential (so it can be selectively presented), which has no built-in revocation.
  v1 revokes by `recognitionId` in B's in-memory policy set — legitimate, since B is the admission
  authority and the disclosed `recognitionId` binds the check. Productionizing = publish B's revocation
  list as an Archon asset (`setProperty`) that admission resolves; the shape is unchanged.
- **"Warden never faces a foreign node" is an architecture property, not an Archon feature.** We preserve
  it by construction: `MeshWarden` is a backend with a `handle(envelope)` method; B's Emissary is the
  world-facing relay. v1 models the relay in-process (as the CGPR e2e models the A2A gateway), so the
  invariant is structural — B's Warden is only ever handed a neutral, already-received request.

## DEFERRED-SCOPE — what v1 does NOT do (named, not built)

- **Multi-hop / friend-of-friend propagation (depth > 1) and fan-out.** v1 is strictly one hop, arrival
  depth 1; B's partition policy rejects depth 2. Propagation, loop-prevention, and fan-out budgeting are
  later.
- **Querier privacy — v1 queries are TRUST-GATED, NOT confidential.** B's Warden sees A's query in the
  clear (it has to, to answer it). Only the *answer* is pairwise-encrypted. Hiding the query from the
  answering node is **Private Information Retrieval** — the hard upgrade, explicitly out of scope. State
  this plainly: **v1 does not hide the query from B.**
- **Recognition-graph privacy.** Who-recognizes-whom is visible within the trusted group in v1 (the
  recognition names its subject and issuer). Hiding the trust graph is BBS+/anonymous-credential tier.
- **Unlinkability across presentations.** The recognition and the answer carry stable issuer signatures, so
  repeat presentations are correlatable — the same boundary as the selective-disclosure module. Unlinkable
  presentation is the BBS+ tier, out of scope.
- **Semantic vocabulary alignment across nodes.** v1 assumes A and B share a claim vocabulary (`domain`,
  `mode`, the fact `reference`s). A shared/negotiated claim schema across independent nodes is deferred.

## Residuals / next steps

- **Multi-hop** builds on this: an admitted answer, re-packaged as a selective-disclosure credential, is
  forwarded onward under a decremented depth + attenuated budget — both primitives are already here.
- **Query privacy (PIR)** and **trust-graph privacy (BBS+)** are the two hard upgrades; naming them keeps
  v1 honest about what "trust-gated" does and does not buy.
- **Archon-native revocation** via a published revocation asset is a small, mechanical hardening.
