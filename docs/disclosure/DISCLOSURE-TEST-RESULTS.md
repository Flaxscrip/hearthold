# Salted-Hash Selective Disclosure — Test Results

SD-JWT-style property-level selective disclosure for Hearthold VCs on Archon, run **live** against an
Archon Keymaster/Gatekeeper (`@didcid/keymaster` 0.6.0 → Drawbridge on `flaxlap.local:4222`,
`registry=local`). An endpoint verifies a **subset** of a credential's properties — without the issuer
signature covering the whole document, and **without learning the undisclosed properties**. It is the
enabling primitive for the privacy-preserving MCP/A2A transport binding, so it ships as a reusable module.

- Module: [`packages/core/src/selective-disclosure.ts`](../../packages/core/src/selective-disclosure.ts)
- Blocker smoke (Task 1): [`scripts/smoke-disclosure-api.ts`](../../scripts/smoke-disclosure-api.ts)
- Test matrix: [`scripts/e2e-disclosure.ts`](../../scripts/e2e-disclosure.ts)
- MCP demo: [`scripts/demo-disclosure-mcp.ts`](../../scripts/demo-disclosure-mcp.ts)

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222
npm run smoke:disclosure       # Task 1 blocker check
npm run e2e:disclosure          # the full REJECT/ACCEPT matrix
npm run demo:disclosure-mcp     # the mock-MCP transport-binding demo
```

> **Scope (read this first).** Salted-hash disclosure gives property-**HIDING**, not unlinkability. The
> issuer signature is a stable value, so an endpoint can correlate repeat presentations of the same
> credential. Unlinkability is a separate BBS+ anonymous-credential tier and is **out of scope** — see
> [FINDINGS.md](./FINDINGS.md).

---

## The model

**Architecture split (identical to the attenuation work):** Archon stays dumb. It **signs an opaque blob**
(`addProof` — the same signature primitive the codebase uses for rulesets; trust = Archon resolution, the
verifier resolves the signer DID through whichever Gatekeeper it trusts) and **stores encrypted content**
(`encryptJSON`). Archon has no knowledge of properties, salts, or subsets — all disclosure semantics are
Hearthold's.

**Issuance (Warden)** — for each disclosable property generate a fresh 256-bit salt and compute
`digest = SHA-256(JCS({name, salt, value}))` (the JCS canonicalization is reused from `attenuation.ts`, so
commitments are reproducible). The **signed body** is the SORTED array of these digests plus always-visible
metadata; the Warden signs it. The **full disclosures** (all salts + values) are pairwise-encrypted to the
holder. Values never enter the signed body — only their salted digests do.

**Presentation (holder → endpoint)** — the holder ships the signed commitments (all opaque digests) plus
the `(salt, name, value)` disclosures for **only** the requested properties, pairwise-encrypted to the
endpoint.

**Verification (endpoint)** — verify the issuer signature over the digest array; for each disclosed
`(salt, name, value)`, recompute the digest and confirm it is **present** in the signed array. Accept →
the endpoint knows the disclosed properties and nothing about the rest (opaque digests).

### Schema (`packages/core/src/selective-disclosure.ts`)

```ts
interface Disclosure { salt: string; name: string; value: unknown; }          // held by the holder

digestDisclosure(d) = SHA-256( JCS({ name, salt, value }) )                    // reproducible commitment

interface SignedDisclosureCommitments {   // the signed body — Archon signs this blob
  sd: string[];                           // sorted digest array (order carries no information)
  issuer: string; credentialType: string; validUntil: string | null;
  proof?: { verificationMethod, proofValue, created, ... };   // addProof — signs the whole body incl. sd
}

interface Presentation {                  // what crosses the wire (pairwise-encrypted to the endpoint)
  commitments: SignedDisclosureCommitments;   // all opaque digests + metadata
  disclosures: Disclosure[];                  // ONLY the requested properties
}

// verifyPresentation → { ok, check?, reason?, disclosed? }
//   checks: (signature) verifyProof + signer==issuer · (validity) · (membership) recompute ∈ sd
```

---

## Results — every case the expected verdict (live)

Credential under test: `{ scope:[read], budget:500000, resources:[ledger-db], tier:gold }` — 4 signed
digests. Verifier ran on a separate node handle (endpoint posture; resolution-trust only).

| Case | Expected | Verifier output |
|---|---|---|
| HAPPY — disclose only `scope` | ACCEPT | `ACCEPT`, disclosed = `{scope:[read]}` (and only that) |
| FORGED-VALUE — disclose `(fresh salt, scope, [write])` never issued | REJECT | `REJECT (membership) — disclosed property 'scope' has no matching digest in the signed array` |
| WRONG-SALT — correct value `[read]`, wrong salt | REJECT | `REJECT (membership) — disclosed property 'scope' has no matching digest in the signed array` |
| TAMPERED-ARRAY — flip one digest in `sd` | REJECT | `REJECT (signature) — issuer signature over the digest array does not verify` |
| MULTI-DISCLOSE — disclose `scope` + `tier` (2 of 4) | ACCEPT | `ACCEPT`, disclosed = `{scope:[read], tier:gold}`; budget + resources stay hidden |

All produced the expected verdict; a correct REJECT is a PASS and the verifier was never loosened.

### HIDING — called out explicitly

Disclosing only `scope`, the wire Presentation and the verifier result were checked directly:

- the undisclosed **budget value `500000` is absent** from the wire Presentation ✓
- the undisclosed **resource `ledger-db` is absent** from the wire Presentation ✓
- the verifier result **exposes no undisclosed key** (`budget`/`tier` not in `disclosed`) ✓
- undisclosed properties are present **only as opaque digests** — all 4 digests ship, 1 disclosure ✓

The endpoint cannot derive `budget` from the Presentation: it holds only `SHA-256(JCS({name,salt,value}))`
for it, and the 256-bit salt makes the preimage unrecoverable (next section).

### SALT-BRUTEFORCE-GUARD — called out explicitly

`tier ∈ {bronze, silver, gold}` — a 3-value domain, the worst case for hiding. An attacker holding the
signed digests but **not** the tier salt enumerates the domain:

- **salted** (the real scheme): enumerating `{bronze,silver,gold}` recovers the tier in **0** cases ✓
- **unsalted** (counterfactual): the *same* enumeration **would** recover it (**1** hit) ✓

So the salt is load-bearing: an unsalted digest over a tiny domain is trivially reversible; a salted one is
not. This is why every property is salted before hashing.

---

## MCP demo transcript (task 7 — the transport-binding leapfrog)

A mock MCP endpoint challenges for one scope fact; the holder answers with a salted-hash-disclosure
Presentation **encrypted to the endpoint**; the endpoint verifies and authorizes without seeing the rest.

```
══════════ salted-hash selective disclosure over a mock MCP transport ══════════
  issuer (Warden): did:cid:bagaaieraxx2ycorsxafhq…
  holder (agent):  did:cid:bagaaiera4v7vrwjdcezay…
  endpoint (MCP):  did:cid:bagaaieraefdx4tceggfsz…

▸ Warden issues the agent a grant: scope, budget, apiKeyRef, tier (values encrypted to the agent)
  signed digest array (opaque): [189cfd91…, 2667b240…, 56662328…, ed8ea47e…]

▸ MCP endpoint → challenge: "prove your ["scope"] to call my tools"
  holder → response: encrypted Presentation asset did:cid:bagaaierauhspuz74qcfxp… (scope disclosed; rest = bare digests)

▸ MCP endpoint verifies:
  signature over the digest array: VALID (issuer = Warden)
  disclosed to the endpoint: {"scope":["tools:read","tools:list"]}
  can the endpoint see the budget?   no
  can the endpoint see the apiKeyRef? no

▸ Authorization: GRANTED — agent may call tools:read

✓ endpoint authorized on the scope fact ALONE — budget + apiKeyRef never left the holder
```

The endpoint made an authorization decision on the **scope fact alone**; the sensitive `budget` and
`apiKeyRef` properties existed in the credential only as opaque digests and never crossed the wire.

---

## Reproducing

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass' HEARTHOLD_REGISTRY=local \
       HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 \
       HEARTHOLD_DATA_ROOT="$(mktemp -d)"
npm run e2e:disclosure          # → "valid subsets ACCEPT, every forgery REJECTs, undisclosed stay hidden"
npm run demo:disclosure-mcp     # → the transcript above
```

Every DID is minted on `registry: local` (hygiene). Assets are permanent on the node, so each run mints a
fresh credential — the DIDs above are from one representative run.
