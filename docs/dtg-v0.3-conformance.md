# Hearthold — DTG v0.3 conformance notes & open WG questions

Hearthold implements the ToIP Decentralized Trust Graph (DTG) credential set
(`trustoverip/dtgwg-cred-tf`) on Archon `did:cid`. `core/dtg.ts` already matches v0.3's shapes exactly —
context, the `DTGCredential` type hierarchy, RCard-as-VDS, VWC digest + `witnessContext`, VEC
endorsement — so no migration was needed. This note records the three v0.3 conformance deltas we did
implement (H3) and two questions we're carrying to the ToIP working group.

## Implemented deltas (H3)

1. **VC 1.1 verify fallback (SHOULD).** We issue W3C VC **2.0** only, but accept **1.1**-shaped DTG
   credentials on the verifier path via `mapVc11ToVc2()` — a non-destructive normalization that maps
   only the fields that moved: the `https://www.w3.org/2018/credentials/v1` context → the 2.0 context,
   `issuanceDate` → `validFrom`, `expirationDate` → `validUntil`. Same schemas, same `type` hierarchy; a
   credential already in 2.0 shape passes through unchanged. Fixture-tested (`e2e:dtg-compat`).

2. **PHC type hint (optional).** `issueVmc(..., { personhood: true })` appends `'PersonhoodCredential'`
   to a VMC's `type` array when the issuing community's governance warrants it. It is **non-authoritative
   per spec** — a hint that the community applies some proof-of-personhood process, not a proof itself —
   and it is **off by default**. Tested both ways (`e2e:dtg-compat`).

3. **ZKP posture: no change.** v0.3 SHOULDs ZKP presentation but permits standard VC presentation. Our
   stance is unchanged: salted-Merkle selective disclosure now, a `PREDICATE` disclosure mode as the
   defined seam, ZK off the critical path (see `docs/trust-graph-and-delegation.md` §7.3). We present via
   Archon challenge/response.

## Open questions for the ToIP WG (a running implementation earns the floor)

1. **VWC `credentialDigest` encoding is self-contradictory in v0.3.** The prose specifies a *multibase
   multihash*, but the worked example shows `sha256:<hex>`. We implemented to the **example**
   (`credentialDigest: "sha256:<hex>"` over a canonicalized credential) because it is the concrete,
   testable form, and documented the divergence. We ask the task force to settle which is normative; if
   the answer is multibase-multihash we will switch and can contribute a migration note. We also offer
   our canonicalization approach (a JCS stand-in over the credential prior to digesting) as input, since
   the digest is meaningless without a pinned canonicalization.

2. **Proof-suite expectations.** Every v0.3 example uses `Ed25519Signature2020`, but Archon (and
   therefore this reference implementation) signs `EcdsaSecp256k1Signature2019` — the native `did:cid`
   suite. Nothing in the credential *shapes* depends on the suite, but a verifier that hard-codes Ed25519
   will reject a conformant secp256k1 credential. We ask the WG for a normative statement that verifiers
   MUST accept both (or, better, a small registry of accepted proof suites the ecosystem agrees on), so
   that DTG credentials remain interoperable across signing substrates.
